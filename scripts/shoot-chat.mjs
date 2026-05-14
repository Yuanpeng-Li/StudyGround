import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1500, height: 1100 });

await p.goto('http://localhost:4321/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelectorAll('#lesson-select option').length > 1);
await p.selectOption('#lesson-select', '01-the-big-picture');
await p.waitForSelector('#lesson-view h1');
await p.waitForTimeout(800);

// Select something in the lesson and trigger toolbar
await p.evaluate(() => {
  const v = document.getElementById('lesson-view');
  const ps = [...v.querySelectorAll('p')].filter((p) => p.textContent.length > 80);
  const target = ps[0];
  const r = document.createRange();
  r.setStart(target.firstChild, 0);
  r.setEnd(target.firstChild, 120);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  document.dispatchEvent(new Event('selectionchange'));
});
await p.waitForTimeout(300);
await p.screenshot({ path: '/tmp/sg-toolbar.png', fullPage: false });

await p.locator('.sg-sel-toolbar button').click();
await p.waitForSelector('.sg-chat-panel.show');
await p.waitForTimeout(300);

// Inject a sample assistant message so we can see the panel populated
await p.evaluate(() => {
  const msgs = document.querySelector('.sg-chat-messages');
  const u = document.createElement('div');
  u.className = 'sg-chat-msg user';
  u.textContent = 'what does "single contract" mean here?';
  msgs.appendChild(u);
  const a = document.createElement('div');
  a.className = 'sg-chat-msg assistant';
  a.innerHTML = '<p>"Contract" here is the software-engineering sense: the agreed-upon input/output signature of a function, independent of how it\'s implemented. The transformer\'s contract is "give me a sequence of tokens, I\'ll give you a probability distribution over the next token at every position." Type signature <code>(T,) -> (T, V)</code>, nothing more.</p><p>The word "single" is doing the real work. The point is that every transformer you\'ve heard of — chat models, code completion, translation — wraps the <strong>same</strong> contract; only the training data and weights differ.</p>';
  msgs.appendChild(a);
});

await p.waitForTimeout(200);
await p.screenshot({ path: '/tmp/sg-chat-styled.png', fullPage: false });

await b.close();
console.log('done');
