import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1300, height: 1100 });
await p.goto('http://localhost:4321/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelectorAll('#sidebar-lessons a').length > 0, { timeout: 8000 });
await p.locator('#sidebar-lessons a[data-slug="01-the-big-picture"]').click();
await p.waitForTimeout(2500);
// Crop just the sidebar
await p.screenshot({
  path: '/tmp/sg-sidebar-only.png',
  clip: { x: 0, y: 0, width: 260, height: 1100 },
});
console.log('done');
await b.close();
