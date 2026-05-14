// Test thread persistence + replay + flash highlight.
import { chromium } from 'playwright';
import { rmSync, existsSync } from 'node:fs';

// Clean slate
const threadsDir = '/home/LYP/studyground/.studyground/threads';
if (existsSync(threadsDir)) rmSync(threadsDir, { recursive: true });

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1400, height: 1100 });

p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await p.goto('http://localhost:4321/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelectorAll('#sidebar-lessons a').length > 0);
await p.locator('#sidebar-lessons a[data-slug="01-the-big-picture"]').click();
await p.waitForSelector('#lesson-view h1');
await p.waitForTimeout(800);

console.log('1. select text + open chat panel');
await p.evaluate(() => {
  const v = document.getElementById('lesson-view');
  const ps = [...v.querySelectorAll('p')].filter((x) => x.textContent.length > 80);
  const r = document.createRange();
  r.setStart(ps[0].firstChild, 0);
  r.setEnd(ps[0].firstChild, 120);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  document.dispatchEvent(new Event('selectionchange'));
});
await p.waitForTimeout(250);
await p.locator('.sg-sel-toolbar button').click();
await p.waitForSelector('.sg-chat-panel.show');

console.log('2. ask one question (streaming)');
await p.locator('.sg-chat-form input').fill('what does this really mean?');
await p.locator('.sg-chat-form button[type="submit"]').click();
// Wait until streaming finished AND the assistant message has real content
await p.waitForFunction(
  () => {
    const msgs = document.querySelectorAll('.sg-chat-messages .sg-chat-msg.assistant');
    if (!msgs.length) return false;
    const last = msgs[msgs.length - 1];
    return (
      last.textContent.trim().length > 30 &&
      last.textContent.trim() !== '…' &&
      !last.classList.contains('streaming')
    );
  },
  null,
  { timeout: 120000 },
);
const reply = await p.locator('.sg-chat-msg.assistant').last().innerText();
console.log('   reply preview:', reply.slice(0, 100));

console.log('3. close chat panel + verify thread persisted');
await p.locator('.sg-chat-close').click();
await p.waitForTimeout(300);

// Sidebar should now show the thread
await p.waitForFunction(
  () => document.querySelectorAll('#sidebar-threads .thread-item').length > 0,
  null,
  { timeout: 5000 },
);
const threadCount = await p.locator('#sidebar-threads .thread-item').count();
console.log('   threads in sidebar:', threadCount);
console.log('   preview:', await p.locator('#sidebar-threads .thread-preview').first().innerText());
console.log('   meta:', await p.locator('#sidebar-threads .thread-meta').first().innerText());

console.log('4. scroll away so we can verify flash + scroll-back works');
await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await p.waitForTimeout(400);

console.log('5. click thread → restore + highlight');
await p.locator('#sidebar-threads .thread-item').first().click();
await p.waitForSelector('.sg-chat-panel.show', { timeout: 5000 });
// Verify history restored
const restoredMsgs = await p.locator('.sg-chat-msg').count();
console.log('   messages restored:', restoredMsgs);
const restoredUserMsg = await p.locator('.sg-chat-msg.user').first().innerText();
console.log('   user msg:', restoredUserMsg);

// Highlight should appear briefly — wait up to 1s for sg-flash to show
const flashed = await p.waitForFunction(
  () => !!document.querySelector('.sg-flash'),
  null,
  { timeout: 2000 },
).then(() => true).catch(() => false);
console.log('   flash applied:', flashed);
if (flashed) {
  await p.waitForTimeout(800);
  await p.screenshot({ path: '/tmp/sg-thread-flash.png', fullPage: false });
  console.log('   (screenshot saved during flash: /tmp/sg-thread-flash.png)');
}

await p.waitForTimeout(2500); // let flash fade out
console.log('   flash gone:', await p.evaluate(() => !document.querySelector('.sg-flash')));

console.log('6. thread file actually on disk?');
const { readdirSync } = await import('node:fs');
const files = readdirSync(threadsDir);
console.log('   files:', files);

await b.close();
