// Visual-test the materials sidebar with realistic filenames + stats so
// we can see whether the new two-row layout actually reads cleanly.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:4321';
const TRACKS = '/home/LYP/studyground/tracks';
const SLUG = 'materials-shot';
const DIR = join(TRACKS, SLUG);
if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
mkdirSync(join(DIR, 'materials'), { recursive: true });
mkdirSync(join(DIR, 'lessons'), { recursive: true });
writeFileSync(join(DIR, 'track.json'), JSON.stringify({
  slug: SLUG, title: 'Materials Shot', description: 't', emoji: '📚',
  created_at: '2026-05-14', updated_at: '2026-05-14',
}));
writeFileSync(join(DIR, 'curriculum.md'), '# C\n');
writeFileSync(join(DIR, 'lessons', '01.md'), `---
title: shot
track: ${SLUG}
estimated_minutes: 5
---
# Shot
p`);

// Drop in dummy material files so the materials sidebar populates.
const fakes = [
  ['CS277Q8.pdf', 1200],
  ['CS277L19.pdf', 2400],
  ['CS277L18.pdf', 4800],
  ['CS277L17.pdf', 4000],
  ['CS277L16.pdf', 3200],
  ['CS277L5.pdf', 4500],
  ['CS277L4.pdf', 6800],
  ['CS277L3.pdf', 6000],
  ['CS277L2.pdf', 4700],
  ['CS277L1.pdf', 2100],
  ['notes_on_attention.md', 500],
];
for (const [name, size] of fakes) {
  writeFileSync(join(DIR, 'materials', name), 'x'.repeat(size));
}

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1500, height: 1000 });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await p.goto(`${BASE}/`);
await p.evaluate(() => localStorage.setItem('sg-theme', 'light'));
await p.goto(`${BASE}/#/t/${SLUG}/`);
await p.waitForSelector('#lesson-view h1');
await p.waitForTimeout(600);

const sidebar = await p.locator('#sidebar').boundingBox();
if (sidebar) {
  await p.screenshot({
    path: '/tmp/materials-sidebar.png',
    clip: { x: sidebar.x, y: sidebar.y, width: sidebar.width, height: sidebar.height },
  });
  console.log('  → /tmp/materials-sidebar.png');
}
await b.close();
try { rmSync(DIR, { recursive: true, force: true }); } catch {}
