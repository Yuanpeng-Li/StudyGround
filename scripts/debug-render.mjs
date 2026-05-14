// Load page, select a lesson, capture render errors.
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:4321/';
const slug = process.argv[3] || '01-the-big-picture';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const errors = [];
const consoleLog = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}\n${e.stack?.split('\n').slice(0, 4).join('\n')}`));
page.on('console', (m) => consoleLog.push(`[${m.type()}] ${m.text()}`));

console.log('loading…');
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
await page.waitForFunction(
  () => document.querySelectorAll('#lesson-select option').length > 1,
  { timeout: 5000 },
);

console.log(`selecting ${slug}…`);
await page.selectOption('#lesson-select', slug);
await page.waitForTimeout(1500);

console.log('\n=== ERRORS ===');
console.log(errors.length ? errors.join('\n---\n') : '(none)');

console.log('\n=== CONSOLE ===');
console.log(consoleLog.length ? consoleLog.join('\n') : '(none)');

const view = await page.locator('#lesson-view').innerHTML();
console.log('\n=== #lesson-view (first 1500 chars) ===');
console.log(view.slice(0, 1500));

console.log('\n=== TOKEN COUNTS ===');
const counts = await page.evaluate(() => {
  const v = document.getElementById('lesson-view');
  return {
    sg_question: v.querySelectorAll('.sg-question').length,
    sg_answer_pending: v.querySelectorAll('.sg-answer.pending').length,
    sg_answer_answered: v.querySelectorAll('.sg-answer.answered').length,
    sg_exercise: v.querySelectorAll('.sg-exercise').length,
    sg_runnable: v.querySelectorAll('.sg-runnable').length,
    sg_feedback: v.querySelectorAll('.sg-feedback').length,
    katex: v.querySelectorAll('.katex').length,
    details: v.querySelectorAll('details').length,
    paragraphs: v.querySelectorAll('p').length,
  };
});
console.log(counts);

await page.screenshot({ path: '/tmp/sg-rendered.png', fullPage: true });
console.log('\n(screenshot: /tmp/sg-rendered.png)');

await browser.close();
