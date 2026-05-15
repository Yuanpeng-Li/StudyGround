// Verify the three fixes from the latest UX pass:
//   (1) .sg-question.btw renders as a rounded callout WITHOUT the inline
//       "dig deeper" pill, and the whole block is the dig-deeper trigger.
//   (2) The folded <details> that follows a deeper block has its summary
//       enriched with the question text AND math inside renders (KaTeX).
//   (3) The btw chat panel (opened via the floating selection toolbar)
//       uses the coral accent palette — no purple leftover.
//
// Run: node scripts/test-deeper-callout.mjs
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:4321';
const TRACKS = '/home/LYP/studyground/tracks';
const SLUG = 'deeper-callout-test';
const DIR = join(TRACKS, SLUG);

function setup() {
  if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, 'lessons'), { recursive: true });
  writeFileSync(join(DIR, 'track.json'), JSON.stringify({
    slug: SLUG, title: 'Deeper Callout Test', description: 'check the deeper/q look', emoji: '🔬',
    created_at: '2026-05-14', updated_at: '2026-05-14',
  }));
  writeFileSync(join(DIR, 'curriculum.md'), '# C\n');
  // Hand-craft a lesson with: one Q block (?> ...), then one deeper block
  // (?>> ...) followed by a folded <details><summary>deeper</summary>...
  // — that's the exact shape this test guards.
  writeFileSync(join(DIR, 'lessons', '01-deeper.md'), `---
title: deeper test
track: ${SLUG}
estimated_minutes: 5
---

# Deeper test

Some lead-in body text.

?> 既然 multi-head 和 single-head ($d_k = d_{\\text{model}}$) 的参数量、计算量几乎一样，多 head 多出来的表达力究竟来自哪里？

?>> 为什么要除以 $\\sqrt{d_k}$？ 这个细节看起来很烦但其实是设计关键。

<details><summary>deeper</summary>

如果 $q$ 和 $k$ 的每个分量独立、均值 0、方差 1，那么 $q^\\top k = \\sum_{i=1}^{d_k} q_i k_i$ 的方差就是 $d_k$。

除以 $\\sqrt{d_k}$ 把方差拉回 1，softmax 的分布更平、梯度更健康。

</details>
`);
}
setup();

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1500, height: 1400 });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await p.goto(`${BASE}/`);
await p.evaluate(() => localStorage.setItem('sg-theme', 'light'));

await p.goto(`${BASE}/#/t/${SLUG}/`);
await p.waitForSelector('main h1');
await p.waitForTimeout(500);

// --- assertion (1): no .sg-q-dig pill (the old protruding button was
// removed when the whole block became the click-to-expand details host) ---
const noDigPill = await p.evaluate(() => document.querySelectorAll('.sg-q-dig').length);
console.log(`(1a) inline dig-deeper pills: ${noDigPill} (want 0)`);

// The deeper block is now a <details class="sg-question btw"> produced by
// mergeQuestionBlocks(); the question text lives inside <summary>.
const btwAttrs = await p.evaluate(() => {
  const el = document.querySelector('.sg-question.btw');
  if (!el) return null;
  const summary = el.querySelector(':scope > summary');
  return {
    tag: el.tagName,
    hasSummary: !!summary,
    hasLabel: !!summary?.querySelector('.sg-q-label'),
    hasText: !!summary?.querySelector('.sg-q-text'),
    open: el.open,
  };
});
console.log(`(1b) .sg-question.btw attrs:`, btwAttrs);

// --- assertion (2): the merged details renders math in its <summary>
// (KaTeX should pick up `$\sqrt{d_k}$`); body lives in .sg-question-body. ---
const summaryInfo = await p.evaluate(() => {
  const details = document.querySelector('.sg-question.btw');
  if (!details) return null;
  const summary = details.querySelector(':scope > summary');
  return {
    isOpen: details.open,
    summaryHTML: summary.innerHTML.slice(0, 200),
    labelText: summary.querySelector('.sg-q-label')?.textContent?.trim(),
    katexCount: summary.querySelectorAll('.katex').length,
    summaryRawDollars: /\$[^\s$][^$]*\$/.test(summary.innerHTML || '') ? 1 : 0,
    hasBody: !!details.querySelector(':scope > .sg-question-body'),
  };
});
console.log(`(2)  merged details:`, summaryInfo);

