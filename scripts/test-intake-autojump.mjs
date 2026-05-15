// Verify: after curriculum.md lands on disk for the intake's track, the
// client auto-jumps from #/t/<slug>/intake to #/t/<slug>/ (reader).
// Driven by the SSE `curriculum-change` event the server emits via the
// watcher + the explicit broadcast on the intake finalize done path.
//
// Also confirms the "skip for now" button is gone — it was redundant
// with the StudyGround brand-link / home navigation.
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

// 1. "skip for now" should be gone
const skipExists = await p.evaluate(() => !!document.querySelector('[data-action="skip-intake"]'));
console.log(`(1) skip-intake button present: ${skipExists}  (want false)`);

// 2. While we're on the intake view, write curriculum.md → SSE should fire,
//    client should navigate to #/t/<slug>/
const beforeHash = await p.evaluate(() => location.hash);
console.log(`(2) before write, hash = ${beforeHash}`);
writeFileSync(join(DIR, 'curriculum.md'), '---\nslug: test\nfinalized: 2026-05-14\n---\n# Curriculum\n\n## Plan\n1. lesson — scope\n');
// Wait long enough for: watcher debounce (200ms) + watcher attach + fs event + SSE roundtrip
await p.waitForTimeout(1800);
const afterHash = await p.evaluate(() => location.hash);
console.log(`(3) after write, hash = ${afterHash}`);

await p.screenshot({ path: '/tmp/intake-autojump.png', fullPage: false });

let failed = 0;
if (skipExists) { console.log('FAIL: skip-intake button still present'); failed++; }
if (beforeHash !== `#/t/${SLUG}/intake/`) { console.log(`FAIL: not on intake view to start (${beforeHash})`); failed++; }
if (afterHash !== `#/t/${SLUG}/`) { console.log(`FAIL: did not auto-jump to reader (${afterHash})`); failed++; }

console.log(`\n${failed === 0 ? 'all green' : failed + ' failing'}`);
await b.close();
try { rmSync(DIR, { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
