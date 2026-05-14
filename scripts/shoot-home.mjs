import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1300, height: 900 });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
p.on('console', (m) => { if (m.type() !== 'log') console.log(`[${m.type()}]`, m.text()); });

await p.goto('http://localhost:4321/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(
  () => document.querySelectorAll('#track-grid .track-card').length > 0,
  null,
  { timeout: 8000 },
);
await p.screenshot({ path: '/tmp/sg-home-light.png', fullPage: true });
console.log('home (light) →', '/tmp/sg-home-light.png');

await p.evaluate(() => {
  localStorage.setItem('sg-theme', 'dark');
  document.documentElement.setAttribute('data-theme', 'dark');
});
await p.waitForTimeout(200);
await p.screenshot({ path: '/tmp/sg-home-dark.png', fullPage: true });
console.log('home (dark) →', '/tmp/sg-home-dark.png');

// Open new-track dialog and screenshot
await p.evaluate(() => document.querySelector('[data-action="open-new-track"]').click());
await p.waitForTimeout(300);
await p.screenshot({ path: '/tmp/sg-home-dialog.png', fullPage: false });
console.log('dialog →', '/tmp/sg-home-dialog.png');

await b.close();
