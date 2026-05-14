import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();

p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
p.on('console', (m) => console.log(`[${m.type()}]`, m.text()));

await p.goto('http://localhost:4321/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelectorAll('#lesson-select option').length > 1);
await p.selectOption('#lesson-select', '01-the-big-picture');

console.log('waiting for Pyodide…');
await p.waitForFunction(
  () => {
    const btn = document.querySelector('.sg-run-btn');
    return btn && !btn.disabled;
  },
  { timeout: 60000 },
);
console.log('Pyodide ready');

const runBtns = await p.locator('.sg-run-btn').count();
console.log('runnable cells:', runBtns);

await p.locator('.sg-run-btn').first().click();
await p.waitForTimeout(2000);

const output = await p.locator('.sg-run-output').first().innerText();
console.log('=== Run output ===');
console.log(output);

await p.screenshot({ path: '/tmp/sg-after-run.png', fullPage: true });

await b.close();
