// (1) Intake page now restores the prior tutor-chat history on entry
//     (it shares storage with the tutor panel, so coming back to the
//     intake shows what was already said).
// (2) Each user message in the tutor panel, btw panel, and intake page has
//     an edit ✎ button. Editing one truncates the conversation at that
//     point, PUTs the rewritten history to the server, and re-runs the
//     turn with the new text (Claude.app-style).
//
// /api/tutor and /api/btw-ask are intercepted in-page so we don't burn
// real LLM calls for the re-run path.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:4321';
const TRACKS_DIR = '/home/LYP/studyground/tracks';
const TEST_SLUG = 'studyground-edit-msg-test';
const TEST_TRACK_DIR = join(TRACKS_DIR, TEST_SLUG);

const r = [];
const pass = (n, info = '') => { r.push({ n, ok: true }); console.log('PASS', n, info); };
const fail = (n, info = '') => { r.push({ n, ok: false }); console.log('FAIL', n, info); };

function ensureTestTrack() {
  if (existsSync(TEST_TRACK_DIR)) rmSync(TEST_TRACK_DIR, { recursive: true, force: true });
  mkdirSync(join(TEST_TRACK_DIR, 'lessons'), { recursive: true });
  mkdirSync(join(TEST_TRACK_DIR, 'materials'), { recursive: true });
  writeFileSync(
    join(TEST_TRACK_DIR, 'track.json'),
    JSON.stringify({
      slug: TEST_SLUG,
      title: 'Edit-msg test',
      description: '',
      emoji: '✏️',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, null, 2),
  );
  writeFileSync(
    join(TEST_TRACK_DIR, 'curriculum.md'),
    '# Curriculum\n\n1. 01-hello — Hello\n',
  );
  writeFileSync(
    join(TEST_TRACK_DIR, 'lessons', '01-hello.md'),
    '# Hello\n\nA tiny test lesson.\n',
  );
}

ensureTestTrack();

// Pre-seed the tutor history (which the intake page also reads) so we have
// a non-empty conversation to test against.
const seedHistory = [
  { role: 'user', content: 'i want to learn linear algebra' },
  { role: 'assistant', content: 'great — what brought you to it?' },
  { role: 'user', content: 'for ML work, eigenvalues mostly' },
  { role: 'assistant', content: 'noted: ML applications, eigen focus.' },
];
const seedResp = await fetch(`${BASE}/api/tutor/${TEST_SLUG}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ history: seedHistory }),
}).then((r) => r.json());
seedResp.ok && seedResp.history.length === 4 ? pass('seeded tutor history via PUT') : fail('seed failed');

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1400, height: 950 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
p.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE.err:', m.text()); });

// Fake stream installer — for any /api/tutor or /api/btw-ask POST.
async function installFakeStream(page) {
  await page.evaluate(() => {
    const origFetch = window.fetch.bind(window);
    window.__fakeAnswer = 'ok new answer';
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input?.url || '';
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'POST' && (url.endsWith('/api/tutor') || url.endsWith('/api/btw-ask') || url.endsWith('/api/intake'))) {
        const encoder = new TextEncoder();
        const text = window.__fakeAnswer;
        const body = new ReadableStream({
          async pull(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text })}\n\n`));
            await new Promise((r) => setTimeout(r, 80));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              type: 'done', duration_ms: 120, cost_usd: 0.001, full_text: text, thread_id: 'fake-thread-id',
            })}\n\n`));
            controller.close();
          },
        });
        return Promise.resolve(new Response(body, {
          status: 200, headers: { 'Content-Type': 'text/event-stream' },
        }));
      }
      return origFetch(input, init);
    };
  });
}

// ============================================================
// (1) Intake page loads prior history
// ============================================================
console.log('\n[1] intake page restores prior tutor history');
await p.goto(`${BASE}/#/t/${TEST_SLUG}/intake`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.getElementById('intake-messages')?.querySelectorAll('.intake-msg').length > 0, null, { timeout: 5000 });
const intakeOnEnter = await p.evaluate(() => {
  const items = [...document.querySelectorAll('#intake-messages .intake-msg')];
  return items
    .filter((el) => !el.classList.contains('intake-curriculum-note'))
    .map((el) => ({ role: el.classList.contains('user') ? 'user' : 'assistant', text: (el.querySelector('.sg-chat-msg-body') || el).textContent.trim() }));
});
console.log('  rendered:', intakeOnEnter);
intakeOnEnter.length === 4 ? pass('renders all 4 seeded messages') : fail(`got ${intakeOnEnter.length}`);
intakeOnEnter[0]?.text === 'i want to learn linear algebra' ? pass('first user message present') : fail(`first=${intakeOnEnter[0]?.text}`);
intakeOnEnter[2]?.text === 'for ML work, eigenvalues mostly' ? pass('second user message present') : fail(`second=${intakeOnEnter[2]?.text}`);