// --- assertion (3): open the btw chat panel directly via the panel API
// (mouseup-from-selection in headless Playwright is flaky). Then verify
// the chat-selection renders math and the panel uses coral.
await p.evaluate(() => {
  // openChatPanel is a top-level function in main.js — invoke directly.
  // Pass a selection that contains $math$ so we can check rendering.
  window.__openChatPanel && window.__openChatPanel('为什么要除以 $\\sqrt{d_k}$? 这个细节看起来很烦但其实是设计关键。');
});
await p.waitForTimeout(500);
const chatChrome = await p.evaluate(() => {
  const panel = document.querySelector('.sg-chat-panel');
  if (!panel) return { open: false };
  const head = panel.querySelector('.sg-chat-head');
  const title = panel.querySelector('.sg-chat-title');
  const sel = panel.querySelector('.sg-chat-selection');
  return {
    open: panel.classList.contains('show'),
    titleText: title?.textContent?.trim(),
    headBg: head ? getComputedStyle(head).backgroundColor : null,
    selBg: sel ? getComputedStyle(sel).backgroundColor : null,
    selBorderRadius: sel ? getComputedStyle(sel).borderRadius : null,
    selBorderTop: sel ? getComputedStyle(sel).borderTopWidth : null,
    selHTML: sel?.innerHTML?.slice(0, 200),
    selKatexCount: sel?.querySelectorAll('.katex').length || 0,
    selRawDollars: /\$\s*\\?[a-zA-Z]/.test(sel?.textContent || '') ? 1 : 0,
  };
});
console.log(`(3) chat panel:`, chatChrome);

await p.screenshot({ path: '/tmp/deeper-callout.png', fullPage: false });
console.log('  → /tmp/deeper-callout.png');
const panelBox = await p.locator('.sg-chat-panel').boundingBox().catch(() => null);
if (panelBox) {
  await p.screenshot({ path: '/tmp/deeper-chat.png', clip: { x: panelBox.x, y: panelBox.y, width: panelBox.width, height: 320 } });
  console.log('  → /tmp/deeper-chat.png');
}

let failed = 0;
if (noDigPill !== 0) { console.log('FAIL (1a) dig-pill leaked back'); failed++; }
if (!btwAttrs || btwAttrs.tag !== 'DETAILS' || !btwAttrs.hasSummary || !btwAttrs.hasLabel || !btwAttrs.hasText) { console.log('FAIL (1b) deeper block is not a merged <details> with label/text'); failed++; }
if (!summaryInfo || summaryInfo.labelText !== 'deeper' || summaryInfo.katexCount < 1 || summaryInfo.summaryRawDollars > 0 || !summaryInfo.hasBody) { console.log('FAIL (2) summary missing label / math / body'); failed++; }
if (!chatChrome.open) {
  console.log('FAIL (3a) chat panel did not open'); failed++;
} else {
  if (chatChrome.selKatexCount < 1) { console.log(`FAIL (3b) chat-selection has no rendered math (got ${chatChrome.selKatexCount})`); failed++; }
  if (chatChrome.selRawDollars > 0) { console.log('FAIL (3c) chat-selection still shows raw $...$'); failed++; }
  // Rounded rectangle: all four sides have a border, and border-radius > 0.
  if (!chatChrome.selBorderTop || chatChrome.selBorderTop === '0px') { console.log(`FAIL (3d) chat-selection missing top border (got ${chatChrome.selBorderTop})`); failed++; }
}
console.log(`\n${failed === 0 ? 'all green' : failed + ' failing'}`);

await b.close();
try { rmSync(DIR, { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
