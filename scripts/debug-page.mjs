// Drive the local web reader headlessly and dump everything diagnostic.
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:4321/';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const consoleEvents = [];
const pageErrors = [];
const requestFails = [];

page.on('console', (msg) => {
  consoleEvents.push({ type: msg.type(), text: msg.text() });
});
page.on('pageerror', (err) => {
  pageErrors.push({ name: err.name, message: err.message, stack: err.stack });
});
page.on('requestfailed', (req) => {
  requestFails.push({ url: req.url(), failure: req.failure()?.errorText });
});

console.log('navigating to', url);
const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 }).catch((e) => {
  console.log('goto error:', e.message);
  return null;
});

console.log('http status:', resp?.status());

// Give app a moment to settle (SSE, async fetches)
await page.waitForTimeout(1500);

const lessonViewHtml = await page.locator('#lesson-view').innerHTML().catch(() => '(missing)');
const selectOptions = await page.locator('#lesson-select option').allTextContents().catch(() => []);
const headerText = await page.locator('header').innerText().catch(() => '');
const statusText = await page.locator('#status').innerText().catch(() => '');

console.log('\n=== PAGE ERRORS ===');
for (const e of pageErrors) {
  console.log(`[${e.name}] ${e.message}`);
  if (e.stack) console.log(e.stack.split('\n').slice(0, 5).join('\n'));
}
if (!pageErrors.length) console.log('(none)');

console.log('\n=== CONSOLE ===');
for (const c of consoleEvents) {
  console.log(`[${c.type}] ${c.text}`);
}
if (!consoleEvents.length) console.log('(none)');

console.log('\n=== FAILED REQUESTS ===');
for (const r of requestFails) {
  console.log(`✗ ${r.url}  →  ${r.failure}`);
}
if (!requestFails.length) console.log('(none)');

console.log('\n=== HEADER ===');
console.log(headerText);

console.log('\n=== SELECT OPTIONS ===');
console.log(selectOptions);

console.log('\n=== #lesson-view INNER (first 800 chars) ===');
console.log(lessonViewHtml.slice(0, 800));

console.log('\n=== STATUS BAR ===');
console.log(statusText);

await page.screenshot({ path: '/tmp/sg-page.png', fullPage: true });
console.log('\n(screenshot at /tmp/sg-page.png)');

await browser.close();
