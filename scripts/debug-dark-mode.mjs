import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1400, height: 1100 }, colorScheme: 'dark' });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await p.goto('http://localhost:4321/#/t/transformers-from-scratch-1/', { waitUntil: 'domcontentloaded' });
await p.evaluate(() => { localStorage.setItem('sg-theme', 'dark'); document.documentElement.dataset.theme = 'dark'; });
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#lesson-view h1'));
await p.waitForTimeout(800);

// Open btw panel with the outline button to capture pill + quote chip + tutor btn
await p.locator('button[data-action="btw-outline"]').first().click().catch(() => {});
await p.waitForTimeout(300);

// Inject a fake assistant message + select inside it for the quote chip
await p.evaluate(() => {
  const msgs = document.querySelector('.sg-chat-panel .sg-chat-messages');
  if (msgs) {
    const div = document.createElement('div');
    div.className = 'sg-chat-msg assistant';
    div.textContent = 'A sample assistant reply with words to highlight in dark mode.';
    msgs.appendChild(div);
  }
});
await p.evaluate(() => {
  const target = document.querySelector('.sg-chat-panel .sg-chat-msg.assistant');
  if (!target) return;
  const range = document.createRange();
  range.selectNodeContents(target);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});
await p.waitForTimeout(300);

// Also trigger the selection toolbar by selecting a lesson para
await p.evaluate(() => {
  const para = document.querySelector('#lesson-view p');
  const range = document.createRange();
  range.selectNodeContents(para);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});
await p.waitForTimeout(250);

const dump = await p.evaluate(() => {
  const cs = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const c = getComputedStyle(e);
    return { bg: c.backgroundColor, color: c.color, background: c.background.slice(0, 100) };
  };
  return {
    theme: document.documentElement.dataset.theme,
    body: cs('body'),
    pill: cs('.sg-sel-toolbar button'),
    quoteChip: cs('.sg-chat-quote-chip'),
    btnTutor: cs('#btn-tutor'),
    tutorPanelHead: cs('.sg-chat-panel.tutor-mode .sg-chat-head'),
    chatPanel: cs('.sg-chat-panel'),
    chatMsgAssistant: cs('.sg-chat-msg.assistant'),
    chatMsgUser: cs('.sg-chat-msg.user'),
  };
});
console.log(JSON.stringify(dump, null, 2));

await p.screenshot({ path: '/tmp/sg-dark.png', fullPage: false });
console.log('shot: /tmp/sg-dark.png');
await b.close();
