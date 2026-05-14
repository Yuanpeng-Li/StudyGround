import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1400, height: 1100 });

p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
p.on('console', (m) => { if (m.type() !== 'log') console.log(`[${m.type()}]`, m.text()); });

// 1. Home (light)
await p.goto('http://localhost:4321/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(
  () => document.querySelectorAll('#track-grid .track-card').length > 0,
  null,
  { timeout: 8000 },
);
await p.screenshot({ path: '/tmp/sg-fin-1-home.png', fullPage: true });
console.log('1. home →', '/tmp/sg-fin-1-home.png');

// 2. Open transformers track
await p.click('a.track-card[data-slug="transformers-from-scratch"]');
await p.waitForSelector('#view-reader:not([hidden])');
await p.waitForSelector('#lesson-view h1', { timeout: 15000 });
await p.waitForTimeout(800);
await p.screenshot({ path: '/tmp/sg-fin-2-reader.png', fullPage: true });
console.log('2. reader →', '/tmp/sg-fin-2-reader.png');

// 3. Hover over a thread to reveal actions (if any threads exist)
const threadCount = await p.locator('#sidebar-threads .thread-li').count();
console.log('   thread count:', threadCount);

// 4. Open ⌘K palette
await p.keyboard.press('Control+k');
await p.waitForSelector('#cmd-palette[open]', { timeout: 3000 });
await p.waitForTimeout(300);
await p.screenshot({ path: '/tmp/sg-fin-3-palette.png', fullPage: false });
console.log('3. palette →', '/tmp/sg-fin-3-palette.png');

// 5. Filter palette: type "rl"
await p.fill('#cmd-input', 'rl');
await p.waitForTimeout(400);
await p.screenshot({ path: '/tmp/sg-fin-4-palette-filtered.png', fullPage: false });
console.log('4. palette filtered →', '/tmp/sg-fin-4-palette-filtered.png');

// 6. Press Enter to navigate to rl-from-scratch
await p.keyboard.press('Enter');
await p.waitForTimeout(800);
const newHash = await p.evaluate(() => location.hash);
console.log('   after enter, hash =', newHash);

// 7. Sidebar materials count for transformers-from-scratch (already has 1)
await p.evaluate(() => (location.hash = '#/t/transformers-from-scratch/'));
await p.waitForTimeout(1500);
const matCount = await p.locator('#sidebar-materials .material-item').count();
console.log('   materials in sidebar:', matCount);
await p.screenshot({ path: '/tmp/sg-fin-5-sidebar.png', clip: { x: 0, y: 0, width: 300, height: 1100 } });
console.log('5. sidebar →', '/tmp/sg-fin-5-sidebar.png');

await b.close();
