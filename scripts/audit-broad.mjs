// Broad UX/UI audit. Walks the major flows, captures console errors,
// measures key positions, and flags anything that looks off.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:4321';
const TRACKS = '/home/LYP/studyground/tracks';
const SLUG = 'audit-fixture';
const DIR = join(TRACKS, SLUG);

function ensureFixture() {
  if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, 'lessons'), { recursive: true });
  mkdirSync(join(DIR, 'materials'), { recursive: true });
  writeFileSync(join(DIR, 'track.json'), JSON.stringify({
    slug: SLUG, title: 'Audit Fixture', description: 'tests', emoji: '🔬',
    created_at: '2026-05-14', updated_at: '2026-05-14',
  }, null, 2));
  writeFileSync(join(DIR, 'curriculum.md'), '# Curriculum\n\n1. 01-intro\n2. 02-deeper\n');
  writeFileSync(join(DIR, 'lessons', '01-intro.md'), `---
title: Intro to the topic
track: ${SLUG}
estimated_minutes: 8
---

# Intro to the topic

## Why this matters

A short paragraph about why this matters. Math: $x^2 + y^2 = r^2$.

## A code block

\`\`\`python
def hello(name: str) -> str:
    return f"hello, {name}"

print(hello("audit"))
\`\`\`

Another paragraph after the code.

## A long Chinese heading 这是一段很长很长的标题用来测试 outline 是否截断

Some body text.
`);
  writeFileSync(join(DIR, 'lessons', '02-deeper.md'), `---
title: Deeper
track: ${SLUG}
estimated_minutes: 5
---

# Deeper

## Another section

More text.
`);
}

ensureFixture();

const issues = [];
function flag(area, severity, msg, extra) {
  issues.push({ area, severity, msg, extra });
  console.log(`[${severity.toUpperCase()}] ${area}: ${msg}` + (extra ? ' — ' + JSON.stringify(extra) : ''));
}
function ok(area, msg) { console.log(`  ok  ${area}: ${msg}`); }

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 1600, height: 1000 } });
const p = await ctx.newPage();
const consoleErrors = [];
p.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('console: ' + m.text()); });

// ============================================================
// [1] HOME view
// ============================================================
console.log('\n=== [1] HOME ===');
await p.goto(`${BASE}/#/`);
await p.waitForSelector('.track-card');
await p.waitForTimeout(400);

// Brand alignment
const brand1 = await p.evaluate(() => {
  const b = document.querySelector('.brand');
  const r = b.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), text: b.textContent.trim() };
});
brand1.text === 'StudyGround' ? ok('home', 'brand text correct') : flag('home', 'minor', 'brand text', brand1);

// Track cards should have edit/export/delete buttons
const cardActions = await p.evaluate((slug) => {
  const card = document.querySelector(`.track-card[data-slug="${slug}"]`);
  if (!card) return null;
  return {
    edit: !!card.querySelector('.track-edit'),
    exp: !!card.querySelector('.track-export'),
    del: !!card.querySelector('.track-delete'),
  };
}, SLUG);
if (!cardActions) flag('home', 'major', 'audit-fixture card missing');
else (cardActions.edit && cardActions.exp && cardActions.del) ? ok('home', 'card has edit/export/delete') : flag('home', 'minor', 'card actions', cardActions);

// New-course button visible
await p.evaluate(() => document.querySelector('[data-action="open-new-track"]')?.scrollIntoView());
const newCardVisible = await p.evaluate(() => {
  const el = document.querySelector('[data-action="open-new-track"]');
  return !!el && el.offsetParent !== null;
});
newCardVisible ? ok('home', '+ new course card present') : flag('home', 'major', 'new course card missing');

// Click pencil → dialog opens
await p.click(`.track-card[data-slug="${SLUG}"] .track-edit`);
await p.waitForSelector('#edit-track-dialog[open]');
const dialogInit = await p.evaluate(() => ({
  title: document.getElementById('et-title').value,
  emoji: document.getElementById('et-emoji').value,
}));
dialogInit.title === 'Audit Fixture' ? ok('home', 'edit dialog pre-fills title') : flag('home', 'minor', 'edit dialog pre-fill', dialogInit);
// Cancel without saving
await p.click('[data-action="close-edit-dialog"]');
await p.waitForFunction(() => !document.getElementById('edit-track-dialog').open);

await p.screenshot({ path: '/tmp/audit-home.png', clip: { x: 0, y: 0, width: 1600, height: 700 } });

