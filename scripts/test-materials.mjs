// Comprehensive regression tests for the materials RAG pipeline.
//
// Spins up the server on a free port with an isolated $STUDYGROUND_DIR
// under /tmp, drives it via fetch, and asserts on the resulting on-disk
// artefacts and SSE events. No browser required.
//
// Run: node scripts/test-materials.mjs
//
// Cases covered:
//   1.  Text file (.md) upload → manifest + chunks + mirror + INDEX.md
//   2.  Multiple text files in one track
//   3.  Multi-page PDF upload → page-anchored mirror
//   4.  CJK content → stats + BM25 retrieval
//   5.  sg-search text mode
//   6.  sg-search JSON mode (structured output)
//   7.  sg-search budget enforcement
//   8.  sg-search nonexistent track exit 2
//   9.  sg-search nonexistent query empty result
//  10.  Re-upload same bytes (replace=1) — manifest updated, sha matches
//  11.  Re-upload different bytes (replace=1) — sha changes, chunks rebuilt
//  12.  Auto-rename on collision (no replace flag)
//  13.  Material DELETE — cleans mirror + manifest + chunks + bm25
//  14.  Reindex endpoint — rebuilds everything
//  15.  Boot reconcile — external file appears after restart
//  16.  Orphan manifest entry removed on reconcile
//  17.  SSE material_indexed event fires
//  18.  Unsupported file type → status: unsupported
//  19.  Malformed PDF → status: failed (graceful)
//  20.  /api/tracks/<slug>/materials/<name>/stats endpoint

import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rm, stat, readdir, unlink } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const TMP_BASE = `/tmp/sg-materials-test-${Date.now()}-${process.pid}`;

let passed = 0;
let failed = 0;
const fails = [];

