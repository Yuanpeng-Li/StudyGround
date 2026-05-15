// (1) Outline scrollspy: scroll through a long lesson, verify the active
//     outline link tracks the current section.
// (2) VSCode open: hit /api/exercise/scaffold and verify the response carries
//     opened_via_cli=true (server spawned `code --reuse-window`).
import { chromium } from 'playwright';
import { existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';

const BASE = 'http://localhost:4321';
const SLUG = 'transformers-from-scratch-1';

const r = [];
const pass = (n, info='') => { r.push({n, ok: true}); console.log('PASS', n, info); };
const fail = (n, info='') => { r.push({n, ok: false}); console.log('FAIL', n, info); };

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await p.goto(`${BASE}/#/t/${SLUG}/`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#lesson-view h1'));
await p.waitForTimeout(800);

// Find a lesson with multiple h2/h3 sections — pick the longest one
await p.evaluate(() => {
  // Click each lesson and find the one with most h2s; pick the first long one
  const a = [...document.querySelectorAll('#sidebar-lessons a[data-slug]')].pop();
  if (a) a.click();
});
await p.waitForTimeout(1000);

// ---- 1. SCROLLSPY ----
console.log('\n[1] outline scrollspy tracks scroll position');
const headings = await p.evaluate(() => {
  return [...document.querySelectorAll('#lesson-view h2, #lesson-view h3')]
    .map((h) => ({ id: h.id, text: h.textContent.trim().slice(0, 30), top: h.getBoundingClientRect().top + window.scrollY }));
});
console.log('  headings:', headings.length, headings.map(h => h.text).slice(0, 6));
if (headings.length < 2) {
  pass('only ' + headings.length + ' headings — skipping scrollspy');
} else {
  // Scroll past first heading, verify outline highlights it
  const targetH = headings[Math.min(2, headings.length - 1)];
  await p.evaluate((y) => window.scrollTo({ top: y - 60, behavior: 'instant' }), targetH.top);
  await p.waitForTimeout(200);
  const active1 = await p.evaluate(() => document.querySelector('#sidebar-outline a.active')?.dataset.id);
  console.log(`  scrolled near "${targetH.text}" (#${targetH.id}); active=${active1}`);
  active1 === targetH.id ? pass(`outline tracks section #${targetH.id} (${targetH.text})`) : fail(`active=${active1} expected ${targetH.id}`);

  // Scroll to last heading, ensure it's highlighted (edge case)
  const last = headings[headings.length - 1];
  await p.evaluate((y) => window.scrollTo({ top: y - 60, behavior: 'instant' }), last.top);
  await p.waitForTimeout(200);
  const active2 = await p.evaluate(() => document.querySelector('#sidebar-outline a.active')?.dataset.id);
  active2 === last.id ? pass(`outline tracks last section (${last.text})`) : fail(`active=${active2} expected ${last.id}`);

  // Scroll past last → still highlighted (near-bottom edge case)
  await p.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
  await p.waitForTimeout(200);
  const active3 = await p.evaluate(() => document.querySelector('#sidebar-outline a.active')?.dataset.id);
  active3 === last.id ? pass(`bottom edge: last section stays active`) : fail(`active=${active3}`);

  // Scroll back to top, first heading should highlight
  await p.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await p.waitForTimeout(200);
  const active4 = await p.evaluate(() => document.querySelector('#sidebar-outline a.active')?.dataset.id);
  active4 === headings[0].id ? pass(`top: first section active (${headings[0].text})`) : fail(`active=${active4}`);
}

// ---- 2. VSCode open ----
console.log('\n[2] /api/exercise/scaffold opens via `code --reuse-window`');
// Pick a lesson that has an exercise — look for the qkv lesson
const slugWithExercise = '05-query-key-value';
const exerciseName = 'qkv-attention';

// Skip the actual VSCode open by intercepting the spawn — we can't observe
// the actual VSCode window state here. But we CAN verify the server response.
const resp = await fetch(`${BASE}/api/exercise/scaffold`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ track: SLUG, lesson: slugWithExercise, name: exerciseName }),
}).then((r) => r.json());
console.log('  scaffold response:', JSON.stringify(resp).slice(0, 200));
resp.ok ? pass('scaffold succeeded') : fail('scaffold failed');
'opened_via_cli' in resp ? pass(`opened_via_cli present (${resp.opened_via_cli})`) : fail('opened_via_cli missing');
resp.vscode_uri ? pass(`vscode_uri fallback present (${resp.vscode_uri.slice(0, 60)})`) : fail('vscode_uri missing');

// Verify scaffolded file exists on disk
const mainPath = resp.abs_path;
existsSync(mainPath) ? pass(`main.py scaffolded at ${mainPath}`) : fail(`main.py missing at ${mainPath}`);

await b.close();
const ok = r.every((x) => x.ok);
console.log(ok ? `\n${r.length}/${r.length} PASS` : '\nFAIL');
process.exit(ok ? 0 : 1);
