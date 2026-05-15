// Regression: when a material file is removed from disk outside the UI
// (e.g. `rm tracks/<slug>/materials/<file>`), the reconciler should drop the
// matching .text mirror, manifest entry, chunks, bm25, and INDEX.md row. We
// also sweep orphan mirrors whose manifest entry never existed (covers the
// "manifest was wiped while a mirror persisted" corner).

import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const REPO = resolve(import.meta.dirname, '..');
const PORT = 4400 + Math.floor(Math.random() * 100);
const SG_DIR = await mkdtemp(join(tmpdir(), 'sg-orphan-'));

function startServer() {
  return new Promise((res, rej) => {
    const child = spawn(join(REPO, 'bin/studyground'), ['serve'], {
      cwd: REPO,
      env: { ...process.env, STUDYGROUND_DIR: SG_DIR, STUDYGROUND_PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const t = setTimeout(() => rej(new Error('server start timeout')), 15000);
    child.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      if (s.includes('reader at') || s.includes('listening')) {
        clearTimeout(t);
        res(child);
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', rej);
  });
}

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok, info });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}`, name, info);
}

// Seed track skeleton.
await mkdir(join(SG_DIR, 'tracks', 'orph', 'materials'), { recursive: true });
await writeFile(
  join(SG_DIR, 'tracks', 'orph', 'track.json'),
  JSON.stringify({ slug: 'orph', title: 'Orph', emoji: '🧪', created_at: '2026-05-15T00:00:00Z', updated_at: '2026-05-15T00:00:00Z' }, null, 2),
);

const child = await startServer();
const matDir = join(SG_DIR, 'tracks', 'orph', 'materials');
const textDir = join(matDir, '.text');

try {
  // Upload a material via the API; the orchestrator writes the mirror + index.
  await fetch(`http://localhost:${PORT}/api/tracks/orph/materials?name=alpha.txt`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'alpha body for the mirror',
  });
  // Poll until the mirror lands (extractor runs async).
  let mirrorAt = '';
  for (let i = 0; i < 30 && !mirrorAt; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const files = await readdir(textDir).catch(() => []);
    if (files.includes('alpha.txt.md')) mirrorAt = join(textDir, 'alpha.txt.md');
  }
  check('mirror written by upload', !!mirrorAt, mirrorAt);

  // Now remove the source externally and wait for the watcher → debounced
  // reconcile to fire (server uses 800ms debounce).
  await rm(join(matDir, 'alpha.txt'));
  let cleaned = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const files = await readdir(textDir).catch(() => []);
    if (!files.includes('alpha.txt.md')) { cleaned = true; break; }
  }
  check('mirror cleaned by reconcile after external rm', cleaned);
  // INDEX.md regen may lag the mirror unlink slightly under load — poll the
  // same way so the assertion doesn't race the reconcile pipeline.
  let idxCleaned = false;
  let idx = '';
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    idx = await readFile(join(matDir, 'INDEX.md'), 'utf8').catch(() => '');
    if (!idx.includes('alpha.txt')) { idxCleaned = true; break; }
  }
  check('INDEX.md no longer mentions alpha.txt', idxCleaned, idx.slice(0, 200));

  // Corner case: simulate a stale orphan with no manifest entry. Write a
  // mirror file directly, then restart the server (boot reconcileAll sweeps).
  await writeFile(join(textDir, 'ghost.pdf.md'), '# ghost\n\nleftover content\n');
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
  const child2 = await startServer();
  try {
    // Boot reconcile is async; wait a moment.
    await new Promise((r) => setTimeout(r, 1500));
    const files = await readdir(textDir).catch(() => []);
    check('boot reconcile prunes orphan mirror with no source', !files.includes('ghost.pdf.md'), `mirror dir: ${files.join(',')}`);
  } finally {
    child2.kill();
  }
} catch (e) {
  check('test run', false, e.message);
} finally {
  try { child.kill(); } catch {}
  await rm(SG_DIR, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('FAILED:', failed.map((f) => f.name).join(', '));
  process.exit(1);
}
