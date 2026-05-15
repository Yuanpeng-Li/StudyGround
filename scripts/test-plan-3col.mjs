// 3-column plan view: materials | chat | plan, with a material viewer that
// slides in as a 4th column when a material is clicked. All adjacent panes
// are separated by drag-resizable handles. The materials column itself
// can be collapsed via the « toggle.
import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:4321';
const TRACKS = '/home/LYP/studyground/tracks';
const SLUG = `plan-3col-${Date.now()}`;
const DIR = join(TRACKS, SLUG);

function setup() {
  if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, 'lessons'), { recursive: true });
  mkdirSync(join(DIR, 'materials'), { recursive: true });
  writeFileSync(join(DIR, 'track.json'), JSON.stringify({
    slug: SLUG, title: '3-col layout', description: 't', emoji: '📐',
    created_at: '2026-05-14', updated_at: '2026-05-14',
  }));
  // A markdown material renders inline (no iframe) so the body text is
  // assertable without scraping the iframe contents.
  writeFileSync(join(DIR, 'materials', 'note.md'),
    '# Note\n\nA cheatsheet the tutor should ground the plan in.\n');
  // Curriculum.md so the view starts in has-plan phase (3-col).
  writeFileSync(join(DIR, 'curriculum.md'),
    '---\nslug: ' + SLUG + '\nfinalized: 2026-05-14\n---\n\n# Curriculum\n\n## Plan\n1. one\n2. two\n');
}
function teardown() { try { rmSync(DIR, { recursive: true, force: true }); } catch {} }

setup();

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1600, height: 1000 });
const errs = [];
p.on('pageerror', (e) => { errs.push(e.message); console.log('PAGEERROR:', e.message); });

let failed = 0;
const fail = (m) => { console.log('FAIL: ' + m); failed++; };

await p.goto(`${BASE}/`);
await p.evaluate(() => {
  localStorage.setItem('sg-theme', 'light');
  // Reset pane widths + collapse state so test runs deterministically
  localStorage.removeItem('sg.intakeMatCollapsed');
  for (const k of ['sg.intake--intake-mat-w','sg.intake--intake-mv-w','sg.intake--intake-plan-w']) {
    localStorage.removeItem(k);
  }
});
await p.goto(`${BASE}/#/t/${SLUG}/intake/`);
await p.waitForSelector('#intake-input', { state: 'visible' });
await p.waitForTimeout(700);

// (1) All 3 persistent panes visible; viewer + viewer-handle hidden
const panes = await p.evaluate(() => ({
  matVisible: !document.getElementById('intake-mat-pane').hidden,
  mvVisible: !document.getElementById('intake-mv-pane').hidden,
  chatVisible: !!document.querySelector('.intake-chat-pane'),
  planVisible: getComputedStyle(document.getElementById('intake-plan-pane')).display !== 'none',
  mvHandleHidden: document.querySelector('.intake-resize-handle[data-resize="mv"]').hidden,
  chatHandleVisible: getComputedStyle(document.querySelector('.intake-resize-handle[data-resize="chat"]')).display !== 'none',
}));
console.log('(1) panes:', JSON.stringify(panes));
if (!panes.matVisible) fail('materials pane not visible');
if (panes.mvVisible) fail('viewer pane should be hidden initially');
if (!panes.chatVisible) fail('chat pane missing');
if (!panes.planVisible) fail('plan pane should be visible in has-plan phase');
if (!panes.mvHandleHidden) fail('viewer handle should be hidden initially');
if (!panes.chatHandleVisible) fail('chat→plan handle should be visible in has-plan phase');

// (2) Materials list shows the .md row
await p.waitForFunction(() =>
  document.querySelectorAll('#intake-materials-list .material-item').length > 0,
  { timeout: 4000 },
);
const matRows = await p.evaluate(() =>
  Array.from(document.querySelectorAll('#intake-materials-list .material-item'))
    .map((n) => n.dataset.name));
console.log(`(2) materials rows: ${JSON.stringify(matRows)}`);
if (matRows.length !== 1 || matRows[0] !== 'note.md') fail(`expected 1 material 'note.md', got ${JSON.stringify(matRows)}`);