// Edit buttons exist on user messages
const editButtons = await p.evaluate(() =>
  [...document.querySelectorAll('#intake-messages .intake-msg.user .sg-chat-msg-edit-btn')].length,
);
editButtons === 2 ? pass('edit button on each user message') : fail(`got ${editButtons}`);

// "curriculum already exists" note should be appended since we have curriculum.json
const hasNote = await p.evaluate(() => !!document.querySelector('.intake-curriculum-note'));
hasNote ? pass('curriculum-exists note present') : fail('curriculum note missing');

// ============================================================
// (2) Intake: edit a user message → truncate + re-run
// ============================================================
console.log('\n[2] intake: edit + re-run');
await installFakeStream(p);
await p.evaluate(() => { window.__fakeAnswer = 'understood — focusing on eigen-decomposition.'; });

// Click ✎ on the SECOND user message ("for ML work, eigenvalues mostly")
await p.evaluate(() => {
  const userMsgs = document.querySelectorAll('#intake-messages .intake-msg.user');
  userMsgs[1].querySelector('.sg-chat-msg-edit-btn').click();
});
await p.waitForSelector('#intake-messages .intake-msg.user.editing .sg-chat-msg-edit-area');
const editingState = await p.evaluate(() => ({
  taValue: document.querySelector('#intake-messages .intake-msg.user.editing textarea').value,
}));
editingState.taValue === 'for ML work, eigenvalues mostly' ? pass('edit textarea pre-fills original text') : fail(`got "${editingState.taValue}"`);

// Edit + Save & re-run
await p.evaluate(() => {
  const ta = document.querySelector('#intake-messages .intake-msg.user.editing textarea');
  ta.value = 'for ML — specifically attention math';
  ta.dispatchEvent(new Event('input'));
});
// Wait for the PUT to fire, then the streamed re-run
const [putRes] = await Promise.all([
  p.waitForResponse((res) => res.url().endsWith(`/api/tutor/${TEST_SLUG}`) && res.request().method() === 'PUT'),
  p.evaluate(() => document.querySelector('#intake-messages .intake-msg.user.editing .sg-chat-msg-edit-save').click()),
]);
const putJson = await putRes.json();
console.log('  PUT response history:', putJson.history?.map((m) => m.content.slice(0, 35)));
// preHistory = first 2 (the user msg at idx=2 is dropped + everything after)
putJson.history?.length === 2 ? pass('PUT body truncates history to pre-edit') : fail(`PUT length=${putJson.history?.length}`);
putJson.history?.[0]?.content === 'i want to learn linear algebra' ? pass('PUT preserves earlier turns') : fail();

// Wait for fake stream to land
await p.waitForFunction(() => {
  const last = document.querySelector('#intake-messages .intake-msg:last-child');
  return last?.classList.contains('assistant') && last.textContent.includes('attention math') === false && last.textContent.length > 5;
}, null, { timeout: 4000 });

const intakeAfterEdit = await p.evaluate(() => {
  const items = [...document.querySelectorAll('#intake-messages .intake-msg')];
  return items
    .filter((el) => !el.classList.contains('intake-curriculum-note'))
    .map((el) => ({ role: el.classList.contains('user') ? 'user' : 'assistant', text: (el.querySelector('.sg-chat-msg-body') || el).textContent.trim() }));
});
console.log('  intake after edit:', intakeAfterEdit);
intakeAfterEdit.length === 4 ? pass('intake has 4 messages (2 pre + edited user + new asst)') : fail(`length=${intakeAfterEdit.length}`);
intakeAfterEdit[2]?.text === 'for ML — specifically attention math' ? pass('edited user message visible') : fail(`got "${intakeAfterEdit[2]?.text}"`);
intakeAfterEdit[3]?.text.includes('eigen-decomposition') ? pass('new assistant response visible') : fail(`got "${intakeAfterEdit[3]?.text}"`);

