import { createServer } from 'node:http';
import { readFile, stat, readdir } from 'node:fs/promises';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { spawnClaudeNext, spawnClaudeAsk, spawnClaudeCheck, spawnClaudeRecap, spawnClaudeBtwAsk, spawnClaudeBtwAskStream, spawnClaudeSaveThread } from './claude.mjs';
import { startWatcher } from './watcher.mjs';
import { scaffoldExercise, vscodeUriFor } from './exercise.mjs';

const STUDYGROUND_DIR = resolve(process.env.STUDYGROUND_DIR);
const PORT = Number(process.env.STUDYGROUND_PORT || 4321);
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT;
const WEB_DIST = join(PLUGIN_ROOT, 'web/dist');
const WEB_SRC = join(PLUGIN_ROOT, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const sseClients = new Set();
const lessonLocks = new Map();

async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (path === '/api/healthz') return sendJSON(res, 200, { ok: true });

  if (path === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`: hello\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (path === '/api/progress') {
    try {
      const content = await readFile(join(STUDYGROUND_DIR, 'progress.json'), 'utf8');
      return sendJSON(res, 200, JSON.parse(content));
    } catch {
      return sendJSON(res, 200, { current_track: null, tracks: {} });
    }
  }

  if (path === '/api/lessons') {
    try {
      const files = await readdir(join(STUDYGROUND_DIR, 'lessons'));
      const list = files
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.replace(/\.md$/, ''))
        .sort();
      return sendJSON(res, 200, { ok: true, lessons: list });
    } catch {
      return sendJSON(res, 200, { ok: true, lessons: [] });
    }
  }

  if (path.startsWith('/api/lesson/')) {
    const slug = decodeURIComponent(path.slice('/api/lesson/'.length));
    const file = join(STUDYGROUND_DIR, 'lessons', slug + '.md');
    if (!file.startsWith(join(STUDYGROUND_DIR, 'lessons') + sep))
      return sendJSON(res, 400, { ok: false, error: 'bad path' });
    try {
      const content = await readFile(file, 'utf8');
      return sendJSON(res, 200, { ok: true, slug, content });
    } catch {
      return sendJSON(res, 404, { ok: false, error: 'not found' });
    }
  }

  if (path === '/api/next' && req.method === 'POST') {
    const body = await readBody(req);
    return await runWithLock('next', res, () =>
      spawnClaudeNext({ studygroundDir: STUDYGROUND_DIR, pluginRoot: PLUGIN_ROOT, body }),
    );
  }

  if (path === '/api/ask' && req.method === 'POST') {
    const body = await readBody(req);
    const key = `ask:${body?.lesson}:${body?.index}`;
    return await runWithLock(key, res, () =>
      spawnClaudeAsk({ studygroundDir: STUDYGROUND_DIR, pluginRoot: PLUGIN_ROOT, body }),
    );
  }

  if (path === '/api/exercise/scaffold' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const result = await scaffoldExercise({
        studygroundDir: STUDYGROUND_DIR,
        pluginRoot: PLUGIN_ROOT,
        lesson: body?.lesson,
        name: body?.name,
      });
      return sendJSON(res, 200, { ok: true, ...result });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  if (path === '/api/check' && req.method === 'POST') {
    const body = await readBody(req);
    const key = `check:${body?.exercise}`;
    return await runWithLock(key, res, () =>
      spawnClaudeCheck({ studygroundDir: STUDYGROUND_DIR, pluginRoot: PLUGIN_ROOT, body }),
    );
  }

  if (path === '/api/recap' && req.method === 'POST') {
    const body = await readBody(req);
    const key = `recap:${body?.lesson}`;
    return await runWithLock(key, res, () =>
      spawnClaudeRecap({ studygroundDir: STUDYGROUND_DIR, pluginRoot: PLUGIN_ROOT, body }),
    );
  }

  if (path === '/api/btw-ask' && req.method === 'POST') {
    const body = await readBody(req);
    // Stream by default; client can pass {stream:false} for legacy single-shot
    if (body?.stream === false) {
      try {
        const result = await spawnClaudeBtwAsk({
          studygroundDir: STUDYGROUND_DIR,
          pluginRoot: PLUGIN_ROOT,
          body,
        });
        return sendJSON(res, 200, { ok: true, answer: result.result, ...result });
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: String(e?.message || e) });
      }
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    let aborted = false;
    req.on('close', () => { aborted = true; });
    const child = spawnClaudeBtwAskStream({
      studygroundDir: STUDYGROUND_DIR,
      pluginRoot: PLUGIN_ROOT,
      body,
      onDelta: (text) => { if (!aborted) write({ type: 'delta', text }); },
      onDone: (meta) => {
        if (aborted) return;
        write({ type: 'done', ...meta });
        res.end();
      },
      onError: (e) => {
        if (aborted) return;
        write({ type: 'error', error: String(e?.message || e) });
        res.end();
      },
    });
    req.on('close', () => { try { child?.kill('SIGTERM'); } catch {} });
    return;
  }

  if (path === '/api/save-thread' && req.method === 'POST') {
    const body = await readBody(req);
    const key = `save-thread:${body?.lesson}`;
    return await runWithLock(key, res, () =>
      spawnClaudeSaveThread({ studygroundDir: STUDYGROUND_DIR, pluginRoot: PLUGIN_ROOT, body }),
    );
  }

  // Static assets
  const root = existsSync(WEB_DIST) ? WEB_DIST : WEB_SRC;
  let file = join(root, path === '/' ? 'index.html' : path);
  if (!file.startsWith(root + sep) && file !== root) {
    res.writeHead(403).end();
    return;
  }
  try {
    const s = await stat(file).catch(() => null);
    if (!s || s.isDirectory()) file = join(root, 'index.html');
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
}

async function runWithLock(key, res, work) {
  if (lessonLocks.has(key)) {
    return sendJSON(res, 409, { ok: false, error: `another ${key} is in flight` });
  }
  const p = (async () => {
    try {
      const result = await work();
      sendJSON(res, 200, { ok: true, ...result });
    } catch (e) {
      sendJSON(res, 500, { ok: false, error: String(e?.message || e) });
    } finally {
      lessonLocks.delete(key);
    }
  })();
  lessonLocks.set(key, p);
  return p;
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function broadcast(event) {
  const msg = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of sseClients) {
    try {
      c.write(msg);
    } catch {
      sseClients.delete(c);
    }
  }
}

const runtimeDir = join(STUDYGROUND_DIR, '.studyground');
if (!existsSync(runtimeDir)) mkdirSync(runtimeDir, { recursive: true });
writeFileSync(
  join(runtimeDir, 'runtime.json'),
  JSON.stringify(
    {
      pid: process.pid,
      port: PORT,
      plugin_root: PLUGIN_ROOT,
      started_at: new Date().toISOString(),
    },
    null,
    2,
  ),
);

startWatcher(STUDYGROUND_DIR, broadcast);

createServer(handle).listen(PORT, () => {
  console.log(`studyground reader at http://localhost:${PORT}`);
  console.log(`watching ${STUDYGROUND_DIR}`);
});
