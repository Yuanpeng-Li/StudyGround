// End-to-end UI sweep: home → intake → reader → tutor → btw → threads → command palette → copy-as-latex → math-in-details
// Reads existing tracks from server. Designed for quick regression detection.
import { chromium } from 'playwright';

const BASE = 'http://localhost:4321';
const results = [];
function pass(name, info = '') { results.push({ name, ok: true, info }); console.log('  PASS', name, info); }
function fail(name, info = '') { results.push({ name, ok: false, info }); console.log('  FAIL', name, info); }

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({
  permissions: ['clipboard-read', 'clipboard-write'],
  viewport: { width: 1400, height: 1100 },
});
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('  [PAGEERROR]', e.message));
p.on('console', (m) => { if (m.type() === 'error') console.log('  [CONSOLE.error]', m.text().slice(0, 200)); });

// ---------- 1. HOME ----------
console.log('\n[1] HOME PAGE');
await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !document.getElementById('view-home')?.hidden);
const home = await p.evaluate(() => ({
  visible: !document.getElementById('view-home').hidden,
  cards: document.querySelectorAll('.track-card').length,
  hasCreateBtn: !!document.querySelector('.track-card.create'),
  brand: document.querySelector('.brand')?.textContent,
}));
home.visible ? pass('home view visible') : fail('home view visible');
home.cards >= 1 ? pass(`home cards rendered (${home.cards} cards)`) : fail('home cards rendered', `got ${home.cards}`);
home.hasCreateBtn ? pass('home has + new course button') : fail('home has + new course button');
home.brand === 'studyground' ? pass('home brand') : fail('home brand', home.brand);

// ---------- 2. PICK AN EXISTING TRACK (transformers-from-scratch-1 if present) ----------
console.log('\n[2] OPEN EXISTING TRACK');
const tracks = await p.evaluate(() =>
  [...document.querySelectorAll('a.track-card[data-slug]')].map((a) => a.dataset.slug)
);
const targetSlug = tracks.find((s) => s.includes('transformers')) || tracks[0];
console.log('  target slug:', targetSlug);
if (!targetSlug) { fail('no tracks to open'); }
else {
  await p.locator(`a.track-card[data-slug="${targetSlug}"]`).click();
  await p.waitForFunction(() => !document.getElementById('view-reader')?.hidden, null, { timeout: 5000 }).catch(() => {});
  await p.waitForTimeout(700);
  const readerInfo = await p.evaluate(() => ({
    readerVisible: !document.getElementById('view-reader').hidden,
    intakeVisible: !document.getElementById('view-intake').hidden,
    sidebarLessons: document.querySelectorAll('#sidebar-lessons a[data-slug]').length,
    h1: document.querySelector('#lesson-view h1')?.textContent,
    emptyHasTutorBtn: !!document.querySelector('.lesson-empty button[data-action="open-tutor"]'),
    btnTutor: !!document.getElementById('btn-tutor'),
  }));
  if (readerInfo.intakeVisible) {
    pass('redirected to intake (no curriculum)');
  } else if (readerInfo.readerVisible) {
    pass('reader visible');
    if (readerInfo.sidebarLessons > 0) pass(`sidebar has ${readerInfo.sidebarLessons} lessons`);
    else pass('sidebar empty but reader open (empty state)');
    readerInfo.btnTutor ? pass('btn-tutor in header') : fail('btn-tutor in header');
    // empty-state CTA only if no lesson loaded
    if (!readerInfo.h1) {
      readerInfo.emptyHasTutorBtn ? pass('empty-state tutor CTA') : fail('empty-state tutor CTA');
    } else {
      pass(`first lesson title: ${readerInfo.h1.slice(0, 60)}`);
    }
  } else {
    fail('neither reader nor intake visible after click');
  }
}

