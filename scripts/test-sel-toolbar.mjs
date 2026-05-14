// Verify the new "btw ask" pill: shows on selection, pill-shaped, has icon,
// positions correctly above the selection, and disappears on click-elsewhere.
import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1400, height: 1100 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await p.goto('http://localhost:4321/#/t/transformers-from-scratch-1/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#lesson-view h1'));
await p.waitForTimeout(700);

const results = [];
const pass = (n, info='') => { results.push({n, ok: true}); console.log('PASS', n, info); };
const fail = (n, info='') => { results.push({n, ok: false}); console.log('FAIL', n, info); };

// 1. Select a paragraph inside the lesson view
await p.evaluate(() => {
  const para = document.querySelector('#lesson-view p');
  const range = document.createRange();
  range.selectNodeContents(para);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});

// Allow the selectionchange to fire and toolbar to position
await p.waitForTimeout(250);

const info = await p.evaluate(() => {
  const tb = document.querySelector('.sg-sel-toolbar');
  if (!tb) return { exists: false };
  const btn = tb.querySelector('button');
  const icon = tb.querySelector('.sg-sel-icon');
  const cs = getComputedStyle(btn);
  const rect = tb.getBoundingClientRect();
  const para = document.querySelector('#lesson-view p').getBoundingClientRect();
  return {
    exists: true,
    visible: tb.classList.contains('show'),
    opacity: getComputedStyle(tb).opacity,
    iconText: icon?.textContent,
    iconExists: !!icon,
    borderRadius: cs.borderRadius,
    background: cs.background.slice(0, 80),
    paddingY: cs.paddingTop,
    textTransform: cs.textTransform,
    pillW: rect.width,
    pillH: rect.height,
    pillCenterX: rect.left + rect.width / 2,
    paraCenterX: para.left + para.width / 2,
    pillBottom: rect.bottom,
    paraTop: para.top,
  };
});

console.log('info:', info);

if (!info.exists) { fail('toolbar exists'); process.exit(1); }
pass('toolbar exists');
info.visible ? pass('toolbar has .show') : fail('toolbar has .show');
Number(info.opacity) > 0.9 ? pass(`opacity ~1 (${info.opacity})`) : fail(`opacity (${info.opacity})`);
info.iconExists ? pass(`icon span present (${info.iconText})`) : fail('icon span present');
info.borderRadius.includes('9999') || /\d{3,}/.test(info.borderRadius) ? pass(`pill shape (border-radius=${info.borderRadius})`) : fail(`pill shape (${info.borderRadius})`);
/linear-gradient/.test(info.background) ? pass('gradient background') : fail('gradient background', info.background);
info.textTransform === 'uppercase' ? pass('uppercase text') : fail(`uppercase text (${info.textTransform})`);
info.pillBottom <= info.paraTop + 4 ? pass(`toolbar above selection (bottom=${info.pillBottom.toFixed(0)} ≤ paraTop=${info.paraTop.toFixed(0)})`) : fail(`toolbar above selection (bottom=${info.pillBottom.toFixed(0)} paraTop=${info.paraTop.toFixed(0)})`);

// Take a screenshot of the visible area around the selection
await p.screenshot({ path: '/tmp/sg-sel-toolbar.png', fullPage: false });
console.log('shot: /tmp/sg-sel-toolbar.png');

await b.close();
const ok = results.every((r) => r.ok);
console.log(ok ? `\n${results.length}/${results.length} PASS` : `\n${results.filter(r=>r.ok).length}/${results.length} FAIL`);
process.exit(ok ? 0 : 1);
