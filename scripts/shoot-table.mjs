// Snapshot a rendered table to verify the Claude-docs styling (row
// separators only, header weight, hover wash, inline code chip).
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:4321';
const TRACKS = '/home/LYP/studyground/tracks';
const SLUG = `table-shot-${Date.now()}`;
const DIR = join(TRACKS, SLUG);
if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
mkdirSync(join(DIR, 'lessons'), { recursive: true });
writeFileSync(join(DIR, 'track.json'), JSON.stringify({
  slug: SLUG, title: 'Tbl', description: 't', emoji: '📊',
  created_at: '2026-05-14', updated_at: '2026-05-14',
}));
writeFileSync(join(DIR, 'curriculum.md'), '# C\n');
writeFileSync(join(DIR, 'lessons', '01.md'), `---
title: table test
track: ${SLUG}
estimated_minutes: 5
---

# Table test

Lead-in to the table.

|                  | Provided correct output      | Provided feedback |
| ---------------- | ---------------------------- | ----------------- |
| Teacher selects  | IL from demonstrations       | Offline RL        |
| Learner selects  | IL from corrections          | RL                |

Some prose follows the table. The header should set the row apart;
inline \`code\` in cells should be a subtle chip.

| status         | what it means                              | what to do                                         |
| -------------- | ------------------------------------------ | -------------------------------------------------- |
| \`ok\`           | text extracted, mirror + index ready       | Use \`sg-search\` / Read the mirror.                 |
| \`pending\`      | extraction running (just uploaded)         | Use native \`Read(file.pdf, pages:)\` for this turn. |
| \`image-pdf\`    | scanned/image-only PDF                     | Use native \`Read(file.pdf, pages:)\`; vision OCRs.  |
| \`failed\`       | extraction errored                         | Fall back to native Read.                          |
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

await p.screenshot({ path: '/tmp/table.png', fullPage: false });
console.log('  → /tmp/table.png');

// Hover the first body row of the second table to capture hover state too
const targetRow = p.locator('main table').nth(1).locator('tbody tr').first();
await targetRow.hover();
await p.waitForTimeout(150);
await p.screenshot({ path: '/tmp/table-hover.png', fullPage: false });
console.log('  → /tmp/table-hover.png');

await b.close();
try { rmSync(DIR, { recursive: true, force: true }); } catch {}
