// Visual snapshot sweep — capture every key view + state for manual review.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:4321';
const TRACKS = '/home/LYP/studyground/tracks';
const SLUG = 'audit-vis';
const DIR = join(TRACKS, SLUG);

function setup() {
  if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, 'lessons'), { recursive: true });
  writeFileSync(join(DIR, 'track.json'), JSON.stringify({
    slug: SLUG, title: 'Visual Audit', description: 'looks-only audit', emoji: '🎨',
    created_at: '2026-05-14', updated_at: '2026-05-14',
  }));
  writeFileSync(join(DIR, 'curriculum.md'), '# Curriculum\n');
  writeFileSync(join(DIR, 'lessons', '01-intro.md'), `---
title: Visual Audit Lesson
track: ${SLUG}
estimated_minutes: 5
---

# Visual Audit Lesson

## A heading

Some text here. Math inline: $\\sigma(x) = \\frac{1}{1+e^{-x}}$.

\`\`\`python
import torch
x = torch.tensor([1.0, 2.0])
print(x.sum())
\`\`\`

## Another heading

More body content for visual review.

> A blockquote that looks like an aside, with **bold** text and \`inline code\`.

| col 1 | col 2 |
|-------|-------|
| a     | b     |
| c     | d     |

`);
}
setup();

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 } });
const p = await ctx.newPage();

async function snap(name, opts = {}) {
  await p.waitForTimeout(500);
  await p.screenshot({ path: `/tmp/vis-${name}.png`, ...opts });
  console.log('  →', `/tmp/vis-${name}.png`);
}

// Need to navigate to the origin before localStorage is available
await p.goto(`${BASE}/`);
// Light mode
await p.evaluate(() => localStorage.setItem('sg-theme', 'light'));

console.log('--- HOME light ---');
await p.goto(`${BASE}/#/`);
await snap('home-light', { fullPage: false });

console.log('--- INTAKE light ---');
await p.goto(`${BASE}/#/t/${SLUG}/intake`);
await snap('intake-light', { fullPage: false });

console.log('--- READER light ---');
await p.goto(`${BASE}/#/t/${SLUG}/`);
await p.waitForSelector('main pre');
await snap('reader-light', { fullPage: false });

console.log('--- READER narrow (1200) ---');
await p.setViewportSize({ width: 1200, height: 900 });
await snap('reader-narrow', { fullPage: false });

console.log('--- READER popover open ---');
await p.click('#outline-toggle');
await snap('reader-popover', { fullPage: false });
await p.keyboard.press('Escape');

await p.setViewportSize({ width: 1600, height: 1000 });

// Dark mode
console.log('--- DARK theme ---');
await p.evaluate(() => localStorage.setItem('sg-theme', 'dark'));
await p.goto(`${BASE}/#/`);
await snap('home-dark');
await p.goto(`${BASE}/#/t/${SLUG}/`);
await p.waitForSelector('main pre');
await snap('reader-dark');

await b.close();
try { rmSync(DIR, { recursive: true, force: true }); } catch {}
console.log('\nDone — review the /tmp/vis-*.png files.');
