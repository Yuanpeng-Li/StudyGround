// Verify round-2 fixes:
//  (a) #/t/<track>/lesson/<lessonSlug> deep-link routes to the named lesson
//  (b) materials POST with colliding name auto-renames + flags renamed=true
import { chromium } from 'playwright';
import { existsSync, statSync } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:4321';

const r = [];
const pass = (n, info='') => { r.push({n, ok: true}); console.log('PASS', n, info); };
const fail = (n, info='') => { r.push({n, ok: false}); console.log('FAIL', n, info); };

// --- (a) Deep-link to specific lesson ---
console.log('\n[a] deep-link routing');
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1400, height: 1000 });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

const slug = 'transformers-from-scratch-1';
const targetLesson = '03-mixing-information';
await p.goto(`${BASE}/#/t/${slug}/lesson/${targetLesson}`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#lesson-view h1'));
await p.waitForTimeout(1000);

const loaded = await p.evaluate(() => ({
  hash: location.hash,
  h1: document.querySelector('#lesson-view h1')?.textContent?.slice(0, 60),
  current: document.querySelector('#sidebar-lessons a.current')?.dataset.slug,
}));
console.log('  state:', loaded);
loaded.hash.includes('/lesson/') ? pass('hash kept lesson segment') : fail(`hash=${loaded.hash}`);
loaded.current === targetLesson ? pass(`active lesson = ${targetLesson}`) : fail(`active=${loaded.current} expected ${targetLesson}`);
loaded.h1?.toLowerCase().includes('mixing') ? pass(`lesson body matches (${loaded.h1})`) : fail(`h1=${loaded.h1}`);

// Switch by hash change to a different lesson (same track)
const next = '05-query-key-value';
await p.evaluate((h) => { location.hash = h; }, `#/t/${slug}/lesson/${next}`);
await p.waitForTimeout(800);
const switched = await p.evaluate(() => ({
  current: document.querySelector('#sidebar-lessons a.current')?.dataset.slug,
  h1: document.querySelector('#lesson-view h1')?.textContent?.slice(0, 60),
}));
switched.current === next ? pass(`hash change → switched to ${next}`) : fail(`switched to ${switched.current}`);
switched.h1?.toLowerCase().match(/query|key|value/) ? pass(`body matches new lesson (${switched.h1})`) : fail(`h1=${switched.h1}`);

await b.close();

// --- (b) Materials collision auto-rename ---
console.log('\n[b] materials auto-rename on collision');
const matsDir = '/home/LYP/studyground/tracks/transformers-from-scratch-1/materials';

// Upload first file
const u1 = await fetch(`${BASE}/api/tracks/transformers-from-scratch-1/materials?name=test-collide.md`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: 'first content',
}).then((r) => r.json());
console.log('  upload 1:', u1);
u1.ok && u1.name === 'test-collide.md' ? pass(`first upload: ${u1.name}`) : fail(`first upload ${JSON.stringify(u1)}`);
!u1.renamed ? pass('first upload: renamed=false') : fail(`renamed=${u1.renamed}`);

// Upload again with same name → expect auto-rename
const u2 = await fetch(`${BASE}/api/tracks/transformers-from-scratch-1/materials?name=test-collide.md`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: 'second content',
}).then((r) => r.json());
console.log('  upload 2:', u2);
u2.ok ? pass('second upload ok') : fail('second upload failed');
u2.renamed ? pass(`renamed=true (${u2.name})`) : fail(`renamed=${u2.renamed}`);
u2.name === 'test-collide (2).md' ? pass(`name "${u2.name}" follows " (2)" pattern`) : fail(`unexpected name: ${u2.name}`);
existsSync(join(matsDir, 'test-collide.md')) ? pass('original test-collide.md still on disk') : fail('original deleted!');
existsSync(join(matsDir, 'test-collide (2).md')) ? pass('renamed file on disk') : fail('renamed file missing');

// Upload third time → " (3)"
const u3 = await fetch(`${BASE}/api/tracks/transformers-from-scratch-1/materials?name=test-collide.md`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: 'third content',
}).then((r) => r.json());
u3.name === 'test-collide (3).md' ? pass(`third upload → " (3)" (${u3.name})`) : fail(`name=${u3.name}`);

// Upload with ?replace=1 → overwrites the original
const u4 = await fetch(`${BASE}/api/tracks/transformers-from-scratch-1/materials?name=test-collide.md&replace=1`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: 'replaced!',
}).then((r) => r.json());
u4.name === 'test-collide.md' && !u4.renamed ? pass(`?replace=1 overwrites (${u4.name})`) : fail(`replace failed ${JSON.stringify(u4)}`);

// Cleanup
for (const f of ['test-collide.md', 'test-collide (2).md', 'test-collide (3).md']) {
  try { unlinkSync(join(matsDir, f)); } catch {}
}

const ok = r.every((x) => x.ok);
console.log(ok ? `\n${r.length}/${r.length} PASS` : '\nFAIL');
process.exit(ok ? 0 : 1);
