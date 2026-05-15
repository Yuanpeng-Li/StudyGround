// Verify: chat panel + intake textarea now accept
//   Enter        → submit form
//   Shift+Enter  → insert a newline
// And the textarea grows with content (up to a CSS cap).
//
// Uses an intercept on /api/chat-* so we don't burn real Claude time.
//
// Run: node scripts/test-enter-submit.mjs
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:4321';
const TRACKS = '/home/LYP/studyground/tracks';
const SLUG = 'enter-submit-test';
const DIR = join(TRACKS, SLUG);

if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
mkdirSync(join(DIR, 'lessons'), { recursive: true });
writeFileSync(join(DIR, 'track.json'), JSON.stringify({
  slug: SLUG, title: 'Enter Submit Test', description: 'enter sends, shift+enter newlines', emoji: '⏎',
  created_at: '2026-05-14', updated_at: '2026-05-14',
}));
writeFileSync(join(DIR, 'curriculum.md'), '# C\n');
writeFileSync(join(DIR, 'lessons', '01-enter.md'), `---
title: enter test
track: ${SLUG}
estimated_minutes: 5
---

# Enter test

Some lead-in.
`);

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1400, height: 900 });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

// Intercept network calls that the chat/tutor would make so we don't burn
// Claude credits — fake a slow SSE-ish stream that the panel can attach to.
await p.route(/\/api\/(chat|tutor-chat|intake)/, (route) => {
  route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: 'data: {"type":"text","text":"ok"}\n\ndata: {"type":"done"}\n\n',
  });
});

await p.goto(`${BASE}/`);
await p.evaluate(() => localStorage.setItem('sg-theme', 'light'));
await p.goto(`${BASE}/#/t/${SLUG}/`);
await p.waitForSelector('#lesson-view h1');
await p.waitForTimeout(300);

// Open the BTW chat panel via the test hook.
await p.evaluate(() => window.__openChatPanel('a quoted snippet for context'));
await p.waitForTimeout(200);

// 1. Shift+Enter inserts a newline (does not submit).
const chatTa = await p.locator('.sg-chat-panel textarea[name="q"]');
await chatTa.focus();
await chatTa.type('line one');
await p.keyboard.down('Shift');
await p.keyboard.press('Enter');
await p.keyboard.up('Shift');
await chatTa.type('line two');
const afterShift = await chatTa.inputValue();
const heightAfterShift = await p.evaluate(() => {
  const t = document.querySelector('.sg-chat-panel textarea[name="q"]');
  return t.getBoundingClientRect().height;
});
console.log('after Shift+Enter:');
console.log('  value :', JSON.stringify(afterShift));
console.log('  height:', heightAfterShift.toFixed(1));

// 2. Enter alone submits — textarea should clear.
await p.keyboard.press('Enter');
await p.waitForTimeout(200);
const afterEnter = await chatTa.inputValue();
console.log('after Enter:');
console.log('  value :', JSON.stringify(afterEnter));

// 3. Also test the intake textarea on the intake view.
await p.goto(`${BASE}/#/t/${SLUG}/intake/`);
await p.waitForSelector('#intake-input', { state: 'visible' });
await p.waitForTimeout(300);
const intakeTa = await p.locator('#intake-input');
await intakeTa.focus();
await intakeTa.type('hello');
await p.keyboard.down('Shift');
await p.keyboard.press('Enter');
await p.keyboard.up('Shift');
await intakeTa.type('world');
const intakeAfterShift = await intakeTa.inputValue();
console.log('intake after Shift+Enter:');
console.log('  value :', JSON.stringify(intakeAfterShift));
await p.keyboard.press('Enter');
await p.waitForTimeout(200);
const intakeAfterEnter = await intakeTa.inputValue();
console.log('intake after Enter:');
console.log('  value :', JSON.stringify(intakeAfterEnter));

await p.screenshot({ path: '/tmp/enter-submit.png', fullPage: false });
console.log('  → /tmp/enter-submit.png');

let failed = 0;
if (afterShift !== 'line one\nline two') { console.log(`FAIL: Shift+Enter did not insert newline (got ${JSON.stringify(afterShift)})`); failed++; }
if (heightAfterShift < 40) { console.log(`FAIL: textarea did not grow (height ${heightAfterShift})`); failed++; }
if (afterEnter !== '') { console.log(`FAIL: Enter did not submit / clear textarea (got ${JSON.stringify(afterEnter)})`); failed++; }
if (intakeAfterShift !== 'hello\nworld') { console.log(`FAIL: intake Shift+Enter did not insert newline (got ${JSON.stringify(intakeAfterShift)})`); failed++; }
if (intakeAfterEnter !== '') { console.log(`FAIL: intake Enter did not submit (got ${JSON.stringify(intakeAfterEnter)})`); failed++; }

console.log(`\n${failed === 0 ? 'all green' : failed + ' failing'}`);

await b.close();
try { rmSync(DIR, { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
