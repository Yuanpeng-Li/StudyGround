// Verify the theme toggle renders a sun icon in light mode, a moon icon in
// dark mode, cycles correctly, and shows an "auto" dot when following system.
import { chromium } from 'playwright';

const BASE = 'http://localhost:4321';

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1400, height: 1000 }, colorScheme: 'light' });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

const r = [];
const pass = (n, info='') => { r.push({n, ok: true}); console.log('PASS', n, info); };
const fail = (n, info='') => { r.push({n, ok: false}); console.log('FAIL', n, info); };

await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
// Reset theme state
await p.evaluate(() => localStorage.removeItem('sg-theme'));
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForTimeout(400);

// Initial: auto, system=light → applied light → sun icon
const initial = await p.evaluate(() => {
  const btn = document.querySelector('.theme-toggle');
  return {
    chosen: btn.dataset.theme,
    applied: btn.dataset.applied,
    htmlTheme: document.documentElement.dataset.theme,
    hasSvg: !!btn.querySelector('svg'),
    svgPath: btn.querySelector('svg path')?.getAttribute('d')?.slice(0, 40) || '',
    hasCircle: !!btn.querySelector('svg circle'),
    title: btn.title,
  };
});
console.log('initial:', initial);
initial.chosen === 'auto' ? pass('initial chosen=auto') : fail(`chosen=${initial.chosen}`);
initial.applied === 'light' ? pass('initial applied=light (system)') : fail(`applied=${initial.applied}`);
initial.hasSvg ? pass('icon rendered as inline svg') : fail('no svg');
initial.hasCircle ? pass('light → sun icon (has circle)') : fail('sun icon missing');
initial.title.includes('auto') ? pass(`title says auto (${initial.title})`) : fail(`title=${initial.title}`);

// Auto "A" badge
const badge = await p.evaluate(() => {
  const cs = getComputedStyle(document.querySelector('.theme-toggle'), '::after');
  return { content: cs.content, bg: cs.backgroundColor, color: cs.color };
});
console.log('auto badge:', badge);
/['"]A['"]/.test(badge.content || '') ? pass(`auto badge shows "A" (${badge.content})`) : fail(`no A badge (${badge.content})`);

// Click → cycles auto → light (no dot, still sun)
await p.locator('.theme-toggle').first().click();
await p.waitForTimeout(150);
const afterClick1 = await p.evaluate(() => {
  const btn = document.querySelector('.theme-toggle');
  return {
    chosen: btn.dataset.theme,
    applied: btn.dataset.applied,
    htmlTheme: document.documentElement.dataset.theme,
    hasCircle: !!btn.querySelector('svg circle'),
    afterContent: getComputedStyle(btn, '::after').content,
  };
});
console.log('after click 1:', afterClick1);
afterClick1.chosen === 'light' ? pass('cycle: auto → light') : fail(`chosen=${afterClick1.chosen}`);
afterClick1.applied === 'light' && afterClick1.hasCircle ? pass('light: shows sun, no dot') : fail('light state wrong');
afterClick1.afterContent === 'none' ? pass('A-badge hidden in manual mode') : fail(`badge leaked (content=${afterClick1.afterContent})`);

// Click again → dark (moon)
await p.locator('.theme-toggle').first().click();
await p.waitForTimeout(150);
const afterClick2 = await p.evaluate(() => {
  const btn = document.querySelector('.theme-toggle');
  return {
    chosen: btn.dataset.theme,
    applied: btn.dataset.applied,
    htmlTheme: document.documentElement.dataset.theme,
    hasCircle: !!btn.querySelector('svg circle'),
    pathD: btn.querySelector('svg path')?.getAttribute('d')?.slice(0, 40) || '',
  };
});
console.log('after click 2:', afterClick2);
afterClick2.chosen === 'dark' ? pass('cycle: light → dark') : fail(`chosen=${afterClick2.chosen}`);
afterClick2.applied === 'dark' ? pass('applied=dark') : fail(`applied=${afterClick2.applied}`);
!afterClick2.hasCircle ? pass('dark: no circle (moon, not sun)') : fail('still sun');
afterClick2.htmlTheme === 'dark' ? pass('html dataset.theme = dark') : fail(`html=${afterClick2.htmlTheme}`);

// Click again → back to auto
await p.locator('.theme-toggle').first().click();
await p.waitForTimeout(150);
const afterClick3 = await p.evaluate(() => ({
  chosen: document.querySelector('.theme-toggle').dataset.theme,
  afterContent: getComputedStyle(document.querySelector('.theme-toggle'), '::after').content,
}));
console.log('after click 3:', afterClick3);
afterClick3.chosen === 'auto' ? pass('cycle: dark → auto') : fail(`chosen=${afterClick3.chosen}`);
/['"]A['"]/.test(afterClick3.afterContent || '') ? pass(`A-badge back on (${afterClick3.afterContent})`) : fail(`no A in auto (${afterClick3.afterContent})`);

// Visual sanity: icon button is square-ish
const dim = await p.evaluate(() => {
  const r = document.querySelector('.theme-toggle').getBoundingClientRect();
  return { w: r.width, h: r.height };
});
Math.abs(dim.w - dim.h) < 8 && dim.w >= 28 && dim.w <= 42
  ? pass(`button is square (${dim.w.toFixed(0)}×${dim.h.toFixed(0)})`)
  : fail(`button dimensions ${dim.w}×${dim.h}`);

await p.screenshot({ path: '/tmp/sg-theme-toggle.png', fullPage: false, clip: { x: 1240, y: 0, width: 200, height: 80 } });
await b.close();
const ok = r.every((x) => x.ok);
console.log(ok ? `\n${r.length}/${r.length} PASS` : '\nFAIL');
process.exit(ok ? 0 : 1);
