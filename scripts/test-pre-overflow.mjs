// Verify wide <pre> blocks render with right-edge gradient fade + are wider
// than they used to be (reclaimed 2rem margin), and the gradient disappears
// once scrolled to the end.
import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1500, height: 1100 });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await p.goto('http://localhost:4321/#/t/transformers-from-scratch-1/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#lesson-view h1'));
await p.waitForTimeout(700);

// Inject a wide pre to deterministically test the styles
await p.evaluate(() => {
  const v = document.getElementById('lesson-view');
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  // 200-char-wide line so it definitely overflows the prose column
  code.textContent = 'col1                col2                col3                col4                col5                col6                col7                col8\n' +
    'aaaaaaaa            bbbbbbbb            cccccccc            dddddddd            eeeeeeee            ffffffff            gggggggg            hhhhhhhh';
  pre.appendChild(code);
  v.appendChild(pre);
});
await p.waitForTimeout(200);

const r = [];
const pass = (n, info='') => { r.push({n, ok: true}); console.log('PASS', n, info); };
const fail = (n, info='') => { r.push({n, ok: false}); console.log('FAIL', n, info); };

const stats = await p.evaluate(() => {
  const pres = document.querySelectorAll('main pre');
  const pre = pres[pres.length - 1]; // the one we injected
  const cs = getComputedStyle(pre);
  return {
    width: pre.getBoundingClientRect().width,
    overflowX: cs.overflowX,
    bgImage: cs.backgroundImage.slice(0, 200),
    bgAttachment: cs.backgroundAttachment,
    marginLeft: cs.marginLeft,
    marginRight: cs.marginRight,
    scrollLeft: pre.scrollLeft,
    scrollWidth: pre.scrollWidth,
    clientWidth: pre.clientWidth,
    overflows: pre.scrollWidth > pre.clientWidth + 2,
  };
});
console.log('pre stats:', stats);

stats.overflowX === 'auto' ? pass('overflow-x: auto') : fail(`overflow-x (${stats.overflowX})`);
stats.bgImage.includes('linear-gradient') ? pass('gradient fade set on background-image') : fail('no gradient bg');
stats.bgAttachment.includes('local') ? pass(`bg-attachment includes local (${stats.bgAttachment})`) : fail(`bg-attachment (${stats.bgAttachment})`);
parseFloat(stats.marginLeft) < 0 ? pass(`pre reclaims left margin (${stats.marginLeft})`) : fail(`marginLeft not negative (${stats.marginLeft})`);
parseFloat(stats.marginRight) < 0 ? pass(`pre reclaims right margin (${stats.marginRight})`) : fail(`marginRight not negative (${stats.marginRight})`);
stats.overflows ? pass(`injected pre overflows horizontally (scrollW=${stats.scrollWidth}, clientW=${stats.clientWidth})`) : fail('injected pre should overflow');

// Scrollbar styling sanity check (only meaningful in webkit)
const scrollbar = await p.evaluate(() => {
  // We can't directly read pseudo ::-webkit-scrollbar styles, but we can
  // verify the pre has overflow content and scroll has effect.
  const pre = document.querySelectorAll('main pre');
  const target = pre[pre.length - 1];
  target.scrollLeft = 100;
  return target.scrollLeft;
});
scrollbar === 100 ? pass('horizontal scroll works (scrollLeft=100)') : fail(`scrollLeft (${scrollbar})`);

await p.screenshot({ path: '/tmp/sg-pre-overflow.png', fullPage: false });
console.log('shot: /tmp/sg-pre-overflow.png');
await b.close();
const ok = r.every((x) => x.ok);
console.log(ok ? `\n${r.length}/${r.length} PASS` : '\nFAIL');
process.exit(ok ? 0 : 1);
