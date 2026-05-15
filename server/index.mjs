import { createServer } from 'node:http';
import { readFile, stat, readdir, writeFile, mkdir, unlink, rename, rm, appendFile } from 'node:fs/promises';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { extname, join, resolve, sep, dirname, basename, relative as relPath, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { spawnClaudeNext, spawnClaudeNextStream, spawnClaudeAsk, spawnClaudeCheck, spawnClaudeRecap, spawnClaudeBtwAsk, spawnClaudeBtwAskStream, spawnClaudeSaveThread, spawnClaudeIntakeStream, spawnClaudeTutorStream } from './claude.mjs';
import { startWatcher } from './watcher.mjs';
import { scaffoldExercise, vscodeUriFor } from './exercise.mjs';
import {
  processMaterial,
  deleteMaterial,
  reconcile,
  reconcileAll,
  listMaterialsWithStats,
  onMaterialEvent,
} from './materials/index.mjs';

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

// Single-source path-segment validator. Used everywhere a track slug,
// thread id, lesson slug, or exercise name lands on disk so a request like
// `/api/thread/..%2F..%2Fevil` can't reach outside its intended directory.
// Studyground is a single-user local tool so the exploit risk is near zero,
// but the bad input still produces confusing crashes — fail fast and clean.
// Reject empty / over-long / dot-only / control-char segments. `..` is
// the obvious attack; pure `_` / `-` / `.` strings also fail an
// alphanumeric-required check.
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
function isSafeSegment(s) {
  if (typeof s !== 'string') return false;
  if (s.length === 0 || s.length > 200) return false;
  if (!SAFE_SEGMENT_RE.test(s)) return false;
  if (/^[._-]+$/.test(s)) return false; // ".", "..", "..." all fail this
  return true;
}
function rejectBadSegment(res, label, value) {
  sendJSON(res, 400, { ok: false, error: `invalid ${label}: ${JSON.stringify(value)}` });
  return null;
}

// Materials are served back to the browser for inline preview. The viewer
// needs accurate Content-Type so PDFs render via <iframe> instead of being
// force-downloaded, and so images render as <img>.
const MATERIAL_MIME = {
  pdf:  'application/pdf',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  webp: 'image/webp',
  svg:  'image/svg+xml',
  md:   'text/plain; charset=utf-8',
  txt:  'text/plain; charset=utf-8',
  json: 'text/plain; charset=utf-8',
  js:   'text/plain; charset=utf-8',
  py:   'text/plain; charset=utf-8',
  css:  'text/plain; charset=utf-8',
  html: 'text/plain; charset=utf-8',
  csv:  'text/plain; charset=utf-8',
};
function contentTypeForMaterial(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  const ext = m ? m[1].toLowerCase() : '';
  return MATERIAL_MIME[ext] || 'application/octet-stream';
}

// Filesystem-safe filename that *preserves* Unicode letters and digits so
// CJK / accented filenames survive a round-trip through the materials API
// and stay linkable from [filename, p.N] citations. Strips path
// separators, NUL / control characters, Windows-reserved chars (\ / : * ?
// " < > |), and leading dots (so e.g. ".hiddenfile" can't be uploaded).
// Collapses whitespace and dashes-only sequences. Caps at 120 chars
// (filesystem norms; gives ext room).
function sanitizeFilename(name) {
  let s = String(name || '')
    .replace(/[\x00-\x1f/\\:*?"<>|]+/g, '_')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > 120) {
    const dot = s.lastIndexOf('.');
    if (dot > 0 && s.length - dot <= 12) {
      s = s.slice(0, 120 - (s.length - dot)) + s.slice(dot);
    } else {
      s = s.slice(0, 120);
    }
  }
  return s;
}

// Cap a chat history before persisting to disk. Tutor + thread JSONL files
// would otherwise grow without bound (clients can PUT thousands of messages).
// We keep the most recent entries; oldest get trimmed.
const CHAT_HISTORY_MAX_MESSAGES = 400;
const CHAT_HISTORY_MAX_BYTES_PER_MSG = 64 * 1024;
function capChatHistory(messages) {
  if (!Array.isArray(messages)) return [];
  const truncated = messages.map((m) => {
    const content = String(m.content || '');
    if (content.length <= CHAT_HISTORY_MAX_BYTES_PER_MSG) return m;
    return { ...m, content: content.slice(0, CHAT_HISTORY_MAX_BYTES_PER_MSG) + '…[truncated]' };
  });
  if (truncated.length <= CHAT_HISTORY_MAX_MESSAGES) return truncated;
  return truncated.slice(-CHAT_HISTORY_MAX_MESSAGES);
}

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
      emoji: body?.emoji || '📜',
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
    if (!isSafeSegment(trackSlug)) return rejectBadSegment(res, 'track slug', trackSlug);
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
          // Don't materialise progress entries for slugs the user might have
          // typo'd into the URL — without this guard, navigating to
          // #/t/<anything>/ would silently leave a permanent ghost course
          // on the home view.
          if (!(await readTrackJson(trackSlug))) {
            return sendJSON(res, 404, { ok: false, error: 'track not found' });
          }
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
        // Preserve Unicode letters/digits so CJK / accented filenames stay
        // intact — `\w` is ASCII-only and would mangle 文献2024年.pdf to
        // _2024_.pdf, which then can't be linked back by [filename, p.N]
        // citations carrying the original name. Still strip path
        // separators, control chars, and the Windows-reserved set.
        const safeName = sanitizeFilename(name);
        if (!safeName) return sendJSON(res, 400, { ok: false, error: 'invalid name' });
        await ensureTrackDir(trackSlug);
        const materialsDir = join(STUDYGROUND_DIR, 'tracks', trackSlug, 'materials');
        // Auto-rename on collision so a duplicate upload doesn't silently
        // clobber prior data. Caller can pass ?replace=1 to opt into
        // overwrite (used by save-thread style flows).
        const replace = url.searchParams.get('replace') === '1';
        const finalName = replace ? safeName : await uniqueFilename(materialsDir, safeName);
        const dest = join(materialsDir, finalName);
        if (typeof content === 'string') await writeFile(dest, content, 'utf8');
        else if (Buffer.isBuffer(content)) await writeFile(dest, content);
        else return sendJSON(res, 400, { ok: false, error: 'no content' });
        // Respond immediately so the browser doesn't block on extraction.
        // The materials orchestrator runs async and broadcasts progress via SSE.
        processMaterial({
          studygroundDir: STUDYGROUND_DIR,
          slug: trackSlug,
          name: finalName,
          replaceExisting: true,
        }).catch((e) => console.warn('[materials] process', trackSlug, finalName, ':', e?.message));
        return sendJSON(res, 200, {
          ok: true,
          name: finalName,
          renamed: finalName !== safeName,
          status: 'pending',
        });
      }
    }
    // /api/tracks/<slug>/reindex — kick off reconcile for the whole track
    if (parts.length === 2 && parts[1] === 'reindex' && req.method === 'POST') {
      reconcile({ studygroundDir: STUDYGROUND_DIR, slug: trackSlug, force: true })
        .catch((e) => console.warn('[materials] reindex', trackSlug, ':', e?.message));
      return sendJSON(res, 200, { ok: true, status: 'pending' });
    }
    // /api/tracks/<slug>/materials/<filename>
    if (parts.length === 3 && parts[1] === 'materials') {
      const matName = parts[2];
      const materialsDir = join(STUDYGROUND_DIR, 'tracks', trackSlug, 'materials');
      const file = join(materialsDir, matName);
      // path.relative + `..` check is the only reliable way to detect a
      // traversal attempt — `startsWith(dir + sep)` can be tricked by
      // resolved-but-coincidentally-prefixed paths.
      const rel = relPath(materialsDir, file);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
        return sendJSON(res, 400, { ok: false, error: 'bad path' });
      }
      if (req.method === 'GET') {
        try {
          const data = await readFile(file);
          res.writeHead(200, {
            'Content-Type': contentTypeForMaterial(matName),
            'X-Content-Type-Options': 'nosniff',
          });
          return res.end(data);
        } catch {
          return sendJSON(res, 404, { ok: false, error: 'not found' });
        }
      }
      if (req.method === 'DELETE') {
        try { await unlink(file); }
        catch { return sendJSON(res, 404, { ok: false, error: 'not found' }); }
        // Clean up derived artefacts (text mirror, manifest entry, chunks, indices).
        deleteMaterial({ studygroundDir: STUDYGROUND_DIR, slug: trackSlug, name: matName })
          .catch((e) => console.warn('[materials] delete', trackSlug, matName, ':', e?.message));
        return sendJSON(res, 200, { ok: true });
      }
    }
    // /api/tracks/<slug>/materials/<filename>/stats — manifest details for one file
    if (parts.length === 4 && parts[1] === 'materials' && parts[3] === 'stats' && req.method === 'GET') {
      const all = await listMaterialsWithStats({ studygroundDir: STUDYGROUND_DIR, slug: trackSlug });
      const found = all.find((m) => m.name === parts[2]);
      if (!found) return sendJSON(res, 404, { ok: false, error: 'not found' });
      return sendJSON(res, 200, { ok: true, material: found });
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
    if (!trackFilter) {
      return sendJSON(res, 400, { ok: false, error: 'track query param required' });
    }
    try {
      const lessons = await listLessonsInTrack(trackFilter, { withSummary: wantDetail });
      if (wantDetail) return sendJSON(res, 200, { ok: true, lessons });
      return sendJSON(res, 200, { ok: true, lessons: lessons.map((l) => l.slug) });
    } catch {
      return sendJSON(res, 200, { ok: true, lessons: [] });
    }
  }

  if (path.startsWith('/api/lesson/')) {
    const slug = decodeURIComponent(path.slice('/api/lesson/'.length));
    if (!isSafeSegment(slug)) return rejectBadSegment(res, 'lesson slug', slug);
    const trackParam = url.searchParams.get('track');
    if (trackParam && !isSafeSegment(trackParam)) return rejectBadSegment(res, 'track slug', trackParam);
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
    if (body?.track && !isSafeSegment(body.track)) return rejectBadSegment(res, 'track slug', body.track);
    // If a specific track is requested, set it as current first
    if (body?.track) {
      try { await setCurrentTrack(body.track); } catch {}
    }
    // Lock per-track so generations on different tracks can run in parallel.
    // Without `body.track` we fall back to whatever's current — keep the
    // global key for that case so we still serialize.
    const nextKey = body?.track ? `next:${body.track}` : 'next';
    if (body?.stream === false) {
      return await runWithLock(nextKey, res, () =>
        spawnClaudeNext({ studygroundDir: STUDYGROUND_DIR, pluginRoot: PLUGIN_ROOT, body }),
      );
    }
    if (lessonLocks.has(nextKey)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: `another ${nextKey} in flight` }));
    }
    lessonLocks.set(nextKey, true);
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
      lessonLocks.delete(nextKey);
    });
    child = spawnClaudeNextStream({
      studygroundDir: STUDYGROUND_DIR,
      pluginRoot: PLUGIN_ROOT,
      body,
      onDelta: (text) => { if (!aborted) write({ type: 'delta', text }); },
      onTool: (ev) => { if (!aborted) write({ type: 'tool', ...ev }); },
      onDone: (meta) => {
        if (!aborted) { write({ type: 'done', ...meta }); res.end(); }
        lessonLocks.delete(nextKey);
      },
      onError: (e) => {
        if (!aborted) { write({ type: 'error', error: String(e?.message || e) }); res.end(); }
        lessonLocks.delete(nextKey);
      },
    });
    return;
  }

  if (path === '/api/ask' && req.method === 'POST') {
    const body = await readBody(req);
    if (body?.track && !isSafeSegment(body.track)) return rejectBadSegment(res, 'track slug', body.track);
    if (body?.lesson && !isSafeSegment(body.lesson)) return rejectBadSegment(res, 'lesson slug', body.lesson);
    const key = `ask:${body?.lesson}:${body?.index}`;
    return await runWithLock(key, res, () =>
      spawnClaudeAsk({ studygroundDir: STUDYGROUND_DIR, pluginRoot: PLUGIN_ROOT, body }),
    );
  }

  if (path === '/api/exercise/scaffold' && req.method === 'POST') {
    const body = await readBody(req);
    if (body?.track && !isSafeSegment(body.track)) return rejectBadSegment(res, 'track slug', body.track);
    if (body?.lesson && !isSafeSegment(body.lesson)) return rejectBadSegment(res, 'lesson slug', body.lesson);
    if (body?.name && !isSafeSegment(body.name)) return rejectBadSegment(res, 'exercise name', body.name);
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
    if (body?.track && !isSafeSegment(body.track)) return rejectBadSegment(res, 'track slug', body.track);
    if (body?.lesson && !isSafeSegment(body.lesson)) return rejectBadSegment(res, 'lesson slug', body.lesson);
    if (body?.exercise && !isSafeSegment(body.exercise)) return rejectBadSegment(res, 'exercise name', body.exercise);
    // Scope by both track + lesson + exercise so a check on a different
    // exercise (even with the same name in another lesson) runs in parallel.
    const key = `check:${body?.track}:${body?.lesson}:${body?.exercise}`;
    return await runWithLock(key, res, () =>
      spawnClaudeCheck({ studygroundDir: STUDYGROUND_DIR, pluginRoot: PLUGIN_ROOT, body }),
    );
  }

  if (path === '/api/recap' && req.method === 'POST') {
    const body = await readBody(req);
    if (body?.track && !isSafeSegment(body.track)) return rejectBadSegment(res, 'track slug', body.track);
    if (body?.lesson && !isSafeSegment(body.lesson)) return rejectBadSegment(res, 'lesson slug', body.lesson);
    const key = `recap:${body?.track}:${body?.lesson}`;
    return await runWithLock(key, res, () =>
      spawnClaudeRecap({ studygroundDir: STUDYGROUND_DIR, pluginRoot: PLUGIN_ROOT, body }),
    );
  }

  if (path === '/api/btw-ask' && req.method === 'POST') {
    const body = await readBody(req);
    if (body?.track && !isSafeSegment(body.track)) return rejectBadSegment(res, 'track slug', body.track);
    if (body?.lesson && !isSafeSegment(body.lesson)) return rejectBadSegment(res, 'lesson slug', body.lesson);
    if (body?.thread_id && !isSafeSegment(body.thread_id)) return rejectBadSegment(res, 'thread id', body.thread_id);
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
    if (!isSafeSegment(trackSlug)) return rejectBadSegment(res, 'track slug', trackSlug);
    const data = await loadTutorChat(trackSlug);
    return sendJSON(res, 200, { ok: true, ...data });
  }

  // PUT /api/tutor/<track> — replace persisted tutor history (used by
  // edit-message-and-truncate UI). Body: { history: [{role,content,ts?}…] }.
  if (path.startsWith('/api/tutor/') && req.method === 'PUT') {
    const trackSlug = decodeURIComponent(path.slice('/api/tutor/'.length));
    if (!isSafeSegment(trackSlug)) return rejectBadSegment(res, 'track slug', trackSlug);
    if (!existsSync(trackDir(trackSlug))) return sendJSON(res, 404, { ok: false, error: 'track not found' });
    const body = await readBody(req);
    const history = Array.isArray(body?.history) ? body.history : [];
    const now = new Date().toISOString();
    const normalized = capChatHistory(history
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role, content: String(m.content || ''), ts: m.ts || now })));
    // Lock on the tutor file so a concurrent POST /api/tutor doesn't
    // interleave with this rewrite.
    return await runWithLock(`tutor:${trackSlug}`, res, async () => {
      await rewriteChatLines(
        tutorChatPath(trackSlug),
        () => ({ kind: 'tutor', track: trackSlug, created_at: now }),
        normalized,
      );
      return await loadTutorChat(trackSlug);
    });
  }

  // POST /api/tutor/<track>/append — append a single user message to the
  // tutor chat without spawning Claude. Used by the plan-mode inline-comment
  // flow: the user highlights text in the curriculum, types a comment, and we
  // record it as a user turn so it survives a reload and gets included on the
  // next /api/intake finalize call.
  if (path.endsWith('/append') && path.startsWith('/api/tutor/') && req.method === 'POST') {
    const trackSlug = decodeURIComponent(path.slice('/api/tutor/'.length, -'/append'.length));
    if (!isSafeSegment(trackSlug)) return rejectBadSegment(res, 'track slug', trackSlug);
    if (!existsSync(trackDir(trackSlug))) return sendJSON(res, 404, { ok: false, error: 'track not found' });
    const body = await readBody(req);
    const role = body?.role || 'user';
    const content = String(body?.content || '').trim();
    if (role !== 'user') return sendJSON(res, 400, { ok: false, error: 'only user role allowed' });
    if (!content) return sendJSON(res, 400, { ok: false, error: 'content required' });
    return await runWithLock(`tutor:${trackSlug}`, res, async () => {
      const data = await appendTutorChat(trackSlug, content, null);
      const ts = data.history.length ? data.history[data.history.length - 1].ts : new Date().toISOString();
      return { ts };
    });
  }

  // POST /api/tutor — streaming, multi-turn, persists per-track
  if (path === '/api/tutor' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body?.track) return sendJSON(res, 400, { ok: false, error: 'track required' });
    if (!isSafeSegment(body.track)) return rejectBadSegment(res, 'track slug', body.track);
    // Serialize POSTs to the same tutor — two simultaneous turns racing on
    // the same .jsonl file would lose history (the slower writer's
    // append clobbered the earlier read).
    if (lessonLocks.has(`tutor:${body.track}`)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'another tutor turn in flight' }));
    }
    lessonLocks.set(`tutor:${body.track}`, true);
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
    const tutorLockKey = `tutor:${body.track}`;
    const releaseLock = () => { lessonLocks.delete(tutorLockKey); };
    req.on('close', () => {
      aborted = true;
      try { child?.kill('SIGTERM'); } catch {}
      releaseLock();
    });
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
        releaseLock();
      },
      onError: (e) => {
        if (!aborted) { write({ type: 'error', error: String(e?.message || e) }); res.end(); }
        releaseLock();
      },
    });
    return;
  }

  if (path === '/api/intake' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body?.track) return sendJSON(res, 400, { ok: false, error: 'track required' });
    if (!isSafeSegment(body.track)) return rejectBadSegment(res, 'track slug', body.track);
    // Intake writes into the same tutor-chat.jsonl that POST /api/tutor uses.
    // Serialize on the same lock key so the two endpoints don't race each
    // other (e.g. user finalized intake, then opened the tutor panel
    // before the intake's append completed).
    if (lessonLocks.has(`tutor:${body.track}`)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'another tutor/intake turn in flight' }));
    }
    lessonLocks.set(`tutor:${body.track}`, true);
    const intakeLockKey = `tutor:${body.track}`;
    const releaseIntakeLock = () => { lessonLocks.delete(intakeLockKey); };
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
      releaseIntakeLock();
    });
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
        // On `action: finalize`, the intake skill wrote curriculum.md.
        // The file watcher only watches `lessons/`, so emit an explicit
        // SSE event here so connected clients reload.
        if (body?.action === 'finalize') {
          try { broadcast({ type: 'curriculum-change', track: body.track }); } catch {}
        }
        if (!aborted) {
          write({ type: 'done', ...meta, full_text: answer });
          res.end();
        }
        releaseIntakeLock();
      },
      onError: (e) => {
        if (!aborted) { write({ type: 'error', error: String(e?.message || e) }); res.end(); }
        releaseIntakeLock();
      },
    });
    return;
  }

  // /api/tracks/<slug>/export → streams a .tgz
  if (path.startsWith('/api/tracks/') && path.endsWith('/export') && req.method === 'GET') {
    const slug = decodeURIComponent(path.slice('/api/tracks/'.length, -'/export'.length));
    if (!isSafeSegment(slug)) return rejectBadSegment(res, 'track slug', slug);
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
    if (!isSafeSegment(trackSlug)) return rejectBadSegment(res, 'track slug', trackSlug);
    const file = join(STUDYGROUND_DIR, 'tracks', trackSlug, 'curriculum.md');
    try {
      const content = await readFile(file, 'utf8');
      return sendJSON(res, 200, { ok: true, content });
    } catch {
      // 200 + {ok:false} so the browser doesn't log a 404 every time a
      // fresh track is opened — the client checks `r.ok` already.
      return sendJSON(res, 200, { ok: false, error: 'no curriculum yet' });
    }
  }

  if (path === '/api/threads' && req.method === 'GET') {
    const lesson = url.searchParams.get('lesson');
    const track = url.searchParams.get('track');
    if (track && !isSafeSegment(track)) return rejectBadSegment(res, 'track slug', track);
    if (lesson && !isSafeSegment(lesson)) return rejectBadSegment(res, 'lesson slug', lesson);
    try {
      const threads = await listThreads({ track, lesson });
      return sendJSON(res, 200, { ok: true, threads });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  if (path.startsWith('/api/thread/')) {
    const id = decodeURIComponent(path.slice('/api/thread/'.length));
    if (!isSafeSegment(id)) return rejectBadSegment(res, 'thread id', id);
    const found = await findThreadFile(id);
    if (!found) return sendJSON(res, 404, { ok: false, error: 'not found' });
    if (req.method === 'DELETE') {
      try {
        if (existsSync(found.path)) await unlink(found.path);
        return sendJSON(res, 200, { ok: true });
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: String(e?.message || e) });
      }
    }
    if (req.method === 'PUT' || req.method === 'PATCH') {
      // PUT — replace this thread's history (edit-message-and-truncate UI).
      // PATCH — partial update (currently: rename via { name }).
      const body = await readBody(req);
      const now = new Date().toISOString();
      const existing = await readChatJsonl(found.path);
      const m = existing.meta || {};
      const isRename = req.method === 'PATCH' || (body?.name !== undefined && !Array.isArray(body?.history));
      // For a rename-only call, keep the existing history; otherwise replace it.
      const messages = isRename
        ? existing.history.map((mm) => ({ role: mm.role, content: mm.content, ts: mm.ts || now }))
        : (Array.isArray(body?.history) ? body.history : [])
            .filter((mm) => mm && (mm.role === 'user' || mm.role === 'assistant'))
            .map((mm) => ({ role: mm.role, content: String(mm.content || ''), ts: mm.ts || now }));
      // Decide what name to store: explicit string wins, '' clears, undefined keeps.
      const name = body?.name === undefined ? (m.name || '') : String(body.name || '').slice(0, 120);
      try {
        await rewriteChatLines(
          found.path,
          () => ({
            kind: 'btw',
            id: m.id || id,
            track: m.track || found.track,
            lesson: m.lesson || null,
            selection: m.selection || '',
            name,
            created_at: m.created_at || now,
          }),
          messages,
        );
        const data = await readThreadData(found.path);
        return sendJSON(res, 200, { ok: true, thread: data });
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: String(e?.message || e) });
      }
    }
    const data = await readThreadData(found.path);
    if (!data) return sendJSON(res, 404, { ok: false, error: 'not found' });
    return sendJSON(res, 200, { ok: true, thread: data });
  }

  if (path === '/api/save-thread' && req.method === 'POST') {
    const body = await readBody(req);
    if (body?.track && !isSafeSegment(body.track)) return rejectBadSegment(res, 'track slug', body.track);
    if (body?.lesson && !isSafeSegment(body.lesson)) return rejectBadSegment(res, 'lesson slug', body.lesson);
    const key = `save-thread:${body?.track}:${body?.lesson}`;
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
    let s = await stat(file).catch(() => null);
    if (!s || s.isDirectory()) {
      file = join(root, 'index.html');
      s = await stat(file).catch(() => null);
    }
    const data = await readFile(file);
    // Dev server: tell the browser to revalidate every request. Without
    // this the user edits style.css / main.js, refreshes, and still sees
    // the cached old version. `no-cache` (≠ `no-store`) lets the
    // browser keep the response in its cache but forces it to ask us
    // first; we send a tiny mtime-keyed ETag and respond 304 when it's
    // unchanged so refreshes stay cheap.
    const etag = s
      ? `W/"${s.size.toString(16)}-${Math.floor(s.mtimeMs).toString(16)}"`
      : `W/"${data.length.toString(16)}"`;
    const headers = {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'ETag': etag,
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
}

// ---------- chat persistence (JSONL) ----------
// First line is a meta record {type:'meta', ...}; each subsequent line is a
// chat message {role, content, ts}. Appends are O(1) `appendFile` calls.

async function readChatJsonl(jsonlPath) {
  if (!existsSync(jsonlPath)) return { meta: null, history: [] };
  const raw = await readFile(jsonlPath, 'utf8');
  const lines = raw.split('\n');
  let meta = null;
  const history = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    if (obj.type === 'meta') meta = obj;
    else if (obj.role) history.push(obj);
  }
  return { meta, history };
}

