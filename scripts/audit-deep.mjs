// Deeper audit: less-trodden flows + odd viewports + focus indicators.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:4321';
const TRACKS = '/home/LYP/studyground/tracks';
const SLUG = 'audit-deep';
const DIR = join(TRACKS, SLUG);

function ensureFixture() {
  if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, 'lessons'), { recursive: true });
  mkdirSync(join(DIR, 'materials'), { recursive: true });
  writeFileSync(join(DIR, 'track.json'), JSON.stringify({
    slug: SLUG, title: 'Audit Deep', description: 'deeper flows', emoji: '🧪',
    created_at: '2026-05-14', updated_at: '2026-05-14',
  }, null, 2));
  writeFileSync(join(DIR, 'curriculum.md'), '# Curriculum\n\n1. 01-lesson\n');
  writeFileSync(join(DIR, 'lessons', '01-lesson.md'), `---
title: A lesson
track: ${SLUG}
estimated_minutes: 5
---

# A lesson

## Section one

A paragraph of text. This sentence has several words that someone might want to highlight for a BTW chat.

## Section two

Another paragraph here for testing.
`);
}
ensureFixture();

const issues = [];
function flag(area, sev, msg, extra) { issues.push({ area, sev, msg, extra }); console.log(`[${sev.toUpperCase()}] ${area}: ${msg}` + (extra?' — '+JSON.stringify(extra):'')); }
function ok(area, msg) { console.log(`  ok  ${area}: ${msg}`); }

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 1600, height: 1000 } });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', e => errs.push('pageerror: ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

// ============================================================
// [1] Materials upload + auto-rename on collision
// ============================================================
console.log('\n=== [1] Materials upload ===');
const u1 = await fetch(`${BASE}/api/tracks/${SLUG}/materials?name=cheatsheet.md`, {
  method: 'POST', headers: {'Content-Type':'application/octet-stream'}, body: 'first version',
}).then(r => r.json());
u1.ok && !u1.renamed ? ok('materials', 'first upload') : flag('materials', 'major', 'first upload', u1);

const u2 = await fetch(`${BASE}/api/tracks/${SLUG}/materials?name=cheatsheet.md`, {
  method: 'POST', headers: {'Content-Type':'application/octet-stream'}, body: 'second version',
}).then(r => r.json());
u2.ok && u2.renamed && u2.name === 'cheatsheet (2).md' ? ok('materials', 'auto-rename on collision') : flag('materials', 'major', 'collision', u2);

// Materials list visible in sidebar
await p.goto(`${BASE}/#/t/${SLUG}/`);
await p.waitForFunction(() => document.querySelectorAll('#sidebar-materials li').length >= 2);
const matCount = await p.evaluate(() => [...document.querySelectorAll('#sidebar-materials li')].filter(li => !li.classList.contains('hint')).length);
matCount === 2 ? ok('materials', `${matCount} materials listed in sidebar`) : flag('materials', 'minor', 'sidebar count', { matCount });

// ============================================================
// [2] BTW outline section button
// ============================================================
console.log('\n=== [2] BTW outline btn ===');
await p.evaluate(() => {
  const orig = window.fetch.bind(window);
  window.fetch = function (i, init) {
    const url = typeof i === 'string' ? i : i?.url || '';
    if ((init?.method||'').toUpperCase() === 'POST' && url.endsWith('/api/btw-ask')) {
      const enc = new TextEncoder();
      const body = new ReadableStream({
        async pull(c) {
          c.enqueue(enc.encode('data: ' + JSON.stringify({type:'delta',text:'ok'}) + '\n\n'));
          c.enqueue(enc.encode('data: ' + JSON.stringify({type:'done', duration_ms:1, cost_usd:0.001, thread_id:'fake'}) + '\n\n'));
          c.close();
        }
      });
      return Promise.resolve(new Response(body, {status:200, headers:{'Content-Type':'text/event-stream'}}));
    }
    return orig(i, init);
  };
});
// Hover an outline-li to surface its btw button, then click it
await p.locator('#outline-rail .outline-li').first().hover();
await p.waitForTimeout(150);
await p.locator('#outline-rail .outline-li').first().locator('.outline-btw').click({ force: true });
await p.waitForFunction(() => document.querySelector('.sg-chat-panel.show'));
const panel = await p.evaluate(() => ({
  shown: !!document.querySelector('.sg-chat-panel.show'),
  selection: document.querySelector('.sg-chat-selection')?.textContent?.trim()?.slice(0, 60),
}));
panel.shown && panel.selection?.includes('Section one') ? ok('btw-outline', 'opens chat with section text') : flag('btw-outline', 'major', 'btw outline click', panel);
await p.click('[data-action="close-chat"]');
await p.waitForTimeout(150);

