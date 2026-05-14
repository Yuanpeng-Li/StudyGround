// Verify (a) chat panel resizable + persisted, (b) sidebar collapse toggle + persisted,
// (c) in-panel text selection shows quote chip and is captured for submit.
import { chromium } from 'playwright';

const BASE = 'http://localhost:4321';
const results = [];
const pass = (n, info='') => { results.push({n, ok: true}); console.log('PASS', n, info); };
const fail = (n, info='') => { results.push({n, ok: false}); console.log('FAIL', n, info); };

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1500, height: 1100 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await p.goto(`${BASE}/#/t/transformers-from-scratch-1/`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#lesson-view h1'));
await p.waitForTimeout(700);

// --- 1. SIDEBAR COLLAPSE ---
console.log('\n[1] sidebar collapse toggle');
const toggleExists = await p.locator('.sidebar-toggle').count();
toggleExists ? pass('sidebar-toggle button rendered') : fail('sidebar-toggle button rendered');

const widthBefore = await p.evaluate(() => document.getElementById('sidebar').getBoundingClientRect().width);
console.log('  width before:', widthBefore);

await p.locator('.sidebar-toggle').click();
await p.waitForTimeout(300);

const stateCollapsed = await p.evaluate(() => ({
  width: document.getElementById('sidebar').getBoundingClientRect().width,
  classList: document.querySelector('#view-reader .app').className,
  lessonsHidden: document.querySelector('#sidebar-lessons')?.offsetParent === null,
}));
console.log('  collapsed:', stateCollapsed);
stateCollapsed.classList.includes('sidebar-collapsed') ? pass('app has .sidebar-collapsed') : fail('app has .sidebar-collapsed');
stateCollapsed.width < 60 ? pass(`sidebar shrunk (${stateCollapsed.width.toFixed(0)}px)`) : fail('sidebar shrunk');
stateCollapsed.lessonsHidden ? pass('sidebar contents hidden') : fail('sidebar contents hidden');

// Reload to verify persistence
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#lesson-view h1') || document.getElementById('view-reader'));
await p.waitForTimeout(700);
const persisted = await p.evaluate(() =>
  document.querySelector('#view-reader .app')?.classList.contains('sidebar-collapsed')
);
persisted ? pass('sidebar state persisted across reload') : fail('sidebar state persisted across reload');

// Expand again
await p.locator('.sidebar-toggle').click();
await p.waitForTimeout(300);
const widthAfter = await p.evaluate(() => document.getElementById('sidebar').getBoundingClientRect().width);
widthAfter > 200 ? pass(`sidebar expanded (${widthAfter.toFixed(0)}px)`) : fail('sidebar expanded');

// --- 2. CHAT PANEL RESIZE ---
console.log('\n[2] chat panel resize');
// Open btw via outline btw button (cheap, no claude call)
const outlineBtw = await p.locator('button[data-action="btw-outline"]').count();
if (!outlineBtw) {
  fail('no outline btw button — cannot open btw panel');
} else {
  await p.locator('button[data-action="btw-outline"]').first().click();
  await p.waitForTimeout(300);
}

const panelW1 = await p.evaluate(() => document.querySelector('.sg-chat-panel')?.getBoundingClientRect().width);
console.log('  initial panel width:', panelW1);
panelW1 >= 320 && panelW1 <= 600 ? pass(`panel width in expected initial range (${panelW1.toFixed(0)}px)`) : fail('panel initial width');

const handleExists = await p.locator('.sg-chat-resize').count();
handleExists ? pass('resize handle present') : fail('resize handle present');

// Drag the handle leftward to widen panel
await p.evaluate(() => {
  const panel = document.querySelector('.sg-chat-panel');
  const handle = panel.querySelector('.sg-chat-resize');
  const rect = handle.getBoundingClientRect();
  const startX = rect.left + 2;
  const targetX = startX - 200; // drag 200px left -> panel widens by 200px
  function fire(type, x) {
    handle.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: rect.top + 10, button: 0 }));
    window.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: rect.top + 10, button: 0 }));
  }
  fire('mousedown', startX);
  fire('mousemove', targetX);
  fire('mouseup', targetX);
});
await p.waitForTimeout(150);
const panelW2 = await p.evaluate(() => document.querySelector('.sg-chat-panel')?.getBoundingClientRect().width);
console.log('  after-drag panel width:', panelW2);
panelW2 > panelW1 + 100 ? pass(`panel widened by drag (${panelW1.toFixed(0)} → ${panelW2.toFixed(0)})`) : fail(`panel did not widen (${panelW1} → ${panelW2})`);