// Write `lines` (records) to jsonl. If the file doesn't exist yet, prepend
// the result of makeMeta() as the first line — so meta+messages land in a
// single atomic appendFile call.
async function writeChatLines(jsonlPath, makeMeta, messages) {
  if (!messages.length && !makeMeta) return;
  const lines = [];
  if (!existsSync(jsonlPath)) {
    await mkdir(dirname(jsonlPath), { recursive: true });
    if (makeMeta) lines.push({ type: 'meta', ...makeMeta() });
  }
  for (const m of messages) lines.push(m);
  if (!lines.length) return;
  await appendFile(jsonlPath, lines.map((m) => JSON.stringify(m)).join('\n') + '\n');
}

// Overwrite the file with a fresh meta line + the supplied message history.
// Used by the "edit a past message → truncate & re-run" flow.
// Atomic: write to a temp file in the same dir, fsync, then rename — a
// crash mid-write can't leave the destination half-written.
async function rewriteChatLines(jsonlPath, makeMeta, messages) {
  await mkdir(dirname(jsonlPath), { recursive: true });
  const lines = [JSON.stringify({ type: 'meta', ...makeMeta() })];
  for (const m of messages) lines.push(JSON.stringify(m));
  const tmp = `${jsonlPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, lines.join('\n') + '\n');
  try {
    await rename(tmp, jsonlPath);
  } catch (e) {
    try { await unlink(tmp); } catch {}
    throw e;
  }
}

function tutorChatPath(track) {
  return join(STUDYGROUND_DIR, 'tracks', track, 'tutor-chat.jsonl');
}
function threadJsonlPath(track, id) {
  return join(trackThreadsDir(track), `${id}.jsonl`);
}

async function loadTutorChat(track) {
  const { meta, history } = await readChatJsonl(tutorChatPath(track));
  return {
    track,
    history,
    updated_at: history.length ? history[history.length - 1].ts : meta?.created_at || null,
  };
}

async function appendTutorChat(track, userMessage, answer) {
  if (!isSafeSegment(track)) throw new Error('appendTutorChat: invalid track');
  const file = tutorChatPath(track);
  const { history: existing } = await readChatJsonl(file);
  const now = new Date().toISOString();
  const msgs = [];
  if (userMessage) msgs.push({ role: 'user', content: userMessage, ts: now });
  // answer is optional: the inline-comment append endpoint persists user-only
  // turns (no Claude spawn) so the comment survives a page reload before the
  // user clicks Regenerate.
  if (answer != null) msgs.push({ role: 'assistant', content: answer, ts: now });
  // If the post-append history would exceed CHAT_HISTORY_MAX_MESSAGES, do
  // an atomic full rewrite that drops the oldest entries. The normal case
  // stays a cheap appendFile.
  const projectedLen = existing.length + msgs.length;
  if (projectedLen > CHAT_HISTORY_MAX_MESSAGES) {
    const trimmed = capChatHistory([...existing, ...msgs]);
    await rewriteChatLines(file, () => ({ kind: 'tutor', track, created_at: now }), trimmed);
  } else {
    await writeChatLines(file, () => ({ kind: 'tutor', track, created_at: now }), capChatHistory(msgs));
  }
  return loadTutorChat(track);
}

async function persistThread({ id, track, lesson, selection, question, answer }) {
  if (!track) throw new Error('persistThread requires track');
  await mkdir(trackThreadsDir(track), { recursive: true });
  const file = threadJsonlPath(track, id);
  const now = new Date().toISOString();
  await writeChatLines(
    file,
    () => ({ kind: 'btw', id, track, lesson, selection, created_at: now }),
    [
      { role: 'user', content: question, ts: now },
      { role: 'assistant', content: answer, ts: now },
    ],
  );
  return readThreadData(file);
}

async function readThreadData(jsonlPath) {
  const { meta, history } = await readChatJsonl(jsonlPath);
  if (!meta && !history.length) return null;
  return {
    id: meta?.id,
    track: meta?.track,
    lesson: meta?.lesson,
    selection: meta?.selection || '',
    name: meta?.name || '',
    history,
    created_at: meta?.created_at,
    updated_at: history.length ? history[history.length - 1].ts : meta?.created_at,
  };
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

// Find a thread file across all tracks (used when client doesn't know track).
// Returns { path, track } where `path` is the .jsonl file.
async function findThreadFile(id) {
  const tracksRoot = join(STUDYGROUND_DIR, 'tracks');
  const subs = await readdir(tracksRoot, { withFileTypes: true }).catch(() => []);
  for (const s of subs) {
    if (!s.isDirectory()) continue;
    const jsonl = join(trackThreadsDir(s.name), `${id}.jsonl`);
    if (existsSync(jsonl)) return { path: jsonl, track: s.name };
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
        emoji: '📜',
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
// Find a free filename in `dir` by appending " (N)" before the extension.
// Examples: "test.md" → "test (2).md" if taken; "README" → "README (2)".
async function uniqueFilename(dir, name) {
  if (!existsSync(join(dir, name))) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}

async function listMaterials(slug) {
  // Materials manifest (pages / approx_tokens / status) merged with on-disk
  // stat info. Hidden files (.text/, INDEX.md) are excluded by the helper.
  return await listMaterialsWithStats({ studygroundDir: STUDYGROUND_DIR, slug });
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
    const readOne = async (jsonlPath) => {
      const data = await readThreadData(jsonlPath);
      if (!data) return;
      if (lesson && data.lesson !== lesson) return;
      out.push({
        id: data.id,
        track: data.track || t,
        lesson: data.lesson,
        selection: data.selection,
        name: data.name || '',
        first_question: data.history?.find((m) => m.role === 'user')?.content || '',
        updated_at: data.updated_at,
        created_at: data.created_at,
        turns: Math.floor((data.history?.length || 0) / 2),
      });
    };
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      await readOne(join(dir, f));
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

// Wire materials orchestrator events into the SSE channel so the web UI can
// reflect extraction progress in real time.
onMaterialEvent((ev) => broadcast(ev));

// Fire-and-forget reconcile: bring every track's text mirrors + indices up to
// date with the on-disk materials/. Cheap when everything matches; only does
// real work when files were dropped in externally or extraction failed last
// run.
reconcileAll({ studygroundDir: STUDYGROUND_DIR }).catch((e) =>
  console.warn('[materials] boot reconcile failed:', e?.message),
);

startWatcher(STUDYGROUND_DIR, broadcast);

createServer(handle).listen(PORT, () => {
  console.log(`studyground reader at http://localhost:${PORT}`);
  console.log(`watching ${STUDYGROUND_DIR}`);
});
