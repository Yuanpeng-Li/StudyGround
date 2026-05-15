// End-to-end: Intake → Plan-mode rework.
//
// Walks through the new split-pane plan view: phase detection, inline
// comment popover (select-on-curriculum → quote + textarea → submit →
// chat shows it as a 📌 comment turn → pending strip lists it),
// pending-comment removal, "Start learning →", and reader [📋 Plan]
// round-trip.
//
// We don't actually spawn the intake skill — that costs Claude tokens.
// Instead we drive the file system directly (write curriculum.md, write
// a lesson) and verify the front-end reacts via SSE + the new endpoints.
import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'http://localhost:4321';
const TRACKS = '/home/LYP/studyground/tracks';
const SLUG = `plan-mode-${Date.now()}`;
const DIR = join(TRACKS, SLUG);

function setup() {
  if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
  mkdirSync(join(DIR, 'lessons'), { recursive: true });
  writeFileSync(join(DIR, 'track.json'), JSON.stringify({
    slug: SLUG, title: 'Plan-mode test', description: 'rework', emoji: '📋',
    created_at: '2026-05-14', updated_at: '2026-05-14',
  }));
}
function teardown() { try { rmSync(DIR, { recursive: true, force: true }); } catch {} }

setup();

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1400, height: 900 });
const errs = [];
p.on('pageerror', (e) => { errs.push(e.message); console.log('PAGEERROR:', e.message); });

let failed = 0;
const fail = (m) => { console.log('FAIL: ' + m); failed++; };

await p.goto(`${BASE}/`);
await p.evaluate(() => localStorage.setItem('sg-theme', 'light'));

// --- (1) home click on a brand-new course (no lessons) → plan view ----------
// Test the new redirect rule: !lessons.length → intake/plan view, regardless
// of whether curriculum exists.
await p.goto(`${BASE}/#/t/${SLUG}/`);
await p.waitForTimeout(700);
let hash1 = await p.evaluate(() => location.hash);
console.log(`(1) brand-new track at #/t/<slug>/ → bounced to: ${hash1}`);
if (!hash1.endsWith('/intake') && !hash1.endsWith('/intake/')) fail(`brand-new track did not bounce to intake (got ${hash1})`);

await p.waitForSelector('#intake-input', { state: 'visible' });
const phase1 = await p.evaluate(() => document.getElementById('view-intake').dataset.phase);
console.log(`(2) initial phase: ${phase1}  (want pre-plan)`);
if (phase1 !== 'pre-plan') fail(`phase should be pre-plan (got ${phase1})`);

// --- (3) write curriculum.md → phase flips to has-plan, plan pane renders ---
writeFileSync(join(DIR, 'curriculum.md'),
  `---
slug: ${SLUG}
finalized: 2026-05-14
---

# Curriculum

## Learner profile
- Background: test

## Plan
1. Foundations — set up the mental model
2. Policy Eval — Monte-Carlo and TD
3. Deep Q-Learning — DQN tricks
`);
await p.waitForTimeout(1800);
const phase2 = await p.evaluate(() => document.getElementById('view-intake').dataset.phase);
console.log(`(3) phase after write: ${phase2}  (want has-plan)`);
if (phase2 !== 'has-plan') fail(`phase should switch to has-plan (got ${phase2})`);

const subtitle = await p.evaluate(() => document.getElementById('intake-plan-subtitle').textContent);
console.log(`(4) subtitle: "${subtitle}"  (want non-empty)`);
if (!subtitle || !/finalized/.test(subtitle)) fail('subtitle should show finalized date');

const planBody = await p.evaluate(() => document.getElementById('intake-plan-body').textContent);
const planLooksRendered = /Foundations/.test(planBody) && /Policy Eval/.test(planBody) && !/^---/.test(planBody);
console.log(`(5) plan body rendered (no frontmatter leak): ${planLooksRendered}`);
if (!planLooksRendered) fail('plan body did not render correctly (frontmatter leak or missing items)');

// Hash should still be intake (the SSE handler must NOT bounce away)
const hash2 = await p.evaluate(() => location.hash);
console.log(`(6) hash after curriculum write: ${hash2}`);
if (!hash2.includes('/intake')) fail(`hash drifted away from intake (${hash2})`);