// ============================================================
// [3] Mid-narrow viewport — does layout break at < 1100?
// ============================================================
console.log('\n=== [3] Narrow viewport ===');
for (const w of [800, 1000, 1100, 1400]) {
  await p.setViewportSize({ width: w, height: 900 });
  await p.waitForTimeout(250);
  const state = await p.evaluate(() => {
    const main = document.querySelector('main#lesson-view');
    const sb = document.getElementById('sidebar');
    const r1 = main.getBoundingClientRect();
    const r2 = sb.getBoundingClientRect();
    return {
      vp: window.innerWidth,
      mainW: Math.round(r1.width),
      mainOverflow: r1.right > window.innerWidth,
      sbW: Math.round(r2.width),
      rail: getComputedStyle(document.getElementById('outline-rail')).display,
      toggle: getComputedStyle(document.getElementById('outline-toggle')).display,
    };
  });
  state.mainOverflow ? flag('narrow', 'major', `main overflows at vp=${w}`, state) : ok('narrow', `vp=${w}: main fits, rail=${state.rail}, toggle=${state.toggle}, sbW=${state.sbW}`);
}
await p.setViewportSize({ width: 1600, height: 900 });

// ============================================================
// [4] Focus indicators — Tab through interactive elements
// ============================================================
console.log('\n=== [4] Focus indicators ===');
await p.goto(`${BASE}/#/`);
await p.waitForSelector('.track-card');
await p.waitForTimeout(300);
await p.evaluate(() => document.body.focus());
const focusables = await p.evaluate(() => {
  const els = [...document.querySelectorAll('button, a, [tabindex], input')].filter(el => el.offsetParent !== null);
  return els.length;
});
focusables > 5 ? ok('focus', `${focusables} focusable elements on home`) : flag('focus', 'minor', 'few focusables', { focusables });
// Tab once, check focus visible
await p.keyboard.press('Tab');
await p.waitForTimeout(100);
const focused = await p.evaluate(() => {
  const el = document.activeElement;
  return el && el !== document.body ? { tag: el.tagName, cls: el.className?.toString()?.slice(0, 40), text: el.textContent?.trim().slice(0, 40) } : null;
});
focused ? ok('focus', `tab moves focus → ${focused.tag} "${focused.text}"`) : flag('focus', 'minor', 'tab did not move focus');

