// Verify: when the user selects body text that contains rendered KaTeX
// and triggers the BTW ask flow, the resulting quote shown in the chat
// panel preserves real $...$ LaTeX (not the duplicated katex-html +
// katex-mathml flattening that produces gibberish like "QKTdkdkQKT").
//
// Run: node scripts/test-math-selection.mjs
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:4321';
const TRACKS = '/home/LYP/studyground/tracks';
const SLUG = 'math-selection-test';
const DIR = join(TRACKS, SLUG);

if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
mkdirSync(join(DIR, 'lessons'), { recursive: true });
writeFileSync(join(DIR, 'track.json'), JSON.stringify({
  slug: SLUG, title: 'Math Selection Test', description: 'check math copy/quote', emoji: '∑',
  created_at: '2026-05-14', updated_at: '2026-05-14',
}));
writeFileSync(join(DIR, 'curriculum.md'), '# C\n');
writeFileSync(join(DIR, 'lessons', '01-math.md'), `---
title: math selection
track: ${SLUG}
estimated_minutes: 5
---

# Math selection

矩阵 $QK^\\top/\\sqrt{d_k}$ 的上界由 softmax 的饱和性决定。
`);

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1400, height: 900 });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await p.goto(`${BASE}/`);
await p.evaluate(() => localStorage.setItem('sg-theme', 'light'));
await p.goto(`${BASE}/#/t/${SLUG}/`);
await p.waitForSelector('#lesson-view h1');
await p.waitForFunction(() => document.querySelector('#lesson-view p .katex'));
await p.waitForTimeout(200);

// Select the entire paragraph (containing the rendered $QK^\top/\sqrt{d_k}$)
// and capture what selectionToTextWithLatex extracts.
const result = await p.evaluate(() => {
  const para = document.querySelector('#lesson-view p');
  if (!para) return { error: 'no <p>' };
  const r = document.createRange();
  r.selectNodeContents(para);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(r);

  // Naive (what the BTW flow used to do) vs the fixed helper. Read the helper
  // through the test hook so we don't depend on internals being exported.
  const naive = s.toString().trim();
  // Trigger the BTW flow directly so we can observe the chat-selection chip
  // that the panel populates from the captured quote.
  window.__openChatPanel(window.__selectionToTextWithLatex
    ? window.__selectionToTextWithLatex(s)
    : naive);
  const sel = document.querySelector('.sg-chat-selection');
  return {
    naive,
    quoteHTML: sel?.innerHTML?.slice(0, 300),
    quoteText: sel?.textContent?.trim(),
    katex: sel?.querySelectorAll('.katex').length || 0,
    rawDollar: /\$[^\s$][^$]*\$/.test(sel?.innerHTML || '') ? 1 : 0,
  };
});

console.log('naive selection:', JSON.stringify(result.naive));
console.log('chat-selection chip:');
console.log('  text   :', JSON.stringify(result.quoteText));
console.log('  katex# :', result.katex);
console.log('  raw $? :', result.rawDollar);
console.log('  html   :', result.quoteHTML);

await p.screenshot({ path: '/tmp/math-selection.png', fullPage: false });
console.log('  → /tmp/math-selection.png');

let failed = 0;
// The naive sel.toString() should still produce a duplicated/garbled form
// — that's the bug we're working around. We don't fail on it, but warn.
if (!/QKT/i.test(result.naive) && !/dk/i.test(result.naive)) {
  console.log('NOTE: naive selection did not duplicate — KaTeX layout may have changed');
}
// The fixed quote in the chip should have a rendered .katex element AND
// no leaked raw `$math$` text.
if (result.katex < 1) { console.log('FAIL: chip has no rendered KaTeX'); failed++; }
if (result.rawDollar > 0) { console.log('FAIL: chip still leaks raw $...$ text'); failed++; }
// Also: the chip text should NOT contain the duplicated "QKTdkdkQKT" garbage.
// After rendering, .katex visible text contains things like "QK⊤dk√QK⊤" — but
// "dkdk" or "QKTQKT" specifically only appears in the unfixed flattening.
if (/QKTdk.*QKT/.test(result.quoteText || '')) { console.log('FAIL: chip text still shows duplicated math flattening'); failed++; }

console.log(`\n${failed === 0 ? 'all green' : failed + ' failing'}`);

await b.close();
try { rmSync(DIR, { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
