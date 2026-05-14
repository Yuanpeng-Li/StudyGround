// Verify (a) ?> question blocks render $math$ as KaTeX, (b) onAskClick still
// gets the clean source string (not the katex-rendered textContent garbage).
import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1400, height: 1100 });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

const r = [];
const pass = (n, info='') => { r.push({n, ok: true}); console.log('PASS', n, info); };
const fail = (n, info='') => { r.push({n, ok: false}); console.log('FAIL', n, info); };

await p.goto('http://localhost:4321/#/t/transformers-from-scratch-1/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#lesson-view h1'));
await p.waitForTimeout(700);

// Navigate to lesson 07-multi-head-attention which contains "$h = 1$" in a ?> block
await p.evaluate(() => {
  const link = [...document.querySelectorAll('#sidebar-lessons a[data-slug]')].find((a) =>
    a.dataset.slug.includes('multi-head')
  );
  if (link) link.click();
});
await p.waitForTimeout(800);

const out = await p.evaluate(() => {
  const blocks = [...document.querySelectorAll('.sg-question')];
  const haveMath = blocks.filter((q) => q.querySelector('.sg-math, .katex'));
  const first = haveMath[0];
  return {
    questions: blocks.length,
    withMath: haveMath.length,
    firstSourceAttr: first?.dataset.source,
    firstHasKatex: !!first?.querySelector('.katex'),
    firstHasRawDollar: /\$[^$\s][^$]*\$/.test(first?.querySelector('.sg-q-text')?.innerHTML || ''),
    firstRenderedSnippet: first?.querySelector('.sg-q-text')?.outerHTML.slice(0, 240),
  };
});

console.log('q blocks total:', out.questions);
console.log('q blocks with math:', out.withMath);
console.log('first data-source:', out.firstSourceAttr);
console.log('first snippet:', out.firstRenderedSnippet);

out.withMath > 0 ? pass(`at least one ?> renders math (${out.withMath})`) : fail('?> renders math');
out.firstHasKatex ? pass('first math question has .katex') : fail('first math question has .katex');
!out.firstHasRawDollar ? pass('no raw $...$ in question html') : fail('no raw $...$ in question html');
(out.firstSourceAttr || '').includes('$h = 1$') || (out.firstSourceAttr || '').includes('$h=1$')
  ? pass(`data-source preserves raw $...$ (${out.firstSourceAttr?.slice(0,60)})`)
  : fail(`data-source missing raw math (${out.firstSourceAttr})`);

await p.screenshot({ path: '/tmp/sg-question-math.png', fullPage: false });
console.log('shot: /tmp/sg-question-math.png');
await b.close();
const ok = r.every((x) => x.ok);
console.log(ok ? `\n${r.length}/${r.length} PASS` : '\nFAIL');
process.exit(ok ? 0 : 1);
