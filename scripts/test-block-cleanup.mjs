// Verify the block-set cleanup:
//   1. .sg-feedback gets merged INTO its matching .sg-exercise as
//      .sg-ex-feedback (single closed-loop card; no sibling card below).
//   2. Blockquote renders as a quiet italic indent — no border / no bg
//      card.
//   3. Standalone <details> (no preceding ?>>) still renders sanely
//      (it inherits the coral wash but is no longer the recommended
//      primitive).
//
// Run: node scripts/test-block-cleanup.mjs
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:4321';
const TRACKS = '/home/LYP/studyground/tracks';
const SLUG = 'block-cleanup-test';
const DIR = join(TRACKS, SLUG);

if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
mkdirSync(join(DIR, 'lessons'), { recursive: true });
writeFileSync(join(DIR, 'track.json'), JSON.stringify({
  slug: SLUG, title: 'Block cleanup', description: 't', emoji: '🧱',
  created_at: '2026-05-14', updated_at: '2026-05-14',
}));
writeFileSync(join(DIR, 'curriculum.md'), '# C\n');
writeFileSync(join(DIR, 'lessons', '01.md'), `---
title: cleanup
track: ${SLUG}
estimated_minutes: 5
---

# Cleanup

Some intro prose.

> Quoted from the original paper: attention is all you need. The block
> spans two lines so we can see the styling settles down.

:::exercise self-attention
Implement single-head attention in NumPy.
:::

<!-- feedback:start name="self-attention" -->
Nice — your shapes line up. One thought: \`Q @ K.T\` is fine but watch out
for the **scaling**: divide by \`sqrt(d_k)\` before softmax.
<!-- feedback:end -->

A standalone disclosure (should *not* be the recommended primitive but
must still render):

<details>
<summary>old-style fold</summary>
Body of a standalone details.
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

const result = await p.evaluate(() => {
  const ex = document.querySelector('.sg-exercise');
  const standaloneFb = document.querySelector('main > .sg-feedback');
  const exFeedback = ex?.querySelector(':scope > .sg-ex-feedback');
  const bq = document.querySelector('main blockquote');
  const standaloneDetails = [...document.querySelectorAll('main > details')]
    .find((d) => !d.classList.contains('sg-question'));
  const bqStyle = bq ? getComputedStyle(bq) : null;
  return {
    exerciseFound: !!ex,
    feedbackInsideExercise: !!exFeedback,
    standaloneFeedbackOutside: !!standaloneFb,
    feedbackLabel: exFeedback?.querySelector('.sg-ex-feedback-label')?.textContent?.trim(),
    feedbackHasBody: !!exFeedback?.querySelector('.sg-ex-feedback-body'),
    feedbackBodyText: exFeedback?.querySelector('.sg-ex-feedback-body')?.textContent?.slice(0, 200),

    bqBackground: bqStyle?.backgroundColor,
    bqBorderTop: bqStyle?.borderTopWidth,
    bqBorderLeft: bqStyle?.borderLeftWidth,
    bqFontStyle: bqStyle?.fontStyle,
    bqBorderRadius: bqStyle?.borderRadius,

    standaloneDetailsRenders: !!standaloneDetails,
    standaloneDetailsSummary: standaloneDetails?.querySelector('summary')?.textContent?.trim(),
  };
});
console.log(JSON.stringify(result, null, 2));

await p.screenshot({ path: '/tmp/block-cleanup.png', fullPage: false });
console.log('  → /tmp/block-cleanup.png');

let failed = 0;
if (!result.exerciseFound) { console.log('FAIL: exercise card missing'); failed++; }
if (!result.feedbackInsideExercise) { console.log('FAIL: feedback was not absorbed into the exercise card'); failed++; }
if (result.standaloneFeedbackOutside) { console.log('FAIL: stale .sg-feedback still rendered as a sibling card'); failed++; }
if (result.feedbackLabel !== 'last check') { console.log(`FAIL: feedback label = ${JSON.stringify(result.feedbackLabel)}, want "last check"`); failed++; }
if (!result.feedbackBodyText?.includes('scaling')) { console.log(`FAIL: feedback body content missing (got ${JSON.stringify(result.feedbackBodyText)})`); failed++; }

if (result.bqBackground && result.bqBackground !== 'rgba(0, 0, 0, 0)' && !result.bqBackground.includes('transparent')) {
  console.log(`FAIL: blockquote still has a background card (${result.bqBackground})`); failed++;
}
if (result.bqBorderTop && result.bqBorderTop !== '0px') { console.log(`FAIL: blockquote has top border (${result.bqBorderTop})`); failed++; }
if (!result.bqBorderLeft || result.bqBorderLeft === '0px') { console.log('FAIL: blockquote lost its left border indicator'); failed++; }
if (result.bqFontStyle !== 'italic') { console.log(`FAIL: blockquote not italic (got ${result.bqFontStyle})`); failed++; }

if (!result.standaloneDetailsRenders) { console.log('FAIL: standalone <details> did not render'); failed++; }

console.log(`\n${failed === 0 ? 'all green' : failed + ' failing'}`);
await b.close();
try { rmSync(DIR, { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
