// Regression: lesson body + material `.md` viewer must NOT execute injected
// JavaScript. The fix in web/main.js wires DOMPurify in front of every
// md.render output. Before the fix, an `<img onerror>` in a lesson or material
// would fire on render. We probe both surfaces here.
//
// Run-pattern follows the rest of scripts/test-*.mjs: spin up a fresh
// $STUDYGROUND_DIR + own server on a random port, drive with Playwright, exit
// non-zero on any failure.

import { chromium } from 'playwright';
import { mkdtemp, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const REPO = resolve(import.meta.dirname, '..');
const PORT = 4400 + Math.floor(Math.random() * 100);
const SG_DIR = await mkdtemp(join(tmpdir(), 'sg-xss-'));

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
function record(name, ok, info = '') {
  results.push({ name, ok, info });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}`, name, info);
}

// 1. Seed track with a lesson + material containing XSS payloads.
await mkdir(join(SG_DIR, 'tracks', 'xss', 'lessons'), { recursive: true });
await mkdir(join(SG_DIR, 'tracks', 'xss', 'materials'), { recursive: true });
await mkdir(join(SG_DIR, 'memory'), { recursive: true });
await cp(join(REPO, 'templates/studyground/memory'), join(SG_DIR, 'memory'), { recursive: true, force: false });
await writeFile(
  join(SG_DIR, 'tracks', 'xss', 'track.json'),
  JSON.stringify({ slug: 'xss', title: 'XSS', emoji: '🧪', created_at: '2026-05-15T00:00:00Z', updated_at: '2026-05-15T00:00:00Z' }, null, 2),
);
await writeFile(
  join(SG_DIR, 'tracks', 'xss', 'lessons', '01-probe.md'),
  `---\nslug: 01-probe\ntitle: XSS probe\n---\n\n# XSS probe\n\n<img src=x onerror="window.__sg_xss_lesson=true">\n<script>window.__sg_xss_lesson_script=true</script>\n<a href="javascript:window.__sg_xss_lesson_link=true">click</a>\n\nend\n`,
);
await writeFile(
  join(SG_DIR, 'tracks', 'xss', 'materials', 'probe.md'),
  `# mat probe\n\n<img src=x onerror="window.__sg_xss_mat=true">\n<a href="javascript:window.__sg_xss_mat_link=true">click</a>\nend\n`,
);
await writeFile(
  join(SG_DIR, 'progress.json'),
  JSON.stringify({ current_track: 'xss', tracks: { xss: { completed: [], cursor: '01-probe' } } }, null, 2),
);

const child = await startServer();
const BASE = `http://localhost:${PORT}`;
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('  [PAGEERROR]', e.message));

try {
  // Reader: open the probe lesson and check the flags stay false.
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('a.track-card[data-slug="xss"]', { timeout: 4000 });
  await p.click('a.track-card[data-slug="xss"]');
  await p.waitForSelector('#sidebar-lessons a[data-slug="01-probe"]', { timeout: 4000 });
  await p.click('#sidebar-lessons a[data-slug="01-probe"]');
  await p.waitForTimeout(600);
  const lessonProbe = await p.evaluate(() => ({
    h1: document.querySelector('#lesson-view h1')?.textContent,
    xss_lesson: !!window.__sg_xss_lesson,
    xss_lesson_script: !!window.__sg_xss_lesson_script,
    xss_lesson_link: !!window.__sg_xss_lesson_link,
    imgs: [...document.querySelectorAll('#lesson-view img')].map((i) => ({ onerror: i.getAttribute('onerror') })),
    scripts: document.querySelectorAll('#lesson-view script').length,
    aHrefs: [...document.querySelectorAll('#lesson-view a')].map((a) => a.getAttribute('href')),
  }));
  record('lesson onerror does not fire', !lessonProbe.xss_lesson, JSON.stringify(lessonProbe.imgs));
  record('lesson script tag stripped', lessonProbe.scripts === 0);
  record('lesson javascript: href stripped', !lessonProbe.xss_lesson_link && lessonProbe.aHrefs.every((h) => !h?.startsWith('javascript:')));
  record('lesson title still renders', lessonProbe.h1 === 'XSS probe', lessonProbe.h1);

  // Material viewer: open the probe material, then re-check.
  await p.evaluate(() => { window.__sg_xss_mat = false; window.__sg_xss_mat_link = false; });
  await p.click('#sidebar-materials .material-item[data-name="probe.md"]');
  await p.waitForSelector('.material-viewer-body .material-md', { timeout: 4000 });
  await p.waitForTimeout(400);
  const matProbe = await p.evaluate(() => ({
    xss_mat: !!window.__sg_xss_mat,
    xss_mat_link: !!window.__sg_xss_mat_link,
    imgs: [...document.querySelectorAll('.material-viewer-body img')].map((i) => ({ onerror: i.getAttribute('onerror') })),
    scripts: document.querySelectorAll('.material-viewer-body script').length,
    aHrefs: [...document.querySelectorAll('.material-viewer-body a')].map((a) => a.getAttribute('href')),
    bodyText: document.querySelector('.material-viewer-body')?.textContent?.trim()?.slice(0, 80),
  }));
  record('material onerror does not fire', !matProbe.xss_mat, JSON.stringify(matProbe.imgs));
  record('material script tag stripped', matProbe.scripts === 0);
  record('material javascript: href stripped', !matProbe.xss_mat_link && matProbe.aHrefs.every((h) => !h?.startsWith('javascript:')));
  record('material body still renders text', matProbe.bodyText?.includes('mat probe'), matProbe.bodyText);
} catch (e) {
  record('test run', false, e.message);
} finally {
  await b.close();
  child.kill();
  await rm(SG_DIR, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('FAILED:', failed.map((f) => f.name).join(', '));
  process.exit(1);
}
