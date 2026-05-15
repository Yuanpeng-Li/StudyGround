// Verify: q + deeper blocks render as a single <details class="sg-question">
// where the question itself is the toggle (click to expand the answer,
// click again to collapse). Specifically:
//   - .sg-question is now <details>, not <div>
//   - There's no separate folded "deeper" details below for btw blocks
//   - There's no separate .sg-answer card below for q blocks
//   - For q blocks, the Ask button is inside the merged details body
//   - For deeper blocks, the body text moves inside the merged details
//
// Run: node scripts/test-merged-questions.mjs
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:4321';
const TRACKS = '/home/LYP/studyground/tracks';
const SLUG = 'merged-q-test';
const DIR = join(TRACKS, SLUG);

if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
mkdirSync(join(DIR, 'lessons'), { recursive: true });
writeFileSync(join(DIR, 'track.json'), JSON.stringify({
  slug: SLUG, title: 'Merged Q Test', description: 'q + deeper merge into one', emoji: '🧩',
  created_at: '2026-05-14', updated_at: '2026-05-14',
}));
writeFileSync(join(DIR, 'curriculum.md'), '# C\n');
writeFileSync(join(DIR, 'lessons', '01-merged.md'), `---
title: merged questions
track: ${SLUG}
estimated_minutes: 5
---

# Merged questions

Lead-in paragraph.

?> What is the smallest reproducible signal that the marker rendered correctly?

<!-- answer:pending -->

?> Is this Q answered already?

<!-- answer:start -->
Yes — the answer text lives inside the merged details body.
<!-- answer:end -->

?>> What did this side question turn up?

<details><summary>deeper</summary>

The short of it: the asker pinged with a quick check. Nothing in the exchange contradicts the paragraph it was anchored to.

If you're skimming for substance, there isn't much new here beyond the main text.

</details>
`);

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1500, height: 1100 });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await p.goto(`${BASE}/`);
await p.evaluate(() => localStorage.setItem('sg-theme', 'light'));
await p.goto(`${BASE}/#/t/${SLUG}/`);
await p.waitForSelector('#lesson-view h1');
await p.waitForTimeout(400);

const before = await p.evaluate(() => {
  const qs = document.querySelectorAll('.sg-question:not(.btw)');
  const qPending = qs[0];
  const qAnswered = qs[1];
  const btw = document.querySelector('.sg-question.btw');
  return {
    qTag: qPending?.tagName,
    qHasSummary: !!qPending?.querySelector(':scope > summary'),
    qOpen: qPending?.open,
    qBodyHasAsk: !!qPending?.querySelector(':scope .sg-question-body .ask-btn'),
    qBodyAnswerCount: qPending?.querySelectorAll(':scope .sg-question-body .sg-answer').length || 0,

    qAnsweredTag: qAnswered?.tagName,
    qAnsweredOpen: qAnswered?.open,
    qAnsweredBodyText: qAnswered?.querySelector(':scope .sg-question-body')?.textContent?.trim()?.slice(0, 80),
    qAnsweredHasAsk: !!qAnswered?.querySelector(':scope .ask-btn'),

    btwTag: btw?.tagName,
    btwHasSummary: !!btw?.querySelector(':scope > summary'),
    btwOpen: btw?.open,
    btwBodyChars: btw?.querySelector(':scope .sg-question-body')?.textContent?.trim()?.length || 0,
    btwBodyHasInnerDetails: !!btw?.querySelector(':scope .sg-question-body details'),

    standaloneDetailsCount: document.querySelectorAll('main > details, main details:not(.sg-question)').length,
    standaloneSgAnswer: document.querySelectorAll('main > .sg-answer').length,
  };
});
console.log('initial (collapsed):', before);

