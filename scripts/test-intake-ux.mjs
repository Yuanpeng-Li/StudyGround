// Verify (a) intake page has conversational framing (no "What do you want to
// learn?" / no "4–6 questions"), (b) reader empty state surfaces tutor CTA.
import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1300, height: 1100 });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

// --- 1. Intake page UX ---
console.log('--- intake page ---');
await p.goto('http://localhost:4321/#/t/tutor-ux-test/intake', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !document.getElementById('view-intake')?.hidden);
await p.waitForTimeout(500);

const intakeText = await p.evaluate(() => {
  const view = document.getElementById('view-intake');
  return {
    h2: view.querySelector('.intake-hero h2')?.textContent,
    sub: view.querySelector('.intake-hero .intake-sub')?.textContent,
    placeholder: view.querySelector('#intake-input')?.placeholder,
    skipLabel: view.querySelector('[data-action="skip-intake"]')?.textContent,
    bodyText: view.textContent,
  };
});
console.log('  h2:', JSON.stringify(intakeText.h2));
console.log('  sub:', JSON.stringify(intakeText.sub.slice(0, 100)) + '...');
console.log('  placeholder:', JSON.stringify(intakeText.placeholder));
console.log('  skip label:', JSON.stringify(intakeText.skipLabel));

const passes = {
  noSurveyTitle: !intakeText.bodyText.includes('What do you want to learn?'),
  noQuestionCount: !intakeText.bodyText.includes('4–6 questions'),
  tutorFraming: intakeText.bodyText.includes('Meet your tutor'),
  hasReadyButton: intakeText.bodyText.includes('Plan curriculum'),
};
console.log('  checks:', passes);

// --- 2. Reader empty-state CTA ---
console.log('\n--- reader empty state ---');
await p.goto('http://localhost:4321/#/t/tutor-ux-test/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(800);

// Note: the auto-redirect to intake will fire because no curriculum + no lessons.
// Manually navigate back to reader after a moment.
await p.evaluate(() => {
  // Stub: write a dummy curriculum so reader stays put
  return fetch('/api/tracks/tutor-ux-test/curriculum', { method: 'PUT' }).catch(() => null);
});
// Actually just check the empty state markup by injecting into a clean reader
await p.goto('http://localhost:4321/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(500);
// Force into reader view and check the empty state DOM:
const emptyState = await p.evaluate(() => {
  // Show reader view manually for inspection
  document.querySelectorAll('.view').forEach((v) => (v.hidden = true));
  document.getElementById('view-reader').hidden = false;
  const ev = document.querySelector('.lesson-empty');
  return {
    hasEmpty: !!ev,
    ctaText: ev?.querySelector('button[data-action="open-tutor"]')?.textContent,
    hintText: ev?.querySelector('.hint')?.textContent,
  };
});
console.log('  has .lesson-empty wrapper:', emptyState.hasEmpty);
console.log('  CTA text:', JSON.stringify(emptyState.ctaText));
console.log('  hint text:', JSON.stringify(emptyState.hintText));

const readerPass = {
  hasWrapper: emptyState.hasEmpty,
  hasTutorBtn: !!emptyState.ctaText && emptyState.ctaText.includes('tutor'),
};
console.log('  checks:', readerPass);

await p.screenshot({ path: '/tmp/sg-intake-ux.png', fullPage: true });
console.log('\nshot: /tmp/sg-intake-ux.png');
await b.close();

const allPass = Object.values(passes).every(Boolean) && Object.values(readerPass).every(Boolean);
console.log('\nall checks:', allPass ? 'PASS' : 'FAIL');
process.exit(allPass ? 0 : 1);
