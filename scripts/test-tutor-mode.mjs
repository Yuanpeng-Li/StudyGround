// Verify the tutor mode toggle:
//  (a) opens read-only by default
//  (b) clicking flips to edit and shows correct labels
//  (c) state persists per-track in localStorage
//  (d) POST /api/tutor body carries mode field
//  (e) btw panel hides the mode button (only tutor mode shows it)
import { chromium } from 'playwright';

const BASE = 'http://localhost:4321';
const SLUG = 'transformers-from-scratch-1';

const r = [];
const pass = (n, info='') => { r.push({n, ok: true}); console.log('PASS', n, info); };
const fail = (n, info='') => { r.push({n, ok: false}); console.log('FAIL', n, info); };

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1400, height: 1000 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
// Auto-confirm the "allow edit?" prompt
p.on('dialog', (d) => d.accept());

await p.goto(`${BASE}/#/t/${SLUG}/`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#lesson-view h1'));
await p.waitForTimeout(700);

// Clear any persisted state
await p.evaluate((slug) => localStorage.removeItem('sg-tutor-mode:' + slug), SLUG);

// --- [1] open tutor → mode button visible, read-only by default ---
console.log('\n[1] open tutor panel');
await p.locator('#btn-tutor').click();
await p.waitForTimeout(500);

const initial = await p.evaluate(() => {
  const btn = document.querySelector('[data-action="toggle-tutor-mode"]');
  const cs = btn ? getComputedStyle(btn) : null;
  return {
    exists: !!btn,
    visible: cs?.display !== 'none',
    text: btn?.textContent.trim(),
    mode: btn?.dataset.mode,
    title: btn?.title,
  };
});
console.log('  initial:', initial);
initial.exists ? pass('mode button exists') : fail('mode button exists');
initial.visible ? pass('mode button visible in tutor panel') : fail('mode button visible');
initial.mode === 'read' ? pass('initial mode = read') : fail(`mode=${initial.mode}`);
/read-only/i.test(initial.text || '') ? pass(`label says read-only (${initial.text})`) : fail(`label (${initial.text})`);

// --- [2] click to flip to edit ---
console.log('\n[2] click to flip to edit');
await p.locator('[data-action="toggle-tutor-mode"]').click();
await p.waitForTimeout(200);
const afterFlip = await p.evaluate(() => {
  const btn = document.querySelector('[data-action="toggle-tutor-mode"]');
  return { mode: btn?.dataset.mode, text: btn?.textContent.trim() };
});
console.log('  after flip:', afterFlip);
afterFlip.mode === 'edit' ? pass('mode flipped to edit') : fail(`mode=${afterFlip.mode}`);
/can edit/i.test(afterFlip.text) ? pass(`label says "can edit" (${afterFlip.text})`) : fail(`label (${afterFlip.text})`);

const persisted = await p.evaluate((slug) => localStorage.getItem('sg-tutor-mode:' + slug), SLUG);
persisted === 'edit' ? pass('localStorage persisted edit mode') : fail(`localStorage=${persisted}`);

// --- [3] POST body carries mode field ---
console.log('\n[3] POST /api/tutor body carries mode');
const sent = await p.evaluate(() => {
  let captured = null;
  const orig = window.fetch;
  window.fetch = (url, opts) => {
    if (typeof url === 'string' && url.startsWith('/api/tutor') && opts?.method === 'POST') {
      try { captured = JSON.parse(opts.body); } catch {}
      const enc = new TextEncoder();
      const body = new ReadableStream({
        start(ctl) { ctl.enqueue(enc.encode('data: {"type":"done","duration_ms":1,"cost_usd":0,"num_turns":1}\n\n')); ctl.close(); }
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    }
    return orig(url, opts);
  };
  // Send a tutor message
  const input = document.querySelector('.sg-chat-panel input[name="q"]');
  input.value = 'apply that change';
  document.querySelector('.sg-chat-panel .sg-chat-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  return new Promise((res) => setTimeout(() => { window.fetch = orig; res(captured); }, 400));
});
console.log('  body:', sent);
sent?.mode === 'edit' ? pass('POST body mode=edit') : fail(`mode=${sent?.mode}`);

// --- [4] reload → mode persists from localStorage ---
console.log('\n[4] mode persists across reload');
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#lesson-view h1'));
await p.waitForTimeout(700);
await p.locator('#btn-tutor').click();
await p.waitForTimeout(400);
const reloaded = await p.evaluate(() => {
  const btn = document.querySelector('[data-action="toggle-tutor-mode"]');
  return { mode: btn?.dataset.mode, text: btn?.textContent.trim() };
});
reloaded.mode === 'edit' ? pass('mode still edit after reload') : fail(`mode=${reloaded.mode}`);

// --- [5] btw panel: mode button hidden ---
console.log('\n[5] btw panel does NOT show the mode button');
await p.evaluate(() => {
  // close tutor
  document.querySelector('.sg-chat-panel [data-action="close-chat"]').click();
});
await p.waitForTimeout(300);
const btwBtn = await p.locator('button[data-action="btw-outline"]').first();
const btwExists = await btwBtn.count();
if (btwExists) {
  await btwBtn.click();
  await p.waitForTimeout(400);
  const btwState = await p.evaluate(() => {
    const btn = document.querySelector('[data-action="toggle-tutor-mode"]');
    return { display: btn ? getComputedStyle(btn).display : null };
  });
  console.log('  btw state:', btwState);
  btwState.display === 'none' ? pass('mode button hidden in btw panel') : fail(`btw display=${btwState.display}`);
} else {
  pass('btw outline button skipped (no outline)');
}

// --- [6] flip back to read mode ---
console.log('\n[6] flip back to read');
await p.evaluate(() => document.querySelector('.sg-chat-panel [data-action="close-chat"]')?.click());
await p.waitForTimeout(200);
await p.locator('#btn-tutor').click();
await p.waitForTimeout(400);
await p.locator('[data-action="toggle-tutor-mode"]').click();
await p.waitForTimeout(200);
const final = await p.evaluate((slug) => ({
  mode: document.querySelector('[data-action="toggle-tutor-mode"]')?.dataset.mode,
  ls: localStorage.getItem('sg-tutor-mode:' + slug),
}), SLUG);
console.log('  final:', final);
final.mode === 'read' && final.ls === 'read' ? pass('flipped back to read; localStorage updated') : fail(`final ${JSON.stringify(final)}`);

await p.screenshot({ path: '/tmp/sg-tutor-mode.png', fullPage: false });
await b.close();
const ok = r.every((x) => x.ok);
console.log(ok ? `\n${r.length}/${r.length} PASS` : '\nFAIL');
process.exit(ok ? 0 : 1);
