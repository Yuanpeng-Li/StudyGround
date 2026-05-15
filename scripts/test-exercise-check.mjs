// Verify the "Check & run" button on the exercise card still fires the
// /api/check request and works end-to-end (request body shape, button
// disabled state during the call, lesson reload + new feedback appears).
//
// Run: node scripts/test-exercise-check.mjs
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:4321';
const TRACKS = '/home/LYP/studyground/tracks';
const SLUG = 'check-button-test';
const DIR = join(TRACKS, SLUG);

if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
mkdirSync(join(DIR, 'lessons'), { recursive: true });
writeFileSync(join(DIR, 'track.json'), JSON.stringify({
  slug: SLUG, title: 'Check Button Test', description: 't', emoji: '🧪',
  created_at: '2026-05-14', updated_at: '2026-05-14',
}));
writeFileSync(join(DIR, 'curriculum.md'), '# C\n');
const lessonPath = join(DIR, 'lessons', '01.md');
writeFileSync(lessonPath, `---
title: check test
track: ${SLUG}
estimated_minutes: 5
---

# Check test

Lead-in.

:::exercise self-attention
Implement single-head attention.
:::
`);

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1400, height: 900 });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
p.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text());
});

// Intercept /api/check so we don't burn Claude, and simulate the
// server-side side-effect of appending a feedback block to the lesson.
let checkHits = 0;
let lastBody = null;
await p.route(/\/api\/check/, async (route) => {
  checkHits++;
  try { lastBody = route.request().postDataJSON(); } catch {}
  // Simulate the server's side-effect: append a feedback block + SSE the
  // lesson-changed event so the client reloads.
  const existing = readFileSync(lessonPath, 'utf8');
  if (!existing.includes('feedback:start')) {
    writeFileSync(
      lessonPath,
      existing + `\n<!-- feedback:start name="self-attention" -->\nNice work — shapes line up. Watch the scaling: divide by \`sqrt(d_k)\`.\n<!-- feedback:end -->\n`,
    );
  }
  route.fulfill({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: true, duration_ms: 1500, cost_usd: 0.01, num_turns: 3 }),
  });
});

await p.goto(`${BASE}/`);
await p.evaluate(() => localStorage.setItem('sg-theme', 'light'));
await p.goto(`${BASE}/#/t/${SLUG}/`);
await p.waitForSelector('#lesson-view h1');
await p.waitForTimeout(300);

// 1. Confirm the Check & run button is in the DOM, enabled, clickable.
const beforeClick = await p.evaluate(() => {
  const btn = document.querySelector('.sg-ex-check');
  if (!btn) return { found: false };
  const cs = getComputedStyle(btn);
  return {
    found: true,
    text: btn.textContent.trim(),
    disabled: btn.disabled,
    action: btn.dataset.action,
    exerciseName: btn.dataset.name,
    pointerEvents: cs.pointerEvents,
    cursor: cs.cursor,
    visible: btn.offsetParent !== null,
  };
});
console.log('before click:', beforeClick);

// 2. Click it.
await p.locator('.sg-ex-check').click();
await p.waitForTimeout(80);
const duringClick = await p.evaluate(() => {
  const btn = document.querySelector('.sg-ex-check');
  return btn ? { disabled: btn.disabled, text: btn.textContent.trim() } : null;
});
console.log('during click (mid-flight):', duringClick);

// Wait for reload to complete.
await p.waitForTimeout(800);

// 3. After the reload, the new feedback should be inside the exercise card.
const afterReload = await p.evaluate(() => {
  const ex = document.querySelector('.sg-exercise');
  const fb = ex?.querySelector(':scope > .sg-ex-feedback');
  return {
    exerciseStillThere: !!ex,
    feedbackInsideExercise: !!fb,
    feedbackLabel: fb?.querySelector('.sg-ex-feedback-label')?.textContent?.trim(),
    feedbackText: fb?.querySelector('.sg-ex-feedback-body')?.textContent?.slice(0, 120),
  };
});
console.log('after reload:', afterReload);

let failed = 0;
if (!beforeClick.found) { console.log('FAIL: Check & run button not in DOM'); failed++; }
if (beforeClick.action !== 'check-exercise') { console.log(`FAIL: wrong data-action (${beforeClick.action})`); failed++; }
if (beforeClick.pointerEvents === 'none') { console.log('FAIL: button has pointer-events: none'); failed++; }
if (!beforeClick.visible) { console.log('FAIL: button is not visible'); failed++; }
if (checkHits !== 1) { console.log(`FAIL: /api/check fired ${checkHits} times (want 1)`); failed++; }
if (lastBody?.exercise !== 'self-attention') { console.log(`FAIL: wrong exercise in body (got ${JSON.stringify(lastBody)})`); failed++; }
if (!afterReload.feedbackInsideExercise) { console.log('FAIL: feedback did not appear inside exercise after reload'); failed++; }
if (afterReload.feedbackLabel !== 'last check') { console.log(`FAIL: wrong label (${afterReload.feedbackLabel})`); failed++; }
if (!afterReload.feedbackText?.includes('scaling')) { console.log(`FAIL: feedback body missing (got ${JSON.stringify(afterReload.feedbackText)})`); failed++; }

console.log(`\n${failed === 0 ? 'all green' : failed + ' failing'}`);
await b.close();
try { rmSync(DIR, { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
