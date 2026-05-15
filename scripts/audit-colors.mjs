// Snapshot every module in light + dark mode for side-by-side comparison.
// Used to spot palette inconsistencies across blocks.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:4321';
const TRACKS = '/home/LYP/studyground/tracks';
const SLUG = 'audit-colors';
const DIR = join(TRACKS, SLUG);

function setup() {
  if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, 'lessons'), { recursive: true });
  writeFileSync(join(DIR, 'track.json'), JSON.stringify({
    slug: SLUG, title: 'Color Audit', description: 'all block types', emoji: '🎨',
    created_at: '2026-05-14', updated_at: '2026-05-14',
  }));
  writeFileSync(join(DIR, 'curriculum.md'), '# C\n');
  writeFileSync(join(DIR, 'lessons', '01-blocks.md'), `---
title: Block sampler
track: ${SLUG}
estimated_minutes: 5
---

# Block sampler

Body prose with **bold**, *italic*, and \`inline code\` mixed in. A link: [example](https://example.com).

> A blockquote — looks like an aside.

\`\`\`python
def f(x):
    return x + 1
\`\`\`

| header A | header B |
|----------|----------|
| cell 1   | cell 2   |
| cell 3   | cell 4   |

?> Why do we need this?

?>> What about this btw question?

<details><summary>Click to expand</summary>
Hidden content inside details.
</details>

<!-- feedback:start name="example" -->
Some feedback body text with **bold** inside.

<details><summary>Full review</summary>
Nested details inside feedback.
</details>
<!-- feedback:end -->
`);
}
setup();

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1600, height: 1400 });
await p.goto(`${BASE}/`);
await p.evaluate(() => localStorage.setItem('sg-theme', 'light'));

await p.goto(`${BASE}/#/t/${SLUG}/`);
await p.waitForSelector('main pre');
await p.waitForTimeout(600);
// Open every details
await p.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true));
await p.waitForTimeout(200);
await p.screenshot({ path: '/tmp/blocks-light.png', fullPage: false });
console.log('  → /tmp/blocks-light.png');

await b.close();
try { rmSync(DIR, { recursive: true, force: true }); } catch {}
