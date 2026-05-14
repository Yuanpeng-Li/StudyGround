// Verify (a) math inside <details> now renders as KaTeX, (b) every math
// element carries data-latex for copy substitution.
import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1300, height: 1100 });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await p.goto('http://localhost:4321/#/t/transformers-from-scratch/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#lesson-view h1'));
await p.waitForTimeout(800);

console.log('--- counts on current lesson ---');
const counts = await p.evaluate(() => {
  const v = document.getElementById('lesson-view');
  const details = v.querySelectorAll('details');
  let detailsWithMath = 0;
  let detailsWithDollarText = 0;
  for (const d of details) {
    if (d.querySelector('.sg-math, .katex')) detailsWithMath++;
    if (/\$[^$]*\$/.test(d.textContent)) detailsWithDollarText++;
  }
  return {
    details: details.length,
    detailsWithMath,
    detailsWithDollarText,
    totalMath: v.querySelectorAll('.sg-math').length,
    inlineMath: v.querySelectorAll('.sg-math-inline').length,
    blockMath: v.querySelectorAll('.sg-math-block').length,
    everyMathHasLatex: [...v.querySelectorAll('.sg-math')].every((e) => !!e.getAttribute('data-latex')),
    sampleLatex: v.querySelector('.sg-math')?.getAttribute('data-latex') || null,
  };
});
console.log(counts);

// Try every lesson in the track and look for any details that still shows raw $$
for (const slug of ['01-the-big-picture', '02-test-exercise', '03-mixing-information', '04-dot-product-scoring', '05-query-key-value']) {
  await p.locator(`#sidebar-lessons a[data-slug="${slug}"]`).click();
  await p.waitForTimeout(900);
  const r = await p.evaluate(() => {
    const v = document.getElementById('lesson-view');
    const details = v.querySelectorAll('details');
    let stillDollar = 0;
    for (const d of details) if (/\$[^$\s]/.test(d.textContent)) stillDollar++;
    return { details: details.length, stillDollar, math: v.querySelectorAll('.sg-math').length };
  });
  console.log(`${slug}: details=${r.details}, raw-$-still-visible=${r.stillDollar}, math=${r.math}`);
}

await p.screenshot({ path: '/tmp/sg-math-details.png', fullPage: true });
console.log('\nshot: /tmp/sg-math-details.png');
await b.close();
