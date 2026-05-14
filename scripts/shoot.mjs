import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1100, height: 1400 });
await p.goto('http://localhost:4321/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelectorAll('#lesson-select option').length > 1);
for (const slug of ['01-the-big-picture', '02-test-exercise']) {
  await p.selectOption('#lesson-select', slug);
  await p.waitForTimeout(2500);
  const dest = `/tmp/sg-shot-${slug}.png`;
  await p.screenshot({ path: dest, fullPage: true });
  console.log(dest);
}
await b.close();
