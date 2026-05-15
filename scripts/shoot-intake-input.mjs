// Snapshot the intake "Meet your tutor" composer in two states (empty +
// typed) so we can visually compare it to the chat panel's composer.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:4321';
const TRACKS = '/home/LYP/studyground/tracks';
const SLUG = 'intake-shot';
const DIR = join(TRACKS, SLUG);
if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
mkdirSync(join(DIR, 'lessons'), { recursive: true });
writeFileSync(join(DIR, 'track.json'), JSON.stringify({
  slug: SLUG, title: 'Intake Shot', description: 't', emoji: '📷',
  created_at: '2026-05-14', updated_at: '2026-05-14',
}));
writeFileSync(join(DIR, 'curriculum.md'), '# C\n');

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1400, height: 900 });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

// Don't actually hit Claude.
await p.route(/\/api\/intake/, async (route) => {
  await new Promise((r) => setTimeout(r, 99999));
});

await p.goto(`${BASE}/`);
await p.evaluate(() => localStorage.setItem('sg-theme', 'light'));
await p.goto(`${BASE}/#/t/${SLUG}/intake/`);
await p.waitForSelector('#intake-input', { state: 'visible' });
await p.waitForTimeout(300);

await p.screenshot({ path: '/tmp/intake-empty.png', fullPage: false });
console.log('  → /tmp/intake-empty.png');

// Just the composer area
const form = await p.locator('#intake-form').boundingBox();
if (form) {
  await p.screenshot({
    path: '/tmp/intake-composer-empty.png',
    clip: { x: form.x - 20, y: form.y - 10, width: form.width + 40, height: form.height + 20 },
  });
  console.log('  → /tmp/intake-composer-empty.png');
}

const ta = p.locator('#intake-input');
await ta.focus();
await ta.type('I want to learn distributed systems.');
await p.keyboard.down('Shift'); await p.keyboard.press('Enter'); await p.keyboard.up('Shift');
await ta.type('Done a fair bit of single-node Postgres work.');
await p.keyboard.down('Shift'); await p.keyboard.press('Enter'); await p.keyboard.up('Shift');
await ta.type('Want to ground in the original papers.');
await p.waitForTimeout(80);

const form2 = await p.locator('#intake-form').boundingBox();
if (form2) {
  await p.screenshot({
    path: '/tmp/intake-composer-typed.png',
    clip: { x: form2.x - 20, y: form2.y - 10, width: form2.width + 40, height: form2.height + 20 },
  });
  console.log('  → /tmp/intake-composer-typed.png');
}

await b.close();
try { rmSync(DIR, { recursive: true, force: true }); } catch {}
