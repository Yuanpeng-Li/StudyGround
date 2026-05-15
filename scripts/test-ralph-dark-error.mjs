import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const PORT = readFileSync('/tmp/ralph-port', 'utf8').trim();
const BASE = `http://localhost:${PORT}`;

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1400, height: 1000 } });
const p = await ctx.newPage();

// Navigate to home
await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(500);

// Switch to dark mode
await p.evaluate(() => {
  document.documentElement.setAttribute('data-theme', 'dark');
  localStorage.setItem('sg-theme', 'dark');
});
await p.waitForTimeout(200);

// Open new course dialog
await p.click('.track-card.create');
await p.waitForTimeout(300);

// Submit with duplicate title to trigger inline error
await p.fill('#nt-title', 'QA Sweep');
await p.click('#new-track-dialog button[type="submit"]');
await p.waitForTimeout(600);

// Get error styles
const errInfo = await p.evaluate(() => {
  const el = document.getElementById('nt-error');
  if (!el) return null;
  const cs = getComputedStyle(el);
  return {
    hidden: el.hidden,
    text: el.textContent,
    bg: cs.backgroundColor,
    color: cs.color,
    theme: document.documentElement.getAttribute('data-theme'),
  };
});
console.log('Dark mode error info:', JSON.stringify(errInfo, null, 2));

await p.screenshot({ path: '/tmp/sg-ralph-dark-error.png' });
console.log('Screenshot: /tmp/sg-ralph-dark-error.png');

// Check edit track path for alert()
await p.keyboard.press('Escape');
await p.waitForTimeout(200);

// Check edit dialog
await p.hover('a.track-card[data-slug]');
await p.waitForTimeout(150);
await p.click('[data-action="edit-track"]');
await p.waitForTimeout(400);

const editDlg = await p.evaluate(() => {
  const dlg = document.getElementById('edit-track-dialog');
  const etErr = document.getElementById('et-error');
  return {
    open: dlg?.open,
    hasEtError: !!etErr,
    etErrorHidden: etErr?.hidden,
  };
});
console.log('Edit dialog state:', JSON.stringify(editDlg, null, 2));

await p.screenshot({ path: '/tmp/sg-ralph-edit-dialog-dark.png' });

await b.close();
