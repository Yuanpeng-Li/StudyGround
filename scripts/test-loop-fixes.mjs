// Sweep over the four issues from the user's report:
//  (1) tutor mode toggle does NOT trigger confirm() dialog
//  (2) code block max width is bounded (≤920px) and modestly wider than prose
//  (3) opening the chat panel pushes body padding (so main stays visible)
//  (4) btw-ask: click on icon span / text span both open the chat panel
import { chromium } from 'playwright';

const BASE = 'http://localhost:4321';
const SLUG = 'transformers-from-scratch-1';

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
let dialogs = 0;
p.on('dialog', (d) => { dialogs++; d.dismiss(); });

const r = [];
const pass = (n, info='') => { r.push({n, ok: true}); console.log('PASS', n, info); };
const fail = (n, info='') => { r.push({n, ok: false}); console.log('FAIL', n, info); };

await p.goto(`${BASE}/#/t/${SLUG}/`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#lesson-view h1'));
await p.waitForTimeout(700);
// Reset any persisted state
await p.evaluate((slug) => {
  localStorage.removeItem('sg-tutor-mode:' + slug);
  localStorage.removeItem('sg-chat-width');
}, SLUG);

// ---- 1. tutor mode toggle no longer fires confirm() ----
console.log('\n[1] tutor mode toggle (no dialog)');
await p.locator('#btn-tutor').click();
await p.waitForTimeout(400);
await p.locator('[data-action="toggle-tutor-mode"]').click();
await p.waitForTimeout(200);
const tutorMode = await p.evaluate(() => document.querySelector('[data-action="toggle-tutor-mode"]')?.dataset.mode);
tutorMode === 'edit' ? pass(`flipped to edit (${tutorMode})`) : fail(`mode=${tutorMode}`);
dialogs === 0 ? pass('no confirm() dialog fired') : fail(`dialogs=${dialogs}`);
// Close panel for next test
await p.locator('.sg-chat-panel [data-action="close-chat"]').click();
await p.waitForTimeout(200);

// ---- 2. code block width bounded ----
console.log('\n[2] code block max width');
// Need a lesson with a wide pre — learn-llm/02-llm-lifecycle has one.
await p.goto(`${BASE}/#/t/learn-llm/`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(800);
// Click into a wide-pre lesson if available
await p.evaluate(() => {
  const a = [...document.querySelectorAll('#sidebar-lessons a[data-slug]')].find((x) => x.dataset.slug.includes('lifecycle')) ||
            document.querySelector('#sidebar-lessons a[data-slug]');
  if (a) a.click();
});
await p.waitForTimeout(1400);
const preStats = await p.evaluate(() => {
  const pres = [...document.querySelectorAll('main pre')];
  // Inject a deterministically wide pre so we can verify the cap regardless
  // of generated content.
  const inj = document.createElement('pre');
  inj.id = 'sg-test-wide-pre';
  inj.textContent = Array(80).fill('cellcellcell ').join('');
  document.getElementById('lesson-view').appendChild(inj);
  // Force reflow
  void inj.offsetWidth;
  const proseEl = document.querySelector('main p') || document.querySelector('main h1');
  return {
    injectedW: inj.clientWidth,
    injectedScrollW: inj.scrollWidth,
    injectedMl: getComputedStyle(inj).marginLeft,
    proseWidth: proseEl ? proseEl.getBoundingClientRect().width : 0,
  };
});
console.log('  pre stats:', preStats);
preStats.injectedW <= 925 ? pass(`pre width capped (${preStats.injectedW}px ≤ 925)`) : fail(`pre too wide (${preStats.injectedW}px)`);
preStats.injectedW > preStats.proseWidth + 50 ? pass(`pre broke out beyond prose (pre=${preStats.injectedW}, prose=${preStats.proseWidth.toFixed(0)})`) : fail(`pre didn't break out (pre=${preStats.injectedW}, prose=${preStats.proseWidth.toFixed(0)})`);
parseFloat(preStats.injectedMl) < 0 ? pass(`negative left margin (${preStats.injectedMl})`) : fail(`marginL=${preStats.injectedMl}`);

// ---- 3. chat panel pushes body padding ----
console.log('\n[3] chat panel pushes body padding-right');
// Open tutor again
await p.locator('#btn-tutor').click();
await p.waitForTimeout(500);
const layout = await p.evaluate(() => ({
  bodyClass: document.body.className,
  bodyPaddingRight: getComputedStyle(document.body).paddingRight,
  panelLeft: document.querySelector('.sg-chat-panel')?.getBoundingClientRect().left,
  panelRight: document.querySelector('.sg-chat-panel')?.getBoundingClientRect().right,
  mainRight: document.querySelector('#view-reader main')?.getBoundingClientRect().right,
}));
console.log('  layout:', layout);
layout.bodyClass.includes('sg-chat-open') ? pass('body.sg-chat-open class added') : fail('body class missing');
parseFloat(layout.bodyPaddingRight) >= 320 ? pass(`body padding-right = ${layout.bodyPaddingRight}`) : fail(`body padding (${layout.bodyPaddingRight})`);
layout.mainRight <= layout.panelLeft + 1 ? pass(`main no longer overlapped (mainR=${layout.mainRight}, panelL=${layout.panelLeft})`) : fail(`overlap: mainR=${layout.mainRight} > panelL=${layout.panelLeft}`);

// Close → padding removed
await p.locator('.sg-chat-panel [data-action="close-chat"]').click();
await p.waitForTimeout(300);
const closed = await p.evaluate(() => ({
  bodyClass: document.body.className,
  pad: getComputedStyle(document.body).paddingRight,
}));
console.log('  after close:', closed);
!closed.bodyClass.includes('sg-chat-open') ? pass('body class removed on close') : fail('body class still present');

// ---- 4. btw-ask: click on inner span opens chat panel ----
console.log('\n[4] btw-ask click target hits even when on inner span');
await p.goto(`${BASE}/#/t/${SLUG}/`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#lesson-view h1'));
await p.waitForTimeout(700);
// Trigger a selection so toolbar shows
await p.evaluate(() => {
  const para = document.querySelector('#lesson-view p');
  const range = document.createRange();
  range.selectNodeContents(para);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});
await p.waitForTimeout(300);
const toolbarVisible = await p.evaluate(() => document.querySelector('.sg-sel-toolbar')?.classList.contains('show'));
toolbarVisible ? pass('selection toolbar appears') : fail('toolbar did not show');

// Click on the inner ICON span specifically
await p.evaluate(() => {
  document.querySelector('.sg-sel-toolbar .sg-sel-icon').dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await p.waitForTimeout(400);
const panelAfterIconClick = await p.evaluate(() => ({
  shown: document.querySelector('.sg-chat-panel')?.classList.contains('show'),
  mode: document.querySelector('.sg-chat-panel')?.classList.contains('tutor-mode') ? 'tutor' : 'btw',
  bodyOpen: document.body.classList.contains('sg-chat-open'),
}));
console.log('  after icon click:', panelAfterIconClick);
panelAfterIconClick.shown ? pass('clicking the icon span opens chat panel') : fail('chat panel did not open');
panelAfterIconClick.mode === 'btw' ? pass('panel opened in btw mode') : fail(`wrong mode: ${panelAfterIconClick.mode}`);
panelAfterIconClick.bodyOpen ? pass('body.sg-chat-open set') : fail('body class missing');

await p.screenshot({ path: '/tmp/sg-loop-fixes.png', fullPage: false });
await b.close();
const ok = r.every((x) => x.ok);
console.log(ok ? `\n${r.length}/${r.length} PASS` : '\nFAIL');
process.exit(ok ? 0 : 1);