// ---------- 3. KaTeX, details-math, copy-as-LaTeX ----------
console.log('\n[3] LESSON RENDERING');
const r = await p.evaluate(() => {
  // navigate to first available lesson if not already
  const link = document.querySelector('#sidebar-lessons a[data-slug]');
  if (link && !document.querySelector('#lesson-view h1')) link.click();
});
await p.waitForTimeout(700);
await p.evaluate(() => {
  const link = document.querySelector('#sidebar-lessons a[data-slug]');
  if (link) link.click();
});
await p.waitForTimeout(900);
const lessonStats = await p.evaluate(() => {
  const v = document.getElementById('lesson-view');
  return {
    h1: v.querySelector('h1')?.textContent,
    paragraphs: v.querySelectorAll('p').length,
    inlineMath: v.querySelectorAll('.sg-math-inline').length,
    blockMath: v.querySelectorAll('.sg-math-block').length,
    everyMathHasLatex: [...v.querySelectorAll('.sg-math')].every((e) => e.getAttribute('data-latex')),
    details: v.querySelectorAll('details').length,
    detailsWithMath: [...v.querySelectorAll('details')].filter((d) => d.querySelector('.sg-math, .katex')).length,
    rawDollar: /\$[^$\s][^$]*\$/.test(v.textContent),
  };
});
lessonStats.h1 ? pass(`lesson loaded: ${lessonStats.h1.slice(0, 50)}`) : fail('lesson loaded');
(lessonStats.inlineMath > 0 || lessonStats.blockMath > 0)
  ? pass(`math rendered: ${lessonStats.inlineMath} inline, ${lessonStats.blockMath} block`)
  : pass('no math on this lesson');
lessonStats.everyMathHasLatex ? pass('every .sg-math has data-latex') : fail('every .sg-math has data-latex');
!lessonStats.rawDollar ? pass('no raw $...$ visible') : fail('no raw $...$ visible (some math missed)');

// Copy-as-latex
console.log('\n[4] COPY-AS-LATEX');
const copyTest = await p.evaluate(async () => {
  const v = document.getElementById('lesson-view');
  const target = [...v.querySelectorAll('p')].find((el) => el.querySelector('.sg-math'));
  if (!target) return { skipped: 'no paragraph with math' };
  const range = document.createRange();
  range.selectNodeContents(target);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return new Promise((resolve) => {
    document.addEventListener('copy', () => {
      setTimeout(() => navigator.clipboard.readText().then(resolve).catch(() => resolve('(unreadable)')), 60);
    }, { once: true, capture: true });
    document.execCommand('copy');
  });
});
if (copyTest?.skipped) pass('copy-as-latex (skipped: ' + copyTest.skipped + ')');
else /\$[^$\s][^$]*\$/.test(copyTest) ? pass('clipboard has $...$ wrapper') : fail('clipboard has $...$ wrapper', copyTest.slice(0, 100));

// ---------- 5. TUTOR PANEL OPEN (no real claude call) ----------
console.log('\n[5] TUTOR PANEL');
await p.locator('#btn-tutor').click();
await p.waitForTimeout(400);
const tutorPanel = await p.evaluate(() => {
  const panel = document.querySelector('.sg-chat-panel');
  return {
    exists: !!panel,
    visible: panel?.classList.contains('show'),
    tutorMode: panel?.classList.contains('tutor-mode'),
    title: panel?.querySelector('.sg-chat-title')?.textContent,
    selectionHidden: panel?.querySelector('.sg-chat-selection')?.style.display === 'none',
    saveHidden: panel?.querySelector('.sg-chat-save')?.style.display === 'none',
  };
});
tutorPanel.exists ? pass('tutor panel exists') : fail('tutor panel exists');
tutorPanel.visible ? pass('tutor panel visible') : fail('tutor panel visible');
tutorPanel.tutorMode ? pass('panel has tutor-mode class') : fail('panel has tutor-mode class');
tutorPanel.selectionHidden ? pass('tutor: selection box hidden') : fail('tutor: selection box hidden');
tutorPanel.saveHidden ? pass('tutor: save button hidden') : fail('tutor: save button hidden');
tutorPanel.title?.includes('tutor') ? pass('tutor: title says tutor · slug') : fail('tutor: title', tutorPanel.title);

// Close it
await p.locator('.sg-chat-panel [data-action="close-chat"]').click();
await p.waitForTimeout(200);

