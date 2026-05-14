import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1300, height: 900 });

await p.goto('http://localhost:4321/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelectorAll('#sidebar-lessons a').length > 0);
await p.locator('#sidebar-lessons a[data-slug="02-test-exercise"]').click();
await p.waitForSelector('#lesson-view .sg-exercise');

// First state: auto (likely light on this headless browser)
let state = await p.evaluate(() => ({
  theme: localStorage.getItem('sg-theme') || 'auto',
  dataTheme: document.documentElement.getAttribute('data-theme'),
  btnText: document.getElementById('btn-theme').textContent,
}));
console.log('initial:', state);
await p.screenshot({ path: '/tmp/sg-theme-1.png', fullPage: false });

// Click to cycle: auto → light
await p.locator('#btn-theme').click();
await p.waitForTimeout(150);
state = await p.evaluate(() => ({
  theme: localStorage.getItem('sg-theme'),
  dataTheme: document.documentElement.getAttribute('data-theme'),
  btnText: document.getElementById('btn-theme').textContent,
}));
console.log('after 1st click:', state);
await p.screenshot({ path: '/tmp/sg-theme-2.png', fullPage: false });

// Click to cycle: light → dark
await p.locator('#btn-theme').click();
await p.waitForTimeout(150);
state = await p.evaluate(() => ({
  theme: localStorage.getItem('sg-theme'),
  dataTheme: document.documentElement.getAttribute('data-theme'),
  btnText: document.getElementById('btn-theme').textContent,
}));
console.log('after 2nd click:', state);
await p.screenshot({ path: '/tmp/sg-theme-3.png', fullPage: false });

// Click to cycle: dark → auto
await p.locator('#btn-theme').click();
await p.waitForTimeout(150);
state = await p.evaluate(() => ({
  theme: localStorage.getItem('sg-theme'),
  dataTheme: document.documentElement.getAttribute('data-theme'),
  btnText: document.getElementById('btn-theme').textContent,
}));
console.log('after 3rd click:', state);

await b.close();
