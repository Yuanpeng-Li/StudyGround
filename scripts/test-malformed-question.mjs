// Verify: when the `learn` skill writes a malformed details block
//   <details><summary>?> question</summary>body</details>
// or
//   <details><summary>?>> question</summary>body</details>
// the reader's mergeQuestionBlocks fix-up rewrites it into the proper
// rounded .sg-question shape (label + question text in summary, body
// below) instead of showing the bare `?>` / `?>>` marker.
//
// Run: node scripts/test-malformed-question.mjs
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:4321';
const TRACKS = '/home/LYP/studyground/tracks';
const SLUG = 'malformed-q-test';
const DIR = join(TRACKS, SLUG);

if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
mkdirSync(join(DIR, 'lessons'), { recursive: true });
writeFileSync(join(DIR, 'track.json'), JSON.stringify({
  slug: SLUG, title: 'Malformed Q', description: 'check the fix-up', emoji: '🔧',
  created_at: '2026-05-14', updated_at: '2026-05-14',
}));
writeFileSync(join(DIR, 'curriculum.md'), '# C\n');
writeFileSync(join(DIR, 'lessons', '01-malformed.md'), `---
title: malformed test
track: ${SLUG}
estimated_minutes: 5
---

# Malformed test

Lead-in.

<details>
<summary>?> 既然每个位置都要 attend 到前面所有位置，inference 是不是每生成一个 token 都要把整个前缀重算一遍？</summary>

朴素实现下，确实是这样 — 复杂度 $O(T^2 \\cdot N)$。

</details>

<details>
<summary>?>> 为什么不用 $\\sqrt{d_k}$ 之外的归一化？</summary>

因为方差刚好回到 1。

</details>

A normal disclosure below should stay untouched.

<details>
<summary>regular details</summary>
plain body
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
await p.waitForTimeout(500);

const html = await p.evaluate(() => document.querySelector('#lesson-view').innerHTML);
console.log('---- rendered HTML ----');
console.log(html.slice(0, 2400));
console.log('-----------------------');

const result = await p.evaluate(() => {
  const all = [...document.querySelectorAll('main details')];
  return all.map((d) => {
    const summary = d.querySelector(':scope > summary');
    return {
      classes: d.className,
      open: d.open,
      summaryText: summary?.textContent?.trim()?.slice(0, 70),
      summaryHasMarker: /\?>{1,2}/.test(summary?.textContent || ''),
      summaryHasLabel: !!summary?.querySelector('.sg-q-label'),
      summaryLabelText: summary?.querySelector('.sg-q-label')?.textContent?.trim(),
      hasBody: !!d.querySelector(':scope > .sg-question-body'),
      bodyKatex: d.querySelectorAll(':scope > .sg-question-body .katex').length,
      summaryKatex: summary?.querySelectorAll('.katex').length || 0,
      summaryRawDollars: /\$[^\s$][^$]*\$/.test(summary?.innerHTML || '') ? 1 : 0,
    };
  });
});
console.log('details on page:');
for (const r of result) console.log(' ', r);

await p.screenshot({ path: '/tmp/malformed-q.png', fullPage: false });
console.log('  → /tmp/malformed-q.png');

// Expect 3 details: q-merged, btw-merged, regular (untouched).
let failed = 0;
const qDet = result.find((r) => r.classes.includes('sg-question') && !r.classes.includes('btw'));
const btwDet = result.find((r) => r.classes.includes('sg-question') && r.classes.includes('btw'));
const plainDet = result.find((r) => !r.classes.includes('sg-question'));

if (!qDet) { console.log('FAIL: no merged q details found'); failed++; }
else {
  if (qDet.summaryHasMarker) { console.log(`FAIL: q summary still shows ?> marker (${qDet.summaryText})`); failed++; }
  if (!qDet.summaryHasLabel || qDet.summaryLabelText !== 'q') { console.log(`FAIL: q label missing/wrong (${qDet.summaryLabelText})`); failed++; }
  if (!qDet.hasBody) { console.log('FAIL: q has no body wrapper'); failed++; }
  if (qDet.open) { console.log('FAIL: q with pre-written answer should default to collapsed'); failed++; }
}
if (!btwDet) { console.log('FAIL: no merged btw details found'); failed++; }
else {
  if (btwDet.summaryHasMarker) { console.log(`FAIL: btw summary still shows ?>> marker (${btwDet.summaryText})`); failed++; }
  if (!btwDet.summaryHasLabel || btwDet.summaryLabelText !== 'deeper') { console.log(`FAIL: deeper label missing/wrong (${btwDet.summaryLabelText})`); failed++; }
  if (btwDet.summaryKatex < 1) { console.log(`FAIL: math in btw summary did not render (katex count ${btwDet.summaryKatex})`); failed++; }
  if (btwDet.summaryRawDollars > 0) { console.log('FAIL: btw summary still shows raw $...$'); failed++; }
}
if (!plainDet) { console.log('FAIL: plain details was rewritten (should stay untouched)'); failed++; }
else if (plainDet.summaryText !== 'regular details') { console.log(`FAIL: plain details summary changed (got ${plainDet.summaryText})`); failed++; }

console.log(`\n${failed === 0 ? 'all green' : failed + ' failing'}`);
await b.close();
try { rmSync(DIR, { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