// (3) Click the material → viewer opens and renders the markdown body
await p.click('#intake-materials-list [data-action="open-material"]');
await p.waitForTimeout(500);
const viewer = await p.evaluate(() => ({
  visible: !document.getElementById('intake-mv-pane').hidden,
  name: document.getElementById('intake-mv-name').textContent,
  hasMd: !!document.querySelector('#intake-mv-body .material-md'),
  bodyText: (document.getElementById('intake-mv-body').textContent || '').trim().slice(0, 80),
  handleVisible: !document.querySelector('.intake-resize-handle[data-resize="mv"]').hidden,
}));
console.log('(3) viewer after click:', JSON.stringify(viewer));
if (!viewer.visible) fail('viewer did not open on click');
if (viewer.name !== 'note.md') fail(`viewer name wrong (${viewer.name})`);
if (!viewer.hasMd) fail('viewer did not render .md content');
if (!/cheatsheet/i.test(viewer.bodyText)) fail(`viewer body missing expected text (${viewer.bodyText})`);
if (!viewer.handleVisible) fail('viewer handle should appear when viewer is open');

// (4) Click again on the same material → toggle closes the viewer
await p.click('#intake-materials-list [data-action="open-material"]');
await p.waitForTimeout(300);
const viewerToggled = await p.evaluate(() => !document.getElementById('intake-mv-pane').hidden);
console.log(`(4) viewer after second click: visible=${viewerToggled}  (want false)`);
if (viewerToggled) fail('second click should close the viewer');

// (5) Drag the chat→plan handle to the LEFT (drag right→left makes plan wider).
// Using bounding-box drag is flaky; use page.mouse with explicit events.
const initialPlanW = await p.evaluate(() =>
  parseInt(getComputedStyle(document.documentElement).getPropertyValue('--intake-plan-w'), 10));
const handleBox = await p.evaluate(() => {
  const h = document.querySelector('.intake-resize-handle[data-resize="chat"]');
  const r = h.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await p.mouse.move(handleBox.x, handleBox.y);
await p.mouse.down();
await p.mouse.move(handleBox.x - 100, handleBox.y, { steps: 6 });
await p.mouse.up();
await p.waitForTimeout(150);
const finalPlanW = await p.evaluate(() =>
  parseInt(getComputedStyle(document.documentElement).getPropertyValue('--intake-plan-w'), 10));
console.log(`(5) plan width: ${initialPlanW}px → ${finalPlanW}px (want grew by ~100)`);
if (finalPlanW <= initialPlanW + 50) fail(`drag didn't grow plan width enough (${initialPlanW} → ${finalPlanW})`);

// (6) Toggle materials collapse → mat pane hidden, reopen tab visible
await p.click('[data-action="toggle-intake-mat"]');
await p.waitForTimeout(200);
const collapsed = await p.evaluate(() => ({
  matHidden: document.getElementById('intake-mat-pane').hidden,
  reopenVisible: !document.querySelector('.intake-mat-reopen').hidden,
  matHandleHidden: document.querySelector('.intake-resize-handle[data-resize="mat"]').hidden,
}));
console.log('(6) after collapse:', JSON.stringify(collapsed));
if (!collapsed.matHidden) fail('materials pane not collapsed');
if (!collapsed.reopenVisible) fail('reopen tab not visible after collapse');
if (!collapsed.matHandleHidden) fail('mat handle should hide when collapsed');

// (7) Click reopen tab → mat pane comes back
await p.click('.intake-mat-reopen');
await p.waitForTimeout(200);
const reopened = await p.evaluate(() => ({
  matVisible: !document.getElementById('intake-mat-pane').hidden,
  reopenHidden: document.querySelector('.intake-mat-reopen').hidden,
}));
console.log('(7) after reopen:', JSON.stringify(reopened));
if (!reopened.matVisible) fail('materials pane did not reopen');
if (!reopened.reopenHidden) fail('reopen tab should hide when expanded');

// (8) Width persistence: reload, --intake-plan-w should still be the new size
await p.reload();
await p.waitForSelector('#intake-input', { state: 'visible' });
await p.waitForTimeout(400);
const persistedPlanW = await p.evaluate(() =>
  parseInt(getComputedStyle(document.documentElement).getPropertyValue('--intake-plan-w'), 10));
console.log(`(8) plan width after reload: ${persistedPlanW}  (want close to ${finalPlanW})`);
if (Math.abs(persistedPlanW - finalPlanW) > 5) fail(`plan width did not persist (got ${persistedPlanW}, want ${finalPlanW})`);

await p.screenshot({ path: '/tmp/plan-3col.png', fullPage: false });

if (errs.length) fail(`${errs.length} pageerror(s): ${errs.join(' | ')}`);

console.log(`\n${failed === 0 ? 'all green' : failed + ' failing'}`);
await b.close();
teardown();
process.exit(failed === 0 ? 0 : 1);
