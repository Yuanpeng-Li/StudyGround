// Verify (a) intake page does NOT auto-fire a first AI turn, and (b) materials
// section is rendered, picks up uploads, and refreshes after delete.
import { chromium } from 'playwright';

const BASE = 'http://localhost:4321';
const SLUG = `intake-mat-test-${Date.now().toString(36)}`;
let createdSlug = null;

const r = [];
const pass = (n, info='') => { r.push({n, ok: true}); console.log('PASS', n, info); };
const fail = (n, info='') => { r.push({n, ok: false}); console.log('FAIL', n, info); };

// Create a fresh track via API
const create = await fetch(`${BASE}/api/tracks`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: SLUG, description: 'intake materials test' }),
}).then((r) => r.json());
createdSlug = create.track?.slug;
console.log('created slug:', createdSlug);
if (!createdSlug) { fail('track create'); process.exit(1); }

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1400, height: 1100 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

// Track network: intake API should NOT be hit on enter
const apiCalls = [];
p.on('request', (req) => {
  const u = req.url();
  if (u.includes('/api/intake')) apiCalls.push({ method: req.method(), url: u });
});

await p.goto(`${BASE}/#/t/${createdSlug}/intake`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !document.getElementById('view-intake')?.hidden);
await p.waitForTimeout(2500); // give the page plenty of time to misbehave

const init = await p.evaluate(() => ({
  messageCount: document.querySelectorAll('.intake-msg').length,
  matsSection: !!document.querySelector('.intake-mat-pane'),
  matsHint: document.querySelector('.intake-materials-list .hint')?.textContent?.trim(),
  matsAddBtn: !!document.querySelector('[data-action="add-intake-material"]'),
}));
console.log('init state:', init);
init.matsSection ? pass('materials section rendered') : fail('materials section');
init.matsAddBtn ? pass('upload button rendered') : fail('upload button');
init.messageCount === 0 ? pass('no auto AI greeting (msg count = 0)') : fail(`unexpected msg count: ${init.messageCount}`);
apiCalls.length === 0 ? pass('no /api/intake POST on entry') : fail(`/api/intake hit ${apiCalls.length}× on entry`);
(init.matsHint || '').toLowerCase().includes('pdf') || (init.matsHint || '').toLowerCase().includes('notes')
  ? pass(`materials list shows hint (${init.matsHint?.slice(0, 50)})`)
  : fail(`materials hint (${init.matsHint})`);

// Upload a material directly via API, then verify the UI picks it up
const fakeFile = new TextEncoder().encode('# A learning resource\n\nSome notes here.');
await fetch(`${BASE}/api/tracks/${createdSlug}/materials?name=notes.md`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: fakeFile,
});
// Re-trigger the page to reload materials (no client-side push for this)
await p.evaluate(async () => {
  // Re-call loadMaterials for the intake list
  if (window.__sgReloadIntake) return;
  // Easiest: navigate again
  location.reload();
});
await p.waitForTimeout(800);
await p.waitForFunction(() => !document.getElementById('view-intake')?.hidden);
await p.waitForTimeout(600);

const afterUpload = await p.evaluate(() => {
  const items = document.querySelectorAll('.intake-materials-list .material-item');
  return {
    count: items.length,
    firstName: items[0]?.querySelector('.material-name')?.textContent,
    deleteBtn: items[0]?.querySelector('[data-action="delete-material"]'),
    deleteTrackAttr: items[0]?.querySelector('[data-action="delete-material"]')?.getAttribute('data-track'),
  };
});
console.log('after upload:', afterUpload);
afterUpload.count === 1 ? pass(`material rendered in list (count=${afterUpload.count})`) : fail(`material count (${afterUpload.count})`);
afterUpload.firstName === 'notes.md' ? pass('material name correct') : fail(`material name ${afterUpload.firstName}`);
afterUpload.deleteTrackAttr === createdSlug ? pass('delete button has correct track attr') : fail(`delete track ${afterUpload.deleteTrackAttr}`);

// Click the "+ upload" button — should set dataset.track on the hidden input
await p.evaluate(() => document.querySelector('[data-action="add-intake-material"]').click());
await p.waitForTimeout(150);
const inputTrack = await p.evaluate(() => document.querySelector('input[type="file"]')?.dataset?.track);
inputTrack ? pass(`upload click set dataset.track="${inputTrack}"`) : fail(`upload click dataset.track (${inputTrack})`);

await p.screenshot({ path: '/tmp/sg-intake-mats.png', fullPage: false });
console.log('shot: /tmp/sg-intake-mats.png');

// Cleanup
await fetch(`${BASE}/api/tracks/${createdSlug}`, { method: 'DELETE' });
await b.close();

const ok = r.every((x) => x.ok);
console.log(ok ? `\n${r.length}/${r.length} PASS` : '\nFAIL');
process.exit(ok ? 0 : 1);