// ============================================================
// (3) Tutor panel: edit a user message → truncate + re-run
// ============================================================
console.log('\n[3] tutor panel: edit + re-run');
// Reset the on-disk history to a known shape (the intake-test edited it)
await fetch(`${BASE}/api/tutor/${TEST_SLUG}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ history: seedHistory }),
});

// Go into reader view + open tutor
await p.goto(`${BASE}/#/t/${TEST_SLUG}/`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('#btn-tutor'));
await installFakeStream(p);  // re-install (new page context after navigation)
await p.evaluate(() => { window.__fakeAnswer = 'fresh response on the edited question'; });
await p.click('#btn-tutor');
await p.waitForFunction(() => document.querySelector('.sg-chat-panel')?.classList.contains('show'));
await p.waitForFunction(() => document.querySelectorAll('.sg-chat-messages .sg-chat-msg').length >= 4);

// Click ✎ on the second user message
await p.evaluate(() => {
  const users = document.querySelectorAll('.sg-chat-messages .sg-chat-msg.user');
  users[1].querySelector('.sg-chat-msg-edit-btn').click();
});
await p.waitForSelector('.sg-chat-msg.user.editing .sg-chat-msg-edit-area');
const tutorTaVal = await p.evaluate(() => document.querySelector('.sg-chat-msg.user.editing textarea').value);
tutorTaVal === 'for ML work, eigenvalues mostly' ? pass('tutor edit textarea pre-fills') : fail(`got "${tutorTaVal}"`);

await p.evaluate(() => {
  const ta = document.querySelector('.sg-chat-msg.user.editing textarea');
  ta.value = 'actually I care about transformers';
});

const [tutorPut] = await Promise.all([
  p.waitForResponse((res) => res.url().endsWith(`/api/tutor/${TEST_SLUG}`) && res.request().method() === 'PUT'),
  p.evaluate(() => document.querySelector('.sg-chat-msg.user.editing .sg-chat-msg-edit-save').click()),
]);
const tutorPutJson = await tutorPut.json();
tutorPutJson.history?.length === 2 ? pass('tutor PUT truncates to pre-edit') : fail(`len=${tutorPutJson.history?.length}`);

await p.waitForFunction(() => {
  const last = document.querySelector('.sg-chat-messages .sg-chat-msg:last-child');
  return last?.classList.contains('assistant') && last.textContent.includes('fresh response');
}, null, { timeout: 4000 });

const tutorAfter = await p.evaluate(() => {
  const items = [...document.querySelectorAll('.sg-chat-messages .sg-chat-msg')];
  return items.map((el) => ({ role: el.classList.contains('user') ? 'user' : 'assistant', text: (el.querySelector('.sg-chat-msg-body') || el).textContent.trim() }));
});
console.log('  tutor after edit:', tutorAfter);
tutorAfter.length === 4 ? pass('tutor panel has 4 messages after re-run') : fail(`len=${tutorAfter.length}`);
tutorAfter[2]?.text === 'actually I care about transformers' ? pass('edited tutor message visible') : fail(`got "${tutorAfter[2]?.text}"`);
tutorAfter[3]?.text.includes('fresh response') ? pass('new tutor assistant response visible') : fail();

// ============================================================
// (4) Edit Cancel doesn't truncate
// ============================================================
console.log('\n[4] cancel keeps the conversation intact');
await p.evaluate(() => {
  const users = document.querySelectorAll('.sg-chat-messages .sg-chat-msg.user');
  users[0].querySelector('.sg-chat-msg-edit-btn').click();
});
await p.waitForSelector('.sg-chat-msg.user.editing');
await p.evaluate(() => document.querySelector('.sg-chat-msg.user.editing .sg-chat-msg-edit-cancel').click());
await p.waitForFunction(() => !document.querySelector('.sg-chat-msg.user.editing'));
const afterCancel = await p.evaluate(() => document.querySelectorAll('.sg-chat-messages .sg-chat-msg').length);
afterCancel === 4 ? pass('cancel preserves all 4 messages') : fail(`got ${afterCancel}`);

await b.close();
try { rmSync(TEST_TRACK_DIR, { recursive: true, force: true }); } catch {}

const ok = r.every((x) => x.ok);
console.log(ok ? `\n${r.length}/${r.length} PASS` : '\nFAIL');
process.exit(ok ? 0 : 1);
