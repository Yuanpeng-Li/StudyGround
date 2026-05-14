import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1300, height: 1000 });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

// 1. Home — verify Import link + per-card actions on hover
await p.goto('http://localhost:4321/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelectorAll('#track-grid .track-card').length > 0);
await p.hover('a.track-card[data-slug="transformers-from-scratch"]');
await p.waitForTimeout(200);
await p.screenshot({ path: '/tmp/sg-m6-1-home.png', fullPage: false });
console.log('1. home (hover shows ⬇/×) →', '/tmp/sg-m6-1-home.png');

// 2. Navigate directly to the intake view of a course that has no curriculum
await p.evaluate(() => (location.hash = '#/t/rl-from-scratch/intake'));
await p.waitForSelector('#view-intake:not([hidden])');
await p.waitForTimeout(300);
await p.screenshot({ path: '/tmp/sg-m6-2-intake-empty.png', fullPage: false });
console.log('2. intake (just opened, no assistant msg yet) →', '/tmp/sg-m6-2-intake-empty.png');

await b.close();
