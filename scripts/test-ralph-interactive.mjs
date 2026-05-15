// Interactive exploratory Playwright sweep for ralph loop iter-1.
// Goes deeper than the scripted qa-tester sweep: visual checks, hover states,
// dark-mode pass, modal stacking, focus traps, keyboard hierarchy, screenshots.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const PORT = fs.readFileSync('/tmp/ralph-port', 'utf8').trim();
const BASE = `http://localhost:${PORT}`;
const SHOTS = '/tmp/ralph-shots-iter1';
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

const issues = [];
const passes = [];
const obs = [];
function bug(sev, title, detail = '') { issues.push({ sev, title, detail }); console.log(`  [${sev}] ${title}${detail ? ' — ' + detail : ''}`); }
function ok(title, detail = '') { passes.push({ title, detail }); console.log(`  PASS ${title}${detail ? ' — ' + detail : ''}`); }
function note(text) { obs.push(text); console.log('  NOTE', text); }

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({
  viewport: { width: 1400, height: 1000 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
const p = await ctx.newPage();
const errors = []; const warnings = [];
p.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
p.on('console', (m) => {
  const t = m.type();
  const txt = m.text().slice(0, 300);
  if (t === 'error') errors.push(`[console.error] ${txt}`);
  else if (t === 'warning') warnings.push(`[console.warning] ${txt}`);
});
p.on('requestfailed', (req) => errors.push(`[netfail] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`));

async function shot(name) {
  const f = path.join(SHOTS, `${name}.png`);
  await p.screenshot({ path: f, fullPage: false });
  return f;
}

async function press(key) { await p.keyboard.press(key); await p.waitForTimeout(80); }
async function wait(ms = 200) { await p.waitForTimeout(ms); }

// ====================================================================
console.log('\n=== A. HOME ===');
await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !document.getElementById('view-home')?.hidden, { timeout: 5000 });
await shot('A1-home-light');

const home = await p.evaluate(() => {
  const cards = [...document.querySelectorAll('.track-card')];
  return {
    cards: cards.length,
    realCards: cards.filter((c) => !c.classList.contains('create')).length,
    badges: cards
      .filter((c) => !c.classList.contains('create'))
      .map((c) => ({
        slug: c.dataset.slug,
        text: c.innerText.replace(/\s+/g, ' ').trim(),
      })),
    importBtn: !!document.querySelector('[data-action="import-track"]'),
    themeToggle: !!document.querySelector('.theme-toggle'),
  };
});
note(`home cards: ${JSON.stringify(home)}`);
if (home.cards >= 2 && home.importBtn && home.themeToggle) ok('home shell ok');
else bug('BUG', 'home shell incomplete', JSON.stringify(home));

// --- Verify INDEX.md material_count bug (qa-tester finding #1)
// Drop an INDEX.md into materials to confirm
fs.writeFileSync(`/tmp/sg-ralph-bug-probe-INDEX.md`, '# index\n');
const sbox = fs.readFileSync('/tmp/ralph-sbox', 'utf8').trim();
const matDir = `${sbox}/tracks/qa-sweep/materials`;
fs.writeFileSync(`${matDir}/INDEX.md`, '# auto-index\n');
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !document.getElementById('view-home')?.hidden, { timeout: 5000 });
const matCountText = await p.evaluate(() => {
  const card = [...document.querySelectorAll('.track-card[data-slug="qa-sweep"]')][0];
  return card ? card.innerText : null;
});
note(`card text with INDEX.md present: ${matCountText?.replace(/\s+/g, ' ')}`);
if (/\b1\s*material/i.test(matCountText || '')) bug('BUG', 'INDEX.md is counted as a material (server/index.mjs listTracks)', 'confirms qa-tester #1');
fs.rmSync(`${matDir}/INDEX.md`);

// --- New course modal: open, validate empty submit, then submit valid
console.log('\n=== A.2 New course modal ===');
await p.click('.track-card.create');
await wait(200);
await shot('A2-new-course-modal');
const modal = await p.evaluate(() => {
  const m = document.querySelector('.modal.open, dialog[open], #new-track-modal, [role="dialog"]');
  if (!m) return null;
  const focused = document.activeElement;
  return {
    visible: !!m,
    emojiGridCount: m.querySelectorAll('.emoji-grid button, [data-action="pick-emoji"]').length,
    titleInput: !!m.querySelector('input[name="title"], #new-track-title'),
    focusedTag: focused?.tagName,
    focusedInModal: m.contains(focused),
  };
});
if (modal) {
  if (modal.emojiGridCount >= 20) ok(`emoji picker has ${modal.emojiGridCount} options`);
  else bug('BUG', 'emoji picker thin', JSON.stringify(modal));
  if (modal.focusedInModal) ok('focus moved into modal');
  else bug('UX', 'focus did not move into new-course modal on open', `focused on ${modal.focusedTag}`);
} else bug('CRITICAL', 'new-course modal did not open');

// try submit empty
const submitBtn = await p.$('.modal.open button[type="submit"], .modal.open [data-action="create-track-submit"], #new-track-modal button[type="submit"]');
if (submitBtn) {
  await submitBtn.click();
  await wait(200);
  const afterEmpty = await p.evaluate(() => {
    const inp = document.querySelector('#new-track-title, input[name="title"]');
    return { invalid: inp ? inp.matches(':invalid') : null, ariaInvalid: inp?.getAttribute('aria-invalid'), value: inp?.value };
  });
  note(`empty submit reaction: ${JSON.stringify(afterEmpty)}`);
  if (afterEmpty.invalid) ok('empty title is :invalid (browser validation kicks in)');
  else bug('UX', 'empty title submit silently noop / no inline feedback');
}

// Press Esc to close
await press('Escape');
await wait(150);
const modalGone = await p.evaluate(() => !document.querySelector('.modal.open, dialog[open]'));
if (modalGone) ok('Esc closes new-course modal');
else bug('UX', 'Esc does not close new-course modal');

// --- Try duplicate-name 409 path
console.log('\n=== A.3 Duplicate course 409 ===');
// open modal again
await p.click('.track-card.create');
await wait(150);
const titleInp = await p.$('#new-track-title, input[name="title"]');
if (titleInp) {
  await titleInp.fill('QA Sweep'); // duplicate name
  // Hook dialog handler
  let alertText = null;
  p.once('dialog', async (dlg) => { alertText = dlg.message(); await dlg.dismiss(); });
  const submit2 = await p.$('.modal.open button[type="submit"], #new-track-modal button[type="submit"]');
  if (submit2) {
    await submit2.click();
    await wait(800);
    if (alertText) bug('UX', `duplicate-name uses native alert() instead of inline form error`, `alert text: "${alertText.slice(0, 120)}"`);
    else {
      const inlineErr = await p.evaluate(() => document.querySelector('.modal.open .error, .modal.open .form-error')?.textContent || null);
      note(`duplicate response inline err: ${inlineErr}`);
    }
  }
}
await press('Escape');
await wait(150);

// --- Theme toggle visual
console.log('\n=== A.4 Theme toggle ===');
const initTheme = await p.evaluate(() => document.documentElement.dataset.theme || 'auto');
note(`theme start: ${initTheme}`);
await p.click('.theme-toggle');
await wait(120);
const t1 = await p.evaluate(() => document.documentElement.dataset.theme);
await p.click('.theme-toggle');
await wait(120);
const t2 = await p.evaluate(() => document.documentElement.dataset.theme);
await p.click('.theme-toggle');
await wait(120);
const t3 = await p.evaluate(() => document.documentElement.dataset.theme);
note(`theme cycle: ${initTheme} → ${t1} → ${t2} → ${t3}`);
if ([t1, t2, t3].includes('dark')) ok('theme cycle reaches dark');
else bug('BUG', 'theme cycle never reaches dark', `${initTheme}/${t1}/${t2}/${t3}`);

// Verify localStorage sanitization (qa-tester finding #3)
await p.evaluate(() => localStorage.setItem('sg-theme', 'javascript:alert(1)'));
await p.reload({ waitUntil: 'domcontentloaded' });
const polluted = await p.evaluate(() => document.documentElement.dataset.theme);
note(`bad theme localStorage propagated as: ${polluted}`);
if (polluted === 'javascript:alert(1)' || (polluted && polluted !== 'auto' && polluted !== 'light' && polluted !== 'dark')) {
  bug('BUG', 'localStorage["sg-theme"] not sanitized — propagates raw to data-theme', `value: "${polluted}"`);
}
await p.evaluate(() => localStorage.removeItem('sg-theme'));

// --- Dark mode visual sanity
console.log('\n=== A.5 Dark mode visual ===');
await p.evaluate(() => { localStorage.setItem('sg-theme', 'dark'); document.documentElement.dataset.theme = 'dark'; });
await p.reload({ waitUntil: 'domcontentloaded' });
await wait(300);
await shot('A5-home-dark');
const darkInsp = await p.evaluate(() => {
  function rgb(c) { return c; }
  const bg = getComputedStyle(document.body).backgroundColor;
  const card = document.querySelector('.track-card:not(.create)');
  const cardBg = card ? getComputedStyle(card).backgroundColor : null;
  const text = card ? getComputedStyle(card).color : null;
  return { bodyBg: rgb(bg), cardBg, text };
});
note(`dark mode colours: ${JSON.stringify(darkInsp)}`);
if (darkInsp.bodyBg && /\(2[0-5]\d/.test(darkInsp.bodyBg.replace(/\s/g, '')) === false) {
  // body bg not light → likely dark, good
  ok('body background is dark in dark mode');
}

// ====================================================================
console.log('\n=== B. READER VIEW ===');
await p.evaluate(() => { localStorage.setItem('sg-theme', 'light'); document.documentElement.dataset.theme = 'light'; });
await p.goto(`${BASE}/#/t/qa-sweep/`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('#lesson-view', { timeout: 5000 });
await wait(500);
await shot('B1-reader');

const reader = await p.evaluate(() => {
  return {
    title: document.querySelector('#lesson-title-bar')?.textContent?.trim(),
    sidebar: !!document.querySelector('#sidebar:not([hidden])'),
    nextBtn: !!document.querySelector('[data-action="generate-next"], #btn-next'),
    recapBtn: !!document.querySelector('[data-action="recap"]'),
    outlineBtn: !!document.querySelector('[data-action="toggle-outline"], #btn-outline'),
    tutorFab: !!document.querySelector('#btn-tutor'),
    lessons: document.querySelectorAll('#sidebar-lessons li, #sidebar-lessons a').length,
    questionBlocks: document.querySelectorAll('.q-block, .question-block').length,
    askButtons: document.querySelectorAll('[data-action="ask"]').length,
    exerciseBlocks: document.querySelectorAll('.exercise, [data-action="open-exercise"]').length,
    runButtons: document.querySelectorAll('[data-action="run-cell"]').length,
    detailsBlocks: document.querySelectorAll('details').length,
    katexEls: document.querySelectorAll('.katex, .katex-html').length,
  };
});
note(`reader shell: ${JSON.stringify(reader)}`);
if (reader.title?.includes('Markers showcase')) ok('reader loaded L1');
else bug('BUG', 'reader title wrong', reader.title);
if (reader.runButtons >= 1) ok('python-run cell rendered');
else bug('BUG', 'python-run cell missing');
if (reader.katexEls >= 2) ok(`KaTeX rendered (${reader.katexEls} els)`);
else bug('BUG', 'KaTeX not rendering or too few', `${reader.katexEls}`);
if (reader.detailsBlocks >= 1) ok('?>> details block rendered');

// --- Outline rail toggle
console.log('\n=== B.2 Outline rail ===');
const outlineBtn = await p.$('[data-action="toggle-outline"], #btn-outline');
if (outlineBtn) {
  await outlineBtn.click();
  await wait(200);
  await shot('B2-outline-open');
  const outlineState = await p.evaluate(() => ({
    railVisible: !!document.querySelector('#outline-rail:not([hidden])'),
    items: document.querySelectorAll('#outline-rail [data-action="jump-section"]').length,
    btwBtns: document.querySelectorAll('#outline-rail [data-action="btw-outline"]').length,
  }));
  note(`outline: ${JSON.stringify(outlineState)}`);
  if (outlineState.railVisible && outlineState.items >= 2) ok('outline rail with items');
  // press Esc to close
  await press('Escape');
  await wait(150);
  const afterEsc = await p.evaluate(() => !!document.querySelector('#outline-rail:not([hidden])'));
  if (!afterEsc) ok('Esc closes outline rail');
  else bug('UX', 'Esc does not close outline rail');
} else bug('BUG', 'outline button not found');

// --- Run a python cell (Pyodide) — real test, no claude needed
console.log('\n=== B.3 Python run cell ===');
const runBtn = await p.$('[data-action="run-cell"]');
if (runBtn) {
  await runBtn.click();
  // Pyodide takes time to load on first run
  try {
    await p.waitForFunction(
      () => {
        const out = document.querySelector('.run-output, .pyodide-output, .cell-output, pre.output');
        return out && (out.textContent.includes('sum') || out.textContent.includes('10') || out.textContent.length > 5);
      },
      { timeout: 30000 }
    );
    const outTxt = await p.evaluate(() => {
      const out = document.querySelector('.run-output, .pyodide-output, .cell-output, pre.output');
      return out?.textContent.trim();
    });
    note(`python output: ${outTxt}`);
    if (outTxt?.includes('10')) ok('python cell produces correct numpy sum (10)');
    else bug('BUG', 'python output unexpected', outTxt);
    await shot('B3-python-output');
  } catch (e) {
    bug('BUG', 'pyodide run timed out / no output element', e.message.slice(0, 100));
  }
}

// --- Material viewer drag-resize keyboard
console.log('\n=== B.4 Material viewer ===');
// Upload a small text file
const matApi = await p.evaluate(async (port) => {
  const form = new FormData();
  form.append('file', new Blob(['Hello from ralph loop. This is a small materials test file.'], { type: 'text/plain' }), 'note.txt');
  const r = await fetch(`/api/tracks/qa-sweep/materials`, { method: 'POST', body: form });
  return { status: r.status, text: await r.text().then(t => t.slice(0, 200)) };
}, PORT);
note(`upload note.txt: ${JSON.stringify(matApi)}`);
await wait(800);
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForSelector('#lesson-view', { timeout: 5000 });
await wait(400);

// click first material in sidebar
const matLink = await p.$('[data-action="open-material"]');
if (matLink) {
  await matLink.click();
  await wait(500);
  await shot('B4-material-open');
  const viewer = await p.evaluate(() => ({
    visible: !!document.querySelector('#material-viewer:not([hidden])'),
    iframeSrc: document.querySelector('#material-viewer iframe')?.src,
    bodyText: document.querySelector('#material-viewer iframe')?.contentDocument?.body?.innerText?.slice(0, 80) || null,
    resizeHandle: !!document.querySelector('#material-viewer-resize'),
  }));
  note(`viewer: ${JSON.stringify(viewer)}`);
  if (viewer.visible) ok('material viewer opened');
  if (viewer.resizeHandle) ok('material viewer has resize handle');

  // test keyboard arrow resize
  const handle = await p.$('#material-viewer-resize');
  if (handle) {
    await handle.focus();
    const w0 = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sg-material-w').trim() || document.querySelector('#material-viewer').clientWidth);
    for (let i = 0; i < 5; i++) await press('ArrowLeft');
    const w1 = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sg-material-w').trim() || document.querySelector('#material-viewer').clientWidth);
    note(`material viewer width arrow-left: ${w0} → ${w1}`);
    if (String(w0) !== String(w1)) ok('material viewer keyboard arrow resize works');
    else bug('BUG', 'material viewer keyboard arrow resize does nothing');
  }

  // close with ×
  const closer = await p.$('#material-viewer [data-action="close-material"], #material-viewer .close');
  if (closer) {
    await closer.click();
    await wait(200);
  }
}

// --- Chat panel keyboard resize (qa-tester finding #2)
console.log('\n=== B.5 Tutor chat resize ===');
const tutorBtn = await p.$('#btn-tutor');
if (tutorBtn) {
  await tutorBtn.click();
  await wait(400);
  await shot('B5-tutor-open');
  const chat = await p.evaluate(() => ({
    visible: !!document.querySelector('#chat-panel:not([hidden]), .sg-chat:not([hidden])'),
    resizeHandle: !!document.querySelector('.sg-chat-resize'),
    handleHasTabindex: document.querySelector('.sg-chat-resize')?.hasAttribute('tabindex'),
    handleAttrs: (() => {
      const h = document.querySelector('.sg-chat-resize');
      if (!h) return null;
      return { tabindex: h.getAttribute('tabindex'), role: h.getAttribute('role'), aria: h.getAttribute('aria-label') };
    })(),
  }));
  note(`chat: ${JSON.stringify(chat)}`);
  if (chat.visible) ok('chat panel opens');
  if (chat.resizeHandle && !chat.handleHasTabindex) {
    bug('BUG', '.sg-chat-resize has no tabindex / no kbd handler — confirms qa-tester #2', JSON.stringify(chat.handleAttrs));
  }
  // close
  await press('Escape');
  await wait(200);
}

// --- Command palette
console.log('\n=== B.6 Command palette ===');
await press('Control+k');
await wait(200);
await shot('B6-palette');
const palette = await p.evaluate(() => ({
  visible: !!document.querySelector('#cmd-palette:not([hidden]), .palette:not([hidden])'),
  itemCount: document.querySelectorAll('#cmd-palette [data-action], .palette-item').length,
  focusedTag: document.activeElement?.tagName,
  focusedInPalette: !!document.querySelector('#cmd-palette')?.contains(document.activeElement),
}));
note(`palette: ${JSON.stringify(palette)}`);
if (palette.visible && palette.itemCount >= 2) ok('palette opens with items');
else bug('BUG', 'palette missing or empty', JSON.stringify(palette));
if (palette.focusedInPalette) ok('palette steals focus');
else bug('UX', 'palette opened but focus did not move into it');
await press('ArrowDown');
await press('ArrowDown');
await wait(100);
await press('Escape');
await wait(150);
const palGone = await p.evaluate(() => !document.querySelector('#cmd-palette:not([hidden])'));
if (palGone) ok('Esc closes palette');

// --- Selection toolbar + Ctrl+/
console.log('\n=== B.7 Selection toolbar / Ctrl+/ ===');
await p.evaluate(() => {
  const para = document.querySelector('#lesson-view p, #lesson-view');
  const r = document.createRange();
  const text = [...document.querySelectorAll('#lesson-view p')].find(n => n.textContent.length > 30);
  if (text) {
    r.setStart(text.firstChild, 5);
    r.setEnd(text.firstChild, 25);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
});
await wait(300);
const selToolbar = await p.evaluate(() => ({
  visible: !!document.querySelector('.selection-toolbar:not([hidden]), #sel-toolbar:not([hidden]), .sg-sel-toolbar:not([hidden])'),
  text: window.getSelection().toString(),
}));
note(`selection: ${JSON.stringify(selToolbar)}`);
if (selToolbar.visible) ok('selection toolbar shows');
else note('selection toolbar may need mouseup event — programmatic selection often does not trigger it');

// Ctrl+/ should open btw chat
await press('Control+/');
await wait(400);
const btwAfter = await p.evaluate(() => ({
  chatOpen: !!document.querySelector('#chat-panel:not([hidden]), .sg-chat:not([hidden])'),
  mode: document.querySelector('#chat-panel')?.dataset?.mode,
}));
note(`after Ctrl+/: ${JSON.stringify(btwAfter)}`);
await press('Escape');

// ====================================================================
console.log('\n=== C. SCROLLSPY / DARK READER ===');
await p.evaluate(() => { localStorage.setItem('sg-theme', 'dark'); document.documentElement.dataset.theme = 'dark'; });
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForSelector('#lesson-view', { timeout: 5000 });
await wait(400);
await shot('C1-reader-dark');
const darkReader = await p.evaluate(() => {
  const bg = getComputedStyle(document.body).backgroundColor;
  const cardBg = getComputedStyle(document.querySelector('#lesson-view')).backgroundColor;
  const code = document.querySelector('pre, code');
  const codeBg = code ? getComputedStyle(code).backgroundColor : null;
  // Check for likely white-on-white or dark-on-dark text
  const errs = [];
  document.querySelectorAll('p, h1, h2, h3, li, button').forEach((el) => {
    const cs = getComputedStyle(el);
    const c = cs.color; const b = cs.backgroundColor;
    // rough contrast check: if both rgb are nearly identical, complain
    function v(s) { const m = /rgb.*?(\d+).*?(\d+).*?(\d+)/.exec(s); return m ? [+m[1],+m[2],+m[3]] : null; }
    const C = v(c); const B = v(b);
    if (C && B && Math.abs(C[0]-B[0]) < 25 && Math.abs(C[1]-B[1]) < 25 && Math.abs(C[2]-B[2]) < 25 && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') {
      errs.push({ tag: el.tagName, fg: c, bg: b, snip: el.textContent?.slice(0, 30) });
    }
  });
  return { bg, cardBg, codeBg, errs: errs.slice(0, 5) };
});
note(`dark reader bg=${darkReader.bg} cardBg=${darkReader.cardBg} codeBg=${darkReader.codeBg}`);
if (darkReader.errs.length) bug('VISUAL', `dark mode: ${darkReader.errs.length} els with near-zero fg/bg contrast`, JSON.stringify(darkReader.errs[0]));
else ok('dark mode: no fg/bg-on-same-color elements detected');

// ====================================================================
console.log('\n=== D. CONSOLE ERRORS ===');
if (errors.length) bug('BUG', `${errors.length} console/page/network errors during sweep`, errors.slice(0, 3).join(' | '));
else ok('zero console/page errors');
note(`warnings: ${warnings.length}; sample: ${warnings.slice(0, 2).join(' | ')}`);

// ====================================================================
await b.close();

// Write report
let md = `# Interactive Playwright sweep — iter 1\n\nDate: ${new Date().toISOString()}\nServer: localhost:${PORT}\nScreenshots: ${SHOTS}\n\n## Summary\n- Issues: ${issues.length}\n- Passes: ${passes.length}\n\n`;
const sevs = ['CRITICAL', 'BUG', 'UX', 'VISUAL'];
for (const s of sevs) {
  const list = issues.filter((i) => i.sev === s);
  if (!list.length) continue;
  md += `## ${s}\n`;
  list.forEach((i, k) => { md += `- ${k + 1}. **${i.title}** ${i.detail ? '— ' + i.detail : ''}\n`; });
  md += `\n`;
}
md += `## Passes\n`;
passes.forEach((p) => { md += `- ${p.title}\n`; });
md += `\n## Observations\n`;
obs.forEach((o) => { md += `- ${o}\n`; });
md += `\n## Console errors (full)\n` + errors.map((e) => '- ' + e).join('\n') + '\n';
fs.writeFileSync('/tmp/ralph-interactive-report-iter1.md', md);
console.log('\nReport:', '/tmp/ralph-interactive-report-iter1.md');
console.log('Shots:', SHOTS);
console.log(`Final: issues=${issues.length} passes=${passes.length}`);