// --- (7) Programmatically select text on the plan body → popover opens ------
// We simulate a real drag-select: mousedown → set selection → mouseup.
// The popover-open logic is now mouseup-gated (it used to be on
// selectionchange but that broke mid-drag because focusing the popover's
// textarea collapsed the in-progress selection).
const popped = await p.evaluate(() => {
  const body = document.getElementById('intake-plan-body');
  const li = body.querySelector('ol > li, ul > li');
  if (!li) return { ok: false, reason: 'no list item' };
  const r = li.getBoundingClientRect();
  // mousedown registers _planMouseDown
  li.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }));
  // Programmatic selection (the browser would normally do this during drag)
  const range = document.createRange();
  range.selectNodeContents(li);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  // mouseup triggers the deferred popover open
  li.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: r.right - 5, clientY: r.bottom - 5 }));
  return { ok: true, text: sel.toString().trim().slice(0, 60) };
});
console.log(`(7) selection on plan list item: ${JSON.stringify(popped)}`);
await p.waitForTimeout(200);
const popVisible = await p.evaluate(() => {
  const pop = document.getElementById('intake-comment-popover');
  return pop && !pop.hidden;
});
console.log(`(8) comment popover visible: ${popVisible}`);
if (!popVisible) fail('selection on plan body did not open the comment popover');

// --- (9) Type a comment + submit → chat shows it; pending strip lists it ---
await p.evaluate(() => {
  const ta = document.getElementById('intake-comment-popover-input');
  ta.value = 'split this into two sub-lessons';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});
await p.click('[data-action="submit-inline-comment"]');
await p.waitForTimeout(500);

const chatHasComment = await p.evaluate(() => {
  const msgs = document.querySelectorAll('#intake-messages .intake-msg.user.comment');
  return msgs.length;
});
console.log(`(9) comment chat bubbles: ${chatHasComment}  (want 1)`);
if (chatHasComment !== 1) fail(`expected 1 comment chat bubble, got ${chatHasComment}`);

// (10) Anchored comments now show as inline pins in the curriculum, not in
// the bottom strip. The strip only surfaces orphans (couldn't be re-anchored).
const pinState = await p.evaluate(() => ({
  pinCount: document.querySelectorAll('#intake-plan-body mark.intake-plan-pin').length,
  badgeCount: document.querySelectorAll('#intake-plan-body .intake-plan-pin-badge').length,
  badgeTitle: document.querySelector('#intake-plan-body .intake-plan-pin-badge')?.title || '',
  stripCount: document.querySelectorAll('#intake-plan-comments-list li').length,
  stripHidden: document.getElementById('intake-plan-comments').hidden,
}));
console.log('(10) pin state:', JSON.stringify(pinState));
if (pinState.pinCount !== 1) fail(`expected 1 inline pin, got ${pinState.pinCount}`);
if (pinState.badgeCount !== 1) fail(`expected 1 💬 badge, got ${pinState.badgeCount}`);
if (!/split this into two/.test(pinState.badgeTitle)) fail(`badge title missing comment text (${pinState.badgeTitle})`);
if (pinState.stripCount !== 0) fail(`bottom strip should be empty when comment is anchored (got ${pinState.stripCount})`);
if (!pinState.stripHidden) fail('bottom strip should be hidden when no orphans');

// On disk: the append should have hit tutor-chat.jsonl
const tutorChat = readFileSync(join(DIR, 'tutor-chat.jsonl'), 'utf8');
const hasCommentTag = tutorChat.includes('studyground:comment');
console.log(`(11) tutor-chat.jsonl has comment tag: ${hasCommentTag}`);
if (!hasCommentTag) fail('comment was not persisted to tutor-chat.jsonl');

// --- (12) Reload → comment + plan + pin survive ---------------------------
await p.reload();
await p.waitForSelector('#intake-input', { state: 'visible' });
await p.waitForTimeout(500);
const reloadState = await p.evaluate(() => ({
  phase: document.getElementById('view-intake').dataset.phase,
  pinCount: document.querySelectorAll('#intake-plan-body mark.intake-plan-pin').length,
  bubbleCount: document.querySelectorAll('#intake-messages .intake-msg.user.comment').length,
}));
console.log(`(12) after reload: ${JSON.stringify(reloadState)} (want phase=has-plan, pinCount=1, bubbleCount=1)`);
if (reloadState.phase !== 'has-plan') fail(`phase did not survive reload (got ${reloadState.phase})`);
if (reloadState.pinCount !== 1) fail(`inline pin lost on reload (${reloadState.pinCount})`);
if (reloadState.bubbleCount !== 1) fail(`comment bubble lost on reload (${reloadState.bubbleCount})`);

