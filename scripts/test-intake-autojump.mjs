// Plan-mode behaviour: when curriculum.md lands on disk while the user is
// on the intake/plan view, the client should NOT bounce to the reader.
// Instead, the right pane (`#intake-plan-body`) should refresh in place
// and the view's data-phase should switch to `has-plan`. This is the new
// post-rework contract — the old "auto-jump to reader" was removed because
// it killed the iterate → comment → regenerate loop.
import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:4321';
const TRACKS = '/home/LYP/studyground/tracks';
const SLUG = `intake-autojump-${Date.now()}`;
const DIR = join(TRACKS, SLUG);

if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
writeFileSync(join(DIR, 'track.json'), JSON.stringify({
  slug: SLUG, title: 'Auto-jump', description: 't', emoji: '🚀',
  created_at: '2026-05-14', updated_at: '2026-05-14',
}));

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1400, height: 900 });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await p.goto(`${BASE}/`);
await p.evaluate(() => localStorage.setItem('sg-theme', 'light'));
await p.goto(`${BASE}/#/t/${SLUG}/intake/`);
await p.waitForSelector('#intake-input', { state: 'visible' });
await p.waitForTimeout(500);

// 1. "skip for now" should be gone (legacy check, retained)
const skipExists = await p.evaluate(() => !!document.querySelector('[data-action="skip-intake"]'));
console.log(`(1) skip-intake button present: ${skipExists}  (want false)`);

// 2. Initial phase should be `pre-plan` (no curriculum yet)
const phaseBefore = await p.evaluate(() => document.getElementById('view-intake').dataset.phase);
console.log(`(2) phase before write: ${phaseBefore}  (want pre-plan)`);

// 3. Write curriculum.md → SSE fires → right pane refreshes in place,
//    NO navigation to reader.
const beforeHash = await p.evaluate(() => location.hash);
console.log(`(3) before write, hash = ${beforeHash}`);
writeFileSync(join(DIR, 'curriculum.md'),
  '---\nslug: test\nfinalized: 2026-05-14\n---\n# Curriculum\n\n## Plan\n1. lesson — scope\n');
// Wait long enough for: watcher debounce (200ms) + watcher attach + fs event + SSE roundtrip + fetch
await p.waitForTimeout(1800);
const afterHash = await p.evaluate(() => location.hash);
const phaseAfter = await p.evaluate(() => document.getElementById('view-intake').dataset.phase);
const planBodyHasContent = await p.evaluate(() => {
  const el = document.getElementById('intake-plan-body');
  return !!el && /lesson — scope/.test(el.textContent || '');
});
console.log(`(4) after write, hash = ${afterHash}`);
console.log(`(5) after write, phase = ${phaseAfter}  (want has-plan)`);
console.log(`(6) plan body shows curriculum content: ${planBodyHasContent}  (want true)`);

await p.screenshot({ path: '/tmp/intake-autojump.png', fullPage: false });

let failed = 0;
if (skipExists) { console.log('FAIL: skip-intake button still present'); failed++; }
if (beforeHash !== `#/t/${SLUG}/intake/`) { console.log(`FAIL: not on intake view to start (${beforeHash})`); failed++; }
if (phaseBefore !== 'pre-plan') { console.log(`FAIL: phase before should be pre-plan (got ${phaseBefore})`); failed++; }
// Critical: must NOT have navigated to the reader.
if (afterHash !== `#/t/${SLUG}/intake/`) { console.log(`FAIL: navigated away from intake (${afterHash}) — plan-mode should refresh in place`); failed++; }
if (phaseAfter !== 'has-plan') { console.log(`FAIL: phase did not switch to has-plan (got ${phaseAfter})`); failed++; }
if (!planBodyHasContent) { console.log('FAIL: plan body does not show curriculum content'); failed++; }

console.log(`\n${failed === 0 ? 'all green' : failed + ' failing'}`);
await b.close();
try { rmSync(DIR, { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
