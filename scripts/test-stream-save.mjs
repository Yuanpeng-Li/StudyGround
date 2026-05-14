// End-to-end: select text → btw ask (streaming) → 2nd turn → save to lesson.
import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1400, height: 1100 });

p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
p.on('console', (m) => {
  if (m.type() === 'error') console.log('[error]', m.text());
});

await p.goto('http://localhost:4321/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelectorAll('#sidebar-lessons a').length > 0);
await p.locator('#sidebar-lessons a[data-slug="01-the-big-picture"]').click();
await p.waitForSelector('#lesson-view h1');
await p.waitForTimeout(800);

console.log('1. selecting text & opening chat panel…');
await p.evaluate(() => {
  const v = document.getElementById('lesson-view');
  const ps = [...v.querySelectorAll('p')].filter((p) => p.textContent.length > 80);
  const r = document.createRange();
  r.setStart(ps[0].firstChild, 0);
  r.setEnd(ps[0].firstChild, 130);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  document.dispatchEvent(new Event('selectionchange'));
});
await p.waitForTimeout(300);
await p.locator('.sg-sel-toolbar button').click();
await p.waitForSelector('.sg-chat-panel.show');

console.log('2. submitting first question (streaming)…');
await p.locator('.sg-chat-form input').fill('what does "single contract" mean here?');
const t0 = Date.now();
await p.locator('.sg-chat-form button[type="submit"]').click();

// Wait for first delta to arrive
console.log('   waiting for streaming to start…');
await p.waitForFunction(
  () => {
    const last = document.querySelector('.sg-chat-msg.assistant:last-child');
    return last && last.textContent.length > 5;
  },
  { timeout: 30000 },
);
const t_first = Date.now() - t0;
console.log(`   first chunk: ${t_first}ms`);

// Wait for streaming to finish (the cursor blink class disappears)
await p.waitForFunction(
  () => !document.querySelector('.sg-chat-msg.assistant.streaming'),
  { timeout: 120000 },
);
const t_done = Date.now() - t0;
console.log(`   finished: ${t_done}ms`);

const reply1 = await p.locator('.sg-chat-msg.assistant').last().innerText();
console.log('   reply length:', reply1.length, 'chars');
console.log('   reply preview:', reply1.slice(0, 120));

await p.screenshot({ path: '/tmp/sg-after-stream.png', fullPage: false });

console.log('\n3. submitting follow-up…');
await p.locator('.sg-chat-form input').fill('so the architecture is decoupled from the task?');
await p.locator('.sg-chat-form button[type="submit"]').click();
await p.waitForFunction(
  () => document.querySelectorAll('.sg-chat-msg.assistant').length >= 2,
  { timeout: 30000 },
);
await p.waitForFunction(
  () => !document.querySelector('.sg-chat-msg.assistant.streaming'),
  { timeout: 120000 },
);
console.log('   follow-up done');

console.log('\n4. clicking Save to lesson…');
const { readFileSync } = await import('node:fs');
const { homedir } = await import('node:os');
const { join } = await import('node:path');
const studygroundDir = process.env.STUDYGROUND_DIR || join(homedir(), 'studyground');
const lessonPath = join(studygroundDir, 'lessons/01-the-big-picture.md');
const beforeContent = readFileSync(lessonPath, 'utf8');
const beforeCount = (beforeContent.match(/^\?>> /gm) || []).length;
console.log('   ?>> markers before:', beforeCount);

await p.locator('.sg-chat-save').click();
// Wait for save to complete (button text 'saved ✓' or panel close)
await p.waitForFunction(
  () => {
    const s = document.getElementById('status').textContent;
    return /saved \(/.test(s);
  },
  { timeout: 120000 },
);
console.log('   status:', await p.locator('#status').innerText());

await p.waitForTimeout(1500);
const afterContent = readFileSync(lessonPath, 'utf8');
const afterCount = (afterContent.match(/^\?>> /gm) || []).length;
console.log('   ?>> markers after:', afterCount);
const newBlock = afterContent.match(/\?>>(?!.*\n.*<summary>btw<\/summary>)[\s\S]*?<summary>btw\s*—\s*saved chat<\/summary>[\s\S]*?<\/details>/);
if (newBlock) {
  console.log('\n=== new saved block ===');
  console.log(newBlock[0].slice(0, 600));
} else {
  // fallback: just dump tail
  console.log('\n=== lesson tail ===');
  console.log(afterContent.slice(-1500));
}

await p.screenshot({ path: '/tmp/sg-after-save.png', fullPage: true });
console.log('\n(screenshots: /tmp/sg-after-stream.png, /tmp/sg-after-save.png)');

await b.close();
