// Smoke test for the inline material viewer + citation chips.
// Run: STUDYGROUND_DIR=~/studyground node scripts/test-material-viewer.mjs
// Assumes a server is already listening on $PORT (default 4321) and that
// tracks/cs277 exists with materials (CS277L1.pdf, etc).

import { chromium } from 'playwright';

const BASE = process.env.SG_BASE || 'http://localhost:4321';
const TRACK = process.env.SG_TRACK || 'cs277';
const LESSON = process.env.SG_LESSON || '01-foundations-imitation-learning';

const results = [];
function check(label, cond, extra) {
  results.push({ label, ok: !!cond, extra: extra ?? null });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + JSON.stringify(extra) : ''}`);
}

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

try {
  await page.goto(`${BASE}/#/t/${TRACK}/lesson/${LESSON}`, { waitUntil: 'domcontentloaded' });
  // Wait for the reader view + lesson body to render (lesson fetch is async).
  await page.waitForSelector('#view-reader:not([hidden])', { timeout: 10000 });
  await page.waitForSelector('#lesson-view .sg-cite, #lesson-view h2', { timeout: 15000 });

  // Citation chips rendered?
  const citeCount = await page.locator('#lesson-view .sg-cite').count();
  check('citation chips render in lesson', citeCount > 0, { count: citeCount });

  // Sidebar materials rendered?
  const matRows = await page.locator('#sidebar-materials .material-item').count();
  check('sidebar shows materials', matRows > 0, { count: matRows });

  // Click a citation: viewer opens, iframe appears with #page=N URL.
  if (citeCount > 0) {
    const firstCite = page.locator('#lesson-view .sg-cite').first();
    const file = await firstCite.getAttribute('data-file');
    const cpage = await firstCite.getAttribute('data-page');
    await firstCite.scrollIntoViewIfNeeded();
    await firstCite.click();
    await page.waitForSelector('#material-viewer:not([hidden])', { timeout: 3000 });
    check('viewer opens on cite click', true);
    const name = await page.locator('#material-viewer-name').textContent();
    check('viewer header shows file name', name && name.includes(file), { name, file });
    // PDF in iframe?
    const iframeSrc = await page.locator('#material-viewer-body iframe').getAttribute('src').catch(() => null);
    check('PDF rendered in iframe', iframeSrc && iframeSrc.includes(encodeURIComponent(file)),
      { iframeSrc });
    if (cpage) {
      check('iframe URL contains page anchor', iframeSrc && iframeSrc.includes('#page='),
        { iframeSrc, cpage });
    }
    // .is-active on the clicked chip
    const isActive = await firstCite.evaluate((el) => el.classList.contains('is-active'));
    check('clicked chip is marked active', isActive);
  }

  // Sidebar row should be marked .is-open while viewer is open
  const openCount = await page.locator('#sidebar-materials .material-item.is-open').count();
  check('sidebar row marked .is-open', openCount === 1, { openCount });

  // Toggle: clicking the same row closes the viewer
  const openRow = page.locator('#sidebar-materials .material-item.is-open').first();
  if (await openRow.count() === 1) {
    await openRow.click();
    await page.waitForFunction(() => document.getElementById('material-viewer')?.hasAttribute('hidden'), null, { timeout: 3000 });
    check('toggle: clicking open row closes viewer', true);
  }

  // Click sidebar row to open viewer freshly, then click close ×
  const firstRow = page.locator('#sidebar-materials .material-item').first();
  await firstRow.click();
  await page.waitForSelector('#material-viewer:not([hidden])', { timeout: 3000 });
  await page.locator('[data-action="close-material"]').click();
  await page.waitForFunction(() => document.getElementById('material-viewer')?.hasAttribute('hidden'), null, { timeout: 3000 });
  check('close button closes viewer', true);

  // Open again, then test drag-resize
  await firstRow.click();
  await page.waitForSelector('#material-viewer:not([hidden])', { timeout: 3000 });
  const handle = page.locator('#material-viewer-resize');
  const startW = await page.evaluate(() => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sg-material-width'), 10));
  const box = await handle.boundingBox();
  // Drag right by 80px
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const endW = await page.evaluate(() => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sg-material-width'), 10));
  check('drag-resize widens viewer', endW > startW + 40, { startW, endW });

  // Cross-cite: click a citation with a *different* page (same file), viewer
  // should update without closing.
  const cites = page.locator('#lesson-view .sg-cite');
  const total = await cites.count();
  if (total >= 2) {
    const meta = [];
    for (let i = 0; i < total; i++) {
      meta.push({
        i,
        file: await cites.nth(i).getAttribute('data-file'),
        page: await cites.nth(i).getAttribute('data-page'),
      });
    }
    // Find two indexes on the same file with different pages.
    let aIdx = -1, bIdx = -1;
    for (let i = 0; i < meta.length; i++) {
      for (let j = i + 1; j < meta.length; j++) {
        if (meta[i].file === meta[j].file && meta[i].page && meta[j].page && meta[i].page !== meta[j].page) {
          aIdx = i; bIdx = j;
          break;
        }
      }
      if (aIdx >= 0) break;
    }
    if (aIdx >= 0) {
      await cites.nth(aIdx).scrollIntoViewIfNeeded();
      await cites.nth(aIdx).click();
      await page.waitForSelector('#material-viewer:not([hidden])');
      await cites.nth(bIdx).scrollIntoViewIfNeeded();
      await cites.nth(bIdx).click();
      const src = await page.locator('#material-viewer-body iframe').getAttribute('src');
      check('cross-cite same-file updates iframe to new page',
        src && src.includes(`#page=${meta[bIdx].page.split(/[-–—]/)[0]}`),
        { src, expected: meta[bIdx].page });
    }
  }

  // Bare citation rendering: [CS277Q1.pdf] (no page) should render with
  // .is-bare class and only an icon visible.
  const bare = await page.evaluate(() => {
    const out = window.__mdRender('See [CS277Q1.pdf] for prereq math.');
    const m = out.match(/<a class="sg-cite[^"]*"[^>]*data-file="CS277Q1\.pdf"[^>]*>([\s\S]*?)<\/a>/);
    return { found: !!m, html: m ? m[0] : out };
  });
  check('bare [file.pdf] citation renders with is-bare', bare.found && bare.html.includes('is-bare'), bare);

  // Citation rule yields to ordinary markdown links: `[file.pdf](url)`.
  const mdLink = await page.evaluate(() => {
    const out = window.__mdRender('See [CS277L1.pdf](https://example.com) here.');
    return { hasCite: out.includes('class="sg-cite'), hasLink: /<a href="https:\/\/example\.com"/.test(out), out };
  });
  check('markdown link [text](url) is NOT eaten by cite rule', !mdLink.hasCite && mdLink.hasLink, mdLink);

  // Cross-file swap: open a chip with a different file. Verify viewer name
  // updates and iframe src points at the new file.
  const cites2 = page.locator('#lesson-view .sg-cite');
  const total2 = await cites2.count();
  const meta2 = [];
  for (let i = 0; i < total2; i++) {
    meta2.push({
      i,
      file: await cites2.nth(i).getAttribute('data-file'),
      page: await cites2.nth(i).getAttribute('data-page'),
    });
  }
  const filesSeen = new Set(meta2.map((m) => m.file));
  if (filesSeen.size >= 2) {
    const files = [...filesSeen];
    const aIdx2 = meta2.findIndex((m) => m.file === files[0]);
    const bIdx2 = meta2.findIndex((m) => m.file === files[1]);
    await cites2.nth(aIdx2).scrollIntoViewIfNeeded();
    await cites2.nth(aIdx2).click();
    await page.waitForSelector('#material-viewer:not([hidden])');
    await cites2.nth(bIdx2).scrollIntoViewIfNeeded();
    await cites2.nth(bIdx2).click();
    const name2 = await page.locator('#material-viewer-name').textContent();
    const src2 = await page.locator('#material-viewer-body iframe').getAttribute('src');
    check('cross-file swap updates header + iframe',
      name2 === files[1] && src2 && src2.includes(encodeURIComponent(files[1])),
      { name2, src2, expected: files[1] });
  }

  // Server MIME: PDF returns application/pdf; .md returns text/plain.
  const mimePdf = await page.evaluate(async () => {
    const r = await fetch('/api/tracks/cs277/materials/CS277L1.pdf');
    return r.headers.get('content-type');
  });
  check('PDF served as application/pdf', mimePdf === 'application/pdf', { mimePdf });
  const mimeMd = await page.evaluate(async () => {
    const r = await fetch('/api/tracks/cs277/materials/INDEX.md');
    return r.headers.get('content-type');
  });
  check('MD served as text/plain', mimeMd && mimeMd.startsWith('text/plain'), { mimeMd });

  // No console errors throughout the run
  check('no JS console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5));

} catch (e) {
  console.error('FAIL (exception):', e.stack || e.message);
  results.push({ label: 'exception', ok: false, extra: e.message });
} finally {
  await page.screenshot({ path: '/tmp/sg-viewer.png', fullPage: false }).catch(() => {});
  await browser.close();
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n${pass}/${results.length} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