// Now click the q summary to expand it
await p.evaluate(() => {
  const q = document.querySelector('.sg-question:not(.btw)');
  q?.querySelector(':scope > summary')?.click();
});
await p.waitForTimeout(150);
const afterQClick = await p.evaluate(() => {
  const q = document.querySelector('.sg-question:not(.btw)');
  return {
    qOpen: q?.open,
    askVisible: q?.querySelector(':scope .sg-question-body .ask-btn')?.offsetParent !== null,
  };
});
console.log('after click q:', afterQClick);

// Click the deeper summary to expand
await p.evaluate(() => {
  const b = document.querySelector('.sg-question.btw');
  b?.querySelector(':scope > summary')?.click();
});
await p.waitForTimeout(150);
const afterBtwClick = await p.evaluate(() => {
  const b = document.querySelector('.sg-question.btw');
  const bodyText = b?.querySelector(':scope .sg-question-body')?.textContent?.trim() || '';
  return {
    btwOpen: b?.open,
    bodyVisible: !!b?.querySelector(':scope .sg-question-body')?.offsetParent,
    bodyHasShortText: bodyText.includes('quick check'),
  };
});
console.log('after click deeper:', afterBtwClick);

// Click again on deeper summary to collapse
await p.evaluate(() => {
  const b = document.querySelector('.sg-question.btw');
  b?.querySelector(':scope > summary')?.click();
});
await p.waitForTimeout(150);
const afterBtwCollapse = await p.evaluate(() => {
  const b = document.querySelector('.sg-question.btw');
  return { btwOpen: b?.open };
});
console.log('after re-click deeper:', afterBtwCollapse);

await p.screenshot({ path: '/tmp/merged-q.png', fullPage: false });
console.log('  → /tmp/merged-q.png');

let failed = 0;
if (before.qTag !== 'DETAILS') { console.log('FAIL: q block is not <details>'); failed++; }
if (before.btwTag !== 'DETAILS') { console.log('FAIL: btw block is not <details>'); failed++; }
if (!before.qHasSummary || !before.btwHasSummary) { console.log('FAIL: missing <summary> on merged block'); failed++; }
if (before.qOpen) { console.log('FAIL: q starts open (should be collapsed when pending)'); failed++; }
if (before.btwOpen) { console.log('FAIL: btw starts open (should be collapsed)'); failed++; }
if (!before.qBodyHasAsk) { console.log('FAIL: q body has no Ask button'); failed++; }
if (before.qBodyAnswerCount !== 1) { console.log(`FAIL: q body should contain exactly one .sg-answer (got ${before.qBodyAnswerCount})`); failed++; }
if (before.btwBodyHasInnerDetails) { console.log('FAIL: btw body still contains a nested <details> (merge incomplete)'); failed++; }
if (before.standaloneSgAnswer !== 0) { console.log(`FAIL: standalone .sg-answer leaked outside merged details (count ${before.standaloneSgAnswer})`); failed++; }
if (!afterQClick.qOpen || !afterQClick.askVisible) { console.log('FAIL: clicking q summary did not expand to show Ask'); failed++; }
if (!afterBtwClick.btwOpen || !afterBtwClick.bodyHasShortText) { console.log('FAIL: clicking deeper did not expand body'); failed++; }
if (afterBtwCollapse.btwOpen) { console.log('FAIL: re-clicking deeper did not collapse it'); failed++; }
if (before.qAnsweredTag !== 'DETAILS') { console.log('FAIL: answered q is not merged'); failed++; }
if (!before.qAnsweredOpen) { console.log('FAIL: answered q is not open by default'); failed++; }
if (!before.qAnsweredBodyText?.includes('answer text lives')) { console.log(`FAIL: answered q body missing expected text (got ${JSON.stringify(before.qAnsweredBodyText)})`); failed++; }
if (before.qAnsweredHasAsk) { console.log('FAIL: answered q still has an Ask button'); failed++; }

console.log(`\n${failed === 0 ? 'all green' : failed + ' failing'}`);

await b.close();
try { rmSync(DIR, { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
