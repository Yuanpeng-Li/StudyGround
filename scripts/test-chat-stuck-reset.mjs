// Reproduce the "对话框没法对话" bug: when the user switches panels (btw
// → tutor, or thread A → thread B) while a stream is in flight, the
// original panel's textarea stays disabled and the submit button stays
// stuck on 'Stop'. Re-opening the panel afterwards previously left it in
// that broken state; resetChatInputIfIdle() should fix it.
//
// Run: node scripts/test-chat-stuck-reset.mjs
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:4321';
const TRACKS = '/home/LYP/studyground/tracks';
const SLUG = 'stuck-reset-test';
const DIR = join(TRACKS, SLUG);

if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
mkdirSync(join(DIR, 'lessons'), { recursive: true });
writeFileSync(join(DIR, 'track.json'), JSON.stringify({
  slug: SLUG, title: 'Stuck Reset', description: 't', emoji: '🛠',
  created_at: '2026-05-14', updated_at: '2026-05-14',
}));
writeFileSync(join(DIR, 'curriculum.md'), '# C\n');
writeFileSync(join(DIR, 'lessons', '01.md'), `---
title: t
track: ${SLUG}
estimated_minutes: 5
---

# T

p
`);

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1400, height: 900 });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

// Slow-stream the btw response so we can interrupt mid-flight.
let chatHits = 0;
await p.route(/\/api\/(btw-ask|tutor)/, async (route) => {
  chatHits++;
  // Hold the connection open ~5s so the panel's stream is mid-flight when
  // we switch away. SSE body never closes; the test aborts via the client.
  await new Promise((r) => setTimeout(r, 50));
  route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: 'data: {"type":"delta","text":"thinking"}\n\n',
  });
});

await p.goto(`${BASE}/`);
await p.evaluate(() => localStorage.setItem('sg-theme', 'light'));
await p.goto(`${BASE}/#/t/${SLUG}/`);
await p.waitForSelector('#lesson-view h1');
await p.waitForTimeout(300);

// 1. Open btw panel + submit a question (starts a stream).
await p.evaluate(() => window.__openChatPanel('quoted thing'));
await p.waitForTimeout(100);
const ta = p.locator('.sg-chat-panel textarea[name="q"]');
await ta.focus();
await ta.type('first');
await p.keyboard.press('Enter');
await p.waitForTimeout(80);
const midBtw = await p.evaluate(() => {
  const t = document.querySelector('.sg-chat-panel textarea[name="q"]');
  const btn = document.querySelector('.sg-chat-panel button[type="submit"]');
  return { disabled: t.disabled, mode: btn.dataset.mode };
});
console.log('btw panel mid-stream:', midBtw);

// 2. Switch to tutor mode while the btw stream is still pending.
await p.evaluate(() => document.getElementById('btn-tutor').click());
await p.waitForTimeout(150);

// 3. Switch back to the btw thread (via the saved threads sidebar entry).
// In real usage you'd click the thread; for the test just call openChatPanel
// with the same selection so the key matches.
await p.evaluate(() => window.__openChatPanel('quoted thing'));
await p.waitForTimeout(150);

// 4. Verify the textarea is enabled + the button is back in Ask mode.
const reopened = await p.evaluate(() => {
  const t = document.querySelector('.sg-chat-panel textarea[name="q"]');
  const btn = document.querySelector('.sg-chat-panel button[type="submit"]');
  return {
    disabled: t.disabled,
    mode: btn.dataset.mode,
    btnLabel: btn.textContent.trim(),
  };
});
console.log('btw panel after reopen:', reopened);

// 5. Try typing + Enter — should send a fresh request.
await ta.focus();
await ta.type('second');
await p.keyboard.press('Enter');
await p.waitForTimeout(150);
const afterSecond = await p.evaluate(() => {
  const t = document.querySelector('.sg-chat-panel textarea[name="q"]');
  const all = [...document.querySelectorAll('.sg-chat-msg.user')].map((m) => m.textContent.trim());
  return { value: t.value, userMsgs: all };
});
console.log('after second Enter:', afterSecond);

await p.screenshot({ path: '/tmp/chat-stuck.png', fullPage: false });

let failed = 0;
if (reopened.disabled) { console.log('FAIL: textarea still disabled after reopen'); failed++; }
if (reopened.mode === 'stop') { console.log(`FAIL: button still stuck on Stop mode (label=${reopened.btnLabel})`); failed++; }
if (afterSecond.value !== '') { console.log(`FAIL: Enter did not clear textarea (got ${JSON.stringify(afterSecond.value)})`); failed++; }
if (!afterSecond.userMsgs.some((m) => m.includes('second'))) { console.log('FAIL: second message did not appear'); failed++; }

console.log(`\n${failed === 0 ? 'all green' : failed + ' failing'}`);
await b.close();
try { rmSync(DIR, { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