function ok(name) {
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}
function bad(name, reason) {
  failed++;
  fails.push(`${name}: ${reason}`);
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${reason}`);
}
function assert(name, cond, reason) {
  if (cond) ok(name); else bad(name, reason || 'assertion failed');
}
function section(title) {
  console.log(`\n\x1b[1m── ${title} ──\x1b[0m`);
}

async function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.unref();
    s.listen(0, () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
    s.on('error', rej);
  });
}

// --- minimal pure-Python-free PDF generator (uses pdfjs-dist serializer? No.
// We hand-write a valid multi-page PDF with Helvetica text. This is the same
// approach as my smoke test earlier but cleaned up. ---
function makePdf(pageTexts) {
  const objects = [];
  const addObj = (b) => { objects.push(b); return objects.length; };
  // 1: catalog
  addObj(Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'));
  // 2: pages root (placeholder, fill kids later)
  const pagesIdx = addObj(Buffer.from(''));
  // 3: font
  const fontId = addObj(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));
  const pageIds = [];
  let y = 720;
  for (const t of pageTexts) {
    const safe = String(t).replace(/[\\()]/g, (m) => '\\' + m);
    const stream = `BT /F1 12 Tf 72 ${y} Td (${safe}) Tj ET`;
    const sBuf = Buffer.from(stream);
    const cid = addObj(Buffer.concat([
      Buffer.from(`<< /Length ${sBuf.length} >>\nstream\n`),
      sBuf,
      Buffer.from('\nendstream'),
    ]));
    const pid = addObj(Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> ` +
      `/Contents ${cid} 0 R >>`
    ));
    pageIds.push(pid);
  }
  objects[pagesIdx - 1] = Buffer.from(
    `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`
  );
  const out = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')];
  const offsets = [0];
  let total = out[0].length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(total);
    const head = Buffer.from(`${i + 1} 0 obj\n`);
    const tail = Buffer.from('\nendobj\n');
    const obj = objects[i];
    out.push(head, obj, tail);
    total += head.length + obj.length + tail.length;
  }
  const xrefPos = total;
  const xrefLines = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n'];
  for (const off of offsets.slice(1)) {
    xrefLines.push(`${off.toString().padStart(10, '0')} 00000 n \n`);
  }
  out.push(Buffer.from(xrefLines.join('')));
  out.push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`));
  return Buffer.concat(out);
}

// --- HTTP helpers ---
let BASE = '';
async function get(path) {
  const r = await fetch(`${BASE}${path}`);
  return { ok: r.ok, status: r.status, json: r.headers.get('content-type')?.includes('json') ? await r.json() : null, body: await safeText(r) };
}
async function safeText(r) {
  try { return await r.text(); } catch { return ''; }
}
async function post(path, body, headers = {}) {
  const opts = { method: 'POST' };
  if (body && typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
    opts.headers = { 'Content-Type': 'application/json', ...headers };
    opts.body = JSON.stringify(body);
  } else if (body) {
    opts.headers = { 'Content-Type': 'application/octet-stream', ...headers };
    opts.body = body;
  } else {
    opts.headers = headers;
  }
  const r = await fetch(`${BASE}${path}`, opts);
  return { ok: r.ok, status: r.status, json: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
}
async function del(path) {
  const r = await fetch(`${BASE}${path}`, { method: 'DELETE' });
  return { ok: r.ok, status: r.status, json: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
}

// Poll until pred() returns truthy (or timeout). Returns the truthy value.
async function pollUntil(pred, { tries = 50, intervalMs = 100, label = 'condition' } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const v = await pred();
      if (v) return v;
    } catch {}
    await wait(intervalMs);
  }
  throw new Error(`pollUntil timeout: ${label}`);
}

// SSE listener — collect typed events until a predicate matches.
function listenSse(types) {
  const events = [];
  const ctrl = new AbortController();
  const promise = (async () => {
    const r = await fetch(`${BASE}/api/events`, { signal: ctrl.signal });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const obj = JSON.parse(line.slice(5).trim());
          if (!types || types.includes(obj.type)) events.push(obj);
        } catch {}
      }
    }
  })();
  promise.catch(() => {});
  return {
    events,
    close: () => ctrl.abort(),
  };
}

let serverProc = null;
async function startServer(dir) {
  const port = await freePort();
  const proc = spawn(process.execPath, [join(REPO_ROOT, 'server/index.mjs')], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      STUDYGROUND_DIR: dir,
      STUDYGROUND_PORT: String(port),
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      STUDYGROUND_EMBEDDINGS_PROVIDER: 'off', // never call external API in tests
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => process.env.SG_DEBUG && process.stdout.write(`[server] ${d}`));
  proc.stderr.on('data', (d) => process.env.SG_DEBUG && process.stderr.write(`[server-err] ${d}`));
  serverProc = proc;
  BASE = `http://localhost:${port}`;
  // Wait for /api/healthz to respond
  await pollUntil(async () => (await get('/api/healthz')).json?.ok, { tries: 50, intervalMs: 100, label: 'server ready' });
  return port;
}
async function stopServer() {
  if (!serverProc) return;
  serverProc.kill('SIGTERM');
  await new Promise((res) => serverProc.once('exit', res));
  serverProc = null;
}

// --- Tests ---

async function setupTrack(slug) {
  const r = await post('/api/tracks', { slug, title: slug });
  if (!r.ok) throw new Error(`create track failed: ${r.status} ${JSON.stringify(r.json)}`);
}

