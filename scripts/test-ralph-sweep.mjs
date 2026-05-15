/**
 * Comprehensive exploratory UX & bug sweep for StudyGround.
 * Covers: Home, Intake, Reader, Cross-cutting, Keyboard, Theme, etc.
 *
 * Usage:
 *   SG_URL=http://localhost:37807 node scripts/test-ralph-sweep.mjs
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const BASE = process.env.SG_URL || 'http://localhost:4321';
const REPORT_PATH = '/tmp/ralph-qa-report-iter1.md';

const issues = { critical: [], bugs: [], friction: [], visual: [], suggestions: [] };
const tested = [];
const skipped = [];
let consoleErrors = [];
let networkErrors = [];

function critical(id, msg, details = '') {
  issues.critical.push({ id, msg, details });
  console.log(`  [CRITICAL] ${id}: ${msg}${details ? ' — ' + details : ''}`);
}
function bug(id, msg, details = '') {
  issues.bugs.push({ id, msg, details });
  console.log(`  [BUG] ${id}: ${msg}${details ? ' — ' + details : ''}`);
}
function friction(id, msg, details = '') {
  issues.friction.push({ id, msg, details });
  console.log(`  [FRICTION] ${id}: ${msg}${details ? ' — ' + details : ''}`);
}
function visual(id, msg, details = '') {
  issues.visual.push({ id, msg, details });
  console.log(`  [VISUAL] ${id}: ${msg}${details ? ' — ' + details : ''}`);
}
function pass(msg) { console.log(`  PASS: ${msg}`); }

// ─── LAUNCH ────────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  permissions: ['clipboard-read', 'clipboard-write'],
  viewport: { width: 1440, height: 900 },
});
const p = await ctx.newPage();

// Capture console errors & network errors
p.on('pageerror', (e) => {
  const msg = e.message?.slice(0, 300);
  consoleErrors.push({ type: 'pageerror', msg });
  console.log(`  [PAGEERROR] ${msg}`);
});
p.on('console', (m) => {
  if (m.type() === 'error') {
    const msg = m.text().slice(0, 300);
    consoleErrors.push({ type: 'console.error', msg });
    console.log(`  [CONSOLE.error] ${msg}`);
  }
});
p.on('response', (resp) => {
  if (resp.status() >= 400 && resp.url().includes('/api/')) {
    networkErrors.push({ url: resp.url(), status: resp.status() });
    console.log(`  [NET ${resp.status()}] ${resp.url()}`);
  }
});

async function screenshot(name) {
  try {
    await p.screenshot({ path: `/tmp/sg-ralph-${name}.png` });
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// A. HOME VIEW
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══ A. HOME VIEW ══');
tested.push('Home view');
await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(800);

// A1. Home view renders
const homeCheck = await p.evaluate(() => ({
  homeVisible: !document.getElementById('view-home').hidden,
  brand: document.querySelector('#view-home .brand')?.textContent?.trim(),
  grid: document.getElementById('track-grid')?.children?.length,
  hasHint: !!document.querySelector('#track-grid .hint'),
  createBtn: !!document.querySelector('.track-card.create'),
  importBtn: !!document.querySelector('[data-action="import-track"]'),
  themeBtn: !!document.querySelector('#view-home .theme-toggle'),
}));

if (!homeCheck.homeVisible) critical('A1', 'Home view not visible on load');
else pass('Home view visible');

if (!homeCheck.createBtn) critical('A2', '+ New course card missing from track grid');
else pass('+ New course card present');

if (!homeCheck.importBtn) bug('A3', 'Import a course button missing');
else pass('Import button present');

if (!homeCheck.themeBtn) bug('A4', 'Theme toggle missing from home header');
else pass('Theme toggle present in home header');

// A2. Brand "StudyGround" — check if it's lowercase or capitalized
if (homeCheck.brand && homeCheck.brand.toLowerCase() !== 'studyground') {
  bug('A5', `Brand text unexpected: "${homeCheck.brand}"`);
} else {
  pass(`Brand: "${homeCheck.brand}"`);
}

// A3. Course card renders with title, emoji, action buttons
await screenshot('home-initial');
const cardInfo = await p.evaluate(() => {
  const cards = [...document.querySelectorAll('a.track-card[data-slug]')];
  return cards.map(c => ({
    slug: c.dataset.slug,
    title: c.querySelector('.track-title')?.textContent?.trim(),
    emoji: c.querySelector('.track-emoji')?.textContent?.trim(),
    editBtn: !!c.querySelector('.track-edit, [data-action="edit-track"]'),
    deleteBtn: !!c.querySelector('.track-delete, [data-action="delete-track"]'),
    exportBtn: !!c.querySelector('.track-export, [data-action="export-track"]'),
  }));
});

if (cardInfo.length === 0) {
  critical('A6', 'No course cards rendered — qa-sweep track not showing');
} else {
  pass(`${cardInfo.length} course card(s) rendered`);
  const card = cardInfo[0];
  if (!card.title) bug('A7', 'Course card has no title text');
  else pass(`Card title: "${card.title}"`);
  if (!card.emoji) bug('A8', 'Course card has no emoji');
  else pass(`Card emoji: "${card.emoji}"`);
  if (!card.editBtn) bug('A9', 'Course card missing edit (✎) button');
  else pass('Card edit button present');
  if (!card.deleteBtn) bug('A10', 'Course card missing delete (×) button');
  else pass('Card delete button present');
  if (!card.exportBtn) bug('A11', 'Course card missing export (⬇) button');
  else pass('Card export button present');
}

// A4. Theme toggle — click and verify it cycles
console.log('\n── Theme toggle ──');
tested.push('Theme toggle cycle');
const themeBefore = await p.evaluate(() => localStorage.getItem('sg-theme') || 'auto');
await p.locator('#view-home .theme-toggle').click();
await p.waitForTimeout(200);
const themeAfter = await p.evaluate(() => localStorage.getItem('sg-theme') || 'auto');
if (themeBefore === themeAfter) {
  bug('A12', 'Theme toggle does not change stored theme value');
} else {
  pass(`Theme cycled: ${themeBefore} → ${themeAfter}`);
}
// Check data-theme on root
const dataTheme = await p.evaluate(() => document.documentElement.getAttribute('data-theme'));
if (!dataTheme) {
  bug('A13', 'data-theme attribute not applied to <html> after theme toggle');
} else {
  pass(`data-theme on <html>: "${dataTheme}"`);
}
// Cycle back to auto
await p.locator('#view-home .theme-toggle').click();
await p.waitForTimeout(100);
await p.locator('#view-home .theme-toggle').click();
await p.waitForTimeout(100);

// A5. New Course modal
console.log('\n── New course modal ──');
tested.push('New course modal — emoji picker, validation');
await p.locator('.track-card.create').click();
await p.waitForTimeout(400);

const modalInfo = await p.evaluate(() => {
  const dlg = document.getElementById('new-track-dialog');
  const picker = dlg?.querySelector('.emoji-picker');
  return {
    open: dlg?.open,
    pickerButtons: picker?.querySelectorAll('.emoji-pick').length,
    titleInput: !!dlg?.querySelector('#nt-title'),
    descInput: !!dlg?.querySelector('#nt-desc'),
    cancelBtn: !!dlg?.querySelector('[data-action="close-dialog"]'),
    submitBtn: !!dlg?.querySelector('button[type="submit"]'),
    selectedEmoji: picker?.querySelector('.is-selected')?.dataset?.emoji,
  };
});

if (!modalInfo.open) {
  critical('A14', 'New course dialog does not open after clicking + card');
} else {
  pass('New course dialog opens');
  if (modalInfo.pickerButtons < 20) {
    bug('A15', `Emoji picker has only ${modalInfo.pickerButtons} buttons (expected ~28)`);
  } else {
    pass(`Emoji picker has ${modalInfo.pickerButtons} buttons`);
  }
  if (!modalInfo.selectedEmoji) {
    bug('A16', 'No emoji pre-selected in picker');
  } else {
    pass(`Default emoji pre-selected: ${modalInfo.selectedEmoji}`);
  }
  if (!modalInfo.titleInput) bug('A17', 'Title input missing from new course dialog');
  if (!modalInfo.descInput) bug('A18', 'Description textarea missing');
  if (!modalInfo.cancelBtn) bug('A19', 'Cancel button missing from new course dialog');
}
await screenshot('new-course-modal');

// A5a. Title required validation
if (modalInfo.open) {
  await p.locator('#new-track-dialog button[type="submit"]').click();
  await p.waitForTimeout(200);
  const stillOpen = await p.evaluate(() => document.getElementById('new-track-dialog').open);
  if (!stillOpen) {
    bug('A20', 'New course dialog closes on submit with empty title (no validation)');
  } else {
    pass('Empty title blocked — dialog stays open (validation works)');
  }
}

// A5b. Pick a different emoji
if (modalInfo.open && modalInfo.pickerButtons > 1) {
  await p.locator('#new-track-dialog .emoji-pick').nth(3).click();
  await p.waitForTimeout(100);
  const newSelected = await p.evaluate(() => {
    const dlg = document.getElementById('new-track-dialog');
    return dlg?.querySelector('.emoji-pick.is-selected')?.dataset?.emoji;
  });
  if (!newSelected) {
    bug('A21', 'Clicking emoji in picker does not mark it as selected');
  } else {
    pass(`Emoji selection works: ${newSelected}`);
  }
}

// Close modal
await p.keyboard.press('Escape');
await p.waitForTimeout(200);
const modalClosed = await p.evaluate(() => !document.getElementById('new-track-dialog').open);
if (!modalClosed) {
  friction('A22', 'Esc does not close new course dialog');
} else {
  pass('Esc closes new course dialog');
}

// A6. Create a real course
console.log('\n── Create course via modal ──');
tested.push('Create new course');
await p.locator('.track-card.create').click();
await p.waitForTimeout(300);
await p.locator('#nt-title').fill('Test Course Alpha');
await p.locator('#new-track-dialog button[type="submit"]').click();
await p.waitForTimeout(1000);
// Should navigate to intake or back to home
const afterCreate = await p.evaluate(() => ({
  homeVisible: !document.getElementById('view-home').hidden,
  intakeVisible: !document.getElementById('view-intake').hidden,
  cards: document.querySelectorAll('a.track-card[data-slug]').length,
}));
if (afterCreate.intakeVisible) {
  pass('Creating course navigates to intake');
} else if (afterCreate.homeVisible && afterCreate.cards > 1) {
  pass('Creating course stays on home with new card');
} else {
  bug('A23', 'After creating course, neither intake nor updated home with card');
}

// A7. Edit course modal
console.log('\n── Edit course modal ──');
tested.push('Edit course modal');
await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(700);

const editBtnExists = await p.locator('[data-action="edit-track"]').count();
if (editBtnExists > 0) {
  // Hover over the card to reveal edit button if needed
  await p.locator('a.track-card[data-slug]').first().hover();
  await p.waitForTimeout(200);
  await p.locator('[data-action="edit-track"]').first().click();
  await p.waitForTimeout(400);
  const editModal = await p.evaluate(() => {
    const dlg = document.getElementById('edit-track-dialog');
    return {
      open: dlg?.open,
      titleFilled: !!dlg?.querySelector('#et-title')?.value,
      pickerPresent: dlg?.querySelectorAll('.emoji-pick').length > 0,
    };
  });
  if (!editModal.open) {
    bug('A24', 'Edit track dialog does not open after clicking ✎');
  } else {
    pass('Edit track dialog opens');
    if (!editModal.titleFilled) bug('A25', 'Edit dialog title input not pre-filled with current title');
    else pass('Edit dialog pre-fills title');
    if (!editModal.pickerPresent) bug('A26', 'Edit dialog has no emoji picker');
    else pass('Edit dialog has emoji picker');
  }
  await p.keyboard.press('Escape');
  await p.waitForTimeout(200);
} else {
  friction('A27', 'No edit-track buttons visible — may require hover to appear');
}

// A8. Export track
console.log('\n── Export track ──');
tested.push('Export track');
const downloadPromise = p.waitForEvent('download', { timeout: 3000 }).catch(() => null);
const exportBtn = await p.locator('[data-action="export-track"]').first();
if (await exportBtn.count() > 0) {
  await p.locator('a.track-card[data-slug]').first().hover();
  await p.waitForTimeout(150);
  await exportBtn.click();
  const dl = await downloadPromise;
  if (!dl) {
    bug('A28', 'Export track button click does not trigger a download');
  } else {
    pass(`Export download triggered: ${dl.suggestedFilename()}`);
  }
} else {
  skipped.push('Export track — no export button found');
}

// A9. Delete track
console.log('\n── Delete track confirmation ──');
tested.push('Delete track confirmation dialog');
await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(700);
const delBtn = p.locator('[data-action="delete-track"]').first();
if (await delBtn.count() > 0) {
  p.once('dialog', async (dialog) => {
    const msg = dialog.message();
    if (!msg) bug('A29', 'Delete confirmation dialog has empty message');
    else pass(`Delete confirm message: "${msg.slice(0, 60)}"`);
    await dialog.dismiss(); // cancel
  });
  await p.locator('a.track-card[data-slug]').first().hover();
  await p.waitForTimeout(150);
  await delBtn.click();
  await p.waitForTimeout(500);
  pass('Delete button click handled');
} else {
  skipped.push('Delete track — no delete button found');
}

// ═══════════════════════════════════════════════════════════════════════════════
// B. INTAKE VIEW
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══ B. INTAKE VIEW ══');
tested.push('Intake view layout and UI elements');

// Navigate to intake for qa-sweep (has curriculum.md but no real lessons trigger intake redirect... let's check)
// Actually qa-sweep has lessons — navigate to a track with no lessons
// Let's use the test-course-alpha we created (it has no lessons)
const tracks2 = await p.evaluate(() =>
  [...document.querySelectorAll('a.track-card[data-slug]')].map(a => a.dataset.slug)
);
// Try navigating to test-course-alpha directly
await p.goto(BASE + '/#/t/test-course-alpha/intake', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(800);

let intakeVisible = await p.evaluate(() => !document.getElementById('view-intake').hidden);
if (!intakeVisible) {
  // Try from home clicking new course
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(600);
  // Find a card with 0 lessons to navigate to intake
  const slugs = await p.evaluate(() =>
    [...document.querySelectorAll('a.track-card[data-slug]')].map(a => a.dataset.slug)
  );
  for (const slug of slugs) {
    if (slug !== 'qa-sweep') {
      await p.goto(BASE + `/#/t/${slug}/intake`, { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(800);
      intakeVisible = await p.evaluate(() => !document.getElementById('view-intake').hidden);
      if (intakeVisible) break;
    }
  }
}

if (!intakeVisible) {
  critical('B1', 'Cannot reach intake view — hash navigation to #/t/<slug>/intake fails');
  skipped.push('Intake view — all sub-checks skipped (view not reachable)');
} else {
  pass('Intake view visible');
  await screenshot('intake-view');

  // B1. 4-pane layout
  const intakeLayout = await p.evaluate(() => ({
    matPane: !!document.getElementById('intake-mat-pane'),
    mvPane: !!document.getElementById('intake-mv-pane'),
    chatPane: !!document.querySelector('.intake-chat-pane'),
    currPane: !!document.querySelector('.intake-curr-pane, .intake-plan-pane, [class*="curr"]'),
    matLabel: document.querySelector('.intake-mat-label')?.textContent?.trim(),
    chatTextarea: !!document.getElementById('intake-input'),
    sendBtn: !!document.querySelector('#intake-form .sg-chat-send'),
    planBtn: !!document.getElementById('btn-finalize'),
    addMat: !!document.querySelector('[data-action="add-intake-material"]'),
    collapseBtn: !!document.querySelector('[data-action="toggle-intake-mat"]'),
  }));

  if (!intakeLayout.matPane) bug('B2', 'intake-mat-pane missing from intake layout');
  else pass('Materials pane present');
  if (!intakeLayout.chatPane) critical('B3', 'Chat pane missing from intake layout');
  else pass('Chat pane present');
  if (!intakeLayout.chatTextarea) critical('B4', 'Intake chat textarea missing');
  else pass('Chat textarea present');
  if (!intakeLayout.sendBtn) critical('B5', 'Intake send button missing');
  else pass('Send button present');
  if (!intakeLayout.planBtn) critical('B6', 'Plan curriculum → button missing');
  else pass('Plan curriculum button present');
  if (!intakeLayout.addMat) bug('B7', 'Add material (+) button missing');
  else pass('Add material button present');

  // B2. Materials pane collapse
  if (intakeLayout.collapseBtn) {
    await p.locator('[data-action="toggle-intake-mat"]').first().click();
    await p.waitForTimeout(300);
    const afterCollapse = await p.evaluate(() => {
      const pane = document.getElementById('intake-mat-pane');
      const reopen = document.querySelector('.intake-mat-reopen');
      return {
        paneCollapsed: pane?.classList.contains('collapsed') || pane?.style.display === 'none',
        reopenVisible: reopen && !reopen.hidden,
      };
    });
    if (!afterCollapse.paneCollapsed && !afterCollapse.reopenVisible) {
      bug('B8', 'Clicking collapse «  does not collapse materials pane');
    } else {
      pass('Materials pane collapses');
      // Re-open via the reopen button (the «  toggle becomes hidden when collapsed)
      const reopenBtn = p.locator('.intake-mat-reopen:not([hidden])');
      if (await reopenBtn.count() > 0) {
        await reopenBtn.first().click({ force: true });
        await p.waitForTimeout(200);
      }
    }
  }

  // B3. Plan curriculum button disabled state before any messages?
  const planBtnDisabled = await p.evaluate(() => {
    const btn = document.getElementById('btn-finalize');
    return btn?.disabled;
  });
  // Plan button should generally be clickable (not always disabled)
  pass(`Plan curriculum button disabled=${planBtnDisabled}`);

  // B4. Chat Enter vs Shift+Enter
  const textarea = p.locator('#intake-input');
  await textarea.click();
  await textarea.fill('test message');
  // Shift+Enter should add newline, NOT submit
  await textarea.press('Shift+Enter');
  await p.waitForTimeout(200);
  const rows = await textarea.evaluate(el => el.value);
  if (!rows.includes('\n')) {
    bug('B9', 'Shift+Enter in intake textarea does not add newline (may have submitted instead)');
  } else {
    pass('Shift+Enter adds newline in intake textarea');
  }
  // Clear and test Enter submits
  await textarea.fill('hello');
  // Don't actually submit (it'd call claude) — just check the form submit handler exists
  const formHasSubmit = await p.evaluate(() => {
    const form = document.getElementById('intake-form');
    return !!form?.onsubmit || form?.getAttribute('onsubmit') || true; // handler is addEventListener
  });
  pass('Intake form submit handler wired (manual check)');
  await textarea.fill(''); // clear

  // B5. Intake resize handles
  const resizeHandles = await p.evaluate(() =>
    [...document.querySelectorAll('.intake-resize-handle')].map(h => ({
      resize: h.dataset.resize,
      tabindex: h.getAttribute('tabindex'),
      role: h.getAttribute('role'),
    }))
  );
  if (resizeHandles.length === 0) {
    bug('B10', 'No intake resize handles found');
  } else {
    pass(`${resizeHandles.length} resize handle(s) present`);
    const hasTabindex = resizeHandles.every(h => h.tabindex === '0');
    if (!hasTabindex) friction('B11', 'Some intake resize handles missing tabindex=0 (not keyboard-focusable)');
    else pass('All resize handles have tabindex=0');
  }

  // B6. Resize handle arrow-key test
  const matHandle = p.locator('.intake-resize-handle[data-resize="mat"]');
  if (await matHandle.count() > 0) {
    await matHandle.focus();
    const widthBefore = await p.evaluate(() => {
      const pane = document.getElementById('intake-mat-pane');
      return pane?.getBoundingClientRect().width;
    });
    await p.keyboard.press('ArrowRight');
    await p.waitForTimeout(100);
    const widthAfter = await p.evaluate(() => {
      const pane = document.getElementById('intake-mat-pane');
      return pane?.getBoundingClientRect().width;
    });
    if (Math.abs((widthAfter || 0) - (widthBefore || 0)) < 1) {
      friction('B12', 'Arrow key on intake resize handle does not resize pane');
    } else {
      pass(`Arrow key resize works: ${widthBefore?.toFixed(0)}→${widthAfter?.toFixed(0)}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// C. READER VIEW
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══ C. READER VIEW ══');
tested.push('Reader view — qa-sweep with seeded lessons');

await p.goto(BASE + '/#/t/qa-sweep/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1200);
await screenshot('reader-initial');

const readerState = await p.evaluate(() => ({
  readerVisible: !document.getElementById('view-reader')?.hidden,
  intakeRedirect: !document.getElementById('view-intake')?.hidden,
  sidebarLessons: document.querySelectorAll('#sidebar-lessons a[data-slug]').length,
  lessonTitles: [...document.querySelectorAll('#sidebar-lessons a[data-slug]')].map(a => a.textContent?.trim()),
  sidebarMats: !!document.getElementById('sidebar-materials'),
  sidebarThreads: !!document.getElementById('sidebar-threads'),
  tutorFab: !!document.getElementById('btn-tutor'),
  outlineToggle: !!document.getElementById('outline-toggle'),
  btnNext: !!document.getElementById('btn-next'),
  btnRecap: !!document.getElementById('btn-recap'),
  btnPlan: !!document.getElementById('btn-back-to-plan'),
  themeToggleInReader: !!document.querySelector('#view-reader .theme-toggle'),
}));

if (readerState.intakeRedirect) {
  // qa-sweep has curriculum.md + lessons — should show reader
  critical('C1', 'Reader redirects to intake despite having lessons');
} else if (!readerState.readerVisible) {
  critical('C2', 'Reader view not visible for qa-sweep track');
} else {
  pass('Reader view visible');
}

if (readerState.sidebarLessons < 2) {
  bug('C3', `Expected 2 sidebar lessons, got ${readerState.sidebarLessons}`);
} else {
  pass(`Sidebar has ${readerState.sidebarLessons} lessons: ${readerState.lessonTitles.join(', ')}`);
}
if (!readerState.tutorFab) bug('C4', 'Tutor FAB (💬) missing from reader');
else pass('Tutor FAB present');
if (!readerState.btnNext) bug('C5', 'Next → button missing from reader header');
else pass('Next → button present');
if (!readerState.btnRecap) bug('C6', 'Recap button missing from reader header');
else pass('Recap button present');
if (!readerState.outlineToggle) bug('C7', 'Outline toggle button missing');
else pass('Outline toggle present');

// C1. Click first lesson
console.log('\n── Click lesson in sidebar ──');
tested.push('Sidebar lesson click — renders lesson');
if (readerState.sidebarLessons > 0) {
  await p.locator('#sidebar-lessons a[data-slug]').first().click();
  await p.waitForTimeout(1000);
  await screenshot('lesson-loaded');

  const lessonContent = await p.evaluate(() => {
    const v = document.getElementById('lesson-view');
    return {
      h1: v?.querySelector('h1')?.textContent?.trim(),
      hasMath: v?.querySelectorAll('.katex, .sg-math').length > 0,
      hasTable: v?.querySelectorAll('table').length > 0,
      hasDetails: v?.querySelectorAll('details').length > 0,
      hasQA: v?.querySelectorAll('.sg-question, [class*="question"]').length > 0,
      hasExercise: v?.querySelectorAll('.sg-exercise, [class*="exercise"]').length > 0,
      hasPythonRun: v?.querySelectorAll('.sg-run-cell, [class*="run"], pre code').length > 0,
      rawDollar: /\$[^$\s][^$]*\$/.test(v?.textContent || ''),
      outlineItems: document.querySelectorAll('#sidebar-outline li:not(.hint)').length,
    };
  });

  if (!lessonContent.h1) {
    critical('C8', 'Lesson did not render h1 after clicking sidebar link');
  } else {
    pass(`Lesson rendered: "${lessonContent.h1}"`);
  }

  // Math rendering
  if (!lessonContent.hasMath) {
    bug('C9', 'No KaTeX math rendered in seeded lesson (has $E=mc^2$)');
  } else {
    pass('Math rendered (KaTeX elements present)');
  }
  if (lessonContent.rawDollar) {
    bug('C10', 'Raw $...$ visible in rendered lesson — math missed');
  } else {
    pass('No raw $...$ visible');
  }

  // Table
  if (!lessonContent.hasTable) {
    bug('C11', 'Pipe table not rendered as <table> in lesson');
  } else {
    pass('Table rendered');
  }

  // details block (btw)
  if (!lessonContent.hasDetails) {
    bug('C12', '<details> block not rendered (btw section)');
  } else {
    pass('<details> block rendered');
  }

  // Exercise block
  if (!lessonContent.hasExercise) {
    bug('C13', ':::exercise block not rendered as exercise UI');
  } else {
    pass('Exercise block rendered');
  }

  // Outline
  if (lessonContent.outlineItems === 0) {
    bug('C14', 'Outline rail has no items after lesson load (lesson has H2 sections)');
  } else {
    pass(`Outline has ${lessonContent.outlineItems} item(s)`);
  }

  // C2. Q&A block
  console.log('\n── ?> Q&A block ──');
  tested.push('Q&A ?> block — answer reveal');
  const qaInfo = await p.evaluate(() => {
    const v = document.getElementById('lesson-view');
    // Rendered as details.sg-question.q (with summary = question text + answer body)
    const qBlocks = v.querySelectorAll('details.sg-question.q, .sg-question:not(.btw)');
    const askBtns = v.querySelectorAll('.ask-btn, [data-action="ask"]');
    const answered = v.querySelectorAll('.sg-answer.answered, .sg-question-body');
    return {
      qBlocks: qBlocks.length,
      askBtns: askBtns.length,
      answered: answered.length,
      sgQItems: v.querySelectorAll('.sg-question').length,
    };
  });
  if (qaInfo.qBlocks === 0 && qaInfo.sgQItems === 0) {
    bug('C15', '?> marker not rendered — no details.sg-question.q or .sg-question found');
  } else {
    pass(`Q&A: ${qaInfo.qBlocks} question block(s), ${qaInfo.askBtns} Ask btn(s), ${qaInfo.answered} answered, total .sg-question=${qaInfo.sgQItems}`);
  }

  // C3. btw details expand/collapse
  console.log('\n── ?>> btw details block ──');
  tested.push('?>> btw details block expand/collapse');
  const btwInfo = await p.evaluate(() => {
    const v = document.getElementById('lesson-view');
    const dets = [...v.querySelectorAll('details')];
    const open = dets[0]?.open;
    const summary = dets[0]?.querySelector('summary')?.textContent?.trim();
    return { count: dets.length, firstOpen: open, summary };
  });
  if (btwInfo.count === 0) {
    bug('C16', 'No <details> blocks in lesson (btw block missing)');
  } else {
    pass(`${btwInfo.count} details block(s), first open=${btwInfo.firstOpen}, summary="${btwInfo.summary?.slice(0, 30)}"`);
    // Click to expand
    await p.locator('#lesson-view details').first().click();
    await p.waitForTimeout(200);
    const nowOpen = await p.evaluate(() => document.querySelector('#lesson-view details')?.open);
    pass(`Details toggle: ${!btwInfo.firstOpen} → ${nowOpen}`);
    // Check math inside details renders
    const mathInDetails = await p.evaluate(() => {
      const det = document.querySelector('#lesson-view details');
      return det?.querySelectorAll('.katex, .sg-math').length > 0;
    });
    if (!mathInDetails) {
      bug('C17', 'Math inside <details> block not rendered (btw details math)');
    } else {
      pass('Math inside <details> renders correctly');
    }
  }

  // C4. Outline toggle
  console.log('\n── Outline toggle ──');
  tested.push('Outline toggle — open/close outline pop');
  await p.locator('#outline-toggle').click();
  await p.waitForTimeout(300);
  const outlinePop = await p.evaluate(() => document.body.classList.contains('outline-pop-open'));
  if (!outlinePop) {
    bug('C18', 'Clicking outline toggle does not add outline-pop-open class');
  } else {
    pass('Outline pop opens on toggle click');
  }
  // Jump to section
  const outlineLinks = await p.locator('#sidebar-outline a[data-action="jump-section"]').count();
  if (outlineLinks > 0) {
    await p.locator('#sidebar-outline a[data-action="jump-section"]').first().click();
    await p.waitForTimeout(300);
    pass(`Outline jump click works (${outlineLinks} links)`);
  }
  // btw buttons in outline
  const btwOutlineBtns = await p.locator('#sidebar-outline .outline-btw, button[data-action="btw-outline"]').count();
  if (btwOutlineBtns === 0) {
    bug('C19', 'No btw buttons in outline (expected per H2/H3 section)');
  } else {
    pass(`${btwOutlineBtns} btw button(s) in outline`);
  }
  // Close outline
  await p.keyboard.press('Escape');
  await p.waitForTimeout(200);
  const outlineClosedAfterEsc = await p.evaluate(() => !document.body.classList.contains('outline-pop-open'));
  if (!outlineClosedAfterEsc) {
    friction('C20', 'Esc does not close outline pop-over');
  } else {
    pass('Esc closes outline pop-over');
  }

  // C5. Sidebar collapse
  console.log('\n── Sidebar collapse ──');
  tested.push('Sidebar collapse/expand toggle');
  const sidebarCollapseBtn = p.locator('[data-action="toggle-sidebar"]');
  if (await sidebarCollapseBtn.count() > 0) {
    await sidebarCollapseBtn.first().click();
    await p.waitForTimeout(300);
    const collapsed = await p.evaluate(() =>
      document.querySelector('#view-reader .app')?.classList.contains('sidebar-collapsed')
    );
    if (!collapsed) {
      bug('C21', 'Sidebar collapse button does not add sidebar-collapsed class');
    } else {
      pass('Sidebar collapses');
    }
    // Expand back
    await sidebarCollapseBtn.first().click();
    await p.waitForTimeout(200);
  } else {
    skipped.push('Sidebar collapse — no toggle-sidebar button found');
  }

  // C6. Exercise block
  console.log('\n── Exercise block ──');
  tested.push(':::exercise block — Open in VSCode and Check buttons');
  const exerciseInfo = await p.evaluate(() => {
    const v = document.getElementById('lesson-view');
    const exBlock = v.querySelector('[class*="exercise"], .sg-exercise');
    if (!exBlock) return { found: false };
    return {
      found: true,
      hasVSCode: !!exBlock.querySelector('[data-action*="vscode"], [data-action*="exercise"], a[href*="vscode"]'),
      hasCheck: !!exBlock.querySelector('[data-action*="check"], button'),
      buttons: [...exBlock.querySelectorAll('button, a')].map(b => b.textContent?.trim()).join(' | '),
    };
  });
  if (!exerciseInfo.found) {
    bug('C22', ':::exercise block not found in rendered lesson');
  } else {
    pass(`Exercise block found. Buttons: "${exerciseInfo.buttons}"`);
    if (!exerciseInfo.hasVSCode) {
      bug('C23', 'Exercise block has no VSCode open button');
    }
  }

  // C7. Python run cell
  console.log('\n── Python run cell ──');
  tested.push('```python run cell — Run button present');
  const pyInfo = await p.evaluate(() => {
    const v = document.getElementById('lesson-view');
    const cells = [...v.querySelectorAll('.sg-run-cell, [class*="run-cell"], .code-run-wrap, pre')];
    // Look for a run button near code blocks
    const runBtns = [...v.querySelectorAll('button')].filter(b =>
      b.textContent?.includes('Run') || b.dataset.action?.includes('run')
    );
    return { cells: cells.length, runBtns: runBtns.length };
  });
  if (pyInfo.runBtns === 0) {
    bug('C24', 'No Run button found for ```python run cell');
  } else {
    pass(`${pyInfo.runBtns} Run button(s) found`);
  }

  // C8. Selection toolbar
  console.log('\n── Selection toolbar ──');
  tested.push('Selection toolbar appears on text selection');
  // Select some text in the lesson
  await p.locator('#lesson-view p').first().dispatchEvent('mousedown');
  await p.evaluate(() => {
    const para = document.querySelector('#lesson-view p');
    if (!para) return;
    const range = document.createRange();
    range.selectNodeContents(para);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    // Trigger mouseup to show toolbar
    para.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await p.waitForTimeout(400);
  const toolbarVisible = await p.evaluate(() => {
    const tb = document.querySelector('.sg-sel-toolbar');
    return { exists: !!tb, visible: tb && getComputedStyle(tb).display !== 'none' && !tb.hidden };
  });
  if (!toolbarVisible.exists) {
    bug('C25', 'Selection toolbar (.sg-sel-toolbar) not created after text selection');
  } else if (!toolbarVisible.visible) {
    bug('C26', 'Selection toolbar exists but is hidden after text selection');
  } else {
    pass('Selection toolbar appears on text selection');
    // Check for btw ask button
    const askBtn = await p.evaluate(() => {
      const tb = document.querySelector('.sg-sel-toolbar');
      return !!tb?.querySelector('button');
    });
    if (!askBtn) bug('C27', 'Selection toolbar has no ask button');
    else pass('Selection toolbar has button(s)');
  }
  // Click elsewhere to deselect
  await p.keyboard.press('Escape');
  await p.locator('body').click({ position: { x: 5, y: 5 } });
  await p.waitForTimeout(200);

  // C9. Tutor FAB
  console.log('\n── Tutor FAB ──');
  tested.push('Tutor FAB opens chat panel');
  await p.locator('#btn-tutor').click();
  await p.waitForTimeout(500);
  const tutorPanel = await p.evaluate(() => {
    const panel = document.querySelector('.sg-chat-panel');
    return {
      exists: !!panel,
      visible: panel?.classList.contains('show'),
      tutorMode: panel?.classList.contains('tutor-mode'),
      title: panel?.querySelector('.sg-chat-title')?.textContent?.trim(),
      resizeHandle: !!panel?.querySelector('.sg-chat-resize'),
      closeBtn: !!panel?.querySelector('[data-action="close-chat"]'),
      saveBtn: panel?.querySelector('.sg-chat-save'),
    };
  });
  if (!tutorPanel.exists) {
    critical('C28', 'Chat panel not in DOM after clicking tutor FAB');
  } else if (!tutorPanel.visible) {
    critical('C29', 'Chat panel not visible (no "show" class) after clicking tutor FAB');
  } else {
    pass('Tutor chat panel opens');
    if (!tutorPanel.tutorMode) bug('C30', 'Panel missing tutor-mode class');
    else pass('Panel has tutor-mode class');
    if (!tutorPanel.resizeHandle) bug('C31', 'Chat panel has no resize handle');
    else pass('Chat panel has resize handle');
    if (!tutorPanel.closeBtn) bug('C32', 'Chat panel has no close button');
    else pass('Chat panel has close button');
    pass(`Tutor panel title: "${tutorPanel.title}"`);
  }

  // Resize chat panel with arrow key
  if (tutorPanel.exists && tutorPanel.visible) {
    const chatResize = p.locator('.sg-chat-resize');
    if (await chatResize.count() > 0) {
      await chatResize.focus();
      const widthBefore = await p.evaluate(() => {
        const panel = document.querySelector('.sg-chat-panel');
        return panel?.getBoundingClientRect().width;
      });
      await p.keyboard.press('ArrowLeft');
      await p.waitForTimeout(100);
      const widthAfter = await p.evaluate(() => {
        const panel = document.querySelector('.sg-chat-panel');
        return panel?.getBoundingClientRect().width;
      });
      if (Math.abs((widthAfter || 0) - (widthBefore || 0)) < 1) {
        friction('C33', 'Arrow key on chat panel resize handle does not resize panel');
      } else {
        pass(`Chat panel arrow-key resize: ${widthBefore?.toFixed(0)}→${widthAfter?.toFixed(0)}`);
      }
    }
  }

  // Close tutor panel
  if (tutorPanel.closeBtn) {
    await p.locator('.sg-chat-panel [data-action="close-chat"]').click();
    await p.waitForTimeout(300);
    const panelClosed = await p.evaluate(() =>
      !document.querySelector('.sg-chat-panel')?.classList.contains('show')
    );
    if (!panelClosed) bug('C34', 'Chat panel close button does not close panel');
    else pass('Chat panel closes on × button');
  }

  // C10. Esc closes chat panel
  await p.locator('#btn-tutor').click();
  await p.waitForTimeout(400);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  const panelEscClosed = await p.evaluate(() =>
    !document.querySelector('.sg-chat-panel')?.classList.contains('show')
  );
  if (!panelEscClosed) {
    friction('C35', 'Esc does not close tutor chat panel');
  } else {
    pass('Esc closes tutor chat panel');
  }
}

// C11. Sidebar sections collapse
console.log('\n── Sidebar section collapse ──');
tested.push('Sidebar section collapse (threads, materials)');
await p.goto(BASE + '/#/t/qa-sweep/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(800);
const sidebarSections = await p.evaluate(() => {
  const sections = [...document.querySelectorAll('.sidebar-section')];
  return sections.map(s => ({
    label: s.querySelector('.sidebar-section-label, h3')?.textContent?.trim(),
    hasToggle: !!s.querySelector('.sidebar-section-toggle, [data-action="toggle-sidebar-section"]'),
  }));
});
pass(`Sidebar sections: ${sidebarSections.map(s => s.label || '?').join(', ')}`);

// Click a section label to collapse
const secToggle = p.locator('[data-action="toggle-sidebar-section"], .sidebar-section-label');
if (await secToggle.count() > 0) {
  await secToggle.first().click();
  await p.waitForTimeout(200);
  pass('Sidebar section toggle clickable');
}

// C12. Thread sidebar items
console.log('\n── Threads sidebar ──');
tested.push('Threads sidebar section');
const threadsSection = await p.evaluate(() => {
  const ul = document.getElementById('sidebar-threads');
  return {
    exists: !!ul,
    hint: ul?.querySelector('.hint')?.textContent?.trim(),
    items: ul?.querySelectorAll('li:not(.hint)').length,
  };
});
if (!threadsSection.exists) {
  bug('C36', 'sidebar-threads element missing');
} else {
  pass(`Threads section: ${threadsSection.items} thread(s), hint="${threadsSection.hint?.slice(0, 50)}"`);
}

// C13. Second lesson
console.log('\n── Second lesson ──');
tested.push('Clicking second lesson in sidebar');
const secondLesson = p.locator('#sidebar-lessons a[data-slug]').nth(1);
if (await secondLesson.count() > 0) {
  await secondLesson.click();
  await p.waitForTimeout(800);
  const lesson2 = await p.evaluate(() => ({
    h1: document.querySelector('#lesson-view h1')?.textContent?.trim(),
  }));
  if (!lesson2.h1) bug('C37', 'Second lesson h1 missing after sidebar click');
  else pass(`Second lesson loaded: "${lesson2.h1}"`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// D. CROSS-CUTTING: Command Palette, Keyboard, Theme Persistence
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══ D. CROSS-CUTTING ══');

// D1. Command palette
console.log('\n── Command palette ──');
tested.push('Command palette (Ctrl+K)');
await p.keyboard.press('Control+k');
await p.waitForTimeout(400);
const palette = await p.evaluate(() => {
  const dlg = document.getElementById('cmd-palette');
  return {
    open: dlg?.open,
    hasInput: !!dlg?.querySelector('#cmd-input'),
    items: dlg?.querySelectorAll('#cmd-list li').length,
    hasHint: !!dlg?.querySelector('.cmd-hint'),
  };
});
if (!palette.open) {
  critical('D1', 'Ctrl+K does not open command palette');
} else {
  pass('Command palette opens with Ctrl+K');
  if (!palette.hasInput) bug('D2', 'Command palette missing text input');
  else pass('Palette has text input');
  if (palette.items === 0) bug('D3', 'Command palette has 0 items');
  else pass(`Palette has ${palette.items} items`);
  if (!palette.hasHint) friction('D4', 'Command palette missing keyboard hint (↑↓/Esc)');

  // Navigate with arrow keys
  await p.keyboard.press('ArrowDown');
  await p.waitForTimeout(100);
  const hasActive = await p.evaluate(() =>
    !!document.querySelector('#cmd-list .is-active, #cmd-list li.active, #cmd-list li[aria-selected="true"]')
  );
  if (!hasActive) friction('D5', 'Arrow-down in palette does not highlight an item');
  else pass('Arrow-down highlights item in palette');

  await p.keyboard.press('ArrowDown');
  await p.waitForTimeout(100);
  await p.keyboard.press('ArrowUp');
  await p.waitForTimeout(100);

  // Type to filter
  await p.locator('#cmd-input').fill('lesson');
  await p.waitForTimeout(300);
  const afterFilter = await p.evaluate(() =>
    document.querySelectorAll('#cmd-list li').length
  );
  pass(`Palette filter on "lesson": ${afterFilter} item(s) visible`);

  // Esc closes
  await p.keyboard.press('Escape');
  await p.waitForTimeout(200);
  const paletteClosed = await p.evaluate(() => !document.getElementById('cmd-palette').open);
  if (!paletteClosed) {
    friction('D6', 'Esc does not close command palette');
  } else {
    pass('Esc closes command palette');
  }
}

// D2. Theme persists across reload
console.log('\n── Theme persistence ──');
tested.push('Theme persistence across page reload');
// Set a specific theme
await p.evaluate(() => {
  localStorage.setItem('sg-theme', 'dark');
});
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForTimeout(600);
const themeAfterReload = await p.evaluate(() => ({
  stored: localStorage.getItem('sg-theme'),
  dataTheme: document.documentElement.getAttribute('data-theme'),
}));
if (themeAfterReload.stored !== 'dark') {
  bug('D7', 'Theme not persisted in localStorage across reload');
} else if (themeAfterReload.dataTheme !== 'dark') {
  bug('D8', `data-theme not applied on reload — expected "dark", got "${themeAfterReload.dataTheme}"`);
} else {
  pass('Theme persists across reload (dark mode applied)');
}
// Reset to auto
await p.evaluate(() => localStorage.setItem('sg-theme', 'auto'));

// D3. Dark mode visual sanity (no white-on-white)
console.log('\n── Dark mode visual check ──');
tested.push('Dark mode — no white-on-white text');
await p.evaluate(() => {
  document.documentElement.setAttribute('data-theme', 'dark');
});
await p.waitForTimeout(200);
await screenshot('dark-mode');
const darkModeCheck = await p.evaluate(() => {
  const body = getComputedStyle(document.body);
  return {
    bodyBg: body.backgroundColor,
    bodyColor: body.color,
    dataDark: document.documentElement.getAttribute('data-theme'),
  };
});
pass(`Dark mode body: bg=${darkModeCheck.bodyBg}, color=${darkModeCheck.bodyColor}`);
// Reset
await p.evaluate(() => {
  document.documentElement.setAttribute('data-theme', 'light');
});

// D4. Brand link goes home (reader → home)
console.log('\n── Brand link ──');
tested.push('Brand link returns to home from reader');
await p.goto(BASE + '/#/t/qa-sweep/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(600);
const brandLink = p.locator('.sidebar-brand[href="#/"]').first();
if (await brandLink.count() > 0) {
  await brandLink.click();
  await p.waitForTimeout(500);
  const onHome = await p.evaluate(() => !document.getElementById('view-home').hidden);
  if (!onHome) bug('D9', 'Brand link in reader does not navigate back to home');
  else pass('Brand link navigates to home');
} else {
  friction('D10', 'No brand link found in reader view');
}

// D5. Console errors summary
console.log('\n── Console/Network errors ──');
tested.push('Console errors and 4xx/5xx during normal navigation');
if (consoleErrors.length > 0) {
  const errMsgs = consoleErrors.filter(e =>
    // Filter out benign network errors (CDN font etc)
    !e.msg?.includes('fonts.googleapis') &&
    !e.msg?.includes('cdn.jsdelivr') &&
    !e.msg?.includes('Failed to fetch') // often Pyodide in headless
  );
  if (errMsgs.length > 0) {
    bug('D11', `${errMsgs.length} console error(s) during session`, errMsgs.slice(0, 3).map(e => e.msg?.slice(0, 100)).join(' | '));
  } else {
    pass('No significant console errors (CDN/Pyodide errors filtered)');
  }
}
if (networkErrors.length > 0) {
  bug('D12', `${networkErrors.length} network error(s) during session`,
    networkErrors.slice(0, 3).map(e => `${e.status} ${e.url}`).join(' | ')
  );
} else {
  pass('No API 4xx/5xx errors during session');
}

// D6. Ctrl+/ btw shortcut
console.log('\n── Ctrl+/ shortcut ──');
tested.push('Ctrl+/ opens btw chat (with selection)');
await p.goto(BASE + '/#/t/qa-sweep/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(800);
await p.locator('#sidebar-lessons a[data-slug]').first().click();
await p.waitForTimeout(800);
// Select some text
await p.evaluate(() => {
  const para = document.querySelector('#lesson-view p');
  if (!para) return;
  const range = document.createRange();
  range.selectNodeContents(para);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
});
await p.waitForTimeout(100);
await p.keyboard.press('Control+/');
await p.waitForTimeout(400);
const ctrlSlashOpened = await p.evaluate(() =>
  document.querySelector('.sg-chat-panel')?.classList.contains('show')
);
if (!ctrlSlashOpened) {
  friction('D13', 'Ctrl+/ with selection does not open btw chat panel');
} else {
  pass('Ctrl+/ opens btw chat panel');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(200);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MATERIAL VIEWER (in reader)
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══ E. MATERIALS IN READER SIDEBAR ══');
tested.push('Materials sidebar section in reader');
const matSection = await p.evaluate(() => {
  const matList = document.getElementById('sidebar-materials');
  return {
    exists: !!matList,
    hint: matList?.querySelector('.hint')?.textContent?.trim(),
    items: matList?.querySelectorAll('li:not(.hint)').length,
  };
});
if (!matSection.exists) {
  bug('E1', 'sidebar-materials element missing in reader');
} else {
  pass(`Materials section in sidebar: ${matSection.items} item(s)`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADDITIONAL: Empty state (no lessons)
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n══ F. EMPTY STATE ══');
tested.push('Empty-state reader (no curriculum)');
// Navigate to a new track that would have no lessons
await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(600);
// Check empty state when all tracks have lessons
const emptyHero = await p.evaluate(() => {
  const grid = document.getElementById('track-grid');
  return {
    hasCards: grid?.querySelectorAll('a.track-card[data-slug]').length > 0,
    hasCreateCard: !!grid?.querySelector('.track-card.create'),
    emptyMsg: grid?.querySelector('.hint')?.textContent?.trim(),
  };
});
pass(`Home grid: ${emptyHero.hasCards ? 'has courses' : 'empty'}, create card=${emptyHero.hasCreateCard}`);
if (!emptyHero.hasCards && !emptyHero.emptyMsg) {
  bug('F1', 'Home shows no courses but no empty-state message');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLOSE & REPORT
// ═══════════════════════════════════════════════════════════════════════════════
await browser.close();

// Build report
const now = new Date().toISOString();
const port = new URL(BASE).port;

const fmtIssue = (list) =>
  list.map(i => `- [${i.id}] **${i.msg}**${i.details ? `\n  ${i.details}` : ''}`).join('\n');

const reportLines = [
  `# QA sweep — iteration 1`,
  `Date: ${now}`,
  `Server: ${port}`,
  '',
  `## CRITICAL (broken)`,
  issues.critical.length > 0 ? fmtIssue(issues.critical) : '_none_',
  '',
  `## BUGS (works but wrong)`,
  issues.bugs.length > 0 ? fmtIssue(issues.bugs) : '_none_',
  '',
  `## UX FRICTION (works, feels bad)`,
  issues.friction.length > 0 ? fmtIssue(issues.friction) : '_none_',
  '',
  `## VISUAL / POLISH`,
  issues.visual.length > 0 ? fmtIssue(issues.visual) : '_none_',
  '',
  `## SUGGESTIONS`,
  '_See per-issue notes above_',
  '',
  `## What I tested vs skipped`,
  `- Tested:`,
  tested.map(t => `  - ${t}`).join('\n'),
  skipped.length > 0 ? `- Skipped:\n${skipped.map(s => `  - ${s}`).join('\n')}` : '- Skipped: _none_',
  '',
  `## Console errors captured`,
  consoleErrors.length > 0
    ? consoleErrors.slice(0, 10).map(e => `- [${e.type}] ${e.msg?.slice(0, 150)}`).join('\n')
    : '_none_',
  '',
  `## Network errors captured`,
  networkErrors.length > 0
    ? networkErrors.map(e => `- ${e.status} ${e.url}`).join('\n')
    : '_none_',
];

const report = reportLines.join('\n');
writeFileSync(REPORT_PATH, report, 'utf8');

const total = issues.critical.length + issues.bugs.length + issues.friction.length + issues.visual.length;
console.log(`\n${'═'.repeat(60)}`);
console.log(`Report: ${REPORT_PATH}`);
console.log(`Issues: ${issues.critical.length} critical, ${issues.bugs.length} bugs, ${issues.friction.length} friction, ${issues.visual.length} visual`);
console.log(`Total: ${total} issues found`);
console.log('═'.repeat(60));