// ============================================================
// [2] READER + outline
// ============================================================
console.log('\n=== [2] READER ===');
await p.goto(`${BASE}/#/t/${SLUG}/`);
await p.waitForFunction(() => document.querySelector('main pre'));
await p.waitForTimeout(500);

// Brand at expected x/y
const brand2 = await p.evaluate(() => {
  const b = document.querySelector('.sidebar-brand');
  const r = b.getBoundingClientRect();
  return { boxX: Math.round(r.left), y: Math.round(r.top) };
});
Math.abs(brand2.y - 18) <= 3 ? ok('reader', 'brand y matches home') : flag('reader', 'minor', 'brand y mismatch', brand2);

// Outline rail visible inline at this viewport
const outline = await p.evaluate(() => ({
  rail: getComputedStyle(document.getElementById('outline-rail')).display,
  toggle: getComputedStyle(document.getElementById('outline-toggle')).display,
}));
outline.rail === 'block' && outline.toggle === 'none'
  ? ok('reader', 'outline inline at 1600px')
  : flag('reader', 'minor', 'outline visibility at 1600', outline);

// Outline item heights all = 28
const heights = await p.evaluate(() => [...document.querySelectorAll('#outline-rail a')].map(a => Math.round(a.getBoundingClientRect().height)));
heights.every(h => h === 28)
  ? ok('reader', 'outline items single-line')
  : flag('reader', 'minor', 'outline wraps', { heights });

// Code-block copy button exists on every pre
const preCount = await p.evaluate(() => document.querySelectorAll('main pre').length);
const decorated = await p.evaluate(() => [...document.querySelectorAll('main pre')].every(pre => pre.querySelector('.sg-pre-copy')));
decorated ? ok('reader', `copy button on all ${preCount} pre blocks`) : flag('reader', 'major', 'copy button missing on some pre');

// Click copy → clipboard
await p.locator('main pre').first().hover();
await p.locator('main pre .sg-pre-copy').first().click();
await p.waitForTimeout(300);
const clip = await p.evaluate(async () => navigator.clipboard.readText().catch(() => 'ERR'));
const expectedCode = await p.evaluate(() => document.querySelector('main pre code').textContent);
clip === expectedCode ? ok('reader', 'copy button writes to clipboard') : flag('reader', 'major', 'clipboard text mismatch', { got: clip.slice(0,50), expected: expectedCode.slice(0,50) });

// Sidebar section toggles
await p.click('[data-action="toggle-section"][data-section="threads"]');
await p.waitForTimeout(150);
const threadsCollapsed = await p.evaluate(() => document.querySelector('[data-section="threads"]').classList.contains('collapsed'));
threadsCollapsed ? ok('reader', 'threads section collapses') : flag('reader', 'major', 'threads toggle did not collapse');
// Expand back
await p.click('[data-action="toggle-section"][data-section="threads"]');
await p.waitForTimeout(150);

// Brand link → home
await p.click('.sidebar-brand');
await p.waitForTimeout(300);
const onHome = await p.evaluate(() => !document.getElementById('view-home').hidden);
onHome ? ok('reader', 'brand link → home') : flag('reader', 'major', 'brand link did not navigate');

// ============================================================
// [3] RESPONSIVE — narrow viewport outline popover
// ============================================================
console.log('\n=== [3] RESPONSIVE ===');
await p.goto(`${BASE}/#/t/${SLUG}/`);
await p.waitForTimeout(300);
await p.setViewportSize({ width: 1200, height: 900 });
await p.waitForTimeout(300);
const narrow = await p.evaluate(() => ({
  rail: getComputedStyle(document.getElementById('outline-rail')).display,
  toggle: getComputedStyle(document.getElementById('outline-toggle')).display,
}));
narrow.rail === 'none' && narrow.toggle === 'flex'
  ? ok('responsive', 'outline → toggle at 1200px')
  : flag('responsive', 'major', 'outline mode wrong at narrow', narrow);

await p.click('#outline-toggle');
await p.waitForTimeout(200);
const popover = await p.evaluate(() => {
  const r = document.getElementById('outline-rail').getBoundingClientRect();
  return { display: getComputedStyle(document.getElementById('outline-rail')).display, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width) };
});
popover.display === 'block' && popover.w === 320
  ? ok('responsive', 'popover opens at 320px wide')
  : flag('responsive', 'major', 'popover dims', popover);
// Close popover
await p.keyboard.press('Escape');
await p.waitForTimeout(200);

// Back to wide
await p.setViewportSize({ width: 1600, height: 900 });
await p.waitForTimeout(200);

