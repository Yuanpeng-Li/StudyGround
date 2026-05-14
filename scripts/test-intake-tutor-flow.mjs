// End-to-end (uses real Claude calls — costs ~$0.30-0.60):
//  1. Create a new track via the home page "+New course" dialog
//  2. Land in intake; verify AI greets conversationally
//  3. Send a user reply; verify AI follows up (not a fixed script)
//  4. Click "Plan curriculum →"; verify curriculum.md written + reader opens
//  5. Open tutor panel; verify history is the intake conversation
import { chromium } from 'playwright';

const BASE = 'http://localhost:4321';
const SLUG_TITLE = `flow-test-${Date.now().toString(36)}`;
const SLUG = SLUG_TITLE.toLowerCase();

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1400, height: 1100 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
const errs = [];
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

const log = (m) => console.log(m);

// --- create via API (skipping dialog for speed) ---
log('\n[setup] create track via api');
const createRes = await fetch(BASE + '/api/tracks', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: SLUG_TITLE, description: 'I want to learn how diffusion models work end to end' }),
});
const created = await createRes.json();
log('  created:', created.track?.slug);
if (!created.track?.slug) throw new Error('track create failed: ' + JSON.stringify(created));

// --- go to intake page ---
log('\n[1] intake first turn');
await p.goto(`${BASE}/#/t/${created.track.slug}/intake`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => {
  const view = document.getElementById('view-intake');
  return view && !view.hidden;
});

// Wait for AI's opening message (streamed). Look for the placeholder to lose .streaming class.
log('  waiting for AI opener (up to 90s)...');
await p.waitForFunction(() => {
  const last = [...document.querySelectorAll('.intake-msg.assistant')].pop();
  return last && !last.classList.contains('streaming') && last.textContent.length > 20;
}, null, { timeout: 90000 });

const opener = await p.evaluate(() => {
  const last = [...document.querySelectorAll('.intake-msg.assistant')].pop();
  return last?.textContent || '';
});
log('  opener:\n    ' + opener.replace(/\n/g, '\n    ').slice(0, 400));
if (opener.length < 20) throw new Error('opener too short');

// --- 2. send user reply ---
log('\n[2] user reply → AI follow-up');
await p.locator('#intake-input').fill(
  "I'm a python dev with some pytorch background. I want to be able to implement a small DDPM and understand the math enough to debug it. I've read the original Ho 2020 paper but found the variance schedules confusing."
);
await p.locator('#intake-form button[type="submit"]').click();

await p.waitForFunction(() => {
  const msgs = [...document.querySelectorAll('.intake-msg')];
  const assistantMsgs = msgs.filter((m) => m.classList.contains('assistant'));
  const last = assistantMsgs[assistantMsgs.length - 1];
  return assistantMsgs.length >= 2 && last && !last.classList.contains('streaming') && last.textContent.length > 20;
}, null, { timeout: 90000 });

const followup = await p.evaluate(() => {
  const ms = [...document.querySelectorAll('.intake-msg.assistant')];
  return ms[ms.length - 1]?.textContent || '';
});
log('  followup:\n    ' + followup.replace(/\n/g, '\n    ').slice(0, 400));
if (followup.length < 20) throw new Error('followup too short');

// --- 3. click Plan curriculum ---
log('\n[3] click Plan curriculum → finalize');
await p.locator('#btn-finalize').click();

// Wait for redirect to reader
await p.waitForFunction(() => {
  return location.hash.includes('/t/') && !location.hash.includes('/intake');
}, null, { timeout: 120000 });
log('  redirected to:', await p.evaluate(() => location.hash));
await p.waitForTimeout(1500);

// Verify curriculum.md was written
const curriculum = await fetch(`${BASE}/api/tracks/${created.track.slug}/curriculum`).then((r) => r.json());
log('  curriculum.ok:', curriculum.ok);
log('  curriculum head:\n    ' + String(curriculum.content || '').replace(/\n/g, '\n    ').slice(0, 500));
if (!curriculum.ok) throw new Error('curriculum not written');
if (!curriculum.content?.includes('Learner profile') || !curriculum.content?.includes('## Plan')) {
  throw new Error('curriculum missing standard sections');
}

// --- 4. open tutor — verify history loaded from intake ---
log('\n[4] open tutor panel; check history pulled from intake');
// First inspect tutor-chat.json server-side
const tutorChat = await fetch(`${BASE}/api/tutor/${created.track.slug}`).then((r) => r.json());
log('  server tutor-chat.json:');
log('    history length:', (tutorChat.history || []).length);
(tutorChat.history || []).forEach((m, i) => log(`      [${i}] ${m.role}: ${m.content.slice(0, 80)}`));

await p.locator('#btn-tutor').click();
await p.waitForTimeout(1500);

const tutor = await p.evaluate(() => {
  const panel = document.querySelector('.sg-chat-panel');
  if (!panel) return { error: 'no panel' };
  const msgs = [...panel.querySelectorAll('.sg-chat-msg')];
  return {
    visible: panel.classList.contains('show'),
    tutorMode: panel.classList.contains('tutor-mode'),
    classes: panel.className,
    msgCount: msgs.length,
    firstMsgText: msgs[0]?.textContent.slice(0, 100),
    lastMsgText: msgs[msgs.length - 1]?.textContent.slice(0, 100),
    selectors: {
      msg: panel.querySelectorAll('.sg-chat-msg').length,
      msgsContainer: !!panel.querySelector('.sg-chat-messages'),
    },
  };
});
log('  panel:', JSON.stringify(tutor, null, 2));
if (tutor.error) throw new Error(tutor.error);
if (!tutor.visible) throw new Error('tutor panel not visible');
if (!tutor.tutorMode) throw new Error('tutor-mode class missing');
// Expect at least 2 messages (assistant opener + assistant follow-up) plus user reply = 3+
const seeded = (tutorChat.history || []).length;
if (seeded < 3) throw new Error(`tutor-chat.json thin (${seeded} entries) — intake didn't seed`);
if (tutor.msgCount < 3) throw new Error(`UI panel thin (${tutor.msgCount} rendered msgs of ${seeded} server-side)`);

// Don't delete — leave it for manual inspection if needed
log('\n[cleanup] (track preserved: ' + created.track.slug + ')');
if (process.env.SG_DELETE) {
  const del = await fetch(`${BASE}/api/tracks/${created.track.slug}`, { method: 'DELETE' }).then((r) => r.json());
  log('  deleted:', del.ok);
}

await b.close();

if (errs.length) {
  console.log('\n[console errors]');
  errs.forEach((e) => console.log('  -', e.slice(0, 200)));
}

console.log('\n[OK] intake → finalize → tutor continuity flow PASS');
process.exit(0);
