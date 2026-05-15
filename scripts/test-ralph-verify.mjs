// Verify the 4 fixes from ralph iter-1 dev-worker.
import { chromium } from 'playwright';
import fs from 'node:fs';
const PORT = fs.readFileSync('/tmp/ralph-port', 'utf8').trim();
const BASE = `http://localhost:${PORT}`;
const results = [];
function pass(n, info='') { results.push({n, ok:true, info}); console.log('  PASS', n, info); }
function fail(n, info='') { results.push({n, ok:false, info}); console.log('  FAIL', n, info); }
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1400, height: 1000 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push('pageerror: '+e.message));
p.on('console', m => { if (m.type()==='error') errs.push('console.error: '+m.text().slice(0,200)); });

// ===== ISSUE 1: INDEX.md not counted =====
console.log('\n[1] INDEX.md material_count');
await p.goto(`${BASE}/`, { waitUntil:'domcontentloaded' });
await p.waitForFunction(() => !document.getElementById('view-home')?.hidden);
const card = await p.evaluate(() => {
  const c = document.querySelector('.track-card[data-slug="qa-sweep"]');
  return c ? c.innerText.replace(/\s+/g,' ') : null;
});
console.log('  card text:', card);
if (/0\s*materials/.test(card)) pass('INDEX.md excluded from material count');
else fail('INDEX.md still counted', card);

// ===== ISSUE 4: duplicate-name 409 → inline error, not alert() =====
console.log('\n[4] duplicate course inline error');
let alertSeen = null;
p.on('dialog', async d => { alertSeen = d.message(); await d.dismiss(); });
await p.click('.track-card.create');
await p.waitForTimeout(200);
await p.fill('#nt-title', 'QA Sweep'); // duplicate
const submitBtn = await p.$('#new-track-form button[type="submit"], dialog[open] button[type="submit"]');
if (submitBtn) await submitBtn.click();
await p.waitForTimeout(800);
const inlineErr = await p.evaluate(() => {
  const e = document.getElementById('nt-error');
  return e ? { hidden: e.hidden, text: e.textContent } : null;
});
const modalStillOpen = await p.evaluate(() => !!document.querySelector('dialog[open]'));
const focusedOnTitle = await p.evaluate(() => document.activeElement?.id);
console.log('  inline error:', inlineErr, 'modal open:', modalStillOpen, 'focus:', focusedOnTitle);
if (alertSeen) fail('still uses native alert()', alertSeen);
else if (inlineErr && !inlineErr.hidden && inlineErr.text) pass('inline error shown', inlineErr.text);
else fail('no error feedback at all');
if (modalStillOpen) pass('modal stays open');
else fail('modal closed prematurely');
if (focusedOnTitle === 'nt-title') pass('focus returned to title input');
else fail('focus elsewhere: '+focusedOnTitle);
// dismiss
await p.keyboard.press('Escape');
await p.waitForTimeout(200);

// ===== ISSUE 3: bad sg-theme localStorage → fallback to auto =====
console.log('\n[3] sg-theme sanitization');
await p.evaluate(() => localStorage.setItem('sg-theme', 'javascript:alert(1)'));
await p.reload({ waitUntil:'domcontentloaded' });
await p.waitForTimeout(300);
const after = await p.evaluate(() => ({
  ls: localStorage.getItem('sg-theme'),
  attr: document.documentElement.dataset.theme,
}));
console.log('  ls=', after.ls, 'attr=', after.attr);
if (after.ls === 'auto' && (after.attr === 'light' || after.attr === 'dark')) pass('invalid sg-theme normalised to auto');
else fail('sanitization wrong', JSON.stringify(after));

// ===== ISSUE 2: chat resize keyboard support =====
console.log('\n[2] chat resize keyboard');
// Open a reader to get the chat panel
await p.goto(`${BASE}/#/t/qa-sweep/`, { waitUntil:'domcontentloaded' });
await p.waitForSelector('#lesson-view', { state:'visible', timeout:5000 });
await p.waitForTimeout(400);
await p.click('#btn-tutor');
await p.waitForTimeout(500);
const handleInfo = await p.evaluate(() => {
  const h = document.querySelector('.sg-chat-resize');
  if (!h) return null;
  return {
    tabindex: h.tabIndex,
    role: h.getAttribute('role'),
    ariaLabel: h.getAttribute('aria-label'),
    ariaOri: h.getAttribute('aria-orientation'),
  };
});
console.log('  handle:', handleInfo);
if (handleInfo?.tabindex === 0 && handleInfo.role === 'separator') pass('handle a11y attributes added');
else fail('handle missing a11y attrs', JSON.stringify(handleInfo));

// focus and arrow-press
await p.evaluate(() => document.querySelector('.sg-chat-resize').focus());
const widthBefore = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sg-chat-width').trim() || document.querySelector('.sg-chat-panel').getBoundingClientRect().width+'px');
await p.keyboard.press('ArrowLeft');
await p.keyboard.press('ArrowLeft');
await p.keyboard.press('ArrowLeft');
await p.waitForTimeout(100);
const widthAfterLeft = await p.evaluate(() => document.documentElement.style.getPropertyValue('--sg-chat-width') || getComputedStyle(document.documentElement).getPropertyValue('--sg-chat-width').trim());
console.log('  width: before='+widthBefore+' afterLeft='+widthAfterLeft);
if (widthAfterLeft && widthAfterLeft !== widthBefore) pass('ArrowLeft widens chat panel');
else fail('ArrowLeft did not resize', widthBefore+' / '+widthAfterLeft);

await p.keyboard.press('ArrowRight');
await p.keyboard.press('ArrowRight');
await p.waitForTimeout(100);
const widthAfterRight = await p.evaluate(() => document.documentElement.style.getPropertyValue('--sg-chat-width'));
console.log('  afterRight=', widthAfterRight);
if (parseInt(widthAfterRight,10) < parseInt(widthAfterLeft,10)) pass('ArrowRight narrows chat panel');
else fail('ArrowRight did not narrow', widthAfterRight);

// Shift = bigger step
await p.evaluate(() => document.documentElement.style.removeProperty('--sg-chat-width'));
await p.keyboard.press('Shift+ArrowLeft');
await p.waitForTimeout(50);
const shifted = await p.evaluate(() => document.documentElement.style.getPropertyValue('--sg-chat-width'));
console.log('  shift+arrow:', shifted);
// localStorage persistence
const lsW = await p.evaluate(() => localStorage.getItem('sg-chat-width'));
console.log('  persisted width:', lsW);
if (lsW) pass('width persisted to localStorage');
else fail('width not persisted');

// ===== console error check =====
if (errs.length) fail('console/page errors during verify', errs.slice(0,3).join(' | '));
else pass('zero console/page errors');

await b.close();
const failed = results.filter(r => !r.ok).length;
const passed = results.filter(r => r.ok).length;
console.log(`\nVERIFY: ${passed} pass, ${failed} fail`);
process.exit(failed ? 1 : 0);