// ============================================================
// [4] CHAT panel — intercept tutor, Esc abort, history nav
// ============================================================
console.log('\n=== [4] CHAT ===');
await p.evaluate(() => {
  const orig = window.fetch.bind(window);
  window.__streamChunks = 0;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    const method = (init?.method || 'GET').toUpperCase();
    if (method === 'POST' && (url.endsWith('/api/tutor') || url.endsWith('/api/btw-ask'))) {
      const enc = new TextEncoder();
      const sig = init?.signal;
      const chunks = ['Hello', ' there', ' partner', ' from', ' the', ' audit', ' run', '.'];
      let i = 0;
      const body = new ReadableStream({
        async pull(controller) {
          if (sig?.aborted) { try { controller.error(new DOMException('aborted','AbortError')); } catch{} return; }
          if (i < chunks.length) {
            controller.enqueue(enc.encode('data: ' + JSON.stringify({type:'delta',text:chunks[i]}) + '\n\n'));
            i++; window.__streamChunks = i;
            await new Promise(r => setTimeout(r, 250));
          } else {
            controller.enqueue(enc.encode('data: ' + JSON.stringify({type:'done', duration_ms:2000, cost_usd:0.01, full_text:''}) + '\n\n'));
            controller.close();
          }
        },
      });
      return Promise.resolve(new Response(body, {status:200, headers:{'Content-Type':'text/event-stream'}}));
    }
    return orig(input, init);
  };
});

// Open tutor (toggle behaviour)
await p.click('#btn-tutor');
await p.waitForFunction(() => document.body.classList.contains('sg-chat-open'));
// Toggle close
await p.click('#btn-tutor');
await p.waitForTimeout(200);
const closed = await p.evaluate(() => !document.body.classList.contains('sg-chat-open'));
closed ? ok('chat', 'tutor FAB toggles close on second click') : flag('chat', 'minor', 'tutor toggle didn\'t close');
// Reopen + send
await p.click('#btn-tutor');
await p.waitForFunction(() => document.body.classList.contains('sg-chat-open'));
await p.fill('.sg-chat-form input[name="q"]', 'first question');
await p.click('.sg-chat-form button[type="submit"]');
await p.waitForFunction(() => Number(window.__streamChunks) >= 2, null, { timeout: 4000 });
// Submit button is Stop
const mid = await p.evaluate(() => {
  const b = document.querySelector('.sg-chat-form button');
  return { mode: b.dataset.mode, text: b.textContent };
});
mid.mode === 'stop' && mid.text === 'Stop' ? ok('chat', 'submit → Stop while streaming') : flag('chat', 'major', 'submit mode wrong', mid);
// Esc aborts
const beforeAbort = await p.evaluate(() => Number(window.__streamChunks));
await p.keyboard.press('Escape');
await p.waitForTimeout(500);
const afterAbort = await p.evaluate(() => ({
  chunks: Number(window.__streamChunks),
  btn: document.querySelector('.sg-chat-form button').dataset.mode,
  interrupted: document.querySelector('.sg-chat-messages .sg-chat-msg:last-child')?.classList.contains('interrupted'),
}));
afterAbort.chunks - beforeAbort <= 2 && afterAbort.btn === 'ask' && afterAbort.interrupted
  ? ok('chat', 'Esc aborts mid-stream')
  : flag('chat', 'major', 'esc abort partial', { before: beforeAbort, ...afterAbort });

// History nav
await p.click('.sg-chat-form input[name="q"]');
await p.keyboard.press('ArrowUp');
await p.waitForTimeout(100);
const histUp = await p.evaluate(() => document.querySelector('.sg-chat-form input[name="q"]').value);
histUp === 'first question' ? ok('chat', 'ArrowUp recalls last prompt') : flag('chat', 'minor', 'ArrowUp', { got: histUp });
await p.keyboard.press('ArrowDown');
await p.waitForTimeout(100);
const histDown = await p.evaluate(() => document.querySelector('.sg-chat-form input[name="q"]').value);
histDown === '' ? ok('chat', 'ArrowDown returns to empty') : flag('chat', 'minor', 'ArrowDown', { got: histDown });

// Outline + chat coexistence at 2400 (both visible)
await p.setViewportSize({ width: 2400, height: 1000 });
await p.waitForTimeout(300);
const both = await p.evaluate(() => ({
  rail: getComputedStyle(document.getElementById('outline-rail')).display,
  toggle: getComputedStyle(document.getElementById('outline-toggle')).display,
}));
both.rail === 'block' && both.toggle === 'none'
  ? ok('responsive', 'outline + chat both visible at 2400')
  : flag('responsive', 'minor', 'rail with chat at 2400', both);
await p.setViewportSize({ width: 1600, height: 900 });

