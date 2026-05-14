import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ colorScheme: 'dark' });
await p.setViewportSize({ width: 1100, height: 1400 });

await p.goto('http://localhost:4321/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelectorAll('#lesson-select option').length > 1);

for (const slug of ['01-the-big-picture', '02-test-exercise']) {
  await p.selectOption('#lesson-select', slug);
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `/tmp/sg-dark-${slug}.png`, fullPage: true });
  console.log(`/tmp/sg-dark-${slug}.png`);
}

await b.close();
