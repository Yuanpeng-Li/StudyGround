// Verify math inside <details> blocks renders in the chat panel.
//
// The btw + tutor chat panels both render assistant replies via
// `placeholder.innerHTML = md.render(fullText, {})` — the same
// markdown-it pipeline lessons use. AI replies frequently include
// `<details>...$math$...</details>` blocks in shapes that aren't
// hand-authored in lesson files:
//   - <details open> or <details class="…"> with attributes
//   - opening/closing tags adjacent to math (no blank lines)
//   - everything on one line
//   - summary with $math$ in it
//   - $$…$$ block math nested inside details
//
// This script injects realistic shapes into the live chat-panel DOM via
// the same renderer the streaming code uses, then asserts:
//   (a) the rendered HTML contains a <details> element
//   (b) the math inside has been turned into .sg-math / .katex spans
//   (c) no raw `$x$` strings leak through as visible text
//
// Run: node scripts/test-btw-details-math.mjs
// Prereq: studyground server running on :4321 with a lesson loaded.
import { chromium } from 'playwright';

const URL = process.env.SG_URL || 'http://localhost:4321/#/t/transformers-from-scratch-1/';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1400, height: 1100 });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await p.goto(URL, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#lesson-view h1'));
await p.waitForFunction(() => typeof window.__mdRender === 'function');

// Open the btw chat panel exactly like a real user would: select a
// paragraph, click the floating btw button.
await p.evaluate(() => {
  const v = document.getElementById('lesson-view');
  const para = v.querySelector('p');
  const r = document.createRange();
  r.selectNodeContents(para);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(r);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
});
await p.waitForTimeout(150);
await p.evaluate(() => {
  const t = document.querySelector('.sg-sel-toolbar');
  if (t) { const btn = t.querySelector('button'); if (btn) btn.click(); }
});
await p.waitForTimeout(250);
const panelExists = await p.locator('.sg-chat-panel').count();
console.log(`chat panel open: ${panelExists > 0 ? 'yes' : 'no'}`);

// Realistic assistant-reply shapes that all contain math inside <details>.
const CASES = [
  {
    label: 'plain — blank lines surround math',
    text:
`<details>
<summary>derivation</summary>

We start from $E = mc^2$ and rearrange:

$$E^2 = (mc^2)^2 + (pc)^2$$

</details>`,
    minMath: 2,
  },
  {
    label: '<details open> with no blank lines (used to fail)',
    text:
`<details open>
<summary>expansion</summary>
The Taylor series is $f(x) = \\sum f^{(n)}(a)(x-a)^n/n!$.
</details>`,
    minMath: 1,
  },
  {
    label: '<details class="hint"> (used to fail)',
    text:
`<details class="hint">
<summary>hint</summary>

$a^2 + b^2 = c^2$

</details>`,
    minMath: 1,
  },
  {
    label: '<details open><summary>…</summary> on same line (used to fail)',
    text:
`<details open><summary>title</summary>
$E=mc^2$
</details>`,
    minMath: 1,
  },
  {
    label: 'all on one line (used to fail)',
    text:
`<details><summary>note</summary>$\\sigma(x) = 1/(1+e^{-x})$</details>`,
    minMath: 1,
  },
  {
    label: 'inline after surrounding text',
    text:
`Quick aside: <details><summary>note</summary>$\\sigma(x) = 1/(1+e^{-x})$</details>`,
    minMath: 1,
  },
  {
    label: 'summary contains math',
    text:
`<details>
<summary>what is $\\nabla f$?</summary>

It is the gradient: $\\nabla f = (\\partial f/\\partial x_1, …)$.

</details>`,
    minMath: 1, // body math (summary math also nice-to-have, not required)
    minSummaryMath: 1,
  },
  {
    label: 'code fence + math inside details',
    text:
`<details>
<summary>derivation in code</summary>

\`\`\`python
import numpy as np
p = np.exp(x) / np.exp(x).sum()
\`\`\`

Equivalently, $p_i = e^{x_i}/\\sum_j e^{x_j}$.

</details>`,
    minMath: 1,
    expectCode: true,
  },
  {
    label: '$$ block math inside details',
    text:
`<details>
<summary>matrix form</summary>

$$
\\mathbf{y} = \\mathbf{W}\\mathbf{x} + \\mathbf{b}
$$

</details>`,
    minMath: 1,
  },
  {
    label: 'streaming partial (no closing tag yet)',
    text:
`<details>
<summary>thinking…</summary>

$E=mc^2$
`,
    minMath: 1, // even partial states should render the math
  },
  {
    label: 'long realistic reply with details mixed in',
    text:
`Sure — here's the idea.

The basic claim is that $a^2 + b^2 = c^2$ for any right triangle.

<details>
<summary>full derivation</summary>

Drop an altitude from the right angle to the hypotenuse. Each smaller
triangle is similar to the whole, so:

$$\\frac{a}{c} = \\frac{a_{\\text{proj}}}{a}$$

Multiplying gives $a^2 = c \\cdot a_{\\text{proj}}$, similarly
$b^2 = c \\cdot b_{\\text{proj}}$. Sum them and you recover
$a^2 + b^2 = c (a_{\\text{proj}} + b_{\\text{proj}}) = c^2$.

</details>

Hope that helps!`,
    minMath: 3,
  },
  {
    label: 'attribute injection attempt is sanitized',
    text:
`<details open onclick="alert('xss')">
<summary>safe</summary>
$x = 1$
</details>`,
    minMath: 1,
    mustNotContain: ['onclick'],
  },
];

const results = [];
for (const c of CASES) {
  const r = await p.evaluate((text) => {
    const panel = document.querySelector('.sg-chat-panel');
    const msgs = panel.querySelector('.sg-chat-messages');
    const msg = document.createElement('div');
    msg.className = 'sg-chat-msg assistant';
    msg.innerHTML = window.__mdRender(text);
    msgs.appendChild(msg);

    const details = msg.querySelectorAll('details');
    const mathInDetails = msg.querySelectorAll('details .sg-math, details .katex').length;
    const summaryMath = msg.querySelectorAll('details summary .sg-math, details summary .katex').length;
    const hasCode = !!msg.querySelector('details pre code');

    // Raw $math$ left as visible text inside <details>
    let rawDollar = 0;
    const sample = [];
    for (const d of details) {
      const walker = document.createTreeWalker(d, NodeFilter.SHOW_TEXT, null);
      let t;
      while ((t = walker.nextNode())) {
        if (t.parentElement.closest('.katex, .sg-math, code, pre')) continue;
        if (/\$[^$\s][^$]*\$/.test(t.nodeValue) || /\$\$/.test(t.nodeValue)) {
          rawDollar++;
          if (sample.length < 3) sample.push(t.nodeValue.slice(0, 60));
        }
      }
    }
    return {
      detailsCount: details.length,
      mathInDetails,
      summaryMath,
      hasCode,
      rawDollar,
      sample,
      htmlOuter: msg.innerHTML.slice(0, 250),
    };
  }, c.text);
  results.push({ case: c, r });
}

let failed = 0;
console.log('\n=== RESULTS ===\n');
for (const { case: c, r } of results) {
  const checks = [];
  if (r.detailsCount === 0) checks.push('no <details> in output');
  if (r.mathInDetails < c.minMath) checks.push(`math-in-details=${r.mathInDetails}, want >= ${c.minMath}`);
  if (r.rawDollar > 0) checks.push(`leaked ${r.rawDollar} raw $math$ text (${JSON.stringify(r.sample)})`);
  if (c.minSummaryMath && r.summaryMath < c.minSummaryMath) checks.push(`summary-math=${r.summaryMath}, want >= ${c.minSummaryMath}`);
  if (c.expectCode && !r.hasCode) checks.push('expected <pre><code> inside details, none found');
  if (c.mustNotContain) {
    for (const banned of c.mustNotContain) {
      if (r.htmlOuter.toLowerCase().includes(banned.toLowerCase())) checks.push(`output still contains "${banned}"`);
    }
  }

  const pass = checks.length === 0;
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.label}`);
  console.log(`       details=${r.detailsCount}  math-inside=${r.mathInDetails}  summary-math=${r.summaryMath}  raw-$=${r.rawDollar}${r.hasCode ? '  code=yes' : ''}`);
  if (!pass) {
    for (const c2 of checks) console.log(`       └─ ${c2}`);
  }
}

console.log(`\n${failed === 0 ? 'all green' : failed + ' failing'}`);
await b.close();
process.exit(failed === 0 ? 0 : 1);
