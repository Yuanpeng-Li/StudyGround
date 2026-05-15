// (1) Edit-track from home: pencil button → dialog → PATCH → updated card.
// (2) Background streaming: tutor stream keeps painting after the panel is
//     closed and re-opened (the user's stated requirement: "切换界面时候
//     llm应该依然可以再后台继续生成").
//
// To avoid burning real LLM cost, the streaming test intercepts /api/tutor
// in the page and replays a controlled SSE stream so we can measure exactly
// what's on screen at each step.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:4321';
const TRACKS_DIR = '/home/LYP/studyground/tracks';
const TEST_SLUG = 'studyground-edit-test';
const TEST_TRACK_DIR = join(TRACKS_DIR, TEST_SLUG);

const r = [];
const pass = (n, info = '') => { r.push({ n, ok: true }); console.log('PASS', n, info); };
const fail = (n, info = '') => { r.push({ n, ok: false }); console.log('FAIL', n, info); };

// ---- Setup: ensure we have a test track with a lesson so the reader
// view shows and the Tutor button is reachable.
function ensureTestTrack() {
  if (existsSync(TEST_TRACK_DIR)) rmSync(TEST_TRACK_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_TRACK_DIR, 'lessons'), { recursive: true });
  mkdirSync(join(TEST_TRACK_DIR, 'materials'), { recursive: true });
  writeFileSync(
    join(TEST_TRACK_DIR, 'track.json'),
    JSON.stringify({
      slug: TEST_SLUG,
      title: 'Edit test course',
      description: 'original description',
      emoji: '🧪',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, null, 2),
  );
  writeFileSync(
    join(TEST_TRACK_DIR, 'curriculum.json'),
    JSON.stringify({ goals: 'test', plan: [{ slug: '01-hello', title: 'Hello' }] }, null, 2),
  );
  writeFileSync(
    join(TEST_TRACK_DIR, 'lessons', '01-hello.md'),
    '# Hello\n\nThis is a tiny lesson used by the test.\n',
  );
}

function cleanup() {
  try { rmSync(TEST_TRACK_DIR, { recursive: true, force: true }); } catch {}
}

ensureTestTrack();

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
p.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE.err:', m.text()); });

// ============================================================
// (1) Edit-track from home
// ============================================================
console.log('\n[1] edit-track from home');
await p.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector(`.track-card[data-slug="${TEST_SLUG}"]`);

// Pencil button should be present (was added in this change)
const hasEdit = await p.$(`.track-card[data-slug="${TEST_SLUG}"] .track-edit`);
hasEdit ? pass('pencil button present on card') : fail('pencil button missing');

// Click pencil — should open dialog with current values
await p.click(`.track-card[data-slug="${TEST_SLUG}"] .track-edit`);
await p.waitForSelector('#edit-track-dialog[open]');

const initial = await p.evaluate(() => ({
  title: document.getElementById('et-title').value,
  desc: document.getElementById('et-desc').value,
  emoji: document.getElementById('et-emoji').value,
  slugHint: document.getElementById('et-slug-hint').textContent,
}));
console.log('  dialog initial:', initial);
initial.title === 'Edit test course' ? pass('dialog pre-fills title') : fail(`title="${initial.title}"`);
initial.desc === 'original description' ? pass('dialog pre-fills description') : fail(`desc="${initial.desc}"`);
initial.emoji === '🧪' ? pass('dialog pre-fills emoji') : fail(`emoji="${initial.emoji}"`);
initial.slugHint?.includes(TEST_SLUG) ? pass('dialog shows slug hint') : fail(`hint="${initial.slugHint}"`);

// Change values + save
await p.fill('#et-title', 'Renamed course');
await p.fill('#et-desc', 'new description here');
await p.fill('#et-emoji', '🔬');
await Promise.all([
  p.waitForResponse((res) => res.url().endsWith(`/api/tracks/${TEST_SLUG}`) && res.request().method() === 'PATCH'),
  p.click('#edit-track-form button[type="submit"]'),
]);
await p.waitForFunction(() => !document.getElementById('edit-track-dialog').open);

