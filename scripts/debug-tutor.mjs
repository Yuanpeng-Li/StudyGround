// Debug-only: navigate to a track's reader, click btn-tutor, dump DOM state.
import { chromium } from 'playwright';
const SLUG = process.argv[2] || process.env.SG_SLUG;
if (!SLUG) { console.log('usage: node debug-tutor.mjs <slug>'); process.exit(1); }
const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1400, height: 1100 });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
p.on('console', (m) => { if (m.type() === 'error') console.log('[CONSOLE.error]', m.text()); });

await p.goto(`http://localhost:4321/#/t/${SLUG}/`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => !document.getElementById('view-reader')?.hidden, null, { timeout: 8000 });
await p.waitForTimeout(1000);

console.log('--- reader DOM probe ---');
const probe1 = await p.evaluate(() => ({
  url: location.hash,
  readerVisible: !document.getElementById('view-reader').hidden,
  intakeVisible: !document.getElementById('view-intake').hidden,
  btnTutor: !!document.getElementById('btn-tutor'),
  preexistingPanel: document.querySelectorAll('.sg-chat-panel').length,
  currentTrack: window.currentTrack ?? '(undef)',
}));
console.log(JSON.stringify(probe1, null, 2));

console.log('\n--- clicking btn-tutor ---');
await p.locator('#btn-tutor').click();
await p.waitForTimeout(2000);

const probe2 = await p.evaluate(() => {
  const panel = document.querySelector('.sg-chat-panel');
  if (!panel) {
    return {
      panelExists: false,
      allElements: [...document.querySelectorAll('[class*="chat"]')].map((e) => e.className),
    };
  }
  const msgs = panel.querySelectorAll('.sg-chat-msg');
  return {
    panelExists: true,
    visible: panel.classList.contains('show'),
    tutorMode: panel.classList.contains('tutor-mode'),
    className: panel.className,
    childrenSelectors: [...panel.querySelectorAll('*')].slice(0, 5).map((e) => e.tagName + '.' + (e.className || '(no-class)')),
    msgCount: msgs.length,
    msgClasses: [...msgs].map((m) => m.className).slice(0, 5),
    msgText0: msgs[0]?.textContent.slice(0, 100),
    msgText1: msgs[1]?.textContent.slice(0, 100),
  };
});
console.log(JSON.stringify(probe2, null, 2));

await b.close();
