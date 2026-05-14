// Verify (a) outline links render math via KaTeX, (b) title bar renders math too,
// (c) no leftover .katex-mathml junk (which makes textContent unreadable).
import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1400, height: 1100 });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await p.goto('http://localhost:4321/#/t/transformers-from-scratch-1/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#lesson-view h1'));
await p.waitForTimeout(800);

const results = [];
const push = (name, ok, info = '') => { results.push({ name, ok, info }); console.log((ok ? 'PASS' : 'FAIL'), name, info); };

// Pick a lesson with math in its h2s — 06-scaled-dot-product has "Why $\sqrt{d_h}$ and not $d_h$"
const target = await p.evaluate(() => {
  const link =
    [...document.querySelectorAll('#sidebar-lessons a[data-slug]')].find((a) => a.dataset.slug.includes('scaled')) ||
    [...document.querySelectorAll('#sidebar-lessons a[data-slug]')].find((a) => /scal|sqrt|dot|query/i.test(a.textContent)) ||
    document.querySelector('#sidebar-lessons a[data-slug]');
  if (link) link.click();
  return link?.dataset.slug;
});
console.log('lesson:', target);
await p.waitForTimeout(900);

const info = await p.evaluate(() => {
  const out = document.getElementById('sidebar-outline');
  const titleBar = document.getElementById('lesson-title-bar');
  return {
    outlineLinks: out.querySelectorAll('a').length,
    outlineKatex: out.querySelectorAll('.katex').length,
    outlineRawDollar: /\$[^$\s][^$]*\$/.test(out.textContent),
    outlineHasMathml: out.querySelectorAll('.katex-mathml').length,
    outlineDuplicates: [...out.querySelectorAll('a')].map((a) => {
      // Check: textContent should not contain doubled-up "dh\sqrt{d_h}dh​​" garbage.
      // A heading with math now contains a .katex (one only).
      return {
        text: a.textContent.replace(/\s+/g, ' ').trim().slice(0, 80),
        katexInside: a.querySelectorAll('.katex').length,
      };
    }),
    titleBarHtml: titleBar.innerHTML.slice(0, 200),
    titleBarText: titleBar.textContent.replace(/\s+/g, ' ').trim().slice(0, 120),
    titleBarKatex: titleBar.querySelectorAll('.katex').length,
    titleBarRawDollar: /\$[^$\s][^$]*\$/.test(titleBar.textContent),
    titleBarHasMathml: titleBar.querySelectorAll('.katex-mathml').length,
  };
});

console.log('\nOUTLINE:');
console.log('  links:', info.outlineLinks);
console.log('  katex spans:', info.outlineKatex);
console.log('  mathml leftovers:', info.outlineHasMathml);
console.log('  raw $ visible:', info.outlineRawDollar);
console.log('  links sample:');
info.outlineDuplicates.slice(0, 5).forEach((l, i) => console.log(`    [${i}] katex=${l.katexInside} text="${l.text}"`));

console.log('\nTITLE BAR:');
console.log('  text:', info.titleBarText);
console.log('  html:', info.titleBarHtml.slice(0, 200));
console.log('  katex spans:', info.titleBarKatex);
console.log('  mathml leftovers:', info.titleBarHasMathml);
console.log('  raw $ visible:', info.titleBarRawDollar);

push('outline has links', info.outlineLinks > 0);
push('outline has no leftover .katex-mathml', info.outlineHasMathml === 0, `(${info.outlineHasMathml})`);
push('outline has no raw $...$', !info.outlineRawDollar);

push('title bar has no leftover .katex-mathml', info.titleBarHasMathml === 0, `(${info.titleBarHasMathml})`);
push('title bar has no raw $...$', !info.titleBarRawDollar);

// If lesson is "Scaling — why divide by $\sqrt{d_h}$" or similar with math, expect katex in title
if (/\\sqrt|\\frac|\$/.test(info.titleBarHtml) || info.titleBarKatex > 0) {
  push('title bar renders math (has .katex)', info.titleBarKatex > 0);
} else {
  console.log('  (no math in this lesson title — skip katex check)');
}

await p.screenshot({ path: '/tmp/sg-outline-math.png', fullPage: false });
console.log('\nshot: /tmp/sg-outline-math.png');

await b.close();
const ok = results.every((r) => r.ok);
console.log(ok ? '\nALL OK' : '\nFAIL');
process.exit(ok ? 0 : 1);