// Card should re-render with new fields
await p.waitForFunction(
  (slug) => document.querySelector(`.track-card[data-slug="${slug}"] .track-title`)?.textContent === 'Renamed course',
  TEST_SLUG,
  { timeout: 5000 },
);
const after = await p.evaluate((slug) => {
  const card = document.querySelector(`.track-card[data-slug="${slug}"]`);
  return {
    title: card.querySelector('.track-title')?.textContent,
    desc: card.querySelector('.track-desc')?.textContent,
    emoji: card.querySelector('.track-emoji')?.textContent,
  };
}, TEST_SLUG);
console.log('  card after save:', after);
after.title === 'Renamed course' ? pass('card title updated') : fail(`title=${after.title}`);
after.desc === 'new description here' ? pass('card desc updated') : fail(`desc=${after.desc}`);
after.emoji === '🔬' ? pass('card emoji updated') : fail(`emoji=${after.emoji}`);

// Server-side: meta.json got rewritten
const persisted = await fetch(`${BASE}/api/tracks/${TEST_SLUG}`).then((r) => r.json());
persisted.track.title === 'Renamed course' && persisted.track.description === 'new description here'
  ? pass('server persists edit')
  : fail(JSON.stringify(persisted.track));

// Slug should be untouched (rename = title only, folder + URL stable)
existsSync(TEST_TRACK_DIR) ? pass('original folder preserved (slug locked)') : fail('folder renamed!');

// ============================================================
// (2) Background streaming: close panel mid-stream, re-open, see text
// ============================================================
console.log('\n[2] tutor stream survives close → re-open');

// Intercept /api/tutor with a controlled SSE stream. We can't easily
// stream from page.route, so override window.fetch from inside the page.
await p.evaluate(() => {
  const origFetch = window.fetch.bind(window);
  window.__streamChunksSent = 0;
  window.__streamComplete = false;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (url.endsWith('/api/tutor')) {
      const encoder = new TextEncoder();
      const chunks = [
        'Hello',
        ' there!',
        ' I am',
        ' your tutor.',
        ' Let us',
        ' begin.',
      ];
      let idx = 0;
      const body = new ReadableStream({
        async pull(controller) {
          if (idx < chunks.length) {
            const ev = `data: ${JSON.stringify({ type: 'delta', text: chunks[idx] })}\n\n`;
            controller.enqueue(encoder.encode(ev));
            idx += 1;
            window.__streamChunksSent = idx;
            await new Promise((r) => setTimeout(r, 350));
          } else {
            const done = `data: ${JSON.stringify({ type: 'done', duration_ms: 2100, cost_usd: 0.001 })}\n\n`;
            controller.enqueue(encoder.encode(done));
            window.__streamComplete = true;
            controller.close();
          }
        },
      });
      return Promise.resolve(new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    }
    return origFetch(input, init);
  };
});

// Navigate into the test track's reader view
location: {
  await p.goto(`${BASE}/#/t/${TEST_SLUG}/`, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.querySelector('#btn-tutor'));
  await p.waitForTimeout(300);
}

// Click "Tutor" → panel opens (no auto-greeting; we must send a message)
await p.click('#btn-tutor');
await p.waitForSelector('.sg-chat-panel.show, [class*="sg-chat-panel"].show', { timeout: 3000 }).catch(() => {});
// Empty-state hint should be present
const hintVisible = await p.evaluate(() => !!document.querySelector('.sg-chat-empty-hint'));
hintVisible ? pass('empty-state hint present, no auto-greet') : fail('empty-state hint missing');
// Type a question + submit to kick the (intercepted) stream
await p.fill('.sg-chat-form input[name="q"]', 'hi tutor');
await p.click('.sg-chat-form button[type="submit"]');
// Wait for at least 2 chunks to land in the placeholder
await p.waitForFunction(
  () => Number(window.__streamChunksSent) >= 2,
  null,
  { timeout: 4000 },
);
const partialBefore = await p.evaluate(() => {
  const msgs = document.querySelector('.sg-chat-messages');
  const last = msgs?.lastElementChild;
  return { text: last?.textContent?.trim(), classes: last?.className };
});
console.log('  partial after 2 chunks:', partialBefore);
partialBefore.text?.length > 0 ? pass('placeholder has partial text') : fail('no text yet');
partialBefore.classes?.includes('streaming') ? pass('placeholder is .streaming') : fail(`classes=${partialBefore.classes}`);