// Persisted?
const saved = await p.evaluate(() => localStorage.getItem('sg-chat-width'));
saved ? pass(`width persisted to localStorage (${saved})`) : fail('width persisted');

// --- 3. PANEL SELECTION → QUOTE CHIP ---
console.log('\n[3] in-panel selection → quote chip');
// Inject an assistant message so we have something to highlight inside the panel
await p.evaluate(() => {
  const msgs = document.querySelector('.sg-chat-panel .sg-chat-messages');
  const div = document.createElement('div');
  div.className = 'sg-chat-msg assistant';
  div.textContent = 'This is the AIs answer about scaling: square-root-d-h fixes the variance.';
  msgs.appendChild(div);
});

await p.evaluate(() => {
  const target = document.querySelector('.sg-chat-panel .sg-chat-msg.assistant');
  const range = document.createRange();
  range.selectNodeContents(target);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});
await p.waitForTimeout(150);

const chip = await p.evaluate(() => {
  const c = document.querySelector('.sg-chat-quote-chip');
  const input = document.querySelector('.sg-chat-form input[name="q"]');
  const cr = c.getBoundingClientRect();
  const ir = input.getBoundingClientRect();
  return {
    visible: c?.classList.contains('show'),
    text: c?.textContent?.trim().slice(0, 100),
    chipY: cr.top,
    chipW: cr.width,
    inputY: ir.top,
    inputW: ir.width,
    chipAboveInput: cr.bottom <= ir.top + 1,
    chipFullWidth: cr.width > ir.width * 1.3, // chip should span much wider than the input on its own row
  };
});
console.log('  chip:', chip);
chip.visible ? pass('quote chip appears on selection') : fail('quote chip appears on selection');
(chip.text || '').includes('square-root') ? pass('chip shows selected text') : fail('chip shows selected text');
chip.chipAboveInput ? pass(`chip sits ABOVE input (chipY=${chip.chipY.toFixed(0)} chipBottom→inputY=${chip.inputY.toFixed(0)})`) : fail(`chip should be above input (chipY=${chip.chipY.toFixed(0)} inputY=${chip.inputY.toFixed(0)})`);
chip.chipW > 200 ? pass(`chip width reasonable (${chip.chipW.toFixed(0)}px)`) : fail(`chip width tiny (${chip.chipW.toFixed(0)}px)`);

// Placeholder should hint at highlighting
const placeholder = await p.evaluate(() => document.querySelector('.sg-chat-panel input[name="q"]')?.placeholder);
console.log('  placeholder:', placeholder);
(placeholder || '').toLowerCase().includes('highlight') ? pass('placeholder mentions highlighting') : fail('placeholder mentions highlighting');

// --- 4. SUBMIT WITH PANEL SELECTION (no claude call — intercept) ---
console.log('\n[4] selection injected into submitted question');
const captured = await p.evaluate(async () => {
  // Stub /api/btw-ask: return capture of request body
  let captured = null;
  const origFetch = window.fetch;
  window.fetch = (url, opts) => {
    if (typeof url === 'string' && url.includes('/api/btw-ask')) {
      try { captured = JSON.parse(opts.body); } catch {}
      // Return a fake closed stream
      const enc = new TextEncoder();
      const body = new ReadableStream({
        start(ctl) { ctl.enqueue(enc.encode('data: {"type":"done","duration_ms":1,"cost_usd":0,"num_turns":1,"thread_id":"x"}\n\n')); ctl.close(); }
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    }
    return origFetch(url, opts);
  };
  // Re-establish the selection just before submit
  const target = document.querySelector('.sg-chat-panel .sg-chat-msg.assistant');
  const range = document.createRange();
  range.selectNodeContents(target);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const input = document.querySelector('.sg-chat-panel input[name="q"]');
  input.value = 'explain that bit';
  document.querySelector('.sg-chat-panel .sg-chat-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  window.fetch = origFetch;
  return captured;
});
console.log('  captured request body keys:', Object.keys(captured || {}));
console.log('  question sent:', (captured?.question || '').slice(0, 200));
const includesQuote = (captured?.question || '').includes('quoted from this chat');
includesQuote ? pass('submitted question contains the quoted selection') : fail('submitted question contains the quoted selection');

await b.close();
const ok = results.every((r) => r.ok);
console.log('\n' + '='.repeat(60));
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(ok ? 0 : 1);
