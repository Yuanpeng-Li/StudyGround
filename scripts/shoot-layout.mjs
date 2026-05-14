import { chromium } from 'playwright';

async function shoot(scheme, slug, file) {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage({ colorScheme: scheme });
  await p.setViewportSize({ width: 1300, height: 1500 });
  await p.goto('http://localhost:4321/', { waitUntil: 'domcontentloaded' });
  // wait for sidebar populated
  await p.waitForFunction(
    () => document.querySelectorAll('#sidebar-lessons a').length > 0,
    { timeout: 8000 },
  ).catch(() => {});
  await p.locator(`#sidebar-lessons a[data-slug="${slug}"]`).click();
  await p.waitForTimeout(2500);
  await p.screenshot({ path: file, fullPage: true });
  console.log(file);
  await b.close();
}

await shoot('light', '01-the-big-picture', '/tmp/sg-layout-light-01.png');
await shoot('light', '02-test-exercise', '/tmp/sg-layout-light-02.png');
await shoot('dark', '01-the-big-picture', '/tmp/sg-layout-dark-01.png');