// Close panel mid-stream
await p.click('[data-action="close-chat"]');
await p.waitForFunction(() => !document.body.classList.contains('sg-chat-open'));
const closedState = await p.evaluate(() => ({
  hasShow: document.querySelector('.sg-chat-panel')?.classList.contains('show'),
  bodyOpen: document.body.classList.contains('sg-chat-open'),
  chunksSentNow: window.__streamChunksSent,
}));
!closedState.hasShow && !closedState.bodyOpen ? pass('panel hidden after close') : fail(JSON.stringify(closedState));

// Wait for more chunks to flow while the panel is hidden — proof that the
// stream is still alive in the background.
const chunksAtClose = closedState.chunksSentNow;
await p.waitForFunction(
  (atClose) => Number(window.__streamChunksSent) > atClose,
  chunksAtClose,
  { timeout: 4000 },
);
pass('stream kept emitting chunks after panel close');

// Re-open tutor — same key, same conversation. The in-progress text
// should already be visible (no flicker, no refetch).
await p.click('#btn-tutor');
await p.waitForFunction(() => document.body.classList.contains('sg-chat-open'));
const reopenedNow = await p.evaluate(() => {
  const msgs = document.querySelector('.sg-chat-messages');
  const last = msgs?.lastElementChild;
  return {
    visibleText: last?.textContent?.trim() || '',
    chunksSent: window.__streamChunksSent,
    complete: window.__streamComplete,
  };
});
console.log('  on re-open:', reopenedNow);
reopenedNow.visibleText.length > 0 ? pass(`re-opened, partial text visible (${reopenedNow.visibleText.length} chars)`) : fail('no text on reopen');

// Wait for the stream to finish + verify final text on screen
await p.waitForFunction(() => window.__streamComplete === true, null, { timeout: 5000 });
await p.waitForTimeout(300);
const final = await p.evaluate(() => {
  const msgs = document.querySelector('.sg-chat-messages');
  const last = msgs?.lastElementChild;
  return {
    text: last?.textContent?.trim() || '',
    classes: last?.className || '',
  };
});
console.log('  final text:', final);
final.text === 'Hello there! I am your tutor. Let us begin.' ? pass('full streamed text rendered') : fail(`final=${final.text}`);
!final.classes.includes('streaming') ? pass('placeholder no longer .streaming') : fail(`still streaming: ${final.classes}`);

// Same-key short-circuit: close + re-open should NOT refetch history.
let tutorHistoryFetchCount = 0;
p.on('request', (req) => { if (req.url().endsWith(`/api/tutor/${TEST_SLUG}`)) tutorHistoryFetchCount++; });
await p.click('[data-action="close-chat"]');
await p.waitForTimeout(100);
await p.click('#btn-tutor');
await p.waitForFunction(() => document.body.classList.contains('sg-chat-open'));
await p.waitForTimeout(300);
tutorHistoryFetchCount === 0
  ? pass('same-key reopen does not refetch history')
  : fail(`refetched ${tutorHistoryFetchCount}× — wipe path triggered`);

// And the messages should still be there
const stillThere = await p.evaluate(() => {
  const msgs = document.querySelector('.sg-chat-messages');
  return msgs?.lastElementChild?.textContent?.trim() || '';
});
stillThere.includes('your tutor') ? pass('transcript preserved through close+reopen') : fail(`transcript=${stillThere}`);

await b.close();
cleanup();

const ok = r.every((x) => x.ok);
console.log(ok ? `\n${r.length}/${r.length} PASS` : '\nFAIL');
process.exit(ok ? 0 : 1);