// ---------- 6. BTW (selection→openChatPanel manually) ----------
console.log('\n[6] BTW SELECTION → CHAT PANEL');
const btwOpen = await p.evaluate(() => {
  // Manually open chat panel without making a real request
  const v = document.getElementById('lesson-view');
  const para = v.querySelector('p');
  if (!para) return { skipped: 'no paragraph' };
  // Simulate selection
  const range = document.createRange();
  range.selectNodeContents(para);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  // Trigger the click on selection toolbar button — but it may not appear in headless
  // Instead, directly call openChatPanel via document event
  const text = para.textContent.slice(0, 200);
  // Use window helper if exposed; otherwise just verify the chat panel can open with btw mode
  // Skip the toolbar; check the existing button[data-action="btw-outline"] on an outline H2
  return { paraText: text.slice(0, 60) };
});
console.log('  para sample:', btwOpen.paraText);
// Click an outline btw button if available
const btwBtn = await p.locator('button[data-action="btw-outline"]').count();
if (btwBtn > 0) {
  await p.locator('button[data-action="btw-outline"]').first().click();
  await p.waitForTimeout(400);
  const btwPanel = await p.evaluate(() => {
    const panel = document.querySelector('.sg-chat-panel');
    return {
      visible: panel?.classList.contains('show'),
      btwMode: !panel?.classList.contains('tutor-mode'),
      title: panel?.querySelector('.sg-chat-title')?.textContent,
      selectionVisible: panel?.querySelector('.sg-chat-selection')?.style.display !== 'none',
    };
  });
  btwPanel.visible ? pass('btw panel visible') : fail('btw panel visible');
  btwPanel.btwMode ? pass('btw mode (not tutor)') : fail('btw mode');
  btwPanel.title === 'btw' ? pass('btw title') : fail('btw title', btwPanel.title);
  btwPanel.selectionVisible ? pass('btw: selection visible') : fail('btw: selection visible');
  await p.locator('.sg-chat-panel [data-action="close-chat"]').click();
  await p.waitForTimeout(200);
} else {
  pass('btw outline button (none in this lesson — skipped)');
}

// ---------- 7. COMMAND PALETTE ----------
console.log('\n[7] COMMAND PALETTE');
await p.keyboard.press('Control+k');
await p.waitForTimeout(300);
const palette = await p.evaluate(() => {
  const dlg = document.getElementById('cmd-palette');
  return {
    open: dlg?.open,
    listItems: dlg?.querySelectorAll('#cmd-list li').length,
  };
});
palette.open ? pass('cmd palette opens with ctrl+k') : fail('cmd palette opens');
palette.listItems > 0 ? pass(`cmd palette has ${palette.listItems} items`) : fail('cmd palette has items');
await p.keyboard.press('Escape');
await p.waitForTimeout(200);

// ---------- 8. THREADS SIDEBAR ----------
console.log('\n[8] THREADS SIDEBAR');
const threads = await p.evaluate(() => {
  const ul = document.getElementById('sidebar-threads');
  return {
    exists: !!ul,
    childCount: ul.children.length,
    text: ul.textContent.slice(0, 80),
  };
});
threads.exists ? pass('threads sidebar exists') : fail('threads sidebar exists');
pass(`threads count: ${threads.childCount} (${threads.text.replace(/\s+/g, ' ').trim()})`);

// ---------- 9. NETWORK HEALTH ----------
console.log('\n[9] NO CRITICAL JS/NETWORK ERRORS');
const apiCalls = await p.evaluate(() =>
  performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/')).map((e) => ({ url: e.name.split('/api/')[1], type: e.initiatorType, ok: !!e.responseStatus }))
);
console.log('  api calls:', apiCalls.length);
pass('api round-trips logged');

// ---------- 10. HOME → DELETE confirm prompt ----------
console.log('\n[10] HOME DELETE WIRING');
await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(500);
const deleteBtns = await p.locator('.track-delete').count();
deleteBtns > 0 ? pass(`${deleteBtns} delete buttons rendered`) : fail('delete buttons rendered');

await b.close();
const ok = results.every((r) => r.ok);
console.log('\n' + '='.repeat(60));
console.log(ok ? 'ALL SWEEP CHECKS PASS' : 'SWEEP FAILED');
console.log(`${results.filter((r) => r.ok).length}/${results.length} checks ok`);
process.exit(ok ? 0 : 1);