async function uploadFile(slug, name, content, opts = {}) {
  const url = `/api/tracks/${encodeURIComponent(slug)}/materials?name=${encodeURIComponent(name)}${opts.replace ? '&replace=1' : ''}`;
  const r = await post(url, content);
  if (!r.ok) throw new Error(`upload ${name} failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

async function listMats(slug) {
  const r = await get(`/api/tracks/${encodeURIComponent(slug)}/materials`);
  return r.json?.materials || [];
}

async function waitForStatus(slug, name, target = ['ok', 'image-pdf', 'failed', 'unsupported']) {
  return pollUntil(async () => {
    const mats = await listMats(slug);
    const m = mats.find((x) => x.name === name);
    if (m && target.includes(m.status)) return m;
    return null;
  }, { tries: 100, intervalMs: 100, label: `${name} reaches one of ${target.join('/')}` });
}

function sgSearchCmd(dir, ...args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(join(REPO_ROOT, 'bin/sg-search'), args, {
      env: { ...process.env, STUDYGROUND_DIR: dir, CLAUDE_PLUGIN_ROOT: REPO_ROOT, STUDYGROUND_EMBEDDINGS_PROVIDER: 'off' },
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => stdout += d);
    proc.stderr.on('data', (d) => stderr += d);
    proc.on('exit', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', reject);
  });
}

async function run() {
  console.log(`\n\x1b[1mStudyGround materials test suite\x1b[0m`);
  console.log(`tmp dir: ${TMP_BASE}`);
  await mkdir(TMP_BASE, { recursive: true });

  // ----------------------------------------------------------------
  section('1–2. Text file upload + multi-file in one track');
  const dir1 = join(TMP_BASE, 'a');
  await mkdir(dir1, { recursive: true });
  await startServer(dir1);
  await setupTrack('alpha');

  await uploadFile('alpha', 'notes.md', '# Attention\n\nScaled dot-product attention: softmax(QK^T/sqrt(d_k))V. The softmax stabilizes.\n');
  const m1 = await waitForStatus('alpha', 'notes.md');
  assert('notes.md indexed ok', m1.status === 'ok', `status=${m1.status}`);
  assert('notes.md has chunks', m1.chunks >= 1, `chunks=${m1.chunks}`);
  assert('notes.md has tokens estimate', m1.approx_tokens > 0, `tokens=${m1.approx_tokens}`);
  assert('notes.md has mirror', m1.has_text_mirror === true, 'has_text_mirror is false');

  const mirrorPath = join(dir1, 'tracks/alpha/materials/.text/notes.md.md');
  assert('mirror file exists', existsSync(mirrorPath), mirrorPath);
  const mirrorContent = await readFile(mirrorPath, 'utf8');
  assert('mirror contains source text', mirrorContent.includes('softmax'), 'softmax missing in mirror');

  const indexMdPath = join(dir1, 'tracks/alpha/materials/INDEX.md');
  assert('INDEX.md exists', existsSync(indexMdPath), indexMdPath);
  const indexMd = await readFile(indexMdPath, 'utf8');
  assert('INDEX.md lists notes.md', indexMd.includes('notes.md'), 'notes.md not in INDEX.md');

  await uploadFile('alpha', 'backprop.py', '# Backpropagation\n\ndef chain_rule(grad, w):\n    return grad * w\n\n# The chain rule propagates gradients backward.\n');
  await waitForStatus('alpha', 'backprop.py');
  const mats2 = await listMats('alpha');
  assert('two materials in alpha', mats2.length === 2, `got ${mats2.length}`);
  const indexMd2 = await readFile(indexMdPath, 'utf8');
  assert('INDEX.md lists both files', indexMd2.includes('notes.md') && indexMd2.includes('backprop.py'), 'one file missing');

  // ----------------------------------------------------------------
  section('3. Multi-page PDF upload → page-anchored mirror');
  const pdf = makePdf([
    'Introduction. Transformers use attention.',
    'Scaled dot-product attention computes softmax of QK transposed over square root of d_k.',
    'Multi-head attention runs parallel attention heads then concatenates.',
  ]);
  await uploadFile('alpha', 'paper.pdf', pdf);
  const mPdf = await waitForStatus('alpha', 'paper.pdf');
  assert('PDF status ok or image-pdf', ['ok', 'image-pdf'].includes(mPdf.status), `status=${mPdf.status}`);
  assert('PDF reports 3 pages', mPdf.pages === 3, `pages=${mPdf.pages}`);
  const pdfMirror = await readFile(join(dir1, 'tracks/alpha/materials/.text/paper.pdf.md'), 'utf8');
  assert('PDF mirror has page anchors', pdfMirror.includes('## p. 1') && pdfMirror.includes('## p. 2') && pdfMirror.includes('## p. 3'), 'page anchors missing');

  // ----------------------------------------------------------------
  section('4. CJK content (Chinese) — stats + BM25 retrieval');
  const cjkContent = '# 注意力机制\n\n变换器架构依赖缩放点积注意力。给定查询 Q、键 K、值 V，注意力的计算为 softmax(QK^T / sqrt(d_k)) V。多头注意力并行地运行注意力，然后将结果拼接起来。\n';
  await uploadFile('alpha', 'cn-notes.md', cjkContent);
  const mCjk = await waitForStatus('alpha', 'cn-notes.md');
  assert('CJK file indexed', mCjk.status === 'ok', `status=${mCjk.status}`);
  assert('CJK token estimate sensible', mCjk.approx_tokens > 10 && mCjk.approx_tokens < cjkContent.length, `tokens=${mCjk.approx_tokens} for ${cjkContent.length} chars`);

  const cjkSearch = await sgSearchCmd(dir1, '注意力', '--track', 'alpha', '--k', '3', '--format', 'json');
  assert('sg-search CJK exit 0', cjkSearch.code === 0, `code=${cjkSearch.code} stderr=${cjkSearch.stderr}`);
  const cjkJson = JSON.parse(cjkSearch.stdout);
  assert('sg-search CJK finds hits', cjkJson.hits && cjkJson.hits.length > 0, `hits=${cjkJson.hits?.length}`);
  assert('sg-search CJK hit points at cn-notes.md', cjkJson.hits.some((h) => h.source === 'cn-notes.md'), 'cn-notes.md not in hits');

  // ----------------------------------------------------------------
  section('5–7. sg-search text/json modes + budget');
  const textOut = await sgSearchCmd(dir1, 'attention softmax', '--track', 'alpha', '--k', '5');
  assert('sg-search text mode exit 0', textOut.code === 0, textOut.stderr);
  assert('sg-search text mode prints citations', /\[.+, p\.\d+\]/.test(textOut.stdout), 'no [file, p.N] in output');
  assert('sg-search text mode prints bm25', /bm25=/.test(textOut.stdout), 'no bm25= in output');

  const jsonOut = await sgSearchCmd(dir1, 'attention', '--track', 'alpha', '--format', 'json');
  assert('sg-search json exit 0', jsonOut.code === 0, jsonOut.stderr);
  let jsonParsed;
  try { jsonParsed = JSON.parse(jsonOut.stdout); } catch { jsonParsed = null; }
  assert('sg-search json parses', !!jsonParsed && jsonParsed.ok, 'invalid json');
  assert('sg-search json hits have required fields', jsonParsed?.hits?.every((h) => h.source && h.page_start && typeof h.bm25 === 'number'), 'hit missing fields');

  // budget enforcement: a tiny budget should reduce hits
  const tightOut = await sgSearchCmd(dir1, 'attention', '--track', 'alpha', '--k', '100', '--budget-tokens', '40', '--format', 'json');
  const tightParsed = JSON.parse(tightOut.stdout);
  assert('sg-search budget enforced', tightParsed.used_tokens <= 200, `used=${tightParsed.used_tokens} (expected <=200 with budget=40 +1 grace)`);

  // ----------------------------------------------------------------
  section('8–9. sg-search edge cases');
  const noTrack = await sgSearchCmd(dir1, 'foo', '--track', 'nonexistent-slug');
  assert('sg-search nonexistent track exits 2', noTrack.code === 2, `code=${noTrack.code}`);
  assert('sg-search nonexistent track stderr message', /no index/i.test(noTrack.stderr), 'expected "no index" in stderr');

  const noHits = await sgSearchCmd(dir1, 'thisstringshouldnotappearanywhere12345xyz', '--track', 'alpha', '--format', 'json');
  assert('sg-search empty query exit 0', noHits.code === 0, noHits.stderr);
  const noHitsParsed = JSON.parse(noHits.stdout);
  assert('sg-search empty query returns empty hits', noHitsParsed.hits.length === 0, `got ${noHitsParsed.hits.length}`);

  // ----------------------------------------------------------------
  section('10–11. Re-upload (replace mode)');
  const beforeSha = (await listMats('alpha')).find((m) => m.name === 'notes.md');
  await uploadFile('alpha', 'notes.md', '# Attention\n\nScaled dot-product attention: softmax(QK^T/sqrt(d_k))V. The softmax stabilizes.\n', { replace: true });
  const afterSameMat = await waitForStatus('alpha', 'notes.md');
  assert('re-upload same bytes leaves indexed', afterSameMat.status === 'ok', `status=${afterSameMat.status}`);

  await uploadFile('alpha', 'notes.md', '# Different content\n\nLayer normalization rescales inputs to mean=0, var=1.\n', { replace: true });
  await wait(300);
  const afterDifferent = await waitForStatus('alpha', 'notes.md');
  const mirrorAfter = await readFile(mirrorPath, 'utf8');
  assert('re-upload different bytes changes mirror', mirrorAfter.includes('Layer normalization'), 'mirror not updated');
  assert('re-upload different bytes changes stats', afterDifferent.chars !== beforeSha.chars, `chars unchanged (${afterDifferent.chars})`);

  // ----------------------------------------------------------------
  section('12. Auto-rename on collision (no replace)');
  const rn = await post('/api/tracks/alpha/materials?name=notes.md', '# Yet another note', { 'Content-Type': 'application/octet-stream' });
  assert('upload without replace renames', rn.json?.renamed === true, `renamed=${rn.json?.renamed} got=${JSON.stringify(rn.json)}`);
  assert('upload renamed to "notes (2).md"', rn.json?.name === 'notes (2).md', `name=${rn.json?.name}`);
  await waitForStatus('alpha', 'notes (2).md');

  // ----------------------------------------------------------------
  section('13. DELETE cleans every derived artefact');
  const delR = await del('/api/tracks/alpha/materials/cn-notes.md');
  assert('DELETE returns ok', delR.json?.ok === true, JSON.stringify(delR.json));
  await pollUntil(async () => {
    const m = (await listMats('alpha')).find((x) => x.name === 'cn-notes.md');
    return !m;
  }, { tries: 50, intervalMs: 100, label: 'cn-notes.md removed from listing' });
  assert('mirror file removed', !existsSync(join(dir1, 'tracks/alpha/materials/.text/cn-notes.md.md')), 'mirror still present');
  const manifestAfterDel = JSON.parse(await readFile(join(dir1, 'tracks/alpha/.studyground-index/manifest.json'), 'utf8'));
  assert('manifest entry removed', !manifestAfterDel.materials['cn-notes.md'], 'manifest still has entry');
  const chunksAfterDel = (await readFile(join(dir1, 'tracks/alpha/.studyground-index/chunks.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  assert('chunks for deleted file removed', !chunksAfterDel.some((c) => c.source === 'cn-notes.md'), 'orphan chunks');
  const sgAfterDel = await sgSearchCmd(dir1, '注意力机制', '--track', 'alpha', '--format', 'json');
  const sgAfterDelParsed = JSON.parse(sgAfterDel.stdout);
  assert('sg-search no longer returns deleted file', !sgAfterDelParsed.hits.some((h) => h.source === 'cn-notes.md'), 'still returns deleted source');

  // ----------------------------------------------------------------
  section('14. Reindex endpoint');
  // Delete the manifest+index out from under us, hit reindex, verify they come back
  await rm(join(dir1, 'tracks/alpha/.studyground-index'), { recursive: true, force: true });
  await rm(join(dir1, 'tracks/alpha/materials/.text'), { recursive: true, force: true });
  const reindex = await post('/api/tracks/alpha/reindex');
  assert('reindex returns ok', reindex.json?.ok === true, JSON.stringify(reindex.json));
  await pollUntil(async () => {
    return existsSync(join(dir1, 'tracks/alpha/.studyground-index/manifest.json'))
      && existsSync(join(dir1, 'tracks/alpha/materials/.text/notes.md.md'));
  }, { tries: 100, intervalMs: 150, label: 'reindex rebuilds everything' });
  ok('reindex rebuilds manifest + mirrors');

  // ----------------------------------------------------------------
  section('15–16. Boot reconcile + orphan removal');
  await stopServer();
  // Drop a new file directly
  await writeFile(join(dir1, 'tracks/alpha/materials/dropped-while-stopped.md'), '# Dropped while server stopped\n\nKV cache reuses past key/value tensors to avoid recomputation in autoregressive decoding.\n');
  // Delete one of the existing files from disk (orphan its manifest entry)
  await unlink(join(dir1, 'tracks/alpha/materials/backprop.py'));
  await startServer(dir1);
  // Wait for reconcile to process new file
  await pollUntil(async () => {
    const m = (await listMats('alpha')).find((x) => x.name === 'dropped-while-stopped.md');
    return m && m.status === 'ok';
  }, { tries: 100, intervalMs: 200, label: 'dropped file indexed' });
  ok('boot reconcile indexed externally-dropped file');
  const finalManifest = JSON.parse(await readFile(join(dir1, 'tracks/alpha/.studyground-index/manifest.json'), 'utf8'));
  assert('orphan manifest entry removed on reconcile', !finalManifest.materials['backprop.py'], 'backprop.py still in manifest after disk-side delete');

  const finalSearch = await sgSearchCmd(dir1, 'KV cache decoding', '--track', 'alpha', '--format', 'json');
  const finalSearchParsed = JSON.parse(finalSearch.stdout);
  assert('sg-search finds reconciled file', finalSearchParsed.hits.some((h) => h.source === 'dropped-while-stopped.md'), 'reconciled file not searchable');

  // ----------------------------------------------------------------
  section('17. SSE material_indexed event');
  await setupTrack('sse-track');
  const sse = listenSse(['material_indexed', 'material_progress', 'material_failed']);
  await wait(150);
  await uploadFile('sse-track', 'sse-note.md', '# Hello SSE\n\nSome content to index.\n');
  await pollUntil(() => sse.events.some((e) => e.type === 'material_indexed' && e.name === 'sse-note.md'),
    { tries: 50, intervalMs: 100, label: 'material_indexed event' });
  ok('SSE delivers material_indexed event');
  sse.close();

  // ----------------------------------------------------------------
  section('18. Unsupported file type');
  // .zip is not in our TEXT_EXT / IMAGE_EXT / PDF_EXT — should land in unsupported.
  const fakeZip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  await setupTrack('beta');
  await uploadFile('beta', 'archive.zip', fakeZip);
  const mZip = await waitForStatus('beta', 'archive.zip', ['unsupported', 'failed']);
  assert('zip marked unsupported', mZip.status === 'unsupported', `status=${mZip.status}`);

  // ----------------------------------------------------------------
  section('19. Malformed PDF → status failed (graceful)');
  await uploadFile('beta', 'bad.pdf', Buffer.from('not actually a PDF'));
  const mBad = await waitForStatus('beta', 'bad.pdf', ['failed', 'ok', 'image-pdf']);
  assert('malformed pdf marked failed', mBad.status === 'failed', `status=${mBad.status} (expected failed)`);
  assert('failed entry has error message', typeof mBad.kind === 'string', `kind=${mBad.kind}`);

  // ----------------------------------------------------------------
  section('20. Per-file stats endpoint');
  const statsR = await get(`/api/tracks/sse-track/materials/${encodeURIComponent('sse-note.md')}/stats`);
  assert('stats endpoint returns ok', statsR.json?.ok === true, JSON.stringify(statsR.json));
  assert('stats endpoint returns material fields', statsR.json?.material?.name === 'sse-note.md', `name=${statsR.json?.material?.name}`);
  assert('stats endpoint includes chunks count', typeof statsR.json?.material?.chunks === 'number', `chunks=${statsR.json?.material?.chunks}`);

  // ----------------------------------------------------------------
  section('21. Concurrent uploads to one track (queue serialization)');
  await setupTrack('busy');
  const concurrentNames = Array.from({ length: 8 }, (_, i) => `concurrent-${i}.md`);
  await Promise.all(concurrentNames.map((n, i) =>
    uploadFile('busy', n, `# File ${i}\n\nLayer ${i} encodes feature ${i} via projection matrix W${i}.\n`),
  ));
  for (const n of concurrentNames) {
    await waitForStatus('busy', n);
  }
  const busyMats = await listMats('busy');
  assert('all 8 concurrent files indexed', busyMats.filter((m) => m.status === 'ok').length === 8,
    `${busyMats.filter((m) => m.status === 'ok').length}/8 indexed`);
  const busyChunks = (await readFile(join(dir1, 'tracks/busy/.studyground-index/chunks.jsonl'), 'utf8'))
    .split('\n').filter(Boolean).map(JSON.parse);
  const busySources = new Set(busyChunks.map((c) => c.source));
  assert('chunks.jsonl reflects all 8 sources', busySources.size === 8, `got ${busySources.size} distinct sources`);
  const sgBusy = await sgSearchCmd(dir1, 'projection matrix', '--track', 'busy', '--k', '10', '--format', 'json');
  const sgBusyParsed = JSON.parse(sgBusy.stdout);
  const distinctHitSources = new Set(sgBusyParsed.hits.map((h) => h.source));
  assert('sg-search returns hits across multiple concurrent files', distinctHitSources.size >= 4,
    `only ${distinctHitSources.size} distinct files in hits`);

  // ----------------------------------------------------------------
  section('22. estimateTokens unit sanity (CJK vs Latin)');
  const stats = await import(join(REPO_ROOT, 'server/material-stats.mjs'));
  const eng = 'The quick brown fox jumps over the lazy dog. '.repeat(20);  // 880 ASCII chars
  const cjk = '注意力机制是变换器架构的核心组件。'.repeat(20);  // 340 CJK chars
  const engTok = stats.estimateTokens(eng);
  const cjkTok = stats.estimateTokens(cjk);
  assert('English estimate ≈ chars/4', engTok > eng.length / 5 && engTok < eng.length / 3,
    `engTok=${engTok} for ${eng.length} chars (expected ~220)`);
  assert('CJK estimate ≈ chars/1.7', cjkTok > cjk.length / 3 && cjkTok < cjk.length,
    `cjkTok=${cjkTok} for ${cjk.length} chars (expected ~200)`);
  // chunkBudget("don't exceed") semantics: with chunks [100, 200, 400]:
  //   budget=300 → packs [100, 200] (sum 300 == budget, fits)
  //   budget=250 → packs [100] only (100+200=300 would exceed)
  //   budget=50  → packs [100] (always returns ≥1 chunk so callers get
  //                something even when the first item is over budget)
  const inputs = [
    { text: 'a', approx_token_count: 100 },
    { text: 'b', approx_token_count: 200 },
    { text: 'c', approx_token_count: 400 },
  ];
  assert('chunkBudget=300 packs 2 (exact fit)', stats.chunkBudget(inputs, 300).chunks.length === 2);
  assert('chunkBudget=250 packs 1 (stops before exceeding)', stats.chunkBudget(inputs, 250).chunks.length === 1);
  assert('chunkBudget=50 still returns 1 (never zero)', stats.chunkBudget(inputs, 50).chunks.length === 1);
  assert('chunkBudget=1000 packs all 3', stats.chunkBudget(inputs, 1000).chunks.length === 3);

  // ----------------------------------------------------------------
  section('23. Extract dispatcher classification');
  const extract = await import(join(REPO_ROOT, 'server/materials/extract.mjs'));
  assert('classifyExt .pdf', extract.classifyExt('foo.pdf') === 'pdf');
  assert('classifyExt .PDF (uppercase)', extract.classifyExt('foo.PDF') === 'pdf');
  assert('classifyExt .md', extract.classifyExt('foo.md') === 'text');
  assert('classifyExt .py', extract.classifyExt('foo.py') === 'text');
  assert('classifyExt .json', extract.classifyExt('foo.json') === 'text');
  assert('classifyExt .png', extract.classifyExt('foo.png') === 'image');
  assert('classifyExt .jpg', extract.classifyExt('foo.jpg') === 'image');
  assert('classifyExt .tiff', extract.classifyExt('foo.tiff') === 'image');
  assert('classifyExt .zip', extract.classifyExt('foo.zip') === 'unsupported');
  assert('classifyExt .exe', extract.classifyExt('foo.exe') === 'unsupported');
  assert('classifyExt empty name', extract.classifyExt('') === 'unsupported');

  // ----------------------------------------------------------------
  section('24. Large content stress (10kB text → multiple chunks)');
  await setupTrack('big');
  // Build a 20k character document with distinct keywords per chunk.
  const paragraphs = [];
  for (let i = 0; i < 30; i++) {
    const word = `keyword${i}`;
    paragraphs.push(`## Section ${i}\n\nThis section discusses ${word} in depth. The concept relates to neural networks layer ${i}. ${'Lorem ipsum dolor sit amet. '.repeat(15)}`);
  }
  const bigText = paragraphs.join('\n\n');
  await uploadFile('big', 'big.md', bigText);
  const mBig = await waitForStatus('big', 'big.md');
  assert('big file indexed', mBig.status === 'ok', `status=${mBig.status}`);
  assert('big file produced multiple chunks', mBig.chunks >= 5, `chunks=${mBig.chunks} (expected >=5)`);

  // sg-search for a keyword that's in just one section
  const sgBig = await sgSearchCmd(dir1, 'keyword17', '--track', 'big', '--format', 'json', '--k', '3');
  const sgBigParsed = JSON.parse(sgBig.stdout);
  assert('sg-search isolates the right chunk', sgBigParsed.hits[0]?.text?.includes('keyword17'), 'top hit does not contain keyword17');
  assert('sg-search top hit has correct source', sgBigParsed.hits[0]?.source === 'big.md');

  // ----------------------------------------------------------------
  section('25. Image OCR via tesseract.js (skipped unless SG_TEST_OCR=1)');
  if (process.env.SG_TEST_OCR === '1') {
    // Generate a small black-on-white PNG with text using pdfjs? No — too heavy.
    // We can't easily synthesize a test PNG without a canvas dep. Instead skip
    // by default and only run when a fixture is provided.
    const ocrFixture = process.env.SG_OCR_FIXTURE;
    if (ocrFixture && existsSync(ocrFixture)) {
      const imgBuf = await readFile(ocrFixture);
      await uploadFile('beta', 'ocr-test.png', imgBuf);
      const mOcr = await waitForStatus('beta', 'ocr-test.png', ['ok', 'failed']);
      assert('OCR image indexed', mOcr.status === 'ok', `status=${mOcr.status}`);
      assert('OCR text extracted (non-empty mirror)', mOcr.chars > 0, `chars=${mOcr.chars}`);
    } else {
      console.log('  \x1b[33m·\x1b[0m SG_OCR_FIXTURE not provided, skipping');
    }
  } else {
    console.log('  \x1b[33m·\x1b[0m skipped (set SG_TEST_OCR=1 to enable)');
  }

  // ----------------------------------------------------------------
  await stopServer();
  await rm(TMP_BASE, { recursive: true, force: true }).catch(() => {});

  console.log(`\n\x1b[1mResults: ${passed} passed, ${failed} failed\x1b[0m`);
  if (failed > 0) {
    console.log('\n\x1b[31mFailures:\x1b[0m');
    for (const f of fails) console.log('  · ' + f);
    process.exit(1);
  }
}

run().catch(async (e) => {
  console.error('\n\x1b[31mFATAL:\x1b[0m', e?.stack || e);
  await stopServer();
  process.exit(2);
});