// Close chat
await p.click('[data-action="close-chat"]');
await p.waitForTimeout(200);

// ============================================================
// [5] THEME toggle on each view
// ============================================================
console.log('\n=== [5] THEME ===');
const themes = ['light', 'dark', 'auto'];
for (const t of themes) {
  await p.evaluate((th) => { localStorage.setItem('sg-theme', th); }, t);
  await p.reload();
  await p.waitForTimeout(400);
  const applied = await p.evaluate(() => ({
    root: document.documentElement.getAttribute('data-theme'),
    btn: document.querySelector('.theme-toggle')?.dataset.applied,
    stored: document.querySelector('.theme-toggle')?.dataset.theme,
  }));
  if (t === 'auto') {
    (applied.root === 'light' || applied.root === 'dark') && applied.stored === 'auto'
      ? ok('theme', `auto resolved → ${applied.root}`) : flag('theme', 'minor', 'auto unresolved', applied);
  } else {
    applied.root === t && applied.btn === t ? ok('theme', `${t} applied`) : flag('theme', 'minor', `${t} mismatch`, applied);
  }
}

// ============================================================
// [5b] SIDEBAR collapse persists
// ============================================================
console.log('\n=== [5b] SIDEBAR collapse ===');
await p.click('.sidebar-toggle');
await p.waitForTimeout(200);
const collapsed = await p.evaluate(() => document.querySelector('#view-reader .app').classList.contains('sidebar-collapsed'));
collapsed ? ok('sidebar', 'collapse class applied') : flag('sidebar', 'minor', 'collapse did not engage');
await p.reload();
await p.waitForTimeout(400);
const persisted = await p.evaluate(() => document.querySelector('#view-reader .app')?.classList.contains('sidebar-collapsed'));
persisted ? ok('sidebar', 'collapse persisted across reload') : flag('sidebar', 'minor', 'collapse not persisted');
// restore
await p.click('.sidebar-toggle');
await p.waitForTimeout(200);

// ============================================================
// [5c] EDIT-MESSAGE button reveals on hover
// ============================================================
console.log('\n=== [5c] EDIT message ===');
// Need a tutor conversation; intercept tutor PUT to seed
await p.evaluate(async (slug) => {
  await fetch(`/api/tutor/${encodeURIComponent(slug)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ history: [
      { role: 'user', content: 'first user message' },
      { role: 'assistant', content: 'first assistant reply' },
    ] }),
  });
}, SLUG);
await p.click('#btn-tutor');
await p.waitForFunction(() => document.querySelectorAll('.sg-chat-messages .sg-chat-msg').length >= 2);
const userMsgs = await p.evaluate(() => {
  const u = document.querySelector('.sg-chat-messages .sg-chat-msg.user');
  return { exists: !!u, hasEdit: !!u?.querySelector('.sg-chat-msg-edit-btn') };
});
userMsgs.exists && userMsgs.hasEdit ? ok('edit', 'edit button on user msg') : flag('edit', 'major', 'edit button missing', userMsgs);
await p.click('[data-action="close-chat"]');
await p.waitForTimeout(200);

// ============================================================
// [5d] DARK MODE visual sweep — capture screenshots
// ============================================================
console.log('\n=== [5d] DARK MODE visual ===');
await p.evaluate(() => { localStorage.setItem('sg-theme', 'dark'); });
await p.reload();
await p.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
await p.waitForTimeout(400);
await p.screenshot({ path: '/tmp/audit-reader-dark.png' });
await p.goto(`${BASE}/#/`);
await p.waitForTimeout(400);
await p.screenshot({ path: '/tmp/audit-home-dark.png' });
ok('dark', 'screenshots captured for review');
await p.evaluate(() => { localStorage.setItem('sg-theme', 'light'); });

// ============================================================
// [6] PAGE error sweep
// ============================================================
console.log('\n=== [6] CONSOLE ERRORS ===');
if (consoleErrors.length === 0) ok('errors', 'no console errors during audit');
else for (const e of consoleErrors) flag('errors', 'major', e);

// Final cleanup
await b.close();
try { rmSync(DIR, { recursive: true, force: true }); } catch {}

// Summary
console.log('\n=== SUMMARY ===');
console.log(`${issues.length} issues found:`);
const bySev = { major: 0, minor: 0 };
for (const i of issues) { bySev[i.severity] = (bySev[i.severity] || 0) + 1; console.log(`  ${i.severity.toUpperCase()} [${i.area}] ${i.msg}`); }
console.log(`major: ${bySev.major}, minor: ${bySev.minor}`);
process.exit(bySev.major ? 1 : 0);
