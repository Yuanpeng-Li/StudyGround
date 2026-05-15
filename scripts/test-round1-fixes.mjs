// Targeted regression probe for the 4 bugs fixed after round-1 sweep:
//   B16 keyboard race (Space on × also triggers row open)
//   B9  .is-active swap on same-PDF page change
//   B13 narrow-viewport ghost state (now falls back to new tab)
//   ghost-course creation from URL typos (server 404 + client bounce-to-home)

import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://localhost:4321';
const results = [];
function check(label, cond, extra) {
  results.push({ label, ok: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + JSON.stringify(extra) : ''}`);
}

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

try {
  // ---------- Ghost-course bounce ----------
  await page.goto(`${BASE}/#/t/zzz-bogus-${Date.now()}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => location.hash === '#/' && !document.getElementById('view-home').hidden, null, { timeout: 5000 }).catch(() => {});
  const bounced = await page.evaluate(() => ({ hash: location.hash, homeVisible: !document.getElementById('view-home').hidden }));
  check('bogus slug bounces to home', bounced.hash === '#/' && bounced.homeVisible, bounced);

  // ---------- Regression: brand-new track deep-linked to a lesson must route to intake, not bounce ----------
  const newSlug = `sg-test-deeplink-${Date.now()}`;
  const createOk = await page.evaluate(async (slug) => {
    const r = await fetch('/api/tracks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: slug, description: '', emoji: '🧪' }),
    }).then((x) => x.json());
    return r.ok;
  }, newSlug);
  if (createOk) {
    await page.goto(`${BASE}/#/t/${newSlug}/lesson/anything`, { waitUntil: 'domcontentloaded' });
    // The reader branch should route to intake when the track has no lessons.
    await page.waitForFunction(() => location.hash.endsWith('/intake'), null, { timeout: 5000 }).catch(() => {});
    const where = await page.evaluate(() => location.hash);
    check('new-track deep link to /lesson/X routes to intake (not bounced)', where.endsWith('/intake'), { where });
    // Cleanup
    await page.evaluate(async (slug) => {
      await fetch(`/api/tracks/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    }, newSlug);
  } else {
    check('new-track deep link to /lesson/X routes to intake (not bounced)', false, { reason: 'track create failed' });
  }

  // Real slug still works
  await page.goto(`${BASE}/#/t/cs277/lesson/01-foundations-imitation-learning`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#lesson-view .sg-cite', { timeout: 15000 });
  const onReader = await page.evaluate(() => !document.getElementById('view-reader').hidden);
  check('real slug still loads reader', onReader);

  // ---------- B9: same-PDF page swap moves .is-active ----------
  const cites = page.locator('#lesson-view .sg-cite');
  const total = await cites.count();
  const meta = [];
  for (let i = 0; i < total; i++) {
    meta.push({ i, file: await cites.nth(i).getAttribute('data-file'), page: await cites.nth(i).getAttribute('data-page') });
  }
  let aIdx = -1, bIdx = -1;
  for (let i = 0; i < meta.length; i++) {
    for (let j = i + 1; j < meta.length; j++) {
      if (meta[i].file === meta[j].file && meta[i].page && meta[j].page && meta[i].page !== meta[j].page) { aIdx = i; bIdx = j; break; }
    }
    if (aIdx >= 0) break;
  }
  if (aIdx >= 0) {
    await cites.nth(aIdx).scrollIntoViewIfNeeded();
    await cites.nth(aIdx).click();
    await page.waitForSelector('#material-viewer:not([hidden])');
    const aActive = await cites.nth(aIdx).evaluate((el) => el.classList.contains('is-active'));
    await cites.nth(bIdx).scrollIntoViewIfNeeded();
    await cites.nth(bIdx).click();
    await page.waitForTimeout(120);
    const aStill = await cites.nth(aIdx).evaluate((el) => el.classList.contains('is-active'));
    const bNow = await cites.nth(bIdx).evaluate((el) => el.classList.contains('is-active'));
    check('B9: .is-active moves on same-PDF page swap', aActive && !aStill && bNow, { aActive, aStill, bNow });
  }
  // Close viewer for next test
  await page.locator('[data-action="close-material"]').click().catch(() => {});

  // ---------- B16: keyboard race ----------
  // Focus the × delete button on a row and press Space. The viewer must NOT
  // open. The delete confirm dialog may pop but that's a separate flow —
  // we cancel any dialog so the page stays clean.
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  const delBtn = page.locator('#sidebar-materials .material-del').first();
  await delBtn.focus();
  await page.keyboard.press(' ');
  await page.waitForTimeout(300);
  const viewerOpenedFromDeleteSpace = await page.evaluate(() => !document.getElementById('material-viewer').hidden);
  check('B16: Space on × delete does NOT open viewer', viewerOpenedFromDeleteSpace === false, { viewerOpenedFromDeleteSpace });

  // Enter on × also must not open viewer (delete dialog will pop; dismissed).
  await delBtn.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const openedFromDeleteEnter = await page.evaluate(() => !document.getElementById('material-viewer').hidden);
  check('B16: Enter on × delete does NOT open viewer', openedFromDeleteEnter === false, { openedFromDeleteEnter });

  // Sanity: Enter on the *row itself* (not the delete child) DOES open viewer.
  const row = page.locator('#sidebar-materials .material-item').first();
  await row.focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('#material-viewer:not([hidden])', { timeout: 2000 }).catch(() => {});
  const openedFromRow = await page.evaluate(() => !document.getElementById('material-viewer').hidden);
  check('B16: Enter on the row itself still opens viewer', openedFromRow === true, { openedFromRow });
  await page.locator('[data-action="close-material"]').click().catch(() => {});

  // ---------- B13: narrow viewport falls back to new tab ----------
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForTimeout(200);
  // Programmatic open() at narrow width should NOT add .material-open;
  // it should request a new tab via window.open. We stub window.open to
  // record the call.
  const popupRecord = await page.evaluate(() => {
    let called = null;
    const orig = window.open;
    window.open = (u, t) => { called = { url: u, target: t }; return null; };
    // Open by clicking a citation chip (uses materialViewer.open under the hood)
    const c = document.querySelector('#lesson-view .sg-cite');
    c?.click();
    window.open = orig;
    return { called, matOpen: document.querySelector('#view-reader .app')?.classList.contains('material-open') };
  });
  check('B13: narrow viewport routes citation click to new tab, no .material-open', popupRecord.called && !popupRecord.matOpen, popupRecord);

  // Resize listener: open at wide, then shrink — viewer should close.
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.waitForTimeout(200);
  await page.locator('#sidebar-materials .material-item').first().click();
  await page.waitForSelector('#material-viewer:not([hidden])', { timeout: 2000 });
  await page.setViewportSize({ width: 800, height: 900 });
  await page.waitForTimeout(400);
  const closedAfterShrink = await page.evaluate(() => document.getElementById('material-viewer').hasAttribute('hidden'));
  check('B13: shrinking viewport while viewer is open closes it', closedAfterShrink, { closedAfterShrink });

  // ---------- Tutor-mode copy md (round 2 bug A8) ----------
  // Reset page to a known state and simulate a tutor conversation with
  // chatHistory populated, then click copy-thread-md.
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(`${BASE}/#/t/cs277/lesson/01-foundations-imitation-learning`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#lesson-view', { timeout: 10000 });
  // Mock the tutor stream so we can populate chatHistory cheaply
  await page.route('**/api/tutor', (route) => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    headers: { 'cache-control': 'no-cache' },
    body: [
      `data: ${JSON.stringify({ type: 'delta', text: 'mock ' })}\n\n`,
      `data: ${JSON.stringify({ type: 'delta', text: 'tutor reply' })}\n\n`,
      `data: ${JSON.stringify({ type: 'done', duration_ms: 1, cost_usd: 0, full_text: 'mock tutor reply' })}\n\n`,
    ].join(''),
  }));
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await page.locator('#btn-tutor').waitFor({ timeout: 5000 });
  await page.locator('#btn-tutor').click();
  await page.waitForSelector('.sg-chat-panel.show', { timeout: 5000 });
  await page.waitForTimeout(350);
  const ta = page.locator('.sg-chat-panel.show textarea[name="q"]');
  await ta.fill('what is BC?');
  await ta.press('Enter');
  await page.waitForFunction(() => {
    const a = document.querySelectorAll('.sg-chat-panel.show .sg-chat-msg.assistant');
    return a.length && a[a.length - 1].textContent.includes('tutor reply');
  }, null, { timeout: 8000 });
  await page.locator('.sg-chat-panel.show [data-action="copy-thread-md"]').click();
  await page.waitForTimeout(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check('tutor-mode copy md writes a transcript', clip.includes('what is BC') && clip.includes('tutor reply'),
    { clipPreview: clip.slice(0, 120) });
  const btnText = await page.locator('.sg-chat-panel.show [data-action="copy-thread-md"]').textContent();
  check('tutor-mode copy md flashes "✓ copied" confirm', btnText.includes('copied'), { btnText });

  // ---------- Outline collapses when material viewer + chat are both open ----------
  // The lesson is already loaded; tutor chat panel is currently open from
  // the previous test. Open the material viewer too — now sidebar + viewer
  // + content + outline + chat = more than fits in 1500px → outline should
  // auto-collapse to the popover.
  await page.locator('#sidebar-materials .material-item').first().click();
  await page.waitForSelector('#material-viewer:not([hidden])', { timeout: 3000 });
  await page.waitForTimeout(300);
  const layoutState = await page.evaluate(() => ({
    chatOpen: document.body.classList.contains('sg-chat-open'),
    matOpen: document.querySelector('#view-reader .app')?.classList.contains('material-open'),
    noRoom: document.body.classList.contains('outline-no-room'),
    railDisplay: getComputedStyle(document.getElementById('outline-rail')).display,
    vw: window.innerWidth,
  }));
  check('outline auto-collapses when viewer + chat both open in 1500px',
    layoutState.chatOpen && layoutState.matOpen && layoutState.noRoom && layoutState.railDisplay === 'none',
    layoutState);

  // Close the chat panel — viewer still open. Confirm outline status updates.
  await page.locator('.sg-chat-panel.show [data-action="close-chat"]').click().catch(() => {});
  await page.waitForTimeout(300);
  const afterChatClose = await page.evaluate(() => ({
    chatOpen: document.body.classList.contains('sg-chat-open'),
    matOpen: document.querySelector('#view-reader .app')?.classList.contains('material-open'),
    noRoom: document.body.classList.contains('outline-no-room'),
    vw: window.innerWidth,
  }));
  // sidebar 256 + matW ~420 + 1320 = ~1996, vw=1500 → still no-room
  check('outline stays collapsed when viewer alone still eats space',
    !afterChatClose.chatOpen && afterChatClose.matOpen && afterChatClose.noRoom,
    afterChatClose);

  // Close the viewer. Now there's plenty of room → outline should reappear.
  await page.locator('[data-action="close-material"]').click().catch(() => {});
  await page.waitForTimeout(300);
  const allClosed = await page.evaluate(() => ({
    chatOpen: document.body.classList.contains('sg-chat-open'),
    matOpen: document.querySelector('#view-reader .app')?.classList.contains('material-open'),
    noRoom: document.body.classList.contains('outline-no-room'),
  }));
  check('outline returns to inline when nothing extra is open',
    !allClosed.chatOpen && !allClosed.matOpen && !allClosed.noRoom,
    allClosed);

  check('no JS console errors', errs.length === 0, errs.slice(0, 5));
} catch (e) {
  console.error('exception:', e.stack || e.message);
  results.push({ label: 'exception', ok: false, extra: e.message });
} finally {
  await browser.close();
}

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n${pass}/${results.length} passed, ${fail} failed.`);
fs.writeFileSync('/tmp/sg-bugs/round1-fixes-verification.json', JSON.stringify(results, null, 2));
process.exit(fail ? 1 : 0);
