// Reproduce: pill goes blank/white on hover.
import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1400, height: 1100 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await p.goto('http://localhost:4321/#/t/transformers-from-scratch-1/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#lesson-view h1'));
await p.waitForTimeout(700);

// Select a paragraph
await p.evaluate(() => {
  const para = document.querySelector('#lesson-view p');
  const range = document.createRange();
  range.selectNodeContents(para);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});
await p.waitForTimeout(250);

// Snapshot before hover
const before = await p.evaluate(() => {
  const tb = document.querySelector('.sg-sel-toolbar');
  const btn = tb.querySelector('button');
  const icon = tb.querySelector('.sg-sel-icon');
  const text = tb.querySelector('.sg-sel-text');
  const cs = (e) => getComputedStyle(e);
  return {
    toolbar: {
      classes: tb.className,
      opacity: cs(tb).opacity,
      visibility: cs(tb).visibility,
      bg: cs(tb).backgroundColor,
    },
    button: {
      bg: cs(btn).background.slice(0, 120),
      color: cs(btn).color,
      filter: cs(btn).filter,
      transform: cs(btn).transform,
    },
    icon: {
      color: cs(icon).color,
      text: icon.textContent,
      display: cs(icon).display,
      opacity: cs(icon).opacity,
    },
    text: {
      visible: !!text,
      text: text?.textContent,
      display: text ? cs(text).display : null,
      color: text ? cs(text).color : null,
      opacity: text ? cs(text).opacity : null,
    },
  };
});
console.log('BEFORE HOVER:'); console.log(JSON.stringify(before, null, 2));

// Hover
await p.locator('.sg-sel-toolbar button').hover();
await p.waitForTimeout(300);

const after = await p.evaluate(() => {
  const tb = document.querySelector('.sg-sel-toolbar');
  if (!tb || !tb.classList.contains('show')) return { gone: true, classes: tb?.className };
  const btn = tb.querySelector('button');
  const icon = tb.querySelector('.sg-sel-icon');
  const text = tb.querySelector('.sg-sel-text');
  const cs = (e) => getComputedStyle(e);
  return {
    toolbar: {
      classes: tb.className,
      opacity: cs(tb).opacity,
      visibility: cs(tb).visibility,
    },
    button: {
      bg: cs(btn).background.slice(0, 120),
      color: cs(btn).color,
      filter: cs(btn).filter,
      transform: cs(btn).transform,
    },
    icon: {
      color: cs(icon).color,
      text: icon.textContent,
      display: cs(icon).display,
      opacity: cs(icon).opacity,
    },
    text: {
      visible: !!text,
      text: text?.textContent,
      display: text ? cs(text).display : null,
      color: text ? cs(text).color : null,
      opacity: text ? cs(text).opacity : null,
    },
    selectionCollapsed: (() => { const s = window.getSelection(); return !s || s.isCollapsed; })(),
  };
});
console.log('\nAFTER HOVER:'); console.log(JSON.stringify(after, null, 2));

await p.screenshot({ path: '/tmp/sg-sel-hover-bug.png', fullPage: false, clip: { x: 200, y: 100, width: 1000, height: 400 } });
console.log('shot: /tmp/sg-sel-hover-bug.png');
await b.close();
