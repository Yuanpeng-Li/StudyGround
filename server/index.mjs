import { createServer } from 'node:http';
import { readFile, stat, readdir, writeFile, mkdir, unlink, rename, rm } from 'node:fs/promises';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { extname, join, resolve, sep, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { spawnClaudeNext, spawnClaudeNextStream, spawnClaudeAsk, spawnClaudeCheck, spawnClaudeRecap, spawnClaudeBtwAsk, spawnClaudeBtwAskStream, spawnClaudeSaveThread, spawnClaudeIntakeStream, spawnClaudeTutorStream } from './claude.mjs';
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

  if (path === '/api/tracks' && req.method === 'GET') {
    try { return sendJSON(res, 200, { ok: true, tracks: await listTracks() }); }
    catch (e) { return sendJSON(res, 500, { ok: false, error: String(e?.message || e) }); }
  }
  if (path === '/api/tracks' && req.method === 'POST') {
    const body = await readBody(req);
    const slug = slugify(body?.slug || body?.title);
    if (!slug) return sendJSON(res, 400, { ok: false, error: 'slug or title required' });
    if (await readTrackJson(slug)) return sendJSON(res, 409, { ok: false, error: 'track exists' });
    const now = new Date().toISOString();
    const data = {
      slug,
      title: body?.title || slug,
      description: body?.description || '',
      emoji: body?.emoji || '📘',
      created_at: now,
      updated_at: now,
    };
    await writeTrackJson(slug, data);
    return sendJSON(res, 200, { ok: true, track: data });
  }
  if (
    path.startsWith('/api/tracks/') &&
    path !== '/api/tracks/import' &&
    !path.endsWith('/export') &&
    !path.endsWith('/curriculum')
  ) {
    const rest = path.slice('/api/tracks/'.length);
    const parts = rest.split('/').filter(Boolean).map(decodeURIComponent);
    const trackSlug = parts[0];
    // /api/tracks/<slug>
    if (parts.length === 1) {
      if (req.method === 'GET') {
        const data = await readTrackJson(trackSlug);
        if (!data) return sendJSON(res, 404, { ok: false, error: 'not found' });
        const lessons = await listLessonsInTrack(trackSlug);
        const mats = await listMaterials(trackSlug);
        return sendJSON(res, 200, { ok: true, track: { ...data, lessons, materials: mats } });
      }
      if (req.method === 'PATCH') {
        const cur = await readTrackJson(trackSlug);
        if (!cur) return sendJSON(res, 404, { ok: false, error: 'not found' });
        const body = await readBody(req);
        const merged = {
          ...cur,
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.emoji !== undefined ? { emoji: body.emoji } : {}),
          updated_at: new Date().toISOString(),
        };
        await writeTrackJson(trackSlug, merged);
        return sendJSON(res, 200, { ok: true, track: merged });
      }
      if (req.method === 'DELETE') {
        await deleteTrackDir(trackSlug);
        return sendJSON(res, 200, { ok: true });
      }
      if (req.method === 'POST') {
        // POST /api/tracks/<slug>/select-as-current
        const body = await readBody(req);
        if (body?.action === 'select') {
          await setCurrentTrack(trackSlug);
          return sendJSON(res, 200, { ok: true });
        }
      }
    }
    // /api/tracks/<slug>/materials
    if (parts.length === 2 && parts[1] === 'materials') {
      if (req.method === 'GET') {
        return sendJSON(res, 200, { ok: true, materials: await listMaterials(trackSlug) });
      }
      if (req.method === 'POST') {
        // Accept either JSON {name, content} or raw body with ?name= query
        const contentType = req.headers['content-type'] || '';
        let name, content;
        if (contentType.startsWith('application/json')) {
          const body = await readBody(req);
          name = body?.name;
          content = body?.content;
        } else {
          name = url.searchParams.get('name');
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          content = Buffer.concat(chunks);
        }
        if (!name) return sendJSON(res, 400, { ok: false, error: 'name required' });
        const safeName = name.replace(/[^\w.\-]+/g, '_').slice(0, 120);
        if (!safeName) return sendJSON(res, 400, { ok: false, error: 'invalid name' });
        await ensureTrackDir(trackSlug);
        const dest = join(STUDYGROUND_DIR, 'tracks', trackSlug, 'materials', safeName);
        if (typeof content === 'string') await writeFile(dest, content, 'utf8');
        else if (Buffer.isBuffer(content)) await writeFile(dest, content);
        else return sendJSON(res, 400, { ok: false, error: 'no content' });
        return sendJSON(res, 200, { ok: true, name: safeName });
      }
    }
    // /api/tracks/<slug>/materials/<filename>
    if (parts.length === 3 && parts[1] === 'materials') {
      const file = join(STUDYGROUND_DIR, 'tracks', trackSlug, 'materials', parts[2]);
      if (!file.startsWith(join(STUDYGROUND_DIR, 'tracks', trackSlug, 'materials') + sep)) {
        return sendJSON(res, 400, { ok: false, error: 'bad path' });
      }
      if (req.method === 'GET') {
        try {
          const data = await readFile(file);
          const isText = /\.(md|txt|json|js|py|css|html|csv)$/i.test(parts[2]);
          res.writeHead(200, {
            'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/octet-stream',
          });
          return res.end(data);
        } catch {
          return sendJSON(res, 404, { ok: false, error: 'not found' });
        }
      }
      if (req.method === 'DELETE') {
        try { await unlink(file); return sendJSON(res, 200, { ok: true }); }
        catch { return sendJSON(res, 404, { ok: false, error: 'not found' }); }
      }
    }
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
    const trackFilter = url.searchParams.get('track');
    const wantDetail = url.searchParams.get('detail') === '1';
    try {
      if (trackFilter) {
        const lessons = await listLessonsInTrack(trackFilter, { withSummary: wantDetail });
        if (wantDetail) return sendJSON(res, 200, { ok: true, lessons });
        return sendJSON(res, 200, { ok: true, lessons: lessons.map((l) => l.slug) });
      }
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
    const trackParam = url.searchParams.get('track');
    let file = null;
    if (trackParam) {
      file = lessonPath(trackParam, slug);
    } else {
      // Fallback: search all tracks for this slug
      const tracksRoot = join(STUDYGROUND_DIR, 'tracks');
      const subs = await readdir(tracksRoot, { withFileTypes: true }).catch(() => []);
      for (const s of subs) {
        if (!s.isDirectory()) continue;
        const candidate = lessonPath(s.name, slug);
        if (existsSync(candidate)) { file = candidate; break; }
      }
    }
    if (!file) return sendJSON(res, 404, { ok: false, error: 'not found' });
    try {
      const content = await readFile(file, 'utf8');
      return sendJSON(res, 200, { ok: true, slug, content });
    } catch {
      return sendJSON(res, 404, { ok: false, error: 'not found' });
    }
  }

  if (path === '/api/next' && req.method === 'POST') {
    const body = await readBody(req);
    // If a specific track is requested, set it as current first
    if (body?.track) {
      try { await setCurrentTrack(body.track); } catch {}
    }
    if (body?.stream === false) {
      return await runWithLock('next', res, () =>
        spawnClaudeNext({ studygroundDir: STUDYGROUND_DIR, pluginRoot: PLUGIN_ROOT, body }),
      );
    }
    if (lessonLocks.has('next')) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'another /next in flight' }));
    }
    lessonLocks.set('next', true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    let aborted = false;
    let child = null;
    req.on('close', () => {
      aborted = true;
      try { child?.kill('SIGTERM'); } catch {}
      lessonLocks.delete('next');
    });
    child = spawnClaudeNextStream({
      studygroundDir: STUDYGROUND_DIR,
      pluginRoot: PLUGIN_ROOT,
      body,
      onDelta: (text) => { if (!aborted) write({ type: 'delta', text }); },
      onTool: (ev) => { if (!aborted) write({ type: 'tool', ...ev }); },
      onDone: (meta) => {
        if (!aborted) { write({ type: 'done', ...meta }); res.end(); }
        lessonLocks.delete('next');
      },
      onError: (e) => {
        if (!aborted) { write({ type: 'error', error: String(e?.message || e) }); res.end(); }
        lessonLocks.delete('next');
      },
    });
    return;
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
        track: body?.track,
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
    let fullText = '';
    let child = null;
    req.on('close', () => {
      aborted = true;
      try { child?.kill('SIGTERM'); } catch {}
    });
    child = spawnClaudeBtwAskStream({
      studygroundDir: STUDYGROUND_DIR,
      pluginRoot: PLUGIN_ROOT,
      body,
      onDelta: (text) => {
        fullText += text;
        if (!aborted) write({ type: 'delta', text });
      },
      onDone: async (meta) => {
        const answer = meta.full_text || fullText;
        let threadId = body?.thread_id;
        if (body?.track && body?.lesson && body?.selection && body?.question) {
          if (!threadId) threadId = randomUUID();
          try {
            await persistThread({
              id: threadId,
              track: body.track,
              lesson: body.lesson,
              selection: body.selection,
              question: body.question,
              answer,
            });
          } catch (e) {
            // non-fatal
          }
        }
        if (!aborted) {
          write({ type: 'done', ...meta, thread_id: threadId });
          res.end();
        }
      },
      onError: (e) => {
        if (aborted) return;
        write({ type: 'error', error: String(e?.message || e) });
        res.end();
      },
    });
    return;
  }

  // GET /api/tutor/<track> — fetch persisted chat history
  if (path.startsWith('/api/tutor/') && req.method === 'GET') {
    const trackSlug = decodeURIComponent(path.slice('/api/tutor/'.length));
    const data = await loadTutorChat(trackSlug);
    return sendJSON(res, 200, { ok: true, ...data });
  }

  // POST /api/tutor — streaming, multi-turn, persists per-track
  if (path === '/api/tutor' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body?.track) return sendJSON(res, 400, { ok: false, error: 'track required' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    let aborted = false;
    let fullText = '';
    let child = null;
    req.on('close', () => { aborted = true; try { child?.kill('SIGTERM'); } catch {} });
    child = spawnClaudeTutorStream({
      studygroundDir: STUDYGROUND_DIR,
      pluginRoot: PLUGIN_ROOT,
      body,
      onDelta: (text) => { fullText += text; if (!aborted) write({ type: 'delta', text }); },
      onTool: (ev) => { if (!aborted) write({ type: 'tool', ...ev }); },
      onDone: async (meta) => {
        const answer = meta.full_text || fullText;
        try {
          await appendTutorChat(body.track, body.user_message, answer);
        } catch {}
        if (!aborted) {
          write({ type: 'done', ...meta });
          res.end();
        }
      },
      onError: (e) => {
        if (!aborted) { write({ type: 'error', error: String(e?.message || e) }); res.end(); }
      },
    });
    return;
  }

  if (path === '/api/intake' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body?.track) return sendJSON(res, 400, { ok: false, error: 'track required' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    let aborted = false;
    let fullText = '';
    let child = null;
    req.on('close', () => { aborted = true; try { child?.kill('SIGTERM'); } catch {} });
    child = spawnClaudeIntakeStream({
      studygroundDir: STUDYGROUND_DIR,
      pluginRoot: PLUGIN_ROOT,
      body,
      onDelta: (text) => { fullText += text; if (!aborted) write({ type: 'delta', text }); },
      onTool: (ev) => { if (!aborted) write({ type: 'tool', ...ev }); },
      onDone: async (meta) => {
        const answer = meta.full_text || fullText;
        // Intake = first conversation with the tutor. Persist every turn into
        // tutor-chat.json so when the user enters the reader and opens the
        // tutor panel, the same conversation continues — no jarring restart.
        try {
          await appendTutorChat(body.track, body.user_message, answer);
        } catch {}
        if (!aborted) {
          write({ type: 'done', ...meta, full_text: answer });
          res.end();
        }
      },
      onError: (e) => {
        if (!aborted) { write({ type: 'error', error: String(e?.message || e) }); res.end(); }
      },
    });
    return;
  }

  // /api/tracks/<slug>/export → streams a .tgz
  if (path.startsWith('/api/tracks/') && path.endsWith('/export') && req.method === 'GET') {
    const slug = decodeURIComponent(path.slice('/api/tracks/'.length, -'/export'.length));
    if (!existsSync(trackDir(slug))) {
      return sendJSON(res, 404, { ok: false, error: 'track not found' });
    }
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${slug}.tgz"`,
      'Cache-Control': 'no-cache',
    });
    const tar = spawn('tar', ['-czf', '-', '-C', join(STUDYGROUND_DIR, 'tracks'), slug]);
    let tarErr = '';
    tar.stderr.on('data', (d) => { tarErr += d; });
    tar.stdout.pipe(res);
    tar.on('exit', (code) => {
      if (code !== 0) console.warn(`[export] tar exit ${code}: ${tarErr.slice(0, 200)}`);
      res.end();
    });
    tar.on('error', (e) => {
      console.warn('[export] tar spawn error:', e.message);
      try { res.end(); } catch {}
    });
    req.on('close', () => { try { tar.kill('SIGTERM'); } catch {} });
    return;
  }

  // /api/tracks/import — accept raw .tgz body, extract into tracks/<slug>/
  if (path === '/api/tracks/import' && req.method === 'POST') {
    const tmpId = `_import_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tmpDir = join(STUDYGROUND_DIR, 'tracks', tmpId);
    await mkdir(tmpDir, { recursive: true });
    try {
      // Buffer the body to a temp file first — piping straight into `tar -xzf -`
      // sometimes EOFs early when the upstream is HTTP/keep-alive.
      const chunks = [];
      let total = 0;
      for await (const c of req) {
        chunks.push(c);
        total += c.length;
      }
      const tmpTgz = join(tmpDir, '_import.tgz');
      await writeFile(tmpTgz, Buffer.concat(chunks));
      if (total < 50) {
        await rm(tmpDir, { recursive: true, force: true });
        return sendJSON(res, 400, { ok: false, error: 'empty or truncated upload' });
      }
      await new Promise((resolve, reject) => {
        const tar = spawn('tar', ['-xzf', tmpTgz, '-C', tmpDir]);
        let err = '';
        tar.stderr.on('data', (d) => { err += d; });
        tar.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`tar -xzf exit ${code}: ${err.slice(0, 200)}`)));
        tar.on('error', reject);
      });
      await unlink(tmpTgz).catch(() => {});
      // Locate the extracted track: either tmpDir itself has track.json, or tmpDir/<one-subdir>/track.json
      let srcDir = null;
      if (existsSync(join(tmpDir, 'track.json'))) {
        srcDir = tmpDir;
      } else {
        const items = await readdir(tmpDir, { withFileTypes: true });
        for (const it of items) {
          if (it.isDirectory() && existsSync(join(tmpDir, it.name, 'track.json'))) {
            srcDir = join(tmpDir, it.name);
            break;
          }
        }
      }
      if (!srcDir) {
        await rm(tmpDir, { recursive: true, force: true });
        return sendJSON(res, 400, { ok: false, error: 'archive does not contain a track.json' });
      }
      // Determine final slug from track.json
      const trackJson = JSON.parse(await readFile(join(srcDir, 'track.json'), 'utf8'));
      let targetSlug = trackJson.slug || basename(srcDir);
      // Avoid collisions
      let suffix = 0;
      let finalSlug = targetSlug;
      while (existsSync(trackDir(finalSlug))) {
        suffix++;
        finalSlug = `${targetSlug}-${suffix}`;
      }
      // Move
      if (srcDir === tmpDir) {
        await rename(tmpDir, trackDir(finalSlug));
      } else {
        await rename(srcDir, trackDir(finalSlug));
        await rm(tmpDir, { recursive: true, force: true });
      }
      // Patch the slug field to match the directory if it changed
      if (finalSlug !== trackJson.slug) {
        trackJson.slug = finalSlug;
        trackJson.updated_at = new Date().toISOString();
        await writeFile(join(trackDir(finalSlug), 'track.json'), JSON.stringify(trackJson, null, 2));
      }
      return sendJSON(res, 200, { ok: true, slug: finalSlug });
    } catch (e) {
      try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
      return sendJSON(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  // /api/tracks/<slug>/curriculum (read)
  if (path.startsWith('/api/tracks/') && path.endsWith('/curriculum') && req.method === 'GET') {
    const trackSlug = decodeURIComponent(path.slice('/api/tracks/'.length, -'/curriculum'.length));
    const file = join(STUDYGROUND_DIR, 'tracks', trackSlug, 'curriculum.md');
    try {
      const content = await readFile(file, 'utf8');
      return sendJSON(res, 200, { ok: true, content });
    } catch {
      return sendJSON(res, 404, { ok: false, error: 'no curriculum yet' });
    }
  }

  if (path === '/api/threads' && req.method === 'GET') {
    const lesson = url.searchParams.get('lesson');
    const track = url.searchParams.get('track');
    try {
      const threads = await listThreads({ track, lesson });
      return sendJSON(res, 200, { ok: true, threads });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  if (path.startsWith('/api/thread/')) {
    const id = decodeURIComponent(path.slice('/api/thread/'.length));
    const found = await findThreadFile(id);
    if (!found) return sendJSON(res, 404, { ok: false, error: 'not found' });
    if (req.method === 'DELETE') {
      try {
        await unlink(found.path);
        return sendJSON(res, 200, { ok: true });
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: String(e?.message || e) });
      }
    }
    try {
      const data = JSON.parse(await readFile(found.path, 'utf8'));
      return sendJSON(res, 200, { ok: true, thread: data });
    } catch {
      return sendJSON(res, 404, { ok: false, error: 'not found' });
    }
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

async function loadTutorChat(track) {
  const file = join(STUDYGROUND_DIR, 'tracks', track, 'tutor-chat.json');
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return { track, history: [], updated_at: null }; }
}
async function appendTutorChat(track, userMessage, answer) {
  const file = join(STUDYGROUND_DIR, 'tracks', track, 'tutor-chat.json');
  const cur = await loadTutorChat(track);
  const now = new Date().toISOString();
  if (userMessage) cur.history.push({ role: 'user', content: userMessage, ts: now });
  cur.history.push({ role: 'assistant', content: answer, ts: now });
  cur.updated_at = now;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(cur, null, 2));
  return cur;
}

async function persistThread({ id, track, lesson, selection, question, answer }) {
  if (!track) throw new Error('persistThread requires track');
  const dir = trackThreadsDir(track);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  let existing = null;
  try { existing = JSON.parse(await readFile(path, 'utf8')); } catch {}
  const now = new Date().toISOString();
  const data = {
    id,
    track,
    lesson,
    selection: existing?.selection || selection,
    history: [
      ...(existing?.history || []),
      { role: 'user', content: question, ts: now },
      { role: 'assistant', content: answer, ts: now },
    ],
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  await writeFile(path, JSON.stringify(data, null, 2));
  return data;
}

// ---------- progress.json write mutex ----------
// Serializes all server-side reads-modify-writes of progress.json.
// Claude's /next subprocess writes are NOT covered (those run in a child
// process); but the existing /next lock prevents concurrent /next calls,
// and Claude only touches tracks[<slug>].current — disjoint from
// setCurrentTrack which touches top-level current_track. The remaining
// race is theoretically possible but rare; acceptable.
let _progressMutex = Promise.resolve();
async function withProgressLock(fn) {
  const prev = _progressMutex;
  let release;
  _progressMutex = new Promise((r) => { release = r; });
  await prev;
  try { return await fn(); }
  finally { release(); }
}

// ---------- path helpers (per-track layout) ----------
function trackDir(track)    { return join(STUDYGROUND_DIR, 'tracks', track); }
function lessonsDir(track)  { return join(trackDir(track), 'lessons'); }
function lessonPath(track, slug) { return join(lessonsDir(track), slug + '.md'); }
function exercisesDir(track){ return join(trackDir(track), 'exercises'); }
function exerciseDir(track, name) { return join(exercisesDir(track), name); }
function trackThreadsDir(track) { return join(trackDir(track), 'threads'); }

// ---------- one-time migration: flat layout → per-track ----------
async function migrateLayoutIfNeeded() {
  const sg = STUDYGROUND_DIR;
  const oldLessons = join(sg, 'lessons');
  const oldExercises = join(sg, 'exercises');
  const oldThreads = join(sg, '.studyground', 'threads');

  // Build lesson → track and exercise → track maps from the OLD flat layout
  const lessonToTrack = {};
  const exerciseToTrack = {};
  let migratedSomething = false;

  let oldLessonFiles = [];
  try { oldLessonFiles = await readdir(oldLessons); } catch {}

  for (const f of oldLessonFiles) {
    if (!f.endsWith('.md')) continue;
    const slug = f.replace(/\.md$/, '');
    let content;
    try { content = await readFile(join(oldLessons, f), 'utf8'); } catch { continue; }
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) continue;
    const tm = fm[1].match(/^track:\s*(.+)$/m);
    const track = tm ? tm[1].trim() : null;
    if (!track) continue;
    lessonToTrack[slug] = track;
    for (const m of content.matchAll(/^:::exercise\s+(\S+)/gm)) {
      exerciseToTrack[m[1]] = track;
    }
    const dest = lessonPath(track, slug);
    if (!existsSync(dest)) {
      await mkdir(dirname(dest), { recursive: true });
      await rename(join(oldLessons, f), dest);
      migratedSomething = true;
    }
  }

  // Move exercises into their owning track
  let oldExFiles = [];
  try { oldExFiles = await readdir(oldExercises); } catch {}
  for (const name of oldExFiles) {
    if (name.startsWith('.')) continue;
    const track = exerciseToTrack[name];
    if (!track) continue;
    const src = join(oldExercises, name);
    const dest = exerciseDir(track, name);
    if (!existsSync(dest)) {
      await mkdir(dirname(dest), { recursive: true });
      try { await rename(src, dest); migratedSomething = true; } catch {}
    }
  }

  // Move threads into their owning track (looked up by thread.lesson → that lesson's track)
  let oldThreadFiles = [];
  try { oldThreadFiles = await readdir(oldThreads); } catch {}
  for (const f of oldThreadFiles) {
    if (!f.endsWith('.json')) continue;
    let data;
    try { data = JSON.parse(await readFile(join(oldThreads, f), 'utf8')); } catch { continue; }
    const track = lessonToTrack[data?.lesson];
    if (!track) continue;
    const dest = join(trackThreadsDir(track), f);
    if (!existsSync(dest)) {
      await mkdir(dirname(dest), { recursive: true });
      try { await rename(join(oldThreads, f), dest); migratedSomething = true; } catch {}
    }
  }

  if (migratedSomething) {
    console.log('[migrate] moved flat lessons/exercises/threads into tracks/<slug>/*');
  }

  // Clean up leftover empty flat dirs (and dirs that contain only .gitkeep).
  // Use recursive: true since fs.rm on dirs needs it.
  for (const dir of [oldLessons, oldExercises, oldThreads]) {
    try {
      const remaining = await readdir(dir);
      const onlyGitkeep = remaining.length === 1 && remaining[0] === '.gitkeep';
      if (remaining.length === 0 || onlyGitkeep) {
        await rm(dir, { recursive: true, force: true });
      }
    } catch {}
  }
}

// ---------- tracks ----------
async function ensureTrackDir(slug) {
  const tracksRoot = join(STUDYGROUND_DIR, 'tracks');
  await mkdir(tracksRoot, { recursive: true });
  const dir = join(tracksRoot, slug);
  await mkdir(join(dir, 'materials'), { recursive: true });
  return dir;
}

async function readTrackJson(slug) {
  const file = join(STUDYGROUND_DIR, 'tracks', slug, 'track.json');
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return null; }
}

async function writeTrackJson(slug, data) {
  await ensureTrackDir(slug);
  const file = join(STUDYGROUND_DIR, 'tracks', slug, 'track.json');
  await writeFile(file, JSON.stringify(data, null, 2));
  return data;
}

async function listLessonsInTrack(track, { withSummary = false } = {}) {
  const dir = lessonsDir(track);
  const files = await readdir(dir).catch(() => []);
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const slugName = f.replace(/\.md$/, '');
    let content;
    try { content = await readFile(join(dir, f), 'utf8'); } catch { continue; }
    const m = content.match(/^---\n([\s\S]*?)\n---/);
    const titleMatch = m && m[1].match(/^title:\s*(.+)$/m);
    const item = { slug: slugName, title: titleMatch ? titleMatch[1].trim() : slugName };
    if (withSummary) {
      const askTotal = (content.match(/^\?>\s/gm) || []).length;
      const askAnswered = (content.match(/<!-- answer:start -->/g) || []).length;
      const askPending = (content.match(/<!-- answer:pending -->/g) || []).length;
      const btwTotal = (content.match(/^\?>>\s/gm) || []).length;
      const exercises = (content.match(/^:::exercise\s+\S+/gm) || []).length;
      const feedbacks = (content.match(/<!-- feedback:start /g) || []).length;
      item.summary = { ask_total: askTotal, ask_answered: askAnswered, ask_pending: askPending, btw_total: btwTotal, exercises, feedbacks };
    }
    out.push(item);
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

async function listAllThreads(track) {
  const dir = track ? trackThreadsDir(track) : null;
  if (!dir) return [];
  const files = await readdir(dir).catch(() => []);
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const data = JSON.parse(await readFile(join(dir, f), 'utf8'));
      out.push(data);
    } catch {}
  }
  return out;
}

// Find a thread file across all tracks (used when client doesn't know track)
async function findThreadFile(id) {
  const tracksRoot = join(STUDYGROUND_DIR, 'tracks');
  const subs = await readdir(tracksRoot, { withFileTypes: true }).catch(() => []);
  for (const s of subs) {
    if (!s.isDirectory()) continue;
    const candidate = join(trackThreadsDir(s.name), `${id}.json`);
    if (existsSync(candidate)) return { path: candidate, track: s.name };
  }
  return null;
}

async function listTracks() {
  // Source of truth: tracks/<slug>/track.json
  // Also: any track key in progress.json that doesn't yet have a track.json — lazy migrate
  const tracksRoot = join(STUDYGROUND_DIR, 'tracks');
  const subs = await readdir(tracksRoot, { withFileTypes: true }).catch(() => []);
  const haveSlugs = new Set();
  const tracks = [];
  for (const s of subs) {
    if (!s.isDirectory()) continue;
    const data = await readTrackJson(s.name);
    if (!data) continue;
    haveSlugs.add(s.name);
    tracks.push(data);
  }
  // Migrate from progress.json
  let progress = null;
  try { progress = JSON.parse(await readFile(join(STUDYGROUND_DIR, 'progress.json'), 'utf8')); } catch {}
  if (progress?.tracks) {
    for (const [slug, info] of Object.entries(progress.tracks)) {
      if (haveSlugs.has(slug)) continue;
      const migrated = {
        slug,
        title: slug.replace(/-/g, ' '),
        description: '',
        emoji: '📘',
        created_at: info?.started_at || new Date().toISOString(),
        updated_at: info?.started_at || new Date().toISOString(),
      };
      await writeTrackJson(slug, migrated);
      tracks.push(migrated);
    }
  }
  // Annotate with lesson count + last activity
  const annotated = await Promise.all(
    tracks.map(async (t) => {
      const lessons = await listLessonsInTrack(t.slug);
      const matsDir = join(STUDYGROUND_DIR, 'tracks', t.slug, 'materials');
      const mats = await readdir(matsDir).catch(() => []);
      return {
        ...t,
        lesson_count: lessons.length,
        material_count: mats.filter((f) => !f.startsWith('.')).length,
        current_lesson: progress?.tracks?.[t.slug]?.current || null,
        is_current_track: progress?.current_track === t.slug,
      };
    }),
  );
  annotated.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  return annotated;
}

function slugify(s) {
  // Preserve Unicode letters/numbers (CJK, accented Latin, etc.) — only strip punctuation/symbols.
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

async function setCurrentTrack(slug) {
  return withProgressLock(async () => {
    const progressFile = join(STUDYGROUND_DIR, 'progress.json');
    let progress = { current_track: null, tracks: {} };
    try { progress = JSON.parse(await readFile(progressFile, 'utf8')); } catch {}
    progress.current_track = slug;
    if (!progress.tracks[slug]) {
      progress.tracks[slug] = {
        current: null,
        completed: [],
        started_at: new Date().toISOString().slice(0, 10),
      };
    }
    await writeFile(progressFile, JSON.stringify(progress, null, 2));
  });
}

async function deleteTrackDir(slug) {
  const dir = join(STUDYGROUND_DIR, 'tracks', slug);
  await rm(dir, { recursive: true, force: true });
  await withProgressLock(async () => {
    const progressFile = join(STUDYGROUND_DIR, 'progress.json');
    try {
      const progress = JSON.parse(await readFile(progressFile, 'utf8'));
      delete progress.tracks?.[slug];
      if (progress.current_track === slug) progress.current_track = null;
      await writeFile(progressFile, JSON.stringify(progress, null, 2));
    } catch {}
  });
}

// ---------- materials ----------
async function listMaterials(slug) {
  const dir = join(STUDYGROUND_DIR, 'tracks', slug, 'materials');
  const files = await readdir(dir).catch(() => []);
  const out = [];
  for (const f of files) {
    if (f.startsWith('.')) continue;
    try {
      const st = await stat(join(dir, f));
      out.push({
        name: f,
        size: st.size,
        mtime: st.mtime.toISOString(),
      });
    } catch {}
  }
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return out;
}

async function listThreads({ track, lesson } = {}) {
  const targetTracks = [];
  if (track) {
    targetTracks.push(track);
  } else {
    const tracksRoot = join(STUDYGROUND_DIR, 'tracks');
    const subs = await readdir(tracksRoot, { withFileTypes: true }).catch(() => []);
    for (const s of subs) if (s.isDirectory()) targetTracks.push(s.name);
  }
  const out = [];
  for (const t of targetTracks) {
    const dir = trackThreadsDir(t);
    const files = await readdir(dir).catch(() => []);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const data = JSON.parse(await readFile(join(dir, f), 'utf8'));
        if (lesson && data.lesson !== lesson) continue;
        out.push({
          id: data.id,
          track: data.track || t,
          lesson: data.lesson,
          selection: data.selection,
          first_question: data.history?.find((m) => m.role === 'user')?.content || '',
          updated_at: data.updated_at,
          created_at: data.created_at,
          turns: Math.floor((data.history?.length || 0) / 2),
        });
      } catch {}
    }
  }
  out.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  return out;
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

// Run idempotent boot migration BEFORE starting watcher (so watches go on new dirs)
await migrateLayoutIfNeeded().catch((e) => console.warn('[migrate] failed:', e?.message));

startWatcher(STUDYGROUND_DIR, broadcast);

createServer(handle).listen(PORT, () => {
  console.log(`studyground reader at http://localhost:${PORT}`);
  console.log(`watching ${STUDYGROUND_DIR}`);
});