// --- (13a) Click the 💬 badge → pin-view popover opens with the text ------
await p.click('#intake-plan-body .intake-plan-pin-badge');
await p.waitForTimeout(200);
const pinViewState = await p.evaluate(() => ({
  visible: !document.getElementById('intake-pin-view').hidden,
  text: document.getElementById('intake-pin-view-text').textContent,
}));
console.log('(13a) pin-view:', JSON.stringify(pinViewState));
if (!pinViewState.visible) fail('pin-view did not open on badge click');
if (!/split this into two/.test(pinViewState.text)) fail(`pin-view text wrong (${pinViewState.text})`);

// --- (13b) Click Delete → pin gone, chat bubble gone, strip empty ---------
await p.click('[data-action="delete-pin"]');
await p.waitForTimeout(400);
const afterDelete = await p.evaluate(() => ({
  pinCount: document.querySelectorAll('#intake-plan-body mark.intake-plan-pin').length,
  bubbleCount: document.querySelectorAll('#intake-messages .intake-msg.user.comment').length,
  stripCount: document.querySelectorAll('#intake-plan-comments-list li').length,
}));
console.log(`(13b) after delete: ${JSON.stringify(afterDelete)} (all want 0)`);
if (afterDelete.pinCount !== 0) fail(`inline pin not removed on delete (${afterDelete.pinCount})`);
if (afterDelete.bubbleCount !== 0) fail(`chat bubble not removed on delete (${afterDelete.bubbleCount})`);
if (afterDelete.stripCount !== 0) fail(`strip not empty after delete (${afterDelete.stripCount})`);

// --- (14) Start learning → → reader view -----------------------------------
await p.click('[data-action="start-learning"]');
await p.waitForTimeout(700);
const hash3 = await p.evaluate(() => location.hash);
console.log(`(14) after Start →, hash: ${hash3}`);
if (!hash3.startsWith(`#/t/${SLUG}/`) || hash3.includes('/intake')) fail(`Start → did not navigate to reader (${hash3})`);

// --- (15) Reader is empty (no lessons yet) — but [Plan] button takes us back
const planBtnVisible = await p.evaluate(() => !!document.querySelector('#btn-back-to-plan'));
console.log(`(15) reader [Plan] button present: ${planBtnVisible}`);
if (!planBtnVisible) fail('reader [Plan] button missing');

await p.click('#btn-back-to-plan');
await p.waitForSelector('#intake-input', { state: 'visible' });
const hash4 = await p.evaluate(() => location.hash);
const phase4 = await p.evaluate(() => document.getElementById('view-intake').dataset.phase);
console.log(`(16) [Plan] click → hash=${hash4}, phase=${phase4}`);
if (!hash4.includes('/intake')) fail(`[Plan] click did not return to intake (${hash4})`);
if (phase4 !== 'has-plan') fail(`[Plan] click landed in wrong phase (${phase4})`);

// --- (17) Now write a lesson → home click should go to reader, not plan ----
writeFileSync(join(DIR, 'lessons', '01-foundations.md'),
  '---\ntitle: Foundations\ntrack: ' + SLUG + '\nindex: 01\n---\n\n# Foundations\n\nbody.\n');
await p.waitForTimeout(800);
await p.goto(`${BASE}/`);
await p.waitForTimeout(400);
await p.goto(`${BASE}/#/t/${SLUG}/`);
await p.waitForTimeout(900);
const hash5 = await p.evaluate(() => location.hash);
console.log(`(17) with 1 lesson, home click → ${hash5}`);
if (hash5.includes('/intake')) fail(`home click bounced to plan even though lesson exists (${hash5})`);

await p.screenshot({ path: '/tmp/plan-mode.png', fullPage: false });

if (errs.length) fail(`${errs.length} pageerror(s): ${errs.join(' | ')}`);

console.log(`\n${failed === 0 ? 'all green' : failed + ' failing'}`);
await b.close();
teardown();
process.exit(failed === 0 ? 0 : 1);
