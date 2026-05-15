// Snapshot the chat input bar in three states so we can compare to Claude's
// composer style: empty, typed-one-line, typed-multi-line, streaming.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:4321';
const TRACKS = '/home/LYP/studyground/tracks';
const SLUG = 'chat-input-shot';
const DIR = join(TRACKS, SLUG);
if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
mkdirSync(join(DIR, 'lessons'), { recursive: true });
writeFileSync(join(DIR, 'track.json'), JSON.stringify({
  slug: SLUG, title: 'Shot', description: 't', emoji: '📷',
  created_at: '2026-05-14', updated_at: '2026-05-14',
}));
writeFileSync(join(DIR, 'curriculum.md'), '# C\n');
writeFileSync(join(DIR, 'lessons', '01.md'), `---
title: shot
track: ${SLUG}
estimated_minutes: 5
---

# Shot

p
`);

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1400, height: 900 });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

// Block real Claude calls.
await p.route(/\/api\/(btw-ask|tutor|intake)/, async (route) => {
  // Hold open so the button stays in "stop" mode for the streaming shot.
  await new Promise((r) => setTimeout(r, 99999));
});

await p.goto(`${BASE}/`);
await p.evaluate(() => localStorage.setItem('sg-theme', 'light'));
await p.goto(`${BASE}/#/t/${SLUG}/`);
await p.waitForSelector('#lesson-view h1');
await p.waitForTimeout(200);

await p.evaluate(() => window.__openChatPanel('quoted thing'));
await p.waitForTimeout(150);

async function shot(name) {
  const panel = await p.locator('.sg-chat-panel').boundingBox();
  if (!panel) return;
  await p.screenshot({
    path: `/tmp/chat-input-${name}.png`,
    clip: { x: panel.x, y: Math.max(0, panel.y + panel.height - 260), width: panel.width, height: 240 },
  });
  console.log(`  → /tmp/chat-input-${name}.png`);
}

// 1. Empty state
await shot('empty');

// 2. Typed one line
const ta = p.locator('.sg-chat-panel textarea[name="q"]');
await ta.focus();
await ta.type('what is attention');
await p.waitForTimeout(80);
await shot('one-line');

// 3. Typed multi-line
for (let i = 0; i < 4; i++) {
  await p.keyboard.down('Shift');
  await p.keyboard.press('Enter');
  await p.keyboard.up('Shift');
  await ta.type(`line ${i + 2}`);
}
await p.waitForTimeout(80);
await shot('multi-line');

// 4. Streaming state (button → stop)
await p.keyboard.press('Enter');
await p.waitForTimeout(250);
await shot('streaming');

await b.close();
try { rmSync(DIR, { recursive: true, force: true }); } catch {}
