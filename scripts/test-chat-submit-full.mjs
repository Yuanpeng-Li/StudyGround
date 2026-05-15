// Verify the full chat-submit flow works after the textarea conversion:
// click Ask, send Enter, both dispatch the same /api/chat-btw request
// with a user message appended. Uses route interception so we don't
// burn real Claude credits.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:4321';
const TRACKS = '/home/LYP/studyground/tracks';
const SLUG = 'chat-submit-test';
const DIR = join(TRACKS, SLUG);

if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
mkdirSync(join(DIR, 'lessons'), { recursive: true });
writeFileSync(join(DIR, 'track.json'), JSON.stringify({
  slug: SLUG, title: 'Chat Submit', description: 't', emoji: '💬',
  created_at: '2026-05-14', updated_at: '2026-05-14',
}));
writeFileSync(join(DIR, 'curriculum.md'), '# C\n');
writeFileSync(join(DIR, 'lessons', '01-chat.md'), `---
title: chat test
track: ${SLUG}
estimated_minutes: 5
---

# Chat test

Paragraph one.
`);

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1400, height: 900 });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
p.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text());
});

// Capture how many times /api/chat-btw is hit.
let chatHits = 0;
let lastBody = null;
await p.route(/\/api\/(btw-ask|tutor|intake)/, (route) => {
  chatHits++;
  try { lastBody = route.request().postDataJSON(); } catch {}
  route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: 'data: {"type":"delta","text":"ok"}\n\ndata: {"type":"done","duration_ms":10,"cost_usd":0,"num_turns":1,"full_text":"ok"}\n\n',
  });
});

await p.goto(`${BASE}/`);
await p.evaluate(() => localStorage.setItem('sg-theme', 'light'));
await p.goto(`${BASE}/#/t/${SLUG}/`);
await p.waitForSelector('#lesson-view h1');
await p.waitForTimeout(300);

await p.evaluate(() => window.__openChatPanel('quoted snippet'));
await p.waitForTimeout(150);

// Path A: click the Ask button.
const ta = p.locator('.sg-chat-panel textarea[name="q"]');
await ta.focus();
await ta.type('first message');
const askBtn = p.locator('.sg-chat-panel button[type="submit"]');
await askBtn.click();
await p.waitForTimeout(300);
const userMsgs = await p.evaluate(() =>
  [...document.querySelectorAll('.sg-chat-msg.user')].map((m) => m.textContent.trim()),
);
console.log('after click Ask:');
console.log('  /api hits        :', chatHits);
console.log('  last sent question:', JSON.stringify(lastBody?.question || lastBody?.user_message || lastBody));
console.log('  user msgs visible :', userMsgs);
console.log('  textarea value    :', JSON.stringify(await ta.inputValue()));

// Path B: press Enter to submit.
// Re-enable the textarea (in real flow the server response would do it).
await p.evaluate(() => {
  const t = document.querySelector('.sg-chat-panel textarea[name="q"]');
  t.disabled = false;
  // Reset the submit button mode from 'stop' back to 'ask' so the next
  // submit isn't short-circuited to abort.
  const btn = document.querySelector('.sg-chat-panel button[type="submit"]');
  if (btn) {
    btn.dataset.mode = 'ask';
    btn.textContent = 'Ask';
  }
});
await ta.focus();
await ta.type('second message');
await p.keyboard.press('Enter');
await p.waitForTimeout(300);
const userMsgs2 = await p.evaluate(() =>
  [...document.querySelectorAll('.sg-chat-msg.user')].map((m) => m.textContent.trim()),
);
console.log('after press Enter:');
console.log('  /api hits        :', chatHits);
console.log('  last sent question:', JSON.stringify(lastBody?.question || lastBody?.user_message || lastBody));
console.log('  user msgs visible :', userMsgs2);
console.log('  textarea value    :', JSON.stringify(await ta.inputValue()));

await p.screenshot({ path: '/tmp/chat-submit.png', fullPage: false });

let failed = 0;
if (chatHits !== 2) { console.log(`FAIL: expected exactly 2 chat requests (one per submit), got ${chatHits}`); failed++; }
if (!userMsgs.some((m) => m.includes('first message'))) { console.log('FAIL: first message did not appear in chat'); failed++; }
if (!userMsgs2.some((m) => m.includes('second message'))) { console.log('FAIL: second message did not appear in chat'); failed++; }

console.log(`\n${failed === 0 ? 'all green' : failed + ' failing'}`);
await b.close();
try { rmSync(DIR, { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
