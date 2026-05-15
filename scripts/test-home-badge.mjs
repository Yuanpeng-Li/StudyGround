// Verify (a) the badge on the recent track says "recent" not "current",
// (b) the badge does not overlap with the hover action buttons.
import { chromium } from 'playwright';

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.setViewportSize({ width: 1400, height: 1100 });
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await p.goto('http://localhost:4321/', { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.querySelector('.track-card.current'));
await p.waitForTimeout(400);

const r = [];
const pass = (n, info='') => { r.push({n, ok: true}); console.log('PASS', n, info); };
const fail = (n, info='') => { r.push({n, ok: false}); console.log('FAIL', n, info); };

// The pseudo-element ::after has its `content` as a string in `getComputedStyle.content`
const badge = await p.evaluate(() => {
  const card = document.querySelector('.track-card.current');
  if (!card) return { error: 'no .current card' };
  const cs = getComputedStyle(card, '::after');
  return {
    content: cs.content,
    position: cs.position,
    bottom: cs.bottom,
    right: cs.right,
    top: cs.top,
    bg: cs.backgroundColor,
    cardRect: card.getBoundingClientRect(),
  };
});
console.log('badge:', badge);
badge.content && /recent/.test(badge.content) ? pass(`badge says "recent" (${badge.content})`) : fail(`badge text (${badge.content})`);
badge.bottom && badge.bottom !== 'auto' ? pass(`badge anchored to bottom (bottom=${badge.bottom})`) : fail(`badge not at bottom (${badge.bottom})`);

// Hover the card to surface the action buttons
await p.locator('.track-card.current').hover();
await p.waitForTimeout(200);

const hoverState = await p.evaluate(() => {
  const card = document.querySelector('.track-card.current');
  const actions = card.querySelector('.track-card-actions');
  const exportBtn = card.querySelector('.track-export');
  const deleteBtn = card.querySelector('.track-delete');
  // We can't get the pseudo-element bounding box directly, but we can read
  // its position from getComputedStyle. The badge bottom is at offset
  // `cardRect.bottom - parseFloat(bottom)`. Use the action btn rects to
  // check no rect overlap.
  return {
    actionsOpacity: getComputedStyle(actions).opacity,
    exportRect: exportBtn.getBoundingClientRect(),
    deleteRect: deleteBtn.getBoundingClientRect(),
    cardRect: card.getBoundingClientRect(),
    badgeBottom: getComputedStyle(card, '::after').bottom,
    badgeRight: getComputedStyle(card, '::after').right,
  };
});
console.log('hover state:', hoverState);
Number(hoverState.actionsOpacity) > 0.9 ? pass('action buttons visible on hover') : fail('action buttons visible on hover');

// Badge is at bottom-right of card; buttons are at top-right. Verify they
// are not in the same Y band of the card.
const cardH = hoverState.cardRect.height;
const buttonsTopY = hoverState.exportRect.top - hoverState.cardRect.top;
const badgeBottomOffset = parseFloat(hoverState.badgeBottom); // distance from card bottom
const badgeTopY = cardH - badgeBottomOffset - 22; // ~ badge height
const gap = badgeTopY - hoverState.deleteRect.bottom + hoverState.cardRect.top;
console.log('  buttons at y=' + buttonsTopY.toFixed(0) + ', badge ~y=' + badgeTopY.toFixed(0) + ' (gap ' + gap.toFixed(0) + 'px)');
gap > 30 ? pass(`badge and buttons separated vertically (${gap.toFixed(0)}px gap)`) : fail(`badge/button overlap (${gap.toFixed(0)}px)`);

// Badge border should track card hover — pre-hover light color, post-hover the
// stronger accent. We can't easily read the pre-hover border without unhovering;
// instead just check the hover border is now the punchier `--accent`.
const badgeBorder = await p.evaluate(() => getComputedStyle(document.querySelector('.track-card.current'), '::after').borderColor);
console.log('  badge border on hover:', badgeBorder);
// Light-mode --accent is #C96442 = rgb(201, 100, 66) (or color-mix variants)
/(201|c96442)/i.test(badgeBorder) ? pass(`badge border lifts to --accent on card hover (${badgeBorder})`) : fail(`badge border doesn't lift (${badgeBorder})`);

// And the CARD's own border should also lift to --accent (used to stay
// stuck at --accent-soft because `.track-card.current` overrode the hover).
const cardBorder = await p.evaluate(() => getComputedStyle(document.querySelector('.track-card.current')).borderColor);
console.log('  card border on hover:', cardBorder);
/(201|c96442)/i.test(cardBorder) ? pass(`card border lifts to --accent on hover (${cardBorder})`) : fail(`card border doesn't lift (${cardBorder})`);

await p.screenshot({ path: '/tmp/sg-home-badge.png', fullPage: false });
console.log('shot: /tmp/sg-home-badge.png');
await b.close();
const ok = r.every((x) => x.ok);
console.log(ok ? `\n${r.length}/${r.length} PASS` : '\nFAIL');
process.exit(ok ? 0 : 1);
