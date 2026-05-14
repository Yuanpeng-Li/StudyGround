import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 600, height: 900 });

await p.goto('http://localhost:4321/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelectorAll('#lesson-select option').length > 1);
await p.selectOption('#lesson-select', '01-the-big-picture');
await p.waitForSelector('#lesson-view h1');
await p.waitForTimeout(700);

await p.evaluate(() => {
  const v = document.getElementById('lesson-view');
  const ps = [...v.querySelectorAll('p')].filter((p) => p.textContent.length > 80);
  const r = document.createRange();
  r.setStart(ps[0].firstChild, 0);
  r.setEnd(ps[0].firstChild, 120);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  document.dispatchEvent(new Event('selectionchange'));
});
await p.waitForTimeout(200);
await p.locator('.sg-sel-toolbar button').click();
await p.waitForSelector('.sg-chat-panel.show');
await p.waitForTimeout(300);

await p.evaluate(() => {
  const msgs = document.querySelector('.sg-chat-messages');
  const u = document.createElement('div');
  u.className = 'sg-chat-msg user';
  u.textContent = 'what does "single contract" mean here?';
  msgs.appendChild(u);
  const a = document.createElement('div');
  a.className = 'sg-chat-msg assistant';
  a.innerHTML = `<p>"Contract" here is the software-engineering sense: the agreed-upon input/output signature of a function, independent of how it's implemented. The transformer's contract is "give me a sequence of tokens, I'll give you a probability distribution over the next token at every position." Type signature <code>(T,) -> (T, V)</code>, nothing more.</p><p>The word "single" is doing the real work. Every transformer you've heard of — chat, code, translation — wraps the <strong>same</strong> contract; only the training data and weights differ.</p>`;
  msgs.appendChild(a);
  const u2 = document.createElement('div');
  u2.className = 'sg-chat-msg user';
  u2.textContent = 'so the architecture is decoupled from the task?';
  msgs.appendChild(u2);
  const a2 = document.createElement('div');
  a2.className = 'sg-chat-msg assistant';
  a2.innerHTML = `<p>Right. The same transformer can do next-token prediction on English, on code, on protein sequences — the contract <code>(T,) → (T, V)</code> is identical, you just change <code>V</code> (the vocabulary) and the training data. <em>That</em> is why one architecture eats every modality.</p>`;
  msgs.appendChild(a2);
});

await p.waitForTimeout(200);
await p.screenshot({
  path: '/tmp/sg-chat-close.png',
  clip: { x: 160, y: 0, width: 440, height: 900 },
});

await b.close();
console.log('done');
