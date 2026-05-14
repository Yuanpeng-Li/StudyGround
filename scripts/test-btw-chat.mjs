import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1300, height: 1400 });

p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
p.on('console', (m) => {
  if (m.type() !== 'log') console.log(`[${m.type()}]`, m.text());
});

console.log('1. loading lesson 01…');
await p.goto('http://localhost:4321/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelectorAll('#lesson-select option').length > 1);
await p.selectOption('#lesson-select', '01-the-big-picture');
await p.waitForSelector('#lesson-view h1');
await p.waitForTimeout(500);

console.log('2. selecting the punchline sentence in #lesson-view…');
// Find a sentence to select — the H2 + first paragraph of "Why this matters"
const result = await p.evaluate(() => {
  const view = document.getElementById('lesson-view');
  const paragraphs = view.querySelectorAll('p');
  // Find a paragraph that has enough text
  let target = null;
  for (const p of paragraphs) {
    if (p.textContent.length > 60) { target = p; break; }
  }
  if (!target) return { selected: false };
  const range = document.createRange();
  range.setStart(target.firstChild, 0);
  range.setEnd(target.firstChild, Math.min(150, target.textContent.length));
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  // selectionchange fires async — manually trigger our listener by dispatching
  document.dispatchEvent(new Event('selectionchange'));
  return { selected: true, text: sel.toString() };
});
console.log('   selected:', result.selected, '/', JSON.stringify(result.text?.slice(0, 60)));

await p.waitForTimeout(300);

console.log('3. checking toolbar visibility…');
const tbVisible = await p.locator('.sg-sel-toolbar.show').count();
console.log('   toolbar.show count:', tbVisible);

if (tbVisible === 0) {
  console.log('   ! toolbar did not appear — taking diagnostic screenshot');
  await p.screenshot({ path: '/tmp/sg-btw-fail.png', fullPage: false });
  await b.close();
  process.exit(1);
}

console.log('4. clicking "btw ask"…');
await p.locator('.sg-sel-toolbar button').click();
await p.waitForSelector('.sg-chat-panel.show', { timeout: 3000 });
console.log('   chat panel opened');

console.log('5. submitting a question…');
await p.locator('.sg-chat-form input').fill('what does "single contract" mean here?');
await p.screenshot({ path: '/tmp/sg-btw-before-submit.png', fullPage: false });
await p.locator('.sg-chat-form button[type="submit"]').click();

console.log('6. waiting for assistant reply (up to 60s)…');
const t0 = Date.now();
await p.waitForFunction(
  () => {
    const msgs = document.querySelectorAll('.sg-chat-msg.assistant');
    if (!msgs.length) return false;
    const last = msgs[msgs.length - 1];
    return last && last.textContent !== '…' && last.textContent.trim().length > 0;
  },
  { timeout: 90000 },
);
console.log(`   reply landed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

const replyText = await p.locator('.sg-chat-msg.assistant').last().innerText();
console.log('\n=== ASSISTANT REPLY (first 400 chars) ===');
console.log(replyText.slice(0, 400));

await p.screenshot({ path: '/tmp/sg-btw-after.png', fullPage: false });
console.log('\n(screenshot: /tmp/sg-btw-after.png)');

await b.close();