// ============================================================
// [5] Tutor FAB position vs chat-resize edge case
// ============================================================
console.log('\n=== [5] FAB position ===');
await p.goto(`${BASE}/#/t/${SLUG}/`);
await p.waitForFunction(() => document.querySelector('.tutor-fab'));
await p.waitForTimeout(300);
// Mock tutor stream so panel opens cleanly
await p.evaluate(() => {
  const orig = window.fetch.bind(window);
  window.fetch = function (i, init) {
    const url = typeof i === 'string' ? i : i?.url || '';
    if ((init?.method||'').toUpperCase() === 'POST' && url.endsWith('/api/tutor')) {
      const enc = new TextEncoder();
      const body = new ReadableStream({
        async pull(c) {
          c.enqueue(enc.encode('data: ' + JSON.stringify({type:'delta',text:'reply'}) + '\n\n'));
          await new Promise(r => setTimeout(r, 100));
          c.enqueue(enc.encode('data: ' + JSON.stringify({type:'done', duration_ms:100, cost_usd:0.001}) + '\n\n'));
          c.close();
        }
      });
      return Promise.resolve(new Response(body, {status:200, headers:{'Content-Type':'text/event-stream'}}));
    }
    return orig(i, init);
  };
});
await p.click('#btn-tutor');
await p.waitForFunction(() => document.body.classList.contains('sg-chat-open'));
await p.waitForTimeout(200);
const fab = await p.evaluate(() => {
  const f = document.querySelector('.tutor-fab').getBoundingClientRect();
  const panel = document.querySelector('.sg-chat-panel').getBoundingClientRect();
  return {
    fabRight: Math.round(window.innerWidth - f.right),
    fabLeft: Math.round(f.left),
    panelLeft: Math.round(panel.left),
    fabOverlapsPanel: f.right > panel.left,
  };
});
!fab.fabOverlapsPanel ? ok('fab', 'FAB clears chat panel') : flag('fab', 'major', 'FAB overlaps panel', fab);
// Now resize chat to extreme width
await p.evaluate(() => document.documentElement.style.setProperty('--sg-chat-width', '900px'));
await p.evaluate(() => window.dispatchEvent(new Event('resize')));
await p.waitForTimeout(200);
const fab2 = await p.evaluate(() => {
  const f = document.querySelector('.tutor-fab').getBoundingClientRect();
  const panel = document.querySelector('.sg-chat-panel').getBoundingClientRect();
  return { fabRight: Math.round(window.innerWidth - f.right), panelLeft: Math.round(panel.left), overlap: f.right > panel.left };
});
!fab2.overlap ? ok('fab', 'FAB shifts left with resized panel') : flag('fab', 'major', 'FAB overlaps wider panel', fab2);
await p.evaluate(() => document.documentElement.style.setProperty('--sg-chat-width', '440px'));
await p.click('[data-action="close-chat"]');

// ============================================================
// [6] Course CREATE flow
// ============================================================
console.log('\n=== [6] Create new course ===');
await p.goto(`${BASE}/#/`);
await p.waitForSelector('.track-card.create');
await p.click('.track-card.create');
await p.waitForSelector('#new-track-dialog[open]');
await p.fill('#nt-title', 'Audit New Course');
await p.fill('#nt-desc', 'test');
await Promise.all([
  p.waitForResponse(r => r.url().endsWith('/api/tracks') && r.request().method() === 'POST'),
  p.click('#new-track-form button[type="submit"]'),
]);
await p.waitForFunction(() => location.hash.endsWith('/intake'));
ok('create', 'new track → intake');
const createdTitle = await p.evaluate(() => document.getElementById('intake-track-name')?.textContent);
createdTitle?.includes('Audit New Course') ? ok('create', 'intake shows new track name') : flag('create', 'minor', 'intake title', { createdTitle });
// Clean up the newly created track
const newSlug = await p.evaluate(() => {
  const m = location.hash.match(/\/t\/([^/]+)\//);
  return m ? decodeURIComponent(m[1]) : null;
});
if (newSlug) await fetch(`${BASE}/api/tracks/${newSlug}`, { method: 'DELETE' }).catch(() => {});

// ============================================================
// [7] Console error sweep
// ============================================================
console.log('\n=== [7] Console errors ===');
if (errs.length === 0) ok('errors', 'no errors');
else for (const e of errs) flag('errors', 'major', e);

await b.close();
try { rmSync(DIR, { recursive: true, force: true }); } catch {}

console.log('\n=== SUMMARY ===');
const major = issues.filter(i => i.sev === 'major').length;
const minor = issues.filter(i => i.sev === 'minor').length;
console.log(`${major} major, ${minor} minor`);
for (const i of issues) console.log(`  ${i.sev.toUpperCase()} [${i.area}] ${i.msg}`);
process.exit(major ? 1 : 0);
