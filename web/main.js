// studyground web reader — M2.
// Plain JS + CDN markdown-it + KaTeX. Vite/TS migration deferred to later.
import markdownit from 'https://cdn.jsdelivr.net/npm/markdown-it@14.1.0/+esm';
import katex from 'https://cdn.jsdelivr.net/npm/katex@0.16.11/+esm';

const md = markdownit({ html: true, linkify: true, typographer: true });

// ---------- math: $...$  and  $$...$$ ----------
md.inline.ruler.before('escape', 'math_inline', mathInline);
md.block.ruler.before('paragraph', 'math_block', mathBlock, {
  alt: ['paragraph', 'blockquote'],
});
md.renderer.rules.math_inline = (tokens, idx) => {
  const latex = tokens[idx].content;
  const html = katex.renderToString(latex, { throwOnError: false });
  return `<span class="sg-math sg-math-inline" data-latex="${escapeHtml(latex)}">${html}</span>`;
};
md.renderer.rules.math_block = (tokens, idx) => {
  const latex = tokens[idx].content;
  const html = katex.renderToString(latex, { displayMode: true, throwOnError: false });
  return `<div class="math-block sg-math sg-math-block" data-latex="${escapeHtml(latex)}">${html}</div>`;
};

function mathInline(state, silent) {
  if (state.src[state.pos] !== '$') return false;
  if (state.src[state.pos + 1] === '$') return false;
  const start = state.pos + 1;
  const end = state.src.indexOf('$', start);
  if (end < 0 || end === start) return false;
  if (state.src[end - 1] === '\\') return false;
  if (!silent) {
    state.push('math_inline', 'math', 0).content = state.src.slice(start, end);
  }
  state.pos = end + 1;
  return true;
}
function mathBlock(state, startLine, endLine, silent) {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  if (state.src.slice(start, start + 2) !== '$$') return false;

  // Case A: $$...$$ all on the same line
  const startMax = state.eMarks[startLine];
  const sameLineRest = state.src.slice(start + 2, startMax);
  const sameLineClose = sameLineRest.lastIndexOf('$$');
  if (sameLineClose >= 0) {
    if (!silent) {
      const token = state.push('math_block', 'math', 0);
      token.content = sameLineRest.slice(0, sameLineClose).trim();
      token.markup = '$$';
      token.block = true;
    }
    state.line = startLine + 1;
    return true;
  }

  // Case B: $$ ... \n ... $$ across multiple lines
  let line = startLine;
  let found = false;
  while (line < endLine) {
    const le = state.eMarks[line];
    if (line > startLine && state.src.slice(le - 2, le) === '$$') {
      found = true;
      break;
    }
    line++;
  }
  if (!found) return false;
  if (!silent) {
    const content = state.src
      .slice(state.bMarks[startLine] + 2, state.eMarks[line] - 2)
      .trim();
    const token = state.push('math_block', 'math', 0);
    token.content = content;
    token.markup = '$$';
    token.block = true;
  }
  state.line = line + 1;
  return true;
}

// ---------- citation chips: [file.pdf], [file.pdf, p.7], [file.pdf, p.7–9] ----------
// Matches before `link` so it can claim the opening `[`. The filename is
// captured loosely (any non-bracket/non-newline chars ending in a file
// extension); the page suffix is optional. Accepts ASCII `-`, en-dash `–`,
// and em-dash `—` between two page numbers.
const SG_CITE_RE = /^\[([^\[\]\n]+?\.(?:pdf|md|txt|png|jpe?g|gif|webp|svg|html?|csv|json))(?:,\s*p\.\s*([0-9]+(?:\s*[\-–—]\s*[0-9]+)?))?\]/i;
md.inline.ruler.before('link', 'sg_cite', sgCite);
function sgCite(state, silent) {
  if (state.src[state.pos] !== '[') return false;
  const tail = state.src.slice(state.pos);
  const m = SG_CITE_RE.exec(tail);
  if (!m) return false;
  // Yield to the regular link rule when this looks like `[text](url)` — we
  // only want to claim *bare* `[file.pdf]` citations.
  if (state.src[state.pos + m[0].length] === '(') return false;
  if (!silent) {
    const token = state.push('sg_cite', '', 0);
    token.meta = { file: m[1].trim(), page: (m[2] || '').replace(/\s+/g, '') };
    token.content = m[0];
  }
  state.pos += m[0].length;
  return true;
}
md.renderer.rules.sg_cite = (tokens, idx) => {
  const { file, page } = tokens[idx].meta;
  const tooltip = page ? `${file} · p.${page}` : file;
  // With a page, render an icon + "p.N" chip. Whole-file refs render as
  // just the icon — the filename lives in the tooltip so inline prose
  // stays readable.
  const pageLabel = page
    ? `<span class="sg-cite-page">p.${escapeHtml(page)}</span>`
    : '';
  return (
    `<a class="sg-cite${page ? '' : ' is-bare'}" href="#" role="button"` +
    ` data-action="open-cite"` +
    ` data-file="${escapeHtml(file)}"` +
    (page ? ` data-page="${escapeHtml(page)}"` : '') +
    ` title="${escapeHtml(tooltip)}">` +
    `<span class="sg-cite-icon" aria-hidden="true">📄</span>` +
    pageLabel +
    `</a>`
  );
};

// ---------- studyground markers: ?>, ?>>, :::exercise, answer blocks ----------
md.block.ruler.before('paragraph', 'sg_question', sgQuestion);
md.block.ruler.before('html_block', 'sg_answer_pending', sgAnswerPending);
md.block.ruler.before('html_block', 'sg_answer_block', sgAnswerBlock);
md.block.ruler.before('fence', 'sg_exercise', sgExercise);
md.block.ruler.before('html_block', 'sg_feedback', sgFeedback);
md.block.ruler.before('html_block', 'sg_details', sgDetailsBlock);

function sgQuestion(state, startLine, endLine, silent) {
  const pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  const line = state.src.slice(pos, max);
  const m = line.match(/^(\?>{1,2})\s+(.+)$/);
  if (!m) return false;
  if (silent) return true;
  if (!state.env.sg) state.env.sg = { count: 0 };
  state.env.sg.count++;
  const kind = m[1] === '?>' ? 'main' : 'btw';
  const tok = state.push('sg_question', 'div', 0);
  tok.attrSet('data-kind', kind);
  tok.attrSet('data-text', m[2]);
  tok.attrSet('data-index', String(state.env.sg.count));
  tok.markup = m[1];
  tok.map = [startLine, startLine + 1];
  state.line = startLine + 1;
  return true;
}

function sgAnswerPending(state, startLine, endLine, silent) {
  const pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  const line = state.src.slice(pos, max).trim();
  if (line !== '<!-- answer:pending -->') return false;
  if (silent) return true;
  const idx = state.env.sg?.count || 0;
  const tok = state.push('sg_answer_pending', 'div', 0);
  tok.attrSet('data-index', String(idx));
  tok.map = [startLine, startLine + 1];
  state.line = startLine + 1;
  return true;
}

function sgAnswerBlock(state, startLine, endLine, silent) {
  const startPos = state.bMarks[startLine] + state.tShift[startLine];
  const startMax = state.eMarks[startLine];
  const startText = state.src.slice(startPos, startMax).trim();
  if (startText !== '<!-- answer:start -->') return false;
  let line = startLine + 1;
  let endIdx = -1;
  while (line < endLine) {
    const p = state.bMarks[line] + state.tShift[line];
    const e = state.eMarks[line];
    if (state.src.slice(p, e).trim() === '<!-- answer:end -->') {
      endIdx = line;
      break;
    }
    line++;
  }
  if (endIdx < 0) return false;
  if (silent) return true;
  const idx = state.env.sg?.count || 0;
  const inner = state.src
    .slice(state.bMarks[startLine + 1], state.bMarks[endIdx])
    .trim();
  const tok = state.push('sg_answer_block', 'div', 0);
  tok.attrSet('data-index', String(idx));
  tok.content = inner;
  tok.map = [startLine, endIdx + 1];
  state.line = endIdx + 1;
  return true;
}

function sgFeedback(state, startLine, endLine, silent) {
  const startPos = state.bMarks[startLine] + state.tShift[startLine];
  const startMax = state.eMarks[startLine];
  const startText = state.src.slice(startPos, startMax).trim();
  const m = startText.match(/^<!--\s*feedback:start\s+name="([^"]+)"\s*-->$/);
  if (!m) return false;
  let line = startLine + 1;
  let endIdx = -1;
  while (line < endLine) {
    const p = state.bMarks[line] + state.tShift[line];
    const e = state.eMarks[line];
    if (state.src.slice(p, e).trim() === '<!-- feedback:end -->') {
      endIdx = line;
      break;
    }
    line++;
  }
  if (endIdx < 0) return false;
  if (silent) return true;
  const inner = state.src
    .slice(state.bMarks[startLine + 1], state.bMarks[endIdx])
    .trim();
  const tok = state.push('sg_feedback', 'div', 0);
  tok.attrSet('data-exercise', m[1]);
  tok.content = inner;
  tok.map = [startLine, endIdx + 1];
  state.line = endIdx + 1;
  return true;
}

// Match <details> at the start of a line, optionally with attributes like
// `<details open>` or `<details class="hint">`. Capture group 1 is the
// raw attribute string (or empty), group 2 is the remainder of the line
// after the opening tag.
const RE_DETAILS_OPEN = /^<details(\s[^>]*)?>(.*)$/i;

// Whitelist attributes copied to the rendered <details> tag. Anything
// else (notably event handlers like `onclick`) is dropped to keep the
// chat panel safe even if a model emits something dodgy.
function sanitizeDetailsAttrs(raw) {
  if (!raw) return '';
  const out = [];
  // Match name or name="value" / name='value' / name=value
  const re = /\s+([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? null;
    if (name === 'open') {
      out.push(' open');
    } else if (name === 'class' || name === 'id') {
      if (value != null) {
        out.push(` ${name}="${String(value).replace(/"/g, '&quot;')}"`);
      }
    }
    // silently drop everything else
  }
  return out.join('');
}

function sgDetailsBlock(state, startLine, endLine, silent) {
  const startPos = state.bMarks[startLine] + state.tShift[startLine];
  const startMax = state.eMarks[startLine];
  const startText = state.src.slice(startPos, startMax);
  const openMatch = startText.match(RE_DETAILS_OPEN);
  if (!openMatch) return false;
  const attrs = sanitizeDetailsAttrs(openMatch[1] || '');
  const sameLineRest = openMatch[2] || '';

  // Case A: the opening line already contains </details> — a single-line
  // <details>...</details> block. Treat it like a normal block: parse
  // everything between the tags as markdown so $math$, code, etc.
  // render properly.
  const sameLineCloseIdx = sameLineRest.toLowerCase().lastIndexOf('</details>');
  if (sameLineCloseIdx >= 0) {
    if (silent) return true;
    const inner = sameLineRest.slice(0, sameLineCloseIdx);
    const { summary: sumA, body: bodyA } = splitSummary(inner);
    const tok = state.push('sg_details', 'div', 0);
    tok.attrSet('data-summary', sumA);
    tok.attrSet('data-attrs', attrs);
    tok.content = bodyA;
    tok.map = [startLine, startLine + 1];
    state.line = startLine + 1;
    return true;
  }

  // Case B: multi-line. Find the closing </details> line.
  let endIdx = -1;
  let endRestBefore = '';
  for (let i = startLine + 1; i < endLine; i++) {
    const p = state.bMarks[i] + state.tShift[i];
    const e = state.eMarks[i];
    const line = state.src.slice(p, e);
    const closeIdx = line.toLowerCase().indexOf('</details>');
    if (closeIdx >= 0) {
      endIdx = i;
      endRestBefore = line.slice(0, closeIdx);
      break;
    }
  }
  if (endIdx < 0) return false;
  if (silent) return true;

  // Collect inner source:
  //   - any text on the opening line after `<details ...>`
  //   - all whole lines between (startLine+1 .. endIdx-1)
  //   - any text on the closing line before `</details>`
  const middle = endIdx > startLine + 1
    ? state.src.slice(state.bMarks[startLine + 1], state.bMarks[endIdx])
    : '';
  // Stitch with newlines so `$math$` etc. parse correctly. If sameLineRest
  // has content (e.g. `<details><summary>x</summary>$y$`), preserve it
  // as the first line of inner.
  let stitched = '';
  if (sameLineRest) stitched += sameLineRest + '\n';
  stitched += middle;
  if (endRestBefore && endRestBefore.trim()) {
    if (!stitched.endsWith('\n')) stitched += '\n';
    stitched += endRestBefore + '\n';
  }

  const { summary, body } = splitSummary(stitched);
  const tok = state.push('sg_details', 'div', 0);
  tok.attrSet('data-summary', summary);
  tok.attrSet('data-attrs', attrs);
  tok.content = body;
  tok.map = [startLine, endIdx + 1];
  state.line = endIdx + 1;
  return true;
}

// Pull out the first <summary>...</summary> (if any) from the raw inner
// text. The summary may be on its own line or inline. Returns the
// summary HTML (string, may be empty) and the remaining body.
function splitSummary(raw) {
  // Try a non-greedy match anywhere near the start, but only consume it
  // if it is the first non-whitespace content.
  const m = raw.match(/^[\s]*<summary>([\s\S]*?)<\/summary>[ \t]*\n?/i);
  if (!m) return { summary: '', body: raw.replace(/^[\s]*\n/, '') };
  return { summary: m[1].trim(), body: raw.slice(m[0].length) };
}

function sgExercise(state, startLine, endLine, silent) {
  const pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  const line = state.src.slice(pos, max);
  const m = line.match(/^:::exercise\s+([\w-]+)\s*$/);
  if (!m) return false;
  let close = startLine + 1;
  while (close < endLine) {
    const p = state.bMarks[close] + state.tShift[close];
    const e = state.eMarks[close];
    if (state.src.slice(p, e).trim() === ':::') break;
    close++;
  }
  if (close >= endLine) return false;
  if (silent) return true;
  const inner = state.src
    .slice(state.bMarks[startLine + 1], state.bMarks[close])
    .trim();
  const tok = state.push('sg_exercise', 'div', 0);
  tok.attrSet('data-name', m[1]);
  tok.content = inner;
  tok.map = [startLine, close + 1];
  state.line = close + 1;
  return true;
}

// ---------- renderers ----------
md.renderer.rules.sg_question = (tokens, idx) => {
  const t = tokens[idx];
  const kind = t.attrGet('data-kind');
  const text = t.attrGet('data-text') || '';
  const index = t.attrGet('data-index');
  // Render the question through inline markdown so $math$ goes through the
  // math rule. Keep the raw source on data-source so onAskClick can recover
  // the clean string (the rendered katex DOM's textContent is unusable).
  const rendered = md.renderInline(text, {});
  const label = kind === 'btw' ? 'deeper' : 'q';
  // The renderer emits a flat <div>; mergeQuestionBlocks() turns this + its
  // adjacent <details>/.sg-answer sibling into a single <details> so the
  // question is the toggle (click to expand/collapse the answer body).
  return `<div class="sg-question ${kind}" data-index="${index}" data-kind="${kind}" data-source="${escapeHtml(text)}">
    <span class="sg-q-label">${label}</span>
    <span class="sg-q-text">${rendered}</span>
  </div>\n`;
};

md.renderer.rules.sg_answer_pending = (tokens, idx) => {
  const t = tokens[idx];
  const index = t.attrGet('data-index');
  return `<div class="sg-answer pending" data-index="${index}">
    <button class="ask-btn" data-action="ask" data-index="${index}">Ask</button>
  </div>\n`;
};

md.renderer.rules.sg_answer_block = (tokens, idx) => {
  const t = tokens[idx];
  const index = t.attrGet('data-index');
  const rendered = md.render(t.content, {}); // recursive — fresh env so it doesn't pollute counters
  return `<div class="sg-answer answered" data-index="${index}">${rendered}</div>\n`;
};

md.renderer.rules.sg_details = (tokens, idx) => {
  const t = tokens[idx];
  const summary = t.attrGet('data-summary') || 'details';
  const attrs = t.attrGet('data-attrs') || '';
  // Render the body as full markdown so `$...$`, `$$...$$`, code fences,
  // and other block constructs work inside <details>.
  const inner = md.render(t.content || '', {});
  // Render the summary line as inline markdown too (so $math$ in summary works)
  const summaryRendered = md.renderInline(summary, {});
  return `<details${attrs}>
    <summary>${summaryRendered}</summary>
    ${inner}
  </details>\n`;
};

md.renderer.rules.sg_feedback = (tokens, idx) => {
  const t = tokens[idx];
  const name = t.attrGet('data-exercise') || '';
  const inner = md.render(t.content, {});
  return `<div class="sg-feedback" data-exercise="${escapeHtml(name)}">
    <div class="sg-fb-label">feedback · <code>${escapeHtml(name)}</code></div>
    <div class="sg-fb-body">${inner}</div>
  </div>\n`;
};

md.renderer.rules.sg_exercise = (tokens, idx) => {
  const t = tokens[idx];
  const name = t.attrGet('data-name');
  const inner = md.render(t.content, {});
  const safeName = escapeHtml(name);
  return `<div class="sg-exercise" data-name="${safeName}">
    <div class="sg-ex-header">
      <span class="sg-ex-label">exercise</span>
      <code class="sg-ex-name">${safeName}</code>
      <span class="sg-ex-actions">
        <button class="sg-ex-open" data-action="open-exercise" data-name="${safeName}">Open in VSCode</button>
        <button class="sg-ex-check" data-action="check-exercise" data-name="${safeName}" title="review your solution + run tests if test_main.py exists">Check &amp; run</button>
      </span>
    </div>
    <div class="sg-ex-body">${inner}</div>
  </div>\n`;
};

// Code fence: detect `<lang> run` suffix and render as a runnable cell
const defaultFence = md.renderer.rules.fence || ((tokens, idx, opts, env, self) => self.renderToken(tokens, idx, opts));
md.renderer.rules.fence = (tokens, idx, opts, env, self) => {
  const t = tokens[idx];
  const info = (t.info || '').trim();
  const parts = info.split(/\s+/);
  const lang = parts[0] || '';
  const isRun = parts.slice(1).includes('run');
  const origInfo = t.info;
  t.info = lang;
  const html = defaultFence(tokens, idx, opts, env, self);
  t.info = origInfo;
  if (!isRun) return html;
  return `<div class="sg-runnable" data-lang="${escapeHtml(lang)}">
    <div class="sg-run-header">
      <span class="sg-run-label">${escapeHtml(lang)} · runnable</span>
      <button class="sg-run-btn" data-action="run-cell" disabled title="loading Python…">Run</button>
    </div>
    ${html}
    <pre class="sg-run-output" hidden></pre>
  </div>`;
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Expose md.render for tests (Playwright). Harmless in production —
// it lets the test verify the exact pipeline the chat panel uses.
if (typeof window !== 'undefined') {
  window.__mdRender = (text) => md.render(text, {});
  // Test-only hooks so Playwright can open the btw panel deterministically
  // (real selectionchange events are flaky in headless mode) and verify
  // the selection-to-LaTeX conversion in isolation.
  window.__openChatPanel = (sel) => openChatPanel(sel);
  window.__selectionToTextWithLatex = (sel) => selectionToTextWithLatex(sel);
}

// ---------- App state ----------
// ---------- Theme toggle (works for any .theme-toggle on the page) ----------
const THEMES = ['auto', 'light', 'dark'];
const ICON_SUN = '<svg class="sg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
const ICON_MOON = '<svg class="sg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

function getStoredTheme() {
  return localStorage.getItem('sg-theme') || 'auto';
}
function applyTheme(theme) {
  const root = document.documentElement;
  const actual = theme === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  root.setAttribute('data-theme', actual);
  const icon = actual === 'dark' ? ICON_MOON : ICON_SUN;
  for (const btn of document.querySelectorAll('.theme-toggle')) {
    btn.innerHTML = icon;
    btn.dataset.theme = theme;
    btn.dataset.applied = actual;
    btn.title = `theme: ${theme}${theme === 'auto' ? ' (following system)' : ''} — click to switch`;
    btn.setAttribute('aria-label', `theme: ${theme}`);
  }
}
applyTheme(getStoredTheme());
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (getStoredTheme() === 'auto') applyTheme('auto');
});
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(getStoredTheme());
  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.theme-toggle');
    if (!btn) return;
    const cur = getStoredTheme();
    const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
    localStorage.setItem('sg-theme', next);
    applyTheme(next);
  });
});

const view = document.getElementById('lesson-view');
const sidebarLessons = document.getElementById('sidebar-lessons');
const sidebarOutline = document.getElementById('sidebar-outline');
const sidebarThreads = document.getElementById('sidebar-threads');
const trackLabel = document.getElementById('track-label');
const lessonTitleBar = document.getElementById('lesson-title-bar');
const btnNext = document.getElementById('btn-next');
const btnRecap = document.getElementById('btn-recap');
const status = document.getElementById('status');
let currentSlug = '';
let inflightAsks = new Set(); // indices currently being asked

function setStatus(msg) {
  status.textContent = msg;
}

function stripFrontmatter(text) {
  if (!text.startsWith('---\n')) return { meta: {}, body: text };
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) return { meta: {}, body: text };
  const raw = text.slice(4, end);
  const meta = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([a-zA-Z_]+):\s*(.+)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  return { meta, body: text.slice(end + 5) };
}

let _allLessons = [];
let _lessonDetails = {}; // slug -> summary
let _progress = { current_track: null, tracks: {} };
let currentTrack = null;

// In-memory cache of valid track slugs, refreshed on demand. Used by route()
// to gate slugs before any track-scoped fetch — without this a typo'd URL
// would trigger 404s + ghost-course creation. /api/tracks lists every
// real track on disk (independent of progress.json's "selected" state).
let _trackSlugs = null;
let _trackSlugsFetchedAt = 0;
async function trackExists(slug) {
  if (!slug) return false;
  // Positive cache hit: trust it (tracks rarely vanish underfoot).
  if (_trackSlugs && _trackSlugs.has(slug)) return true;
  // Miss → always refetch. Negative-caching breaks the case where the user
  // just created the track in this same tab (so the cache is "fresh" but
  // doesn't yet contain it).
  try {
    const r = await fetch('/api/tracks').then((x) => x.json()).catch(() => null);
    if (r?.tracks) {
      _trackSlugs = new Set(r.tracks.map((t) => t.slug));
      _trackSlugsFetchedAt = Date.now();
      return _trackSlugs.has(slug);
    }
  } catch {}
  return false;
}
function invalidateTrackSlugCache() { _trackSlugs = null; }

async function loadList() {
  // Without a current track the lessons endpoint 400s — that's noise in
  // the console for callers like SSE handlers that don't know whether
  // we've already navigated home. Bail early and refresh just progress.
  if (!currentTrack) {
    try {
      const progressRes = await fetch('/api/progress').then((r) => r.json());
      _progress = progressRes;
    } catch {}
    _allLessons = [];
    _lessonDetails = {};
    renderSidebarLessons();
    return _allLessons;
  }
  const wantDetail = !!currentTrack;
  const lessonsUrl = currentTrack
    ? `/api/lessons?track=${encodeURIComponent(currentTrack)}&detail=1`
    : '/api/lessons';
  const [lessonsRes, progressRes] = await Promise.all([
    fetch(lessonsUrl).then((r) => r.json()),
    fetch('/api/progress').then((r) => r.json()),
  ]);
  const rawLessons = lessonsRes.lessons || [];
  if (wantDetail && rawLessons.length && typeof rawLessons[0] === 'object') {
    _allLessons = rawLessons.map((l) => l.slug);
    _lessonDetails = Object.fromEntries(rawLessons.map((l) => [l.slug, l.summary || {}]));
  } else {
    _allLessons = rawLessons;
    _lessonDetails = {};
  }
  _progress = progressRes;
  renderSidebarLessons();
  return _allLessons;
}

function renderSidebarLessons() {
  const track = _progress.current_track;
  const trackData = track ? _progress.tracks?.[track] : null;
  const completed = new Set(trackData?.completed || []);
  const trackCurrent = trackData?.current;

  trackLabel.textContent = track || 'no track yet';

  if (!_allLessons.length) {
    sidebarLessons.innerHTML =
      '<li class="hint" style="padding:0.25rem 0.6rem;font-size:0.8rem;color:var(--text-faint);font-style:italic">no lessons yet — click <b>Next →</b></li>';
    return;
  }

  sidebarLessons.innerHTML = _allLessons
    .map((slug) => {
      const isCurrentDisplay = slug === currentSlug;
      const isProgressCurrent = slug === trackCurrent;
      const isCompleted = completed.has(slug);
      const cls = [
        isCurrentDisplay ? 'current' : '',
        isCompleted ? 'completed' : '',
        isProgressCurrent && !isCurrentDisplay ? 'progress-current' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const label = slug.replace(/^\d+-/, '').replace(/-/g, ' ');
      const summary = _lessonDetails[slug];
      const pct = lessonProgressPct(slug, summary, isCompleted);
      const bar = pct !== null
        ? `<span class="lesson-progress" title="${pct}% read"><span class="lesson-progress-fill" style="width:${pct}%"></span></span>`
        : '';
      return `<li><a href="#" data-action="pick-lesson" data-slug="${escapeHtml(slug)}" class="${cls}" title="${escapeHtml(slug)}">
        <span class="lesson-label">${escapeHtml(label)}</span>
        ${bar}
      </a></li>`;
    })
    .join('');
}

function lessonProgressPct(slug, summary, isCompleted) {
  if (isCompleted) return 100;
  if (!summary) return null;
  const totalAsk = summary.ask_total || 0;
  const totalEx = summary.exercises || 0;
  const totalUnits = totalAsk + totalEx;
  if (totalUnits === 0) return null;
  const doneAsk = summary.ask_answered || 0;
  const doneEx = summary.feedbacks || 0;
  return Math.min(100, Math.round(((doneAsk + doneEx) / totalUnits) * 100));
}

// Render a short string of markdown (math + inline formatting) into HTML
// suitable for chrome / chip / quote contexts — strips the duplicate
// katex-mathml clones so textContent stays readable.
function renderInlineChrome(src) {
  if (!src) return '';
  const html = md.renderInline(String(src), {});
  const tmp = document.createElement('span');
  tmp.innerHTML = html;
  tmp.querySelectorAll('.katex-mathml').forEach((n) => n.remove());
  return tmp.innerHTML;
}

// Merge each .sg-question (q + deeper) with its adjacent answer block into
// a single <details> so the question itself is the toggle: click to expand
// the answer inline, click again to collapse. Previously these rendered as
// two separate stacked rectangles (question + folded details / Ask card),
// which felt redundant — same text twice.
//
//   .sg-question.btw  + <details><summary>deeper</summary>BODY</details>
//     → <details class="sg-question btw"><summary>QUESTION</summary>BODY</details>
//
//   .sg-question.q    + .sg-answer.pending OR .sg-answer.answered
//     → <details class="sg-question q"><summary>QUESTION</summary>{Ask | answer}</details>
function mergeQuestionBlocks(root) {
  if (!root) return;
  const dryLabels = new Set(['btw', 'deeper', 'btw — saved chat']);

  // Find the next "meaningful" element sibling, skipping markdown-it's empty
  // text wrappers (whitespace-only paragraphs).
  function nextEl(node) {
    let n = node.nextElementSibling;
    while (n && n.children.length === 0 && !(n.textContent || '').trim()) {
      n = n.nextElementSibling;
    }
    return n;
  }

  function buildMerged(q, bodyNodes, openByDefault) {
    const merged = document.createElement('details');
    merged.className = q.className;
    for (const k of Object.keys(q.dataset)) merged.dataset[k] = q.dataset[k];
    if (openByDefault) merged.open = true;
    const summaryEl = document.createElement('summary');
    summaryEl.innerHTML = q.innerHTML;
    merged.appendChild(summaryEl);
    if (bodyNodes && bodyNodes.length) {
      const body = document.createElement('div');
      body.className = 'sg-question-body';
      for (const n of bodyNodes) body.appendChild(n);
      merged.appendChild(body);
    }
    return merged;
  }

  // Deeper / btw blocks paired with a follow-up <details><summary>deeper</summary>
  for (const q of [...root.querySelectorAll('.sg-question.btw')]) {
    const sibling = nextEl(q);
    let bodyNodes = null;
    if (sibling && sibling.tagName === 'DETAILS') {
      const summary = sibling.querySelector(':scope > summary');
      const label = (summary?.textContent || '').trim().toLowerCase();
      if (dryLabels.has(label)) {
        bodyNodes = [...sibling.childNodes].filter(
          (n) => !(n.nodeType === 1 && n.tagName === 'SUMMARY'),
        );
        sibling.remove();
      }
    }
    // Default state: collapsed (user has to click to dig deeper).
    q.replaceWith(buildMerged(q, bodyNodes, false));
  }

  // Q blocks paired with .sg-answer (pending Ask button OR answered body).
  // The markdown rule emits data-kind="main" for `?>` questions — match
  // that explicitly so we don't accidentally re-process the .btw blocks
  // already merged above.
  //
  // Both pending and answered Qs default to COLLAPSED, mirroring the
  // deeper callout. The learner pauses, takes a guess, then clicks the
  // summary to reveal. Answers are pre-written in modern lessons; the
  // legacy `<!-- answer:pending -->` shape still works for old files
  // (the Ask button shows up inside the body when expanded).
  for (const q of [...root.querySelectorAll('.sg-question:not(.btw)')]) {
    const sibling = nextEl(q);
    if (!sibling || !sibling.classList.contains('sg-answer')) continue;
    q.replaceWith(buildMerged(q, [sibling], /* open */ false));
  }

  // Defensive fix-up for LLM-malformed details: when the `learn` / `next`
  // skill collapses the spec's two-block shape into a single
  //   <details><summary>?> question text</summary>body</details>
  // (or `?>>`), the marker leaks into the summary verbatim. Detect that
  // here and rewrite into the proper merged .sg-question shape so the
  // rendered lesson still looks right.
  const markerRe = /^\s*(\?>{1,2})\s+(.+)$/s;
  for (const det of [...root.querySelectorAll('details:not(.sg-question)')]) {
    const summary = det.querySelector(':scope > summary');
    if (!summary) continue;
    // Reconstruct the summary's markdown source so $math$ round-trips:
    // drop the duplicate katex-mathml clone, swap each .sg-math span back
    // to `$<latex>$`. textContent alone would give the doubled visible
    // KaTeX layout ("dk\sqrt{d_k}dk").
    const clone = summary.cloneNode(true);
    clone.querySelectorAll('.katex-mathml').forEach((n) => n.remove());
    clone.querySelectorAll('.sg-math').forEach((el) => {
      const latex = el.getAttribute('data-latex') || '';
      const isBlock = el.classList.contains('sg-math-block');
      el.replaceWith(document.createTextNode(isBlock ? `$$${latex}$$` : `$${latex}$`));
    });
    const source = (clone.textContent || '').trim();
    const m = source.match(markerRe);
    if (!m) continue;
    const kind = m[1] === '?>' ? 'main' : 'btw';
    const questionText = m[2].trim();
    if (!questionText) continue;
    const fakeQ = document.createElement('div');
    fakeQ.className = `sg-question ${kind === 'btw' ? 'btw' : ''}`.trim();
    fakeQ.dataset.kind = kind;
    fakeQ.dataset.source = questionText;
    const label = kind === 'btw' ? 'deeper' : 'q';
    fakeQ.innerHTML =
      `<span class="sg-q-label">${label}</span>` +
      `<span class="sg-q-text">${md.renderInline(questionText, {})}</span>`;
    const bodyNodes = [...det.childNodes].filter(
      (n) => !(n.nodeType === 1 && n.tagName === 'SUMMARY'),
    );
    // Default: deeper (btw) collapsed, q open (the answer is right there).
    // Same rule as the primary merge above: both Q and deeper default
    // to collapsed; the only thing that overrides is an explicit
    // `<details open>` in the source markdown.
    det.replaceWith(buildMerged(fakeQ, bodyNodes, !!det.open));
  }
}

// Markdown tables sit directly in the prose; wrap each in .sg-table-wrap
// so wide tables scroll horizontally without breaking the natural cell
// layout (the old `display: block` on <table> killed border rendering).
function wrapTables(root) {
  if (!root) return;
  for (const t of root.querySelectorAll('main table, table')) {
    if (t.parentElement?.classList.contains('sg-table-wrap')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'sg-table-wrap';
    t.replaceWith(wrap);
    wrap.appendChild(t);
  }
}

// Pull each <div class="sg-feedback" data-exercise="X"> into the matching
// <div class="sg-exercise" data-name="X"> as a footer section. The two
// blocks describe the same loop (write code → run check → see feedback);
// rendering them as one card removes the visual "two siblings" effect and
// the doubled coral wash.
function mergeFeedbackIntoExercise(root) {
  if (!root) return;
  for (const fb of [...root.querySelectorAll('.sg-feedback')]) {
    const name = fb.dataset.exercise;
    if (!name) continue;
    const ex = root.querySelector(`.sg-exercise[data-name="${CSS.escape(name)}"]`);
    if (!ex) continue;
    // Strip the standalone "feedback · <code>name</code>" label — the
    // exercise header above already says which exercise this is. Inside
    // the card we just need a thinner divider + the body.
    const body = fb.querySelector(':scope > .sg-fb-body');
    if (!body) continue;
    const section = document.createElement('div');
    section.className = 'sg-ex-feedback';
    section.dataset.exercise = name;
    section.innerHTML =
      `<div class="sg-ex-feedback-label">last check</div>` +
      `<div class="sg-ex-feedback-body"></div>`;
    section.querySelector('.sg-ex-feedback-body').append(...body.childNodes);
    ex.appendChild(section);
    fb.remove();
  }
}

// Decorate every <pre> with a "Copy" button in the top-right corner.
// Click → write the code text to the clipboard, briefly flip the label.
function decorateCodeBlocks(root) {
  if (!root) return;
  for (const pre of root.querySelectorAll('pre')) {
    if (pre.querySelector(':scope > .sg-pre-copy')) continue; // already wired
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sg-pre-copy';
    btn.dataset.label = 'copy';
    btn.title = 'copy code';
    btn.setAttribute('aria-label', 'copy code');
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="9" y="9" width="11" height="11" rx="2"/>
        <path d="M5 15V6a2 2 0 0 1 2-2h9"/>
      </svg>
      <span class="sg-pre-copy-label">copy</span>`;
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      // textContent of the <code> child (or the <pre> if no <code>) is the raw
      // source — KaTeX/markdown-it-highlightjs both leave spans inside, but
      // textContent flattens them.
      const codeEl = pre.querySelector('code') || pre;
      const text = codeEl.textContent || '';
      try {
        await navigator.clipboard.writeText(text);
        flashCopy(btn, 'copied!');
      } catch {
        // Fallback: select + execCommand for older browsers / non-secure ctx
        try {
          const range = document.createRange();
          range.selectNodeContents(codeEl);
          const sel = window.getSelection();
          sel.removeAllRanges(); sel.addRange(range);
          document.execCommand('copy');
          sel.removeAllRanges();
          flashCopy(btn, 'copied!');
        } catch {
          flashCopy(btn, 'failed');
        }
      }
    });
    pre.appendChild(btn);
  }
}
function flashCopy(btn, msg) {
  const label = btn.querySelector('.sg-pre-copy-label');
  if (!label) return;
  const prev = label.textContent;
  label.textContent = msg;
  btn.classList.add('flashed');
  clearTimeout(btn._flashT);
  btn._flashT = setTimeout(() => {
    label.textContent = prev;
    btn.classList.remove('flashed');
  }, 1100);
}

function buildOutline() {
  sidebarOutline.innerHTML = '';
  const headings = view.querySelectorAll('h2, h3');
  if (!headings.length) {
    sidebarOutline.innerHTML = '<li class="hint">(no sections)</li>';
    return;
  }
  let i = 0;
  const items = [];
  for (const h of headings) {
    i++;
    const id = `sg-h-${i}`;
    h.id = id;
    // Clone the heading, strip duplicated katex-mathml (visible + a11y copies
    // both end up in textContent → unreadable). What's left is the rendered
    // KaTeX HTML — drop straight into the outline so math renders.
    const clone = h.cloneNode(true);
    clone.querySelectorAll('.katex-mathml').forEach((n) => n.remove());
    // Also strip the section's own ¶/btw buttons if any leaked in via markdown
    clone.querySelectorAll('.sg-q-dig, .ask-btn').forEach((n) => n.remove());
    items.push({ level: h.tagName, html: clone.innerHTML.trim(), text: clone.textContent.trim(), id });
  }
  sidebarOutline.innerHTML = items
    .map(
      (it) =>
        `<li class="outline-li">
          <a href="#${it.id}" data-action="jump-section" data-id="${it.id}" class="outline-${it.level === 'H2' ? 2 : 3}" title="${escapeHtml(it.text)}">${it.html}</a>
          <button class="outline-btw" data-action="btw-outline" data-id="${it.id}" title="btw — chat about this section">btw</button>
        </li>`,
    )
    .join('');
  setupSectionObserver(items);
}

async function loadMaterials(track, listEl, emptyText) {
  // Backwards-compat: zero-arg call from old call-sites uses sidebar + currentTrack
  if (track === undefined && listEl === undefined) {
    track = currentTrack;
    listEl = document.getElementById('sidebar-materials');
    emptyText = 'drop in PDFs/notes →';
  }
  if (!listEl) return;
  if (!track) {
    listEl.innerHTML = '<li class="hint">(pick a course)</li>';
    return;
  }
  try {
    const r = await fetch(`/api/tracks/${encodeURIComponent(track)}/materials`).then((r) => r.json());
    const mats = r.materials || [];
    if (!mats.length) {
      listEl.innerHTML = `<li class="hint">${escapeHtml(emptyText || 'drop in PDFs/notes →')}</li>`;
      return;
    }
    listEl.innerHTML = mats
      .map((m) => {
        const sizeKb = m.size < 1024 ? `${m.size}B` : `${(m.size / 1024).toFixed(1)}K`;
        const status = m.status || 'pending';
        // status drives the dot color in CSS; stats line is human-readable.
        const statsBits = [];
        if (m.pages && m.pages > 1) statsBits.push(`${m.pages}pp`);
        if (m.approx_tokens) {
          statsBits.push(m.approx_tokens >= 1000
            ? `~${(m.approx_tokens / 1000).toFixed(m.approx_tokens >= 10000 ? 0 : 1)}k tok`
            : `~${m.approx_tokens} tok`);
        }
        const stats = statsBits.length ? statsBits.join(' · ') : sizeKb;
        const tooltip = [
          m.name,
          `Size: ${sizeKb}`,
          m.pages ? `Pages: ${m.pages}` : null,
          m.approx_tokens ? `≈ ${m.approx_tokens} tokens` : null,
          m.chunks ? `Chunks: ${m.chunks}` : null,
          `Status: ${status}`,
          m.indexed_at ? `Indexed: ${new Date(m.indexed_at).toLocaleString()}` : null,
        ].filter(Boolean).join('\n');
        return `<li><div class="material-item" data-status="${escapeHtml(status)}" data-action="open-material" data-name="${escapeHtml(m.name)}" data-track="${escapeHtml(track)}" role="button" tabindex="0" title="${escapeHtml(tooltip)}">
          <span class="material-dot" title="${escapeHtml(status)}"></span>
          <span class="material-name">${escapeHtml(m.name)}</span>
          <span class="material-size">${escapeHtml(stats)}</span>
          <button class="material-del" data-action="delete-material" data-name="${escapeHtml(m.name)}" data-track="${escapeHtml(track)}" title="delete" aria-label="delete">×</button>
        </div></li>`;
      })
      .join('');
    try { materialViewer?.refreshSidebar?.(); } catch {}
  } catch {}
}

async function uploadMaterial(track, file) {
  // Backwards-compat: old single-arg call
  if (file === undefined && (track instanceof File || track instanceof Blob)) {
    file = track;
    track = currentTrack;
  }
  if (!track || !file) return;
  setStatus(`uploading ${file.name}…`);
  try {
    const buf = await file.arrayBuffer();
    const url = `/api/tracks/${encodeURIComponent(track)}/materials?name=${encodeURIComponent(file.name)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buf,
    }).then((r) => r.json());
    if (!r.ok) throw new Error(r.error || 'upload failed');
    setStatus(r.renamed
      ? `uploaded as ${r.name} (auto-renamed to avoid overwriting an existing file)`
      : `uploaded ${r.name}`);
    // Refresh whichever list is visible for this track
    if (track === currentTrack) loadMaterials();
    if (track === intakeTrack) {
      loadMaterials(intakeTrack, document.getElementById('intake-materials-list'), 'drop in PDFs / notes / cheatsheets — your tutor will see them');
    }
  } catch (e) {
    setStatus('upload error: ' + e.message);
  }
}

async function deleteMaterial(track, name) {
  if (!track || !name) return;
  if (!confirm(`Delete material "${name}"?`)) return;
  try {
    const r = await fetch(`/api/tracks/${encodeURIComponent(track)}/materials/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) => r.json());
    if (!r.ok) throw new Error(r.error || 'delete failed');
    setStatus(`deleted ${name}`);
    if (track === currentTrack) loadMaterials();
    if (track === intakeTrack) {
      loadMaterials(intakeTrack, document.getElementById('intake-materials-list'), 'drop in PDFs / notes / cheatsheets — your tutor will see them');
    }
  } catch (e) {
    setStatus('delete error: ' + e.message);
  }
}

// ---------- material viewer (inline PDF / text preview) ----------
const materialViewer = (() => {
  const root = document.getElementById('material-viewer');
  const nameEl = document.getElementById('material-viewer-name');
  const bodyEl = document.getElementById('material-viewer-body');
  const openLink = document.getElementById('material-viewer-open');
  const resizeEl = document.getElementById('material-viewer-resize');
  let appEl = null; // resolved lazily — view may not be mounted at script-load.
  let state = { track: null, name: null, page: null };

  // Persist width across page loads. Clamp to a sane range.
  const STORE_KEY = 'sg.materialWidth';
  // During drag we update the CSS variable on every pointermove (cheap) but
  // skip the localStorage write + outline-layout recomputation — both are
  // synchronous DOM/storage work that turns a smooth drag into a stutter.
  // commitWidth() flushes the slow path on pointerup.
  let _lastWidth = 420;
  function setWidth(w, opts = {}) {
    const clamped = Math.max(280, Math.min(900, Math.round(w)));
    _lastWidth = clamped;
    document.documentElement.style.setProperty('--sg-material-width', clamped + 'px');
    if (!opts.transient) commitWidth();
  }
  function commitWidth() {
    try { localStorage.setItem(STORE_KEY, String(_lastWidth)); } catch {}
    try { updateOutlineLayout?.(); } catch {}
  }
  function loadWidth() {
    let v;
    try { v = parseInt(localStorage.getItem(STORE_KEY) || '', 10); } catch {}
    // Always seed the custom property so getComputedStyle() returns a value
    // even before the user has resized. Without this the JS read returns ''
    // and resize math breaks.
    setWidth(Number.isFinite(v) ? v : 420);
  }
  loadWidth();

  function getApp() {
    // The reader view's .app may not exist on initial home/intake routes.
    if (appEl && document.contains(appEl)) return appEl;
    appEl = document.querySelector('#view-reader .app');
    return appEl;
  }

  function isText(name)  { return /\.(md|txt|json|js|py|css|html|csv)$/i.test(name); }
  function isPdf(name)   { return /\.pdf$/i.test(name); }
  function isImage(name) { return /\.(png|jpe?g|gif|webp|svg)$/i.test(name); }
  function isMd(name)    { return /\.md$/i.test(name); }

  function urlFor(track, name, page) {
    const base = `/api/tracks/${encodeURIComponent(track)}/materials/${encodeURIComponent(name)}`;
    return page ? `${base}#page=${encodeURIComponent(String(page).split(/[-–—]/)[0])}` : base;
  }

  function syncSidebarActive() {
    const list = document.getElementById('sidebar-materials');
    if (!list) return;
    for (const item of list.querySelectorAll('.material-item')) {
      const match = state.name &&
        item.dataset.name === state.name &&
        item.dataset.track === state.track;
      item.classList.toggle('is-open', !!match);
    }
  }

  async function render() {
    bodyEl.innerHTML = '<div class="material-loading">loading…</div>';
    const { track, name, page } = state;
    const url = urlFor(track, name, page);
    openLink.href = url;

    if (isPdf(name)) {
      bodyEl.innerHTML = `<iframe src="${escapeHtml(url)}" title="${escapeHtml(name)}"></iframe>`;
      return;
    }
    if (isImage(name)) {
      bodyEl.innerHTML = `<img class="material-preview" src="${escapeHtml(url)}" alt="${escapeHtml(name)}">`;
      return;
    }
    if (isText(name)) {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const text = await r.text();
        // Guard against a race: another open() may have started while we awaited.
        if (state.track !== track || state.name !== name) return;
        if (isMd(name)) {
          bodyEl.innerHTML = `<div class="material-md">${md.render(text, {})}</div>`;
        } else {
          bodyEl.innerHTML = `<pre class="material-text">${escapeHtml(text)}</pre>`;
        }
      } catch (e) {
        bodyEl.innerHTML = `<div class="material-error">failed to load: ${escapeHtml(e.message || String(e))}</div>`;
      }
      return;
    }
    bodyEl.innerHTML =
      `<div class="material-unsupported">Preview not available for this file type.` +
      `<br><a href="${escapeHtml(url)}" target="_blank" rel="noopener">Open / download ↗</a></div>`;
  }

  // Below this width the third column is hidden via CSS (the prose would
  // get crushed). Falling back to a new tab is less confusing than
  // toggling state that doesn't show up on screen.
  const NARROW_PX = 1100;
  function isNarrow() { return window.innerWidth <= NARROW_PX; }

  function open(track, name, opts = {}) {
    if (!track || !name) return;
    if (isNarrow()) {
      const url = urlFor(track, name, opts.page);
      window.open(url, '_blank', 'noopener');
      return;
    }
    const app = getApp();
    if (!app) return;
    const samePdfDifferentPage =
      state.track === track &&
      state.name === name &&
      isPdf(name) &&
      (opts.page || null) !== state.page;
    state = { track, name, page: opts.page || null };
    nameEl.textContent = name;
    nameEl.title = name + (state.page ? ` · p.${state.page}` : '');
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    app.classList.add('material-open');
    syncSidebarActive();
    try { updateOutlineLayout?.(); } catch {}
    // Move the .is-active highlight to the chip that triggered this open
    // *before* the same-PDF-page-swap early return — otherwise hash-only
    // updates leave the previous chip glowing.
    flashActiveCite(opts.source || null);
    // For PDFs, if just the page changed, swap the iframe hash so the
    // viewer scrolls without a hard reload when possible.
    if (samePdfDifferentPage) {
      const iframe = bodyEl.querySelector('iframe');
      if (iframe) {
        iframe.src = urlFor(track, name, state.page);
        openLink.href = iframe.src;
        return;
      }
    }
    render();
  }

  function close() {
    const app = getApp();
    state = { track: null, name: null, page: null };
    if (app) app.classList.remove('material-open');
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    bodyEl.innerHTML = '';
    nameEl.textContent = '';
    syncSidebarActive();
    clearActiveCite();
    try { updateOutlineLayout?.(); } catch {}
  }

  function toggle(track, name) {
    if (state.track === track && state.name === name && !root.hidden) {
      close();
    } else {
      open(track, name);
    }
  }

  // Brief glow on the citation that triggered the open, so the user knows
  // which chip is currently driving the viewer.
  function flashActiveCite(node) {
    clearActiveCite();
    if (node && node.classList) node.classList.add('is-active');
  }
  function clearActiveCite() {
    document.querySelectorAll('.sg-cite.is-active').forEach((n) => n.classList.remove('is-active'));
  }

  // Drag-resize. The handle sits on the viewer's right edge; dragging
  // changes --sg-material-width which the grid template reads. We
  // coalesce moves with rAF — pointermove fires faster than the screen
  // refreshes and CSS-var writes that don't paint are wasted work.
  let dragStartX = 0;
  let dragStartW = 0;
  let dragPendingX = 0;
  let dragRaf = 0;
  function applyDrag() {
    dragRaf = 0;
    setWidth(dragStartW + (dragPendingX - dragStartX), { transient: true });
  }
  function onDragMove(ev) {
    dragPendingX = ev.clientX;
    if (!dragRaf) dragRaf = requestAnimationFrame(applyDrag);
  }
  function onDragEnd() {
    document.removeEventListener('pointermove', onDragMove);
    document.removeEventListener('pointerup', onDragEnd);
    if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = 0; applyDrag(); }
    commitWidth();
    const app = getApp();
    if (app) app.classList.remove('material-dragging');
    resizeEl.classList.remove('dragging');
  }
  resizeEl.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    dragStartX = ev.clientX;
    dragPendingX = ev.clientX;
    const cs = getComputedStyle(document.documentElement).getPropertyValue('--sg-material-width');
    dragStartW = parseInt(cs, 10) || root.getBoundingClientRect().width || 420;
    const app = getApp();
    if (app) app.classList.add('material-dragging');
    resizeEl.classList.add('dragging');
    // Capture pointer so we keep getting move events even when the cursor
    // briefly enters the iframe / sidebar during a fast drag.
    try { resizeEl.setPointerCapture(ev.pointerId); } catch {}
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', onDragEnd);
  });
  // Keyboard resize (Left/Right when handle is focused).
  resizeEl.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    ev.preventDefault();
    const cs = getComputedStyle(document.documentElement).getPropertyValue('--sg-material-width');
    const w = parseInt(cs, 10) || 420;
    setWidth(w + (ev.key === 'ArrowRight' ? 16 : -16));
  });

  // If the user drags the browser below the narrow breakpoint while the
  // viewer is open, the CSS hides the column but JS state (and the sidebar
  // highlight) would otherwise lie about what's visible. Close it.
  window.addEventListener('resize', () => {
    if (!root.hidden && isNarrow()) close();
  });

  // Close with Esc when viewer is the focused/active region.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (root.hidden) return;
    // Don't steal Esc from chat panels / modals — only close if the user
    // clicked into the viewer or there's no other obvious modal target.
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return;
    if (root.contains(document.activeElement) || ev.target === document.body) {
      close();
    }
  });

  return {
    open,
    close,
    toggle,
    refreshSidebar: syncSidebarActive,
    get state() { return { ...state }; },
  };
})();
const materialFileInput = document.createElement('input');
materialFileInput.type = 'file';
materialFileInput.multiple = true;
materialFileInput.style.display = 'none';
materialFileInput.addEventListener('change', async (ev) => {
  const target = materialFileInput.dataset.track || currentTrack;
  for (const f of ev.target.files) await uploadMaterial(target, f);
  ev.target.value = '';
  delete materialFileInput.dataset.track;
});
document.body.appendChild(materialFileInput);

document.addEventListener('click', (ev) => {
  const node = ev.target.closest('[data-action]');
  if (!node) return;
  const action = node.dataset.action;
  if (action === 'add-material') {
    ev.preventDefault();
    materialFileInput.dataset.track = currentTrack || '';
    materialFileInput.click();
  } else if (action === 'add-intake-material') {
    ev.preventDefault();
    materialFileInput.dataset.track = intakeTrack || '';
    materialFileInput.click();
  } else if (action === 'delete-material') {
    ev.preventDefault();
    ev.stopPropagation();
    deleteMaterial(node.dataset.track || currentTrack, node.dataset.name);
  } else if (action === 'open-material') {
    ev.preventDefault();
    materialViewer.toggle(node.dataset.track || currentTrack, node.dataset.name);
  } else if (action === 'close-material') {
    ev.preventDefault();
    materialViewer.close();
  } else if (action === 'open-cite') {
    ev.preventDefault();
    const file = node.dataset.file;
    const page = node.dataset.page || null;
    materialViewer.open(currentTrack, file, { page, source: node });
  }
});

// Keyboard support for the material rows (Enter/Space). Only fire when the
// row itself is the keydown target — pressing Space on a nested button
// (e.g. the × delete) has its own native click semantics and must not also
// trigger toggle on the parent row.
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  const node = ev.target;
  if (!(node instanceof HTMLElement)) return;
  if (node.dataset?.action !== 'open-material') return;
  ev.preventDefault();
  materialViewer.toggle(node.dataset.track || currentTrack, node.dataset.name);
});

async function loadThreads() {
  if (!sidebarThreads) return;
  if (!currentSlug) {
    sidebarThreads.innerHTML = '<li class="hint">(pick a lesson)</li>';
    return;
  }
  try {
    const r = await fetch(
      '/api/threads?lesson=' + encodeURIComponent(currentSlug)
      + (currentTrack ? '&track=' + encodeURIComponent(currentTrack) : ''),
    ).then((r) => r.json());
    const threads = r.threads || [];
    if (!threads.length) {
      sidebarThreads.innerHTML = '<li class="hint">(no chats yet)</li>';
      return;
    }
    sidebarThreads.innerHTML = threads
      .map((t) => {
        // Use the user-set name if any, otherwise fall back to the first
        // question (the prior default).
        const label = (t.name || t.first_question || t.selection || '').slice(0, 60);
        const ago = relTime(t.updated_at);
        return `<li class="thread-li" data-id="${escapeHtml(t.id)}">
          <button class="thread-item" data-action="open-thread" data-id="${escapeHtml(t.id)}" title="${escapeHtml(t.selection || '')}">
            <span class="thread-preview" data-label="${escapeHtml(label)}">${escapeHtml(label)}</span>
            <span class="thread-meta">${t.turns}T · ${ago}</span>
          </button>
          <div class="thread-actions">
            <button class="thread-act" data-action="rename-thread" data-id="${escapeHtml(t.id)}" data-current="${escapeHtml(t.name || '')}" title="rename" aria-label="rename">✎</button>
            <button class="thread-act" data-action="download-thread" data-id="${escapeHtml(t.id)}" title="download .md" aria-label="download">⬇</button>
            <button class="thread-act" data-action="delete-thread" data-id="${escapeHtml(t.id)}" title="delete" aria-label="delete">×</button>
          </div>
        </li>`;
      })
      .join('');
  } catch {}
}

// Swap the thread's label into an inline <input> so the user can rename
// it. Enter saves, Esc cancels, click-away saves whatever was typed.
function startThreadRename(triggerBtn) {
  const id = triggerBtn.dataset.id;
  const li = triggerBtn.closest('.thread-li');
  if (!li) return;
  const labelEl = li.querySelector('.thread-preview');
  if (!labelEl || li.classList.contains('renaming')) return;
  const original = labelEl.textContent;
  const current = triggerBtn.dataset.current || '';
  li.classList.add('renaming');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'thread-rename-input';
  input.value = current || original;
  input.placeholder = 'thread name';
  input.maxLength = 120;
  labelEl.replaceWith(input);
  input.focus();
  input.select();
  let settled = false;
  const restore = (text) => {
    if (settled) return; settled = true;
    li.classList.remove('renaming');
    const span = document.createElement('span');
    span.className = 'thread-preview';
    span.textContent = text;
    input.replaceWith(span);
  };
  const save = async () => {
    if (settled) return;
    const newName = input.value.trim();
    if (newName === current) { restore(original); return; }
    settled = true;
    li.classList.remove('renaming');
    // Optimistic: swap text first, refresh from server in background
    const span = document.createElement('span');
    span.className = 'thread-preview';
    span.textContent = newName || original;
    input.replaceWith(span);
    try {
      const r = await fetch('/api/thread/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      }).then((r) => r.json());
      if (!r.ok) throw new Error(r.error || 'rename failed');
      setStatus(newName ? `renamed thread → "${newName}"` : 'thread name cleared');
      loadThreads();
    } catch (e) {
      setStatus('rename failed: ' + e.message);
      loadThreads();
    }
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); save(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); restore(original); }
    ev.stopPropagation();
  });
  // Stop click/mousedown from bubbling up to the parent .thread-item button
  // (which would otherwise open the thread the moment the user clicked into
  // the input).
  for (const ev of ['click', 'mousedown', 'pointerdown']) {
    input.addEventListener(ev, (e) => e.stopPropagation());
  }
  input.addEventListener('blur', save);
}

function relTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

async function openThreadById(id) {
  const r = await fetch('/api/thread/' + encodeURIComponent(id)).then((r) => r.json());
  if (!r.ok || !r.thread) {
    setStatus('thread not found');
    return;
  }
  if (r.thread.lesson !== currentSlug) {
    await loadLesson(r.thread.lesson);
  }
  openChatPanel(r.thread.selection, r.thread);
  // Wait for next paint so the lesson DOM is settled, then highlight
  requestAnimationFrame(() => {
    setTimeout(() => highlightSelectionInLesson(r.thread.selection), 80);
  });
}

function highlightSelectionInLesson(text) {
  if (!text) return;
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const target = norm(text).slice(0, 80);
  if (!target) return;
  // Pick text-bearing elements where we'd find the original selection
  const candidates = view.querySelectorAll(
    'p, li, h1, h2, h3, blockquote, .sg-q-text, .sg-answer.answered, details, pre, .sg-ex-body',
  );
  let best = null;
  for (const c of candidates) {
    if (norm(c.textContent).includes(target.slice(0, 50))) { best = c; break; }
  }
  if (!best) return;
  best.classList.add('sg-flash');
  best.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => best.classList.add('sg-flash-out'), 1700);
  setTimeout(() => best.classList.remove('sg-flash', 'sg-flash-out'), 3400);
}

function extractSectionText(heading) {
  if (!heading) return '';
  const startLevel = heading.tagName === 'H2' ? 2 : 3;
  const parts = [heading.textContent.trim()];
  let sib = heading.nextElementSibling;
  while (sib) {
    const tag = sib.tagName;
    if (tag === 'H2') break;
    if (tag === 'H3' && startLevel === 3) break;
    const txt = sib.textContent?.trim();
    if (txt) parts.push(txt);
    sib = sib.nextElementSibling;
  }
  // Cap to ~1500 chars so the prompt doesn't blow up; users can paraphrase further in chat
  let joined = parts.join('\n\n');
  if (joined.length > 1500) joined = joined.slice(0, 1500) + '…';
  return joined;
}

// Classic scrollspy: on every scroll/resize, find the heading whose top is
// closest to but still above an offset (~80px below the sticky header), and
// mark its outline link active. IntersectionObserver was brittle here — when
// the user stopped between two headings or scrolled fast, no entry was
// "intersecting" within the narrow threshold band and the active link froze.
let _scrollSpyState = null;
function setupSectionObserver(items) {
  // Disconnect any previous listeners.
  if (_scrollSpyState) {
    window.removeEventListener('scroll', _scrollSpyState.onScroll, { passive: true });
    window.removeEventListener('resize', _scrollSpyState.onScroll);
  }
  if (!items.length) { _scrollSpyState = null; return; }
  const headings = items
    .map((it) => document.getElementById(it.id))
    .filter(Boolean);
  if (!headings.length) { _scrollSpyState = null; return; }
  const OFFSET = 100; // distance from viewport top below which a heading counts as "passed"
  let raf = 0;
  let lastActive = null;
  const tick = () => {
    raf = 0;
    let active = headings[0].id;
    for (const h of headings) {
      const top = h.getBoundingClientRect().top;
      if (top <= OFFSET) active = h.id; else break;
    }
    // Edge case: if user has scrolled to the very bottom, force the last
    // heading to be active (otherwise long final sections never highlight).
    const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
    if (nearBottom) active = headings[headings.length - 1].id;
    if (active !== lastActive) {
      lastActive = active;
      markOutlineActive(active);
    }
  };
  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(tick);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  _scrollSpyState = { onScroll };
  tick(); // initial paint
}

function markOutlineActive(id) {
  for (const a of sidebarOutline.querySelectorAll('a')) {
    a.classList.toggle('active', a.dataset.id === id);
  }
}

async function loadLesson(slug) {
  if (!slug) {
    view.innerHTML = '<p class="hint">Pick a lesson.</p>';
    currentSlug = '';
    lessonTitleBar.textContent = '';
    sidebarOutline.innerHTML = '<li class="hint">pick a lesson →</li>';
    renderSidebarLessons();
    return;
  }
  const r = await fetch(
    '/api/lesson/' + encodeURIComponent(slug) +
    (currentTrack ? '?track=' + encodeURIComponent(currentTrack) : ''),
  ).then((r) => r.json());
  if (!r.ok) {
    view.innerHTML = `<p class="hint">Lesson not found: ${slug}</p>`;
    return;
  }
  currentSlug = slug;
  const { meta, body } = stripFrontmatter(r.content);
  const titleBlock = meta.title
    ? `<div class="lesson-meta">${escapeHtml(meta.track || '')} · ${escapeHtml(meta.estimated_minutes || '?')} min</div>`
    : '';
  view.innerHTML = titleBlock + md.render(body, {});
  decorateCodeBlocks(view);
  mergeQuestionBlocks(view);
  mergeFeedbackIntoExercise(view);
  wrapTables(view);
  // Title bar may contain $math$ from the frontmatter. Render it via md (inline
  // grammar so no <p> wrapper), then strip the duplicated katex-mathml clone.
  const titleSrc = meta.title || slug;
  const renderedTitle = (md.renderInline || md.render).call(md, String(titleSrc), {});
  const tmp = document.createElement('span');
  tmp.innerHTML = renderedTitle;
  tmp.querySelectorAll('.katex-mathml').forEach((n) => n.remove());
  lessonTitleBar.innerHTML = tmp.innerHTML;
  buildOutline();
  renderSidebarLessons();
  loadThreads();
  loadMaterials();
  for (const idx of inflightAsks) {
    const block = view.querySelector(`.sg-answer.pending[data-index="${idx}"]`);
    if (block) {
      block.classList.add('thinking');
      const btn = block.querySelector('.ask-btn');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'thinking…';
      }
    }
  }
  ensurePyodideIfNeeded();
  // Reset scroll to top of new lesson
  window.scrollTo({ top: 0 });
}

// ---------- Pyodide ----------
let _pyodide = null;
let _pyodideLoading = null;
function ensurePyodideIfNeeded() {
  if (!view.querySelector('.sg-runnable[data-lang="python"]')) return;
  if (_pyodide) {
    enableRunButtons();
    return;
  }
  if (_pyodideLoading) return _pyodideLoading;
  setStatus('loading Python (Pyodide, ~10MB first time)…');
  _pyodideLoading = (async () => {
    try {
      const mod = await import('https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.mjs');
      _pyodide = await mod.loadPyodide({
        indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/',
      });
      await _pyodide.loadPackage(['numpy']);
      setStatus('Python ready (numpy loaded)');
      enableRunButtons();
    } catch (e) {
      setStatus('Pyodide failed to load: ' + e.message);
      _pyodideLoading = null;
    }
  })();
  return _pyodideLoading;
}
function enableRunButtons() {
  for (const btn of view.querySelectorAll('.sg-run-btn')) {
    btn.disabled = false;
    btn.removeAttribute('title');
  }
}

async function onRunCell(btn) {
  const cell = btn.closest('.sg-runnable');
  if (!cell) return;
  const code = cell.querySelector('pre > code')?.textContent || '';
  const output = cell.querySelector('.sg-run-output');
  if (!_pyodide) {
    output.textContent = 'Python still loading…';
    output.hidden = false;
    output.classList.remove('error');
    await ensurePyodideIfNeeded();
    if (!_pyodide) return;
  }
  output.hidden = false;
  output.textContent = '';
  output.classList.remove('error');
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'running…';
  let buf = '';
  _pyodide.setStdout({ batched: (s) => { buf += s + '\n'; } });
  _pyodide.setStderr({ batched: (s) => { buf += '[stderr] ' + s + '\n'; } });
  try {
    const result = await _pyodide.runPythonAsync(code);
    if (result !== undefined && result !== null) {
      const repr = String(result);
      if (!buf.trimEnd().endsWith(repr)) buf += '→ ' + repr + '\n';
    }
    output.textContent = buf.trimEnd() || '(no output)';
  } catch (e) {
    output.textContent = String(e?.message || e);
    output.classList.add('error');
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

// ---------- Event delegation: ask button, exercise open ----------
view.addEventListener('click', async (ev) => {
  const action = ev.target?.dataset?.action;
  if (action === 'ask') return onAskClick(ev.target);
  if (action === 'open-exercise') return onOpenExercise(ev.target);
  if (action === 'check-exercise') return onCheckExercise(ev.target);
  if (action === 'run-cell') return onRunCell(ev.target);
});

async function onAskClick(btn) {
  const index = Number(btn.dataset.index);
  if (!index || !currentSlug) return;
  const qBlock = view.querySelector(`.sg-question[data-index="${index}"]`);
  if (!qBlock) return;
  const kind = qBlock.dataset.kind || 'main';
  // Use the source string preserved on the block; the rendered DOM has
  // katex-mathml duplicates that would break the prompt.
  const text = qBlock.dataset.source || qBlock.querySelector('.sg-q-text')?.textContent || '';
  const ansBlock = view.querySelector(`.sg-answer.pending[data-index="${index}"]`);
  if (ansBlock) ansBlock.classList.add('thinking');
  btn.disabled = true;
  btn.textContent = 'thinking…';
  inflightAsks.add(index);
  setStatus(`asking q-${index} (${kind})…`);
  try {
    const r = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ track: currentTrack, lesson: currentSlug, index, kind, question: text }),
    }).then((r) => r.json());
    if (!r.ok) throw new Error(r.error || 'ask failed');
    setStatus(`q-${index} answered (${(r.duration_ms / 1000).toFixed(1)}s, $${r.cost_usd?.toFixed(3)})`);
    // SSE lesson-change will trigger reload — but reload here too in case SSE was missed
    await loadLesson(currentSlug);
  } catch (e) {
    setStatus('ask error: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Ask';
  } finally {
    inflightAsks.delete(index);
  }
}

async function onOpenExercise(btn) {
  const name = btn.dataset.name;
  if (!name || !currentSlug) return;
  setStatus(`scaffolding exercises/${name}/…`);
  try {
    const r = await fetch('/api/exercise/scaffold', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ track: currentTrack, lesson: currentSlug, name }),
    }).then((r) => r.json());
    if (!r.ok) throw new Error(r.error || 'scaffold failed');
    const created = r.created?.length ? ` (created: ${r.created.join(', ')})` : ' (already existed)';
    setStatus(`opening ${name}${created}`);
    // Server tried `code --reuse-window` first (reuses existing window).
    // Only fall back to the vscode:// protocol URI when that failed, since
    // the URI handler tends to open a fresh window on WSL.
    if (!r.opened_via_cli) {
      window.location.href = r.vscode_uri;
    }
  } catch (e) {
    setStatus('open error: ' + e.message);
    alert(e.message);
  }
}

async function onCheckExercise(btn) {
  const name = btn.dataset.name;
  if (!name || !currentSlug) return;
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'reviewing…';
  setStatus(`checking exercises/${name}/…`);
  try {
    const r = await fetch('/api/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ track: currentTrack, lesson: currentSlug, exercise: name, run_tests: true }),
    }).then((r) => r.json());
    if (!r.ok) throw new Error(r.error || 'check failed');
    setStatus(`reviewed (${(r.duration_ms / 1000).toFixed(1)}s, $${r.cost_usd?.toFixed(3)})`);
    await loadLesson(currentSlug);
  } catch (e) {
    setStatus('check error: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

// ---------- Header buttons ----------
// Sidebar: lesson picks + outline jumps
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('a[data-action]');
  if (!t) return;
  const action = t.dataset.action;
  if (action === 'pick-lesson') {
    ev.preventDefault();
    loadLesson(t.dataset.slug);
  } else if (action === 'jump-section') {
    ev.preventDefault();
    const el = document.getElementById(t.dataset.id);
    if (el) {
      const top = el.getBoundingClientRect().top + window.scrollY - 70;
      window.scrollTo({ top, behavior: 'smooth' });
      markOutlineActive(t.dataset.id);
    }
  }
});

// Outline btw / thread open/delete/download — buttons need a separate handler
document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'btw-outline') {
    ev.preventDefault();
    ev.stopPropagation();
    const heading = document.getElementById(btn.dataset.id);
    const sel = extractSectionText(heading);
    if (sel) openChatPanel(sel);
  } else if (action === 'open-tutor') {
    ev.preventDefault();
    ev.stopPropagation();
    openTutorPanel();
  } else if (action === 'toggle-sidebar') {
    ev.preventDefault();
    ev.stopPropagation();
    toggleSidebar();
  } else if (action === 'open-cmd-palette') {
    ev.preventDefault();
    ev.stopPropagation();
    openCmdPalette();
  } else if (action === 'toggle-section') {
    ev.preventDefault();
    ev.stopPropagation();
    toggleSidebarSection(btn);
  } else if (action === 'toggle-tutor-mode') {
    ev.preventDefault();
    ev.stopPropagation();
    if (!currentTrack) return;
    tutorPermission = tutorPermission === 'edit' ? 'read' : 'edit';
    saveTutorPermission(currentTrack, tutorPermission);
    syncTutorModeButton();
    setStatus('tutor mode: ' + (tutorPermission === 'edit' ? 'can edit' : 'read-only'));
  } else if (action === 'open-thread') {
    ev.preventDefault();
    ev.stopPropagation();
    openThreadById(btn.dataset.id);
  } else if (action === 'delete-thread') {
    ev.preventDefault();
    ev.stopPropagation();
    if (!confirm('Delete this conversation?')) return;
    try {
      const r = await fetch('/api/thread/' + encodeURIComponent(btn.dataset.id), { method: 'DELETE' }).then((r) => r.json());
      if (!r.ok) throw new Error(r.error || 'delete failed');
      // If the panel currently shows this thread, close it
      if (threadId === btn.dataset.id) closeChatPanel();
      loadThreads();
      setStatus('thread deleted');
    } catch (e) {
      setStatus('delete error: ' + e.message);
    }
  } else if (action === 'rename-thread') {
    ev.preventDefault();
    ev.stopPropagation();
    startThreadRename(btn);
  } else if (action === 'download-thread') {
    ev.preventDefault();
    ev.stopPropagation();
    try {
      const r = await fetch('/api/thread/' + encodeURIComponent(btn.dataset.id)).then((r) => r.json());
      if (!r.ok || !r.thread) throw new Error('thread not found');
      downloadThreadAsMd(r.thread);
    } catch (e) {
      setStatus('download error: ' + e.message);
    }
  } else if (action === 'copy-thread-md') {
    ev.preventDefault();
    ev.stopPropagation();
    // Nothing to copy if the conversation is empty. In tutor mode (no
    // selection / no threadId) we still copy — render as a plain Q/A
    // transcript without the "selected from" preamble.
    if (!chatHistory?.length) return;
    const md = threadToMd({
      id: threadId,
      lesson: currentSlug,
      selection: chatSelection,
      history: chatHistory,
      updated_at: new Date().toISOString(),
    });
    try {
      await navigator.clipboard.writeText(md);
      const b = chatPanel?.querySelector('[data-action="copy-thread-md"]');
      if (b) {
        const prev = b.textContent;
        b.textContent = '✓ copied';
        setTimeout(() => (b.textContent = prev), 1200);
      }
    } catch (e) {
      setStatus('copy failed: ' + e.message);
    }
  }
});

function threadToMd(thread) {
  const lines = [];
  const day = (thread.updated_at || '').slice(0, 10);
  const hasSelection = !!thread.selection;
  lines.push(`# ${hasSelection ? 'btw' : 'tutor'} chat — ${day}`);
  lines.push('');
  if (hasSelection) {
    lines.push(`> _Selected from_ \`lessons/${thread.lesson}.md\``);
    lines.push('>');
    for (const line of String(thread.selection).split('\n')) {
      lines.push('> ' + line);
    }
    lines.push('');
  } else if (thread.lesson) {
    lines.push(`> _Lesson context_ \`lessons/${thread.lesson}.md\``);
    lines.push('');
  }
  for (const m of thread.history || []) {
    if (m.role === 'user') {
      lines.push(`**Q:** ${m.content}`);
    } else {
      lines.push(m.content);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function downloadThreadAsMd(thread) {
  const md = threadToMd(thread);
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `btw-${thread.lesson || 'thread'}-${thread.id.slice(0, 8)}.md`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 100);
}

const nextProgress = document.getElementById('next-progress');
const npTitle = nextProgress.querySelector('.np-title');
const npTools = nextProgress.querySelector('.np-tools');
const npText = nextProgress.querySelector('.np-text');
nextProgress.querySelector('[data-action="np-close"]').addEventListener('click', () => {
  nextProgress.hidden = true;
});
function npReset() {
  nextProgress.classList.remove('done', 'error');
  npTitle.textContent = 'Generating lesson…';
  npTools.innerHTML = '';
  npText.textContent = '';
  nextProgress.hidden = false;
}
function npToolStart(name) {
  const pill = document.createElement('span');
  pill.className = 'np-tool pending';
  pill.textContent = name;
  pill.dataset.name = name;
  npTools.appendChild(pill);
}
function npToolDone(name) {
  // Mark the most recent pending pill with this name as done
  const pending = [...npTools.querySelectorAll('.np-tool.pending')]
    .reverse()
    .find((el) => el.dataset.name === name);
  if (pending) pending.classList.replace('pending', 'done');
}

btnNext.addEventListener('click', async () => {
  btnNext.disabled = true;
  const prev = btnNext.textContent;
  btnNext.textContent = 'writing…';
  npReset();
  setStatus('generating next lesson…');
  try {
    const resp = await fetch('/api/next', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ track: currentTrack }),
    });
    if (!resp.ok || !resp.body) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`stream open failed: ${resp.status} ${txt.slice(0, 200)}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let meta = null;
    let errMsg = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        if (!chunk.startsWith('data: ')) continue;
        let ev;
        try { ev = JSON.parse(chunk.slice(6)); } catch { continue; }
        if (ev.type === 'delta') {
          npText.textContent += ev.text;
          npText.scrollTop = npText.scrollHeight;
        } else if (ev.type === 'tool') {
          if (ev.phase === 'start') npToolStart(ev.name);
          else if (ev.phase === 'done') npToolDone(ev.name);
        } else if (ev.type === 'done') {
          meta = ev;
        } else if (ev.type === 'error') {
          errMsg = ev.error;
        }
      }
    }
    if (errMsg) throw new Error(errMsg);
    nextProgress.classList.add('done');
    npTitle.textContent = `✓ done (${(meta?.duration_ms / 1000).toFixed(1)}s, $${meta?.cost_usd?.toFixed(3)})`;
    setStatus(`generated (${(meta?.duration_ms / 1000).toFixed(1)}s, $${meta?.cost_usd?.toFixed(3)})`);
    setTimeout(() => { nextProgress.hidden = true; }, 2200);

    const lessons = await loadList();
    const newest = lessons[lessons.length - 1];
    if (newest) await loadLesson(newest);
  } catch (e) {
    nextProgress.classList.add('error');
    npTitle.textContent = '✗ ' + e.message.slice(0, 60);
    setStatus('error: ' + e.message);
  } finally {
    btnNext.disabled = false;
    btnNext.textContent = prev;
  }
});

// ---------- Selection-based btw chat panel ----------
let selToolbar = null;
let chatPanel = null;
let chatHistory = [];
let chatSelection = '';
let threadId = null;
let chatMode = 'btw'; // 'btw' | 'tutor'
let tutorPermission = 'read'; // 'read' | 'edit' — drives /api/tutor allowed-tools

// Identity of the conversation currently mounted in the chat panel — either
// `tutor:<track>` or `btw:<threadId>`. When close → re-open lands on the
// same key, skip the destructive rebuild so the user sees the existing
// transcript (and any in-flight stream keeps painting into the same DOM
// node).
let currentPanelKey = null;
// In-flight streams, keyed like currentPanelKey. When the panel is rebuilt
// for a different key (e.g., the user opens a different track's tutor),
// the previous stream keeps running in the background; coming back to its
// key re-attaches the running text to a fresh placeholder.
const inflightStreams = new Map();

function registerInflight(key, mode, userMessage, target) {
  const e = {
    key, mode,
    userMessage: userMessage || '',
    fullText: '',
    target,
    done: false,
    controller: new AbortController(),
  };
  inflightStreams.set(key, e);
  return e;
}

// Cancel an in-flight stream (Esc / Stop button). Server sees req.close
// and SIGTERMs the spawned `claude` child.
function abortInflight(key) {
  const e = inflightStreams.get(key);
  if (!e || e.done) return false;
  try { e.controller.abort(); } catch {}
  e.done = true;
  inflightStreams.delete(key);
  return true;
}

// Submit button doubles as a Stop button while a turn is streaming.
function setChatSubmitMode(form, mode) {
  if (!form) return;
  const btn = form.querySelector('button[type="submit"]');
  if (!btn) return;
  // The button has TWO SVG icons inside (.sg-chat-send-icon-send /
  // .sg-chat-send-icon-stop); CSS swaps which is visible based on
  // data-mode. Don't touch innerHTML — that would wipe the SVGs.
  btn.dataset.mode = mode;
  btn.setAttribute('aria-label', mode === 'stop' ? 'Stop' : 'Send');
  btn.title = mode === 'stop' ? 'Stop (Esc)' : 'Send (Enter)';
}

// Grow a <textarea> to fit its content up to the CSS max-height; the
// scrollbar appears once the cap is hit. Cheap inline approach beats a
// hidden mirror element for our usage.
function autosizeTextarea(ta) {
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
}

// --- input history (Up/Down through previously-typed prompts) ---
const chatInputHistory = [];   // shared by btw + tutor (same panel)
let chatInputHistoryIdx = -1;
const intakeInputHistory = [];
let intakeInputHistoryIdx = -1;

function pushChatInputHistory(text) {
  const t = (text || '').trim();
  if (!t) return;
  if (chatInputHistory[chatInputHistory.length - 1] === t) return;
  chatInputHistory.push(t);
  if (chatInputHistory.length > 80) chatInputHistory.shift();
  chatInputHistoryIdx = -1;
}
function pushIntakeInputHistory(text) {
  const t = (text || '').trim();
  if (!t) return;
  if (intakeInputHistory[intakeInputHistory.length - 1] === t) return;
  intakeInputHistory.push(t);
  if (intakeInputHistory.length > 80) intakeInputHistory.shift();
  intakeInputHistoryIdx = -1;
}
function navigateInputHistory(input, store, idxRef, dir) {
  if (!store.length) return false;
  let idx = idxRef.value;
  if (dir === 'up') {
    if (idx === -1) idx = store.length - 1;
    else if (idx > 0) idx--;
    else return true; // already at oldest — swallow the keystroke
  } else {
    if (idx === -1) return false; // nothing to step forward to
    idx++;
    if (idx >= store.length) {
      idxRef.value = -1;
      input.value = '';
      // place cursor at end
      requestAnimationFrame(() => { try { input.setSelectionRange(0, 0); } catch {} });
      return true;
    }
  }
  idxRef.value = idx;
  input.value = store[idx];
  requestAnimationFrame(() => {
    try { input.setSelectionRange(input.value.length, input.value.length); } catch {}
  });
  return true;
}

// On rebuild, if a stream is still painting for this key, append its
// in-progress text into a fresh placeholder and let the stream continue.
function reattachInflightForKey(key) {
  const e = inflightStreams.get(key);
  if (!e || e.done) return null;
  if (e.userMessage) {
    appendChatMessage('user', e.userMessage);
    chatHistory.push({ role: 'user', content: e.userMessage });
  }
  const placeholder = appendChatMessage('assistant', e.fullText ? '' : '…');
  placeholder.classList.add('streaming');
  if (e.fullText) placeholder.innerHTML = md.render(e.fullText, {});
  e.target = placeholder;
  const msgs = chatPanel.querySelector('.sg-chat-messages');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
  // Re-disable the input until the stream finishes so the user can't fire
  // a concurrent turn into the same conversation.
  const input = chatPanel.querySelector('[name="q"]');
  const btn = chatPanel.querySelector('.sg-chat-form button[type="submit"]');
  if (input) input.disabled = true;
  if (btn) btn.disabled = true;
  return e;
}

function loadTutorPermission(track) {
  try {
    return localStorage.getItem(`sg-tutor-mode:${track}`) === 'edit' ? 'edit' : 'read';
  } catch { return 'read'; }
}
function saveTutorPermission(track, mode) {
  try { localStorage.setItem(`sg-tutor-mode:${track}`, mode); } catch {}
}
function syncTutorModeButton() {
  const btn = chatPanel?.querySelector('[data-action="toggle-tutor-mode"]');
  if (!btn) return;
  btn.dataset.mode = tutorPermission;
  btn.textContent = tutorPermission === 'edit' ? '✎ can edit' : '🔒 read-only';
  btn.title = tutorPermission === 'edit'
    ? 'tutor can modify files — click to switch back to read-only'
    : 'read-only mode — click to allow tutor to edit files';
  // Only visible in tutor mode
  btn.style.display = chatMode === 'tutor' ? '' : 'none';
}

function ensureSelToolbar() {
  if (selToolbar) return selToolbar;
  selToolbar = document.createElement('div');
  selToolbar.className = 'sg-sel-toolbar';
  selToolbar.innerHTML = `<button data-action="btw-ask-selection" title="ask Claude about the highlighted passage"><span class="sg-sel-icon">✦</span><span class="sg-sel-text">ask</span></button>`;
  // pointerdown happens before any selection collapse — capture the current
  // selection text NOW and stash it on the toolbar, so the click handler has
  // it even if the browser collapses the selection between events.
  let stashed = '';
  selToolbar.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    // selectionToTextWithLatex preserves real LaTeX source for rendered math
    // instead of capturing the duplicated katex-html+mathml flattening.
    stashed = selectionToTextWithLatex(window.getSelection());
  }, true);
  selToolbar.addEventListener('click', (ev) => {
    // Use closest() so clicks on the inner <span> (icon / text) still match.
    const btn = ev.target.closest?.('[data-action="btw-ask-selection"]');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    const sel = stashed || selectionToTextWithLatex(window.getSelection());
    stashed = '';
    if (sel) openChatPanel(sel);
  });
  document.body.appendChild(selToolbar);
  return selToolbar;
}

function hideSelToolbar() {
  if (selToolbar) selToolbar.classList.remove('show');
}

// Read the current Selection as text but substitute LaTeX source for any
// rendered .sg-math nodes (KaTeX renders both katex-html + katex-mathml,
// so a naive sel.toString() doubles every formula into garbage like
// "QKTdkdkQKT" for $QK^T/\sqrt{d_k}$). Used by both the copy handler
// and the BTW ask flow so quoted passages preserve real LaTeX.
function selectionToTextWithLatex(sel) {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return '';
  const range = sel.getRangeAt(0);
  const frag = range.cloneContents();
  // Drop the accessibility mathml copy first (it duplicates the visible math).
  frag.querySelectorAll?.('.katex-mathml').forEach((n) => n.remove());
  // Replace each .sg-math span with its data-latex wrapped in $...$ / $$...$$.
  const mathNodes = frag.querySelectorAll?.('.sg-math') || [];
  for (const el of mathNodes) {
    const latex = el.getAttribute('data-latex') || '';
    const isBlock = el.classList.contains('sg-math-block');
    el.replaceWith(document.createTextNode(isBlock ? `$$${latex}$$` : `$${latex}$`));
  }
  // Use innerText (attaching off-screen) so block-level newlines stay reasonable.
  const tmp = document.createElement('div');
  tmp.style.cssText = 'position:absolute;left:-99999px;top:0;white-space:pre-wrap;';
  tmp.appendChild(frag);
  document.body.appendChild(tmp);
  const text = tmp.innerText;
  tmp.remove();
  return text.trim();
}

// Substitute LaTeX source on copy when selection contains rendered math.
document.addEventListener('copy', (ev) => {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  // Only intercept when the selection is inside a lesson view / chat / intake
  const anchor = sel.anchorNode;
  if (!anchor) return;
  const inMath =
    (view && view.contains(anchor)) ||
    (chatPanel && chatPanel.contains(anchor)) ||
    document.getElementById('view-intake')?.contains(anchor);
  if (!inMath) return;
  // Only override when the selection actually contains rendered math; otherwise
  // let the browser's default copy carry whatever formatting it normally would.
  const range = sel.getRangeAt(0);
  if (!range.cloneContents().querySelector('.sg-math')) return;
  const text = selectionToTextWithLatex(sel);
  if (!text) return;
  try {
    ev.clipboardData.setData('text/plain', text);
    ev.preventDefault();
  } catch {
    // If clipboardData unavailable, fall through to default
  }
});

let _selToolbarRaf = 0;
function scheduleSelToolbarUpdate() {
  if (_selToolbarRaf) return;
  _selToolbarRaf = requestAnimationFrame(() => {
    _selToolbarRaf = 0;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return hideSelToolbar();
    const text = sel.toString().trim();
    if (text.length < 3) return hideSelToolbar();
    const range = sel.getRangeAt(0);
    let node = range.commonAncestorContainer;
    if (node.nodeType === 3) node = node.parentNode;
    if (!view.contains(node)) return hideSelToolbar();
    if (chatPanel && chatPanel.contains(node)) return hideSelToolbar();
    // Use the FIRST client rect (single line) rather than the bounding rect
    // (union of all lines) so the pill anchors to the first line's gutter,
    // not to a midway point of a multi-line union. Fall back to bounding rect
    // when getClientRects is unavailable.
    const rects = range.getClientRects?.();
    const firstRect = (rects && rects.length) ? rects[0] : range.getBoundingClientRect();
    if (!firstRect || (!firstRect.width && !firstRect.height)) return hideSelToolbar();
    const lastRect = (rects && rects.length) ? rects[rects.length - 1] : firstRect;
    const tb = ensureSelToolbar();
    const pillHeight = 32;
    const gap = 4;
    // Prefer placing pill ABOVE the first line, in the gap between this
    // paragraph's top and the previous element. If the line is too close to
    // the viewport top, drop below the last line instead.
    const aboveTop = firstRect.top - pillHeight - gap;
    const placeBelow = aboveTop < 8;
    const top = placeBelow ? lastRect.bottom + gap : aboveTop;
    const centerX = (placeBelow ? lastRect : firstRect).left + (placeBelow ? lastRect : firstRect).width / 2;
    tb.style.top = window.scrollY + top + 'px';
    tb.style.left = window.scrollX + centerX + 'px';
    tb.dataset.place = placeBelow ? 'below' : 'above';
    tb.classList.add('show');
  });
}
document.addEventListener('selectionchange', scheduleSelToolbarUpdate);

function ensureChatPanel() {
  if (chatPanel) return chatPanel;
  chatPanel = document.createElement('aside');
  chatPanel.className = 'sg-chat-panel';
  chatPanel.innerHTML = `
    <div class="sg-chat-resize" title="drag to resize"></div>
    <div class="sg-chat-head">
      <span class="sg-chat-title">btw</span>
      <div class="sg-chat-head-actions">
        <button class="sg-chat-mode" data-action="toggle-tutor-mode" data-mode="read" title="read-only mode — click to allow file edits">🔒 read-only</button>
        <button class="sg-chat-copy" data-action="copy-thread-md" title="copy this conversation as markdown">copy md</button>
        <button class="sg-chat-save" data-action="save-chat" title="save this conversation as a ?>> block in the lesson" disabled>Save to lesson</button>
        <button class="sg-chat-close" data-action="close-chat" title="close (Esc)">×</button>
      </div>
    </div>
    <div class="sg-chat-selection"></div>
    <div class="sg-chat-messages"></div>
    <form class="sg-chat-form">
      <div class="sg-chat-quote-chip" title="this snippet (selected inside the panel) will be sent as context"></div>
      <div class="sg-chat-input-wrap">
        <textarea name="q" rows="1" placeholder="ask about this passage…" autocomplete="off"></textarea>
        <div class="sg-chat-input-bar">
          <span class="sg-chat-input-spacer"></span>
          <button type="submit" class="sg-chat-send" aria-label="Send" title="Send (Enter)">
            <svg class="sg-chat-send-icon-send" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
            <svg class="sg-chat-send-icon-stop" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>
          </button>
        </div>
      </div>
    </form>
  `;
  document.body.appendChild(chatPanel);
  chatPanel.querySelector('[data-action="close-chat"]').addEventListener('click', closeChatPanel);
  chatPanel.querySelector('[data-action="save-chat"]').addEventListener('click', onSaveChat);
  chatPanel.querySelector('.sg-chat-form').addEventListener('submit', onChatSubmit);
  chatPanel.querySelector('.sg-chat-messages').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-action="edit-chat-msg"]');
    if (!btn) return;
    const msg = btn.closest('.sg-chat-msg.user');
    if (msg) editChatMsgAndRerun(msg);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (!chatPanel.classList.contains('show')) return;
    // Esc: if a turn is streaming, abort it. Otherwise close the panel.
    if (currentPanelKey && inflightStreams.has(currentPanelKey)) {
      abortInflight(currentPanelKey);
      ev.preventDefault();
    } else {
      closeChatPanel();
    }
  });
  const chatInput = chatPanel.querySelector('[name="q"]');
  chatInput.addEventListener('keydown', (ev) => {
    // Enter submits, Shift+Enter inserts a newline (Claude.app-style).
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) {
      ev.preventDefault();
      // NB: requestSubmit() returns undefined, so `requestSubmit?.() || …`
      // would double-fire — second submit sees the button in 'stop' mode
      // and aborts the turn we just started. Use a real if/else.
      const form = chatPanel.querySelector('.sg-chat-form');
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      return;
    }
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
    // Only trigger history nav when caret is at start (↑) / end (↓), so
    // editing inside multi-line text isn't hijacked.
    const atStart = chatInput.selectionStart === 0 && chatInput.selectionEnd === 0;
    const atEnd = chatInput.selectionStart === chatInput.value.length;
    if (ev.key === 'ArrowUp' && !atStart) return;
    if (ev.key === 'ArrowDown' && !atEnd) return;
    const dir = ev.key === 'ArrowUp' ? 'up' : 'down';
    const ref = { value: chatInputHistoryIdx };
    const handled = navigateInputHistory(chatInput, chatInputHistory, ref, dir);
    chatInputHistoryIdx = ref.value;
    if (handled) ev.preventDefault();
  });
  // Any non-arrow typing resets the history pointer + grows the textarea
  // to fit the current content (up to a CSS-enforced max height).
  chatInput.addEventListener('input', () => {
    chatInputHistoryIdx = -1;
    autosizeTextarea(chatInput);
  });
  wireChatResize(chatPanel);
  wireChatPanelSelectionPreview(chatPanel);
  restoreChatWidth();
  return chatPanel;
}

function wireChatResize(panel) {
  const handle = panel.querySelector('.sg-chat-resize');
  let dragging = false;
  let startX = 0;
  let startW = 0;
  handle.addEventListener('mousedown', (ev) => {
    dragging = true;
    startX = ev.clientX;
    startW = panel.getBoundingClientRect().width;
    handle.classList.add('dragging');
    panel.classList.add('dragging');
    ev.preventDefault();
  });
  window.addEventListener('mousemove', (ev) => {
    if (!dragging) return;
    const dx = startX - ev.clientX;
    const w = Math.max(320, Math.min(window.innerWidth * 0.92, startW + dx));
    // Write to :root so the body.sg-chat-open padding tracks the panel width.
    document.documentElement.style.setProperty('--sg-chat-width', w + 'px');
    updateOutlineLayout();
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    panel.classList.remove('dragging');
    const w = document.documentElement.style.getPropertyValue('--sg-chat-width');
    try { if (w) localStorage.setItem('sg-chat-width', w); } catch {}
    updateOutlineLayout();
  });
}

// Decide whether the inline outline rail has room to live alongside
// whatever the user has open right now (chat panel of any width). The
// chat panel is user-resizable, so static media queries can't catch
// every overlap — recompute on open/close/resize.
function updateOutlineLayout() {
  const chatOpen = document.body.classList.contains('sg-chat-open');
  const matEl = document.getElementById('material-viewer');
  const matOpen = !!(matEl && !matEl.hidden && window.innerWidth > 1100);
  if (!chatOpen && !matOpen) {
    document.body.classList.remove('outline-no-room');
    return;
  }
  const chatPanel = document.querySelector('.sg-chat-panel.show');
  const chatW = chatOpen ? (chatPanel ? chatPanel.getBoundingClientRect().width : 440) : 0;
  const matW = matOpen ? matEl.getBoundingClientRect().width : 0;
  const sb = document.getElementById('sidebar');
  const sbW = sb ? sb.getBoundingClientRect().width : 256;
  // Need: sidebar + material viewer (if open) + content-body padding +
  // prose 896 + gap 72 + rail 320 + chat (if open) = sbW + matW + 1320 + chatW
  const needed = sbW + matW + 1320 + chatW;
  document.body.classList.toggle('outline-no-room', window.innerWidth < needed);
}
window.addEventListener('resize', updateOutlineLayout);

function restoreChatWidth() {
  try {
    const saved = localStorage.getItem('sg-chat-width');
    if (saved) document.documentElement.style.setProperty('--sg-chat-width', saved);
  } catch {}
}

// Selection stash: when the user highlights text inside the panel, remember
// it. Clicking the input would otherwise clear the live selection, so we
// can't rely on window.getSelection() at submit time.
let panelStashedQuote = '';

function clearPanelQuote(panel) {
  panelStashedQuote = '';
  const chip = panel?.querySelector('.sg-chat-quote-chip');
  if (chip) {
    chip.classList.remove('show');
    chip.textContent = '';
  }
}

function setPanelQuote(panel, text) {
  panelStashedQuote = text;
  const chip = panel.querySelector('.sg-chat-quote-chip');
  if (!chip) return;
  const truncated = text.slice(0, 240);
  const tail = text.length > 240 ? '…' : '';
  chip.innerHTML =
    '<span class="sg-chat-quote-text">“' +
    renderInlineChrome(truncated) + tail +
    '”</span>' +
    '<button class="sg-chat-quote-x" type="button" title="don\'t quote this">×</button>';
  chip.classList.add('show');
}

// When the user highlights text inside the chat panel, stash it + show a
// quote chip near the input so they can see what's about to be sent.
function wireChatPanelSelectionPreview(panel) {
  document.addEventListener('selectionchange', () => {
    if (!panel.classList.contains('show')) return;
    const snippet = getPanelSelection(panel);
    if (snippet && snippet !== panelStashedQuote) setPanelQuote(panel, snippet);
  });
  // Click the × on the chip to drop the quote
  panel.addEventListener('click', (ev) => {
    if (ev.target.closest?.('.sg-chat-quote-x')) {
      ev.preventDefault();
      clearPanelQuote(panel);
    }
  });
}

function getPanelSelection(panel) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return '';
  const anchor = sel.anchorNode;
  const focus = sel.focusNode;
  const within = (n) => {
    while (n) { if (n === panel) return true; n = n.parentNode; }
    return false;
  };
  if (!within(anchor) || !within(focus)) return '';
  // Don't capture text typed inside the input itself.
  const sNode = anchor.nodeType === 1 ? anchor : anchor.parentElement;
  if (sNode?.closest('input, textarea, .sg-chat-form')) return '';
  // Preserve LaTeX source for rendered math nodes.
  return selectionToTextWithLatex(sel);
}

function toggleSidebar() {
  const app = document.querySelector('#view-reader .app');
  if (!app) return;
  app.classList.toggle('sidebar-collapsed');
  try {
    localStorage.setItem(
      'sg-sidebar-collapsed',
      app.classList.contains('sidebar-collapsed') ? '1' : '0'
    );
  } catch {}
}

function restoreSidebarState() {
  try {
    if (localStorage.getItem('sg-sidebar-collapsed') === '1') {
      document.querySelector('#view-reader .app')?.classList.add('sidebar-collapsed');
    }
    // Restore per-section collapse state (materials / threads)
    for (const name of ['materials', 'threads']) {
      const collapsed = localStorage.getItem('sg-sec-' + name) === '1';
      const sec = document.querySelector(`#sidebar [data-section="${name}"]`);
      const tog = document.querySelector(`#sidebar [data-action="toggle-section"][data-section="${name}"]`);
      if (sec) sec.classList.toggle('collapsed', collapsed);
      if (tog) tog.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
  } catch {}
}

function toggleSidebarSection(triggerEl) {
  const name = triggerEl?.dataset.section;
  if (!name) return;
  const sec = document.querySelector(`#sidebar [data-section="${name}"]`);
  if (!sec) return;
  const collapsed = !sec.classList.contains('collapsed');
  sec.classList.toggle('collapsed', collapsed);
  // Sync aria-expanded on the matching toggle button
  const tog = document.querySelector(`#sidebar [data-action="toggle-section"][data-section="${name}"]`);
  if (tog) tog.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  try { localStorage.setItem('sg-sec-' + name, collapsed ? '1' : '0'); } catch {}
}

// Re-enable the input + reset the submit-button to 'Ask' when no stream is
// currently in flight for the panel's NEW key. Without this, switching
// between conversations while one was streaming leaves the freshly-shown
// panel with a disabled textarea and a stuck-on-'Stop' button (the prior
// turn's finally-block bails out because currentPanelKey already moved on).
function resetChatInputIfIdle(panel, panelKey) {
  if (!panel) return;
  const input = panel.querySelector('[name="q"]');
  const form = panel.querySelector('.sg-chat-form');
  const stillStreaming = panelKey && inflightStreams.has(panelKey) && !inflightStreams.get(panelKey).done;
  if (input) input.disabled = !!stillStreaming;
  setChatSubmitMode(form, stillStreaming ? 'stop' : 'ask');
}

function openChatPanel(selection, restoreThread = null) {
  hideSelToolbar();
  const panel = ensureChatPanel();
  const targetThreadId = restoreThread?.id || null;
  const newKey = `btw:${targetThreadId || 'new:' + (selection || '').slice(0, 64)}`;
  // Same thread / same selection as last time — just show it.
  if (currentPanelKey === newKey) {
    chatMode = 'btw';
    panel.classList.remove('tutor-mode');
    panel.classList.add('show');
    document.body.classList.add('sg-chat-open');
    updateOutlineLayout();
    resetChatInputIfIdle(panel, currentPanelKey);
    setTimeout(() => panel.querySelector('[name="q"]').focus(), 50);
    return;
  }
  chatMode = 'btw';
  panel.classList.remove('tutor-mode');
  panel.querySelector('.sg-chat-title').textContent = 'btw';
  panel.querySelector('.sg-chat-selection').style.display = '';
  panel.querySelector('.sg-chat-save').style.display = '';
  clearPanelQuote(panel);
  if (restoreThread) {
    chatSelection = restoreThread.selection || selection;
    chatHistory = (restoreThread.history || []).map((m) => ({ role: m.role, content: m.content }));
    threadId = restoreThread.id;
  } else {
    chatSelection = selection;
    chatHistory = [];
    threadId = (window.crypto?.randomUUID && window.crypto.randomUUID()) || (Date.now() + '-' + Math.random().toString(36).slice(2));
  }
  panel.querySelector('.sg-chat-selection').innerHTML = renderInlineChrome(chatSelection);
  const msgs = panel.querySelector('.sg-chat-messages');
  msgs.innerHTML = '';
  for (const m of chatHistory) appendChatMessage(m.role, m.content);
  panel.querySelector('[name="q"]').placeholder = 'ask about this passage…';
  panel.classList.add('show');
  document.body.classList.add('sg-chat-open');
  updateOutlineLayout();
  currentPanelKey = `btw:${threadId}`;
  // If this thread already has a stream running (e.g. user re-opened from
  // the sidebar while the previous turn was still painting), re-attach.
  reattachInflightForKey(currentPanelKey);
  resetChatInputIfIdle(panel, currentPanelKey);
  setChatSaveEnabled();
  syncTutorModeButton();
  setTimeout(() => panel.querySelector('[name="q"]').focus(), 50);
}

async function openTutorPanel() {
  if (!currentTrack) { setStatus('open a course first'); return; }
  hideSelToolbar();
  const panel = ensureChatPanel();
  const newKey = `tutor:${currentTrack}`;
  // Same conversation as last time — just show it. Any in-flight stream
  // is still painting into the existing placeholder, so no rebuild needed.
  if (currentPanelKey === newKey) {
    chatMode = 'tutor';
    panel.classList.add('tutor-mode');
    panel.classList.add('show');
    document.body.classList.add('sg-chat-open');
    updateOutlineLayout();
    resetChatInputIfIdle(panel, currentPanelKey);
    setTimeout(() => panel.querySelector('[name="q"]').focus(), 50);
    return;
  }
  chatMode = 'tutor';
  panel.classList.add('tutor-mode');
  panel.querySelector('.sg-chat-title').textContent = 'tutor · ' + currentTrack;
  panel.querySelector('.sg-chat-selection').style.display = 'none';
  panel.querySelector('.sg-chat-save').style.display = 'none';
  clearPanelQuote(panel);
  tutorPermission = loadTutorPermission(currentTrack);
  syncTutorModeButton();
  chatSelection = '';
  threadId = null;
  // Restore persisted tutor history for this track
  try {
    const r = await fetch(`/api/tutor/${encodeURIComponent(currentTrack)}`).then((r) => r.json());
    chatHistory = (r?.history || []).map((m) => ({ role: m.role, content: m.content }));
  } catch {
    chatHistory = [];
  }
  const msgs = panel.querySelector('.sg-chat-messages');
  msgs.innerHTML = '';
  for (const m of chatHistory) appendChatMessage(m.role, m.content);
  panel.querySelector('[name="q"]').placeholder = 'ask the tutor anything…';
  panel.classList.add('show');
  document.body.classList.add('sg-chat-open');
  updateOutlineLayout();
  currentPanelKey = newKey;
  // If a tutor turn for this track was started earlier (e.g. from a
  // previous panel session), pick the stream back up.
  reattachInflightForKey(newKey);
  resetChatInputIfIdle(panel, currentPanelKey);
  // Empty conversation — show a soft hint instead of auto-sending an
  // opener. The user explicitly wants to start the conversation.
  if (chatHistory.length === 0 && !inflightStreams.has(newKey)) {
    const hint = document.createElement('div');
    hint.className = 'sg-chat-empty-hint';
    hint.textContent = 'Say anything to start — your tutor knows this course.';
    panel.querySelector('.sg-chat-messages').appendChild(hint);
  }
  setTimeout(() => panel.querySelector('[name="q"]').focus(), 50);
}

function closeChatPanel() {
  if (chatPanel) chatPanel.classList.remove('show');
  document.body.classList.remove('sg-chat-open');
  updateOutlineLayout();
  // Keep chatHistory / chatSelection / threadId / currentPanelKey intact:
  // - re-opening the same panel restores instantly with no flicker;
  // - any in-flight stream keeps writing to the (hidden) placeholder, and
  //   on re-attach we fast-forward the text.
}

async function onChatSubmit(ev) {
  ev.preventDefault();
  const submitBtn = ev.target.querySelector('button[type="submit"]');
  // Submit button doubles as Stop while a turn is in flight.
  if (submitBtn?.dataset.mode === 'stop') {
    if (currentPanelKey) abortInflight(currentPanelKey);
    return;
  }
  const input = ev.target.querySelector('[name="q"]');
  const rawQuestion = input.value.trim();
  if (!rawQuestion) return;
  if (chatMode === 'btw' && !chatSelection) return;
  pushChatInputHistory(rawQuestion);
  // If the user highlighted text inside this panel before submitting, include
  // it as a quoted preamble so the AI sees what they were referring to.
  const panelSnippet = panelStashedQuote || getPanelSelection(chatPanel);
  const question = panelSnippet
    ? `> quoted from this chat:\n> ${panelSnippet.split('\n').join('\n> ')}\n\n${rawQuestion}`
    : rawQuestion;
  input.value = '';
  autosizeTextarea(input);
  clearPanelQuote(chatPanel);
  window.getSelection()?.removeAllRanges();
  if (chatMode === 'tutor') {
    return sendTutorTurn(question);
  }
  input.disabled = true;
  setChatSubmitMode(ev.target, 'stop');
  appendChatMessage('user', question);
  const historyBefore = chatHistory.slice();
  chatHistory.push({ role: 'user', content: question });
  const placeholder = appendChatMessage('assistant', '…');
  // Capture the owning thread/key so the stream survives a panel rebuild
  // (user closes panel + opens tutor + comes back).
  const ownerThreadId = threadId;
  const streamKey = `btw:${ownerThreadId}`;
  const stream = registerInflight(streamKey, 'btw', question, placeholder);
  setStatus('btw asking…');
  try {
    const resp = await fetch('/api/btw-ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        track: currentTrack,
        lesson: currentSlug,
        selection: chatSelection,
        question,
        history: historyBefore,
        thread_id: ownerThreadId,
      }),
      signal: stream.controller.signal,
    });
    if (!resp.ok || !resp.body) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`stream open failed: ${resp.status} ${errBody.slice(0, 200)}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let meta = null;
    let errorMsg = null;

    placeholder.textContent = '';
    placeholder.classList.add('streaming');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        if (!chunk.startsWith('data: ')) continue;
        let ev;
        try { ev = JSON.parse(chunk.slice(6)); } catch { continue; }
        if (ev.type === 'delta') {
          stream.fullText += ev.text;
          stream.target.innerHTML = md.render(stream.fullText, {});
          if (stream.target.isConnected) {
            const msgs = chatPanel.querySelector('.sg-chat-messages');
            if (msgs) msgs.scrollTop = msgs.scrollHeight;
          }
        } else if (ev.type === 'done') {
          meta = ev;
        } else if (ev.type === 'error') {
          errorMsg = ev.error;
        }
      }
    }
    stream.target.classList.remove('streaming');
    if (errorMsg) throw new Error(errorMsg);
    if (!stream.fullText && meta?.full_text) {
      stream.fullText = meta.full_text;
      stream.target.innerHTML = md.render(stream.fullText, {});
    }
    // Push assistant message only if the panel is still showing this thread.
    if (currentPanelKey === streamKey) {
      chatHistory.push({ role: 'assistant', content: stream.fullText });
      setChatSaveEnabled();
    }
    if (meta) {
      if (meta.thread_id && meta.thread_id !== ownerThreadId && currentPanelKey === streamKey) {
        threadId = meta.thread_id;
        currentPanelKey = `btw:${threadId}`;
      }
      setStatus(`btw answered (${(meta.duration_ms / 1000).toFixed(1)}s, $${meta.cost_usd?.toFixed(3)})`);
    }
    loadThreads();
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    if (aborted) {
      // Keep whatever partial text was painted; tag it interrupted.
      stream.target.classList.remove('streaming');
      stream.target.classList.add('interrupted');
      if (!stream.fullText) stream.target.textContent = '(interrupted)';
      if (currentPanelKey === streamKey) chatHistory.push({ role: 'assistant', content: stream.fullText || '(interrupted)' });
      setStatus('btw interrupted');
    } else {
      stream.target.textContent = '✗ ' + e.message;
      stream.target.classList.add('error');
      setStatus('btw error: ' + e.message);
    }
  } finally {
    stream.done = true;
    inflightStreams.delete(streamKey);
    // Only restore focus / re-enable the input if the panel is still on
    // this thread; otherwise we'd be poking another conversation's UI.
    if (currentPanelKey === streamKey) {
      input.disabled = false;
      setChatSubmitMode(chatPanel.querySelector('.sg-chat-form'), 'ask');
      input.focus();
    }
  }
}

async function sendTutorTurn(userMessage) {
  const panel = chatPanel;
  const form = panel.querySelector('.sg-chat-form');
  const input = panel.querySelector('[name="q"]');
  input.disabled = true;
  setChatSubmitMode(form, 'stop');
  if (userMessage) {
    appendChatMessage('user', userMessage);
    chatHistory.push({ role: 'user', content: userMessage });
  }
  const placeholder = appendChatMessage('assistant', '…');
  placeholder.classList.add('streaming');
  setStatus('tutor thinking…');
  // Capture which track owns this turn so it survives a panel switch.
  const ownerTrack = currentTrack;
  const streamKey = `tutor:${ownerTrack}`;
  const ownerMode = tutorPermission;
  const stream = registerInflight(streamKey, 'tutor', userMessage, placeholder);
  const historyBefore = userMessage ? chatHistory.slice(0, -1) : chatHistory.slice();
  try {
    const resp = await fetch('/api/tutor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        track: ownerTrack,
        user_message: userMessage,
        history: historyBefore,
        mode: ownerMode,
      }),
      signal: stream.controller.signal,
    });
    if (!resp.ok || !resp.body) {
      const t = await resp.text().catch(() => '');
      throw new Error(`stream open failed: ${resp.status} ${t.slice(0, 200)}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let meta = null;
    let errMsg = null;
    stream.target.textContent = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        if (!chunk.startsWith('data: ')) continue;
        let ev;
        try { ev = JSON.parse(chunk.slice(6)); } catch { continue; }
        if (ev.type === 'delta') {
          stream.fullText += ev.text;
          stream.target.innerHTML = md.render(stream.fullText, {});
          if (stream.target.isConnected && currentPanelKey === streamKey) {
            const msgs = chatPanel.querySelector('.sg-chat-messages');
            if (msgs) msgs.scrollTop = msgs.scrollHeight;
          }
        } else if (ev.type === 'done') {
          meta = ev;
        } else if (ev.type === 'error') {
          errMsg = ev.error;
        }
      }
    }
    stream.target.classList.remove('streaming');
    if (errMsg) throw new Error(errMsg);
    // Only mutate in-memory chatHistory if the panel is still mounted to
    // this conversation; otherwise the server-persisted history is the
    // authoritative copy and we'll reload it next time the user opens.
    if (currentPanelKey === streamKey) {
      chatHistory.push({ role: 'assistant', content: stream.fullText });
    }
    if (meta) setStatus(`tutor replied (${(meta.duration_ms / 1000).toFixed(1)}s, $${meta.cost_usd?.toFixed(3)})`);
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    if (aborted) {
      stream.target.classList.remove('streaming');
      stream.target.classList.add('interrupted');
      if (!stream.fullText) stream.target.textContent = '(interrupted)';
      if (currentPanelKey === streamKey) chatHistory.push({ role: 'assistant', content: stream.fullText || '(interrupted)' });
      setStatus('tutor interrupted');
    } else {
      stream.target.textContent = '✗ ' + e.message;
      stream.target.classList.add('error');
      stream.target.classList.remove('streaming');
      setStatus('tutor error: ' + e.message);
    }
  } finally {
    stream.done = true;
    inflightStreams.delete(streamKey);
    if (currentPanelKey === streamKey) {
      input.disabled = false;
      setChatSubmitMode(form, 'ask');
      input.focus();
    }
  }
}

function appendChatMessage(role, content) {
  const msg = document.createElement('div');
  msg.className = `sg-chat-msg ${role}`;
  // We render markdown for assistants; user messages stay as plain text so
  // the edit textarea round-trips cleanly. The content lives in an inner
  // `.sg-chat-msg-body` wrapper to keep the edit-button positioning simple.
  if (role === 'user') {
    const body = document.createElement('div');
    body.className = 'sg-chat-msg-body';
    body.textContent = content;
    msg.appendChild(body);
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'sg-chat-msg-edit-btn';
    editBtn.dataset.action = 'edit-chat-msg';
    editBtn.title = 'edit this message and re-run from here';
    editBtn.setAttribute('aria-label', 'edit');
    editBtn.textContent = '✎';
    msg.appendChild(editBtn);
  } else if (content !== '…') {
    msg.innerHTML = md.render(content, {});
  } else {
    msg.textContent = content;
  }
  const msgs = chatPanel.querySelector('.sg-chat-messages');
  // Drop the empty-state hint once a real message lands.
  msgs.querySelector('.sg-chat-empty-hint')?.remove();
  msgs.appendChild(msg);
  msgs.scrollTop = msgs.scrollHeight;
  return msg;
}

// Compute which chatHistory index a clicked user-message DOM element
// corresponds to. We can't trust raw DOM position because the trailing
// streaming placeholder is in DOM but not yet in chatHistory.
function indexOfUserMsg(msgEl, history) {
  const parent = msgEl.parentElement;
  if (!parent) return -1;
  let countInDom = -1;
  for (const el of parent.children) {
    if (el.classList.contains('user')) countInDom++;
    if (el === msgEl) break;
  }
  if (countInDom < 0) return -1;
  let seen = 0;
  for (let i = 0; i < history.length; i++) {
    if (history[i].role !== 'user') continue;
    if (seen === countInDom) return i;
    seen++;
  }
  return -1;
}

// Swap a user message's content for a textarea + Save/Cancel.
// onSubmit gets the new text; onCancel just restores.
function enterMsgEditMode(msgEl, originalText, onSubmit) {
  if (msgEl.classList.contains('editing')) return;
  msgEl.classList.add('editing');
  const body = msgEl.querySelector('.sg-chat-msg-body') || msgEl;
  const prev = body.textContent;
  body.innerHTML = '';
  const ta = document.createElement('textarea');
  ta.className = 'sg-chat-msg-edit-area';
  ta.value = originalText;
  ta.rows = Math.min(8, Math.max(2, originalText.split('\n').length));
  const actions = document.createElement('div');
  actions.className = 'sg-chat-msg-edit-actions';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'sg-chat-msg-edit-save primary';
  save.textContent = 'Save & re-run';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'sg-chat-msg-edit-cancel';
  cancel.textContent = 'Cancel';
  actions.appendChild(save);
  actions.appendChild(cancel);
  body.appendChild(ta);
  body.appendChild(actions);
  setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 20);
  const finish = () => { msgEl.classList.remove('editing'); };
  cancel.addEventListener('click', () => {
    finish();
    body.innerHTML = '';
    body.textContent = prev;
  });
  save.addEventListener('click', () => {
    const v = ta.value.trim();
    if (!v) return cancel.click();
    finish();
    onSubmit(v);
  });
  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); cancel.click(); }
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); save.click(); }
  });
}

// Truncate the conversation at the edited user message and re-run the new
// text — the Claude.app-style "edit a past message" flow.
async function editChatMsgAndRerun(msgEl) {
  if (!chatPanel) return;
  const idx = indexOfUserMsg(msgEl, chatHistory);
  if (idx < 0) return;
  const original = chatHistory[idx]?.content || '';
  enterMsgEditMode(msgEl, original, async (newText) => {
    const preHistory = chatHistory.slice(0, idx);
    try {
      if (chatMode === 'tutor') {
        await fetch(`/api/tutor/${encodeURIComponent(currentTrack)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ history: preHistory }),
        });
      } else if (chatMode === 'btw' && threadId) {
        // For unsaved btw threads (no file yet) the 404 is fine — we just
        // need the in-memory state to be truncated.
        await fetch(`/api/thread/${encodeURIComponent(threadId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ history: preHistory }),
        }).catch(() => {});
      }
    } catch (e) {
      setStatus('edit failed: ' + e.message);
      return;
    }
    // Drop any in-flight stream for this conversation — its target placeholder
    // is about to be wiped, and the file underneath it has just been rewritten.
    if (currentPanelKey && inflightStreams.has(currentPanelKey)) {
      const e = inflightStreams.get(currentPanelKey);
      e.done = true;
      inflightStreams.delete(currentPanelKey);
    }
    chatHistory = preHistory;
    const msgs = chatPanel.querySelector('.sg-chat-messages');
    msgs.innerHTML = '';
    for (const m of chatHistory) appendChatMessage(m.role, m.content);
    if (chatMode === 'tutor') {
      sendTutorTurn(newText);
    } else {
      const input = chatPanel.querySelector('[name="q"]');
      input.value = newText;
      chatPanel.querySelector('.sg-chat-form').dispatchEvent(
        new Event('submit', { cancelable: true, bubbles: true }),
      );
    }
  });
}

function setChatSaveEnabled() {
  if (!chatPanel) return;
  const saveBtn = chatPanel.querySelector('[data-action="save-chat"]');
  if (!saveBtn) return;
  // Need at least one user + one assistant turn
  const hasAssistant = chatHistory.some((m) => m.role === 'assistant');
  saveBtn.disabled = !hasAssistant || !currentSlug;
}

async function onSaveChat() {
  if (!chatPanel || !currentSlug || !chatSelection || chatHistory.length === 0) return;
  const saveBtn = chatPanel.querySelector('[data-action="save-chat"]');
  saveBtn.disabled = true;
  const prev = saveBtn.textContent;
  saveBtn.textContent = 'saving…';
  setStatus('saving thread to lesson…');
  try {
    const r = await fetch('/api/save-thread', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        track: currentTrack,
        lesson: currentSlug,
        selection: chatSelection,
        history: chatHistory,
      }),
    }).then((r) => r.json());
    if (!r.ok) throw new Error(r.error || 'save-thread failed');
    setStatus(`saved (${(r.duration_ms / 1000).toFixed(1)}s, $${r.cost_usd?.toFixed(3)})`);
    saveBtn.textContent = 'saved ✓';
    setTimeout(() => {
      closeChatPanel();
      loadLesson(currentSlug);
    }, 600);
  } catch (e) {
    setStatus('save error: ' + e.message);
    saveBtn.textContent = prev;
    saveBtn.disabled = false;
  }
}

document.getElementById('btn-tutor').addEventListener('click', () => {
  // Toggle: if the tutor panel for this track is already showing, the
  // second click closes it.
  const isOpenForThisTrack =
    chatPanel?.classList.contains('show') &&
    currentPanelKey === `tutor:${currentTrack}`;
  if (isOpenForThisTrack) closeChatPanel();
  else openTutorPanel();
});

// Outline popover toggle — only shown at narrow viewports (≤ 1469px).
// Mirrors Claude docs' "Toggle table of contents" affordance.
const outlineToggleBtn = document.getElementById('outline-toggle');
function setOutlinePopOpen(open) {
  document.body.classList.toggle('outline-pop-open', open);
  outlineToggleBtn?.setAttribute('aria-expanded', open ? 'true' : 'false');
}
outlineToggleBtn?.addEventListener('click', (ev) => {
  ev.stopPropagation();
  setOutlinePopOpen(!document.body.classList.contains('outline-pop-open'));
});
// Close when clicking outside the rail (but not on the toggle itself)
document.addEventListener('click', (ev) => {
  if (!document.body.classList.contains('outline-pop-open')) return;
  if (ev.target.closest('#outline-rail') || ev.target.closest('#outline-toggle')) return;
  setOutlinePopOpen(false);
});
// Close on Esc
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && document.body.classList.contains('outline-pop-open')) {
    setOutlinePopOpen(false);
  }
});
// Close when an outline link is clicked (the user jumped — popover's done its job)
document.getElementById('outline-rail')?.addEventListener('click', (ev) => {
  if (ev.target.closest('a[data-action="jump-section"]')) setOutlinePopOpen(false);
});

btnRecap.addEventListener('click', async () => {
  if (!currentSlug) { setStatus('pick a lesson first'); return; }
  btnRecap.disabled = true;
  const prev = btnRecap.textContent;
  btnRecap.textContent = 'folding…';
  setStatus(`recapping ${currentSlug}…`);
  try {
    const r = await fetch('/api/recap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ track: currentTrack, lesson: currentSlug }),
    }).then((r) => r.json());
    if (!r.ok) throw new Error(r.error || 'recap failed');
    setStatus(`recap done (${(r.duration_ms / 1000).toFixed(1)}s, $${r.cost_usd?.toFixed(3)})`);
    await loadLesson(currentSlug);
  } catch (e) {
    setStatus('recap error: ' + e.message);
  } finally {
    btnRecap.disabled = false;
    btnRecap.textContent = prev;
  }
});

// ---------- SSE ----------
const es = new EventSource('/api/events');
es.addEventListener('message', async (ev) => {
  let data;
  try {
    data = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (data.type === 'lesson-change') {
    setStatus(`fs: ${data.file} ${data.evType}`);
    loadList().then(() => {
      if (currentSlug === data.file) loadLesson(currentSlug);
      else if (!currentSlug) {
        loadLesson(data.file);
      }
    });
  }
  if (data.type === 'progress-change') {
    loadList();
  }
  // Plan-mode: a curriculum-change SSE means the file was just (re)written.
  // Refresh the right pane in place rather than auto-bouncing to the reader,
  // so the iterate → comment → regenerate loop stays in one view. (The
  // event still fires for the broader app — useful for cross-tab updates.)
  if (data.type === 'curriculum-change') {
    const onIntakeView = location.hash.startsWith(`#/t/${encodeURIComponent(data.track)}/intake`);
    if (onIntakeView && intakeTrack === data.track) {
      try {
        const cur = await fetch(`/api/tracks/${encodeURIComponent(data.track)}/curriculum`).then((r) => r.json());
        if (cur?.ok) {
          setIntakePhase('has-plan');
          renderPlanPane(cur.content || '');
        }
      } catch {}
    }
  }
  // Materials pipeline events — refresh whichever materials list is visible
  // for the affected track. Cheap: the list re-fetch is small and
  // server-side stats already include the new status.
  if (data.type === 'material_indexed' || data.type === 'material_failed' || data.type === 'material_deleted') {
    if (data.type === 'material_deleted') {
      const open = materialViewer.state;
      if (open.track === data.slug && open.name === data.name) materialViewer.close();
    }
    if (data.slug === currentTrack) {
      loadMaterials();
    }
    if (data.slug === intakeTrack) {
      const il = document.getElementById('intake-materials-list');
      if (il) loadMaterials(intakeTrack, il, 'drop in PDFs / notes / cheatsheets — your tutor will see them');
    }
    if (data.type === 'material_failed') {
      setStatus(`extraction failed: ${data.name} — ${data.error || 'unknown error'}`);
    } else if (data.type === 'material_indexed') {
      const tag = data.status && data.status !== 'ok' ? ` (${data.status})` : '';
      setStatus(`indexed: ${data.name}${tag}`);
    }
  }
  if (data.type === 'material_progress' && data.phase) {
    // Surface long-running phases (extract / vectors) without spamming.
    if (data.phase === 'extract' && data.of) {
      setStatus(`extracting ${data.name}: page ${data.page}/${data.of}`);
    } else if (data.phase === 'vectors' && data.done && data.of) {
      setStatus(`embedding ${data.name}: ${data.done}/${data.of}`);
    } else if (data.phase === 'bm25' || data.phase === 'mirror' || data.phase === 'chunk') {
      setStatus(`${data.phase}: ${data.name}`);
    }
  }
});

// ---------- Router + Home ----------
const viewHome = document.getElementById('view-home');
const viewReader = document.getElementById('view-reader');
const trackGrid = document.getElementById('track-grid');
const newTrackDialog = document.getElementById('new-track-dialog');
const newTrackForm = document.getElementById('new-track-form');
const editTrackDialog = document.getElementById('edit-track-dialog');
const editTrackForm = document.getElementById('edit-track-form');

// Curated cover emoji set, biased toward the warm-paper / scholarly
// palette of this theme (cream + terracotta + Source Serif). Avoids
// rainbow textbook covers, kid-cartoon sci icons, and modern tech
// glyphs that clash with the parchment vibe. Order is intentional:
// row 1 writing, row 2 time + classical, row 3 celestial + autumn,
// row 4 nature + quiet objects. Default is the first item (📜).
const COVER_EMOJIS = [
  '📜', '📖', '📔', '📓', '🪶', '🖋️', '✒️', '🕯️',
  '⏳', '🗝️', '🧭', '🗺️', '🔭', '🏛️', '🏺', '⛰️',
  '☀️', '🌙', '🪐', '✨', '🌾', '🍂', '🍁', '🍄',
  '🪴', '☕', '🫖', '🎼', '🦉', '🦌', '🦋', '🪵',
];

function renderEmojiPicker(pickerEl, hiddenInput) {
  if (!pickerEl || !hiddenInput) return;
  const current = hiddenInput.value || COVER_EMOJIS[0];
  // If the current value isn't in the curated set (e.g. an older track
  // stored a custom emoji), prepend it as a "custom" tile so editing
  // doesn't silently overwrite it on save.
  const list = COVER_EMOJIS.includes(current)
    ? COVER_EMOJIS
    : [current, ...COVER_EMOJIS];
  pickerEl.innerHTML = list.map((e) =>
    `<button type="button" class="emoji-pick${e === current ? ' is-selected' : ''}${!COVER_EMOJIS.includes(e) ? ' is-custom' : ''}" data-emoji="${escapeHtml(e)}" aria-label="${escapeHtml(e)}" title="${escapeHtml(e)}${!COVER_EMOJIS.includes(e) ? ' (current — keep as-is)' : ''}">${escapeHtml(e)}</button>`
  ).join('');
}
function setEmojiPickerValue(pickerEl, hiddenInput, value) {
  if (!pickerEl || !hiddenInput) return;
  const v = value || COVER_EMOJIS[0];
  hiddenInput.value = v;
  // If this is an out-of-list value, re-render so we get the custom tile.
  if (!COVER_EMOJIS.includes(v) && !pickerEl.querySelector(`.emoji-pick[data-emoji="${CSS.escape(v)}"]`)) {
    renderEmojiPicker(pickerEl, hiddenInput);
    return;
  }
  for (const b of pickerEl.querySelectorAll('.emoji-pick')) {
    b.classList.toggle('is-selected', b.dataset.emoji === v);
  }
}
// Init once; click-delegate updates the hidden input.
const _ntPicker = document.querySelector('.emoji-picker[data-emoji-picker="nt"]');
const _etPicker = document.querySelector('.emoji-picker[data-emoji-picker="et"]');
renderEmojiPicker(_ntPicker, document.getElementById('nt-emoji'));
renderEmojiPicker(_etPicker, document.getElementById('et-emoji'));
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.emoji-pick');
  if (!btn) return;
  ev.preventDefault();
  const picker = btn.closest('.emoji-picker');
  const which = picker?.dataset.emojiPicker;
  const hidden = which === 'et' ? document.getElementById('et-emoji') : document.getElementById('nt-emoji');
  setEmojiPickerValue(picker, hidden, btn.dataset.emoji);
});

function parseRoute() {
  const hash = location.hash || '#/';
  // #/t/<slug>/intake → intake
  const intake = hash.match(/^#\/t\/([^/]+)\/intake\/?$/);
  if (intake) return { name: 'intake', slug: decodeURIComponent(intake[1]) };
  // #/t/<slug>/lesson/<lessonSlug> → reader pinned to a specific lesson
  const lessonDeep = hash.match(/^#\/t\/([^/]+)\/lesson\/([^/?#]+)\/?$/);
  if (lessonDeep) {
    return {
      name: 'reader',
      slug: decodeURIComponent(lessonDeep[1]),
      lesson: decodeURIComponent(lessonDeep[2]),
    };
  }
  // #/t/<slug>/ → reader at default lesson
  const reader = hash.match(/^#\/t\/([^/]+)\/?/);
  if (reader) return { name: 'reader', slug: decodeURIComponent(reader[1]) };
  return { name: 'home' };
}

async function route() {
  const r = parseRoute();
  // Leaving the reader (or switching to a different reader track) must
  // tear down the material viewer — otherwise it shows the previous
  // track's PDF over an unrelated view.
  const leavingReader = r.name !== 'reader' || (r.slug && currentTrack && currentTrack !== r.slug);
  if (leavingReader) {
    try { materialViewer?.close?.(); } catch {}
  }
  if (r.name === 'intake') {
    viewHome.hidden = true;
    viewReader.hidden = true;
    document.getElementById('view-intake').hidden = false;
    await enterIntake(r.slug);
    return;
  }
  if (r.name === 'reader') {
    viewHome.hidden = true;
    document.getElementById('view-intake').hidden = true;
    viewReader.hidden = false;
    restoreSidebarState();
    if (currentTrack !== r.slug) {
      // Reject unknown slugs up-front (URL typos) so we don't trigger a
      // 404 in the network log and don't materialise a ghost course.
      // Use /api/tracks (authoritative inventory of all tracks on disk) —
      // /api/progress would falsely reject brand-new tracks that haven't
      // been selected yet (e.g. just created via the dialog, or via API).
      const slugKnown = await trackExists(r.slug);
      if (!slugKnown) {
        currentTrack = null;
        location.hash = '#/';
        return;
      }
      currentTrack = r.slug;
      // Confirm the track is still alive — a stale positive cache (e.g.
      // the track was deleted out-of-band: CLI, another tab) would let
      // us walk straight into a 404. If select 404s, invalidate the
      // cache and bounce home.
      let selectOk = true;
      try {
        const sr = await fetch(`/api/tracks/${encodeURIComponent(r.slug)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'select' }),
        });
        selectOk = sr.ok;
      } catch {}
      if (!selectOk) {
        invalidateTrackSlugCache();
        currentTrack = null;
        location.hash = '#/';
        return;
      }
      const lessons = await loadList();
      // The `#/t/<slug>/` URL means "go to the reader" — that's a deliberate
      // user action (Start → from the plan view, a typed URL, an old
      // bookmark). Only auto-bounce to intake when the track is *completely*
      // empty (no curriculum AND no lessons), to avoid stranding a fresh
      // track in an empty reader. Home-card clicks on a course with no
      // lessons take the user straight to the intake URL via trackCardHtml,
      // so they don't hit this branch.
      if (!lessons.length) {
        const cur = await fetch(`/api/tracks/${encodeURIComponent(r.slug)}/curriculum`).then((x) => x.json()).catch(() => null);
        if (!cur?.ok) {
          currentTrack = null;
          location.hash = `#/t/${encodeURIComponent(r.slug)}/intake`;
          return;
        }
      }
      const trackProgress = _progress.tracks?.[r.slug];
      // If the URL pins a specific lesson, honor it (unknown slugs fall
      // back to progress.current / first lesson).
      const target = (r.lesson && lessons.includes(r.lesson))
        ? r.lesson
        : trackProgress?.current && lessons.includes(trackProgress.current)
          ? trackProgress.current
          : lessons[0];
      if (target) await loadLesson(target);
      else {
        currentSlug = '';
        view.innerHTML = '<p class="hint">Curriculum is set but no lessons yet — click <b>Next →</b> to generate lesson 1.</p>';
        lessonTitleBar.textContent = '';
        renderSidebarLessons();
        loadMaterials();
        loadThreads();
        sidebarOutline.innerHTML = '<li class="hint">(no lesson)</li>';
      }
    } else if (r.lesson && r.lesson !== currentSlug) {
      // Same track, different lesson named in URL — switch without re-init.
      await loadLesson(r.lesson);
    }
  } else {
    viewReader.hidden = true;
    document.getElementById('view-intake').hidden = true;
    viewHome.hidden = false;
    currentTrack = null;
    currentSlug = '';
    renderHome();
  }
}

// ---------- intake / plan view ----------
let intakeTrack = null;
let intakeHistory = [];
// A "comment" is a user turn whose content begins with COMMENT_TAG. We use
// the chat history as the source of truth for inline comments so they
// survive a reload — pendingComments below is just a UI cache derived from
// history (everything after the most recent assistant turn).
const COMMENT_TAG = '<!--studyground:comment-->';
let pendingComments = [];
const intakeMessagesEl = () => document.getElementById('intake-messages');

async function enterIntake(slug) {
  intakeTrack = slug;
  intakeHistory = [];
  pendingComments = [];
  const msgsEl = document.getElementById('intake-messages');
  msgsEl.innerHTML = '';
  document.getElementById('intake-input').value = '';
  // Show the slug immediately so the user doesn't see "planning…" flash
  // while the /api/tracks fetch resolves. Upgraded to title once it lands.
  document.getElementById('intake-track-name').textContent = slug;
  try {
    const meta = await fetch(`/api/tracks/${encodeURIComponent(slug)}`).then((r) => r.json());
    document.getElementById('intake-track-name').textContent =
      (meta?.track?.emoji ? meta.track.emoji + ' ' : '') + (meta?.track?.title || slug);
  } catch {}
  // Restore the running conversation with this track's tutor (intake turns
  // are persisted into tutor-chat.jsonl, so when the user returns to the
  // intake page they pick up exactly where they left off).
  try {
    const r = await fetch(`/api/tutor/${encodeURIComponent(slug)}`).then((r) => r.json());
    const past = (r?.history || []).filter((m) => m.role === 'user' || m.role === 'assistant');
    intakeHistory = past.map((m) => ({ role: m.role, content: m.content }));
    for (const m of past) appendIntakeMsg(m.role, m.content);
  } catch {}
  // Derive pendingComments BEFORE renderPlanPane: the latter calls
  // anchorInlinePins which iterates the cache to wrap the matching passages.
  pendingComments = derivePendingComments(intakeHistory);
  // Phase = has-plan iff curriculum.md exists. CSS hides the right pane in
  // pre-plan via [data-phase].
  const cur = await fetch(`/api/tracks/${encodeURIComponent(slug)}/curriculum`).then((r) => r.json()).catch(() => null);
  setIntakePhase(cur?.ok ? 'has-plan' : 'pre-plan');
  if (cur?.ok) renderPlanPane(cur.content || '');
  renderPendingComments();
  // Surface any uploaded materials for this track
  loadMaterials(
    slug,
    document.getElementById('intake-materials-list'),
    'drop in PDFs / notes / cheatsheets — your tutor will see them',
  );
  // Don't auto-send a first turn — let the learner open the conversation.
  setTimeout(() => document.getElementById('intake-input').focus(), 50);
}

function setIntakePhase(phase) {
  const root = document.getElementById('view-intake');
  if (root) root.dataset.phase = phase;
}

function renderPlanPane(markdown) {
  const body = document.getElementById('intake-plan-body');
  const subtitle = document.getElementById('intake-plan-subtitle');
  if (!body) return;
  // Strip YAML frontmatter and surface `finalized:` as a small subtitle.
  let finalized = '';
  let mdText = markdown;
  const fm = /^---\s*\n([\s\S]*?)\n---\s*\n?/m.exec(markdown);
  if (fm) {
    const block = fm[1];
    const fmatch = /^finalized:\s*(.+)$/m.exec(block);
    if (fmatch) finalized = fmatch[1].trim();
    mdText = markdown.slice(fm[0].length);
  }
  body.innerHTML = md.render(mdText, {});
  if (subtitle) subtitle.textContent = finalized ? `· finalized ${finalized}` : '';
  // Banner: warn if there are completed lessons that may diverge from a fresh plan.
  const banner = document.getElementById('intake-plan-banner');
  const completed = _progress?.tracks?.[intakeTrack]?.completed || [];
  if (banner) {
    if (completed.length > 0) {
      banner.hidden = false;
      banner.textContent = `⚠ You've completed ${completed.length} lesson(s). Regenerating may diverge from them — existing lesson files won't be deleted, but their numbering may no longer match the new plan.`;
    } else {
      banner.hidden = true;
      banner.textContent = '';
    }
  }
  // Re-anchor pins for any pendingComments whose original passage still exists
  // in the freshly-rendered curriculum.
  anchorInlinePins();
}

// ---- inline pins: wrap commented passages with a 💬 badge --------------

// Pin a Range in the curriculum: ideally wrap it in <mark.intake-plan-pin>
// (highlights the passage) + trailing 💬 badge. For cross-element selections
// where surroundContents() would split list/paragraph structure, fall back
// to badge-only at the end of the selection — the DOM is untouched and the
// pin still sits visually at the user's anchor point. Returns the mark or
// the badge (whichever was inserted), or null on total failure.
function wrapRangeWithPin(range, idx, comment) {
  const badge = createPinBadge(idx, comment);
  // Single-parent selection: clean wrap with highlight.
  const mark = document.createElement('mark');
  mark.className = 'intake-plan-pin';
  mark.dataset.idx = String(idx);
  try {
    range.surroundContents(mark);
    mark.after(badge);
    return mark;
  } catch {
    // Cross-element (e.g. selection spans two <li> siblings). DON'T extract
    // contents — that mangles the list structure into anonymous boxes. Just
    // collapse to the end of the selection and insert the badge there.
    const tail = range.cloneRange();
    tail.collapse(false);
    try {
      tail.insertNode(badge);
      return badge;
    } catch {
      return null;
    }
  }
}

// Real <button> so the global click delegate (which matches
// `button[data-action]`) picks up the badge press, and keyboard
// activation / focus management come for free.
function createPinBadge(idx, comment) {
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'intake-plan-pin-badge';
  badge.dataset.idx = String(idx);
  badge.dataset.action = 'open-pin-view';
  badge.textContent = '💬';
  badge.title = comment || '';
  badge.setAttribute('aria-label', 'show comment');
  return badge;
}

// Find the first occurrence of `needle` in `container`'s rendered text,
// tolerating whitespace differences. Returns a Range or null. Used to
// re-anchor pins after a render (where the saved selection text comes
// from chat history, possibly with collapsed whitespace).
function findFirstTextRangeIn(container, needle) {
  const target = (needle || '').replace(/\s+/g, ' ').trim();
  if (!target || target.length < 3) return null;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  // Build a normalized string + char→(node, offset) map.
  let normStr = '';
  const map = []; // map[i] = { node, offset } for normStr[i]
  let prevWs = true;
  let node;
  while ((node = walker.nextNode())) {
    // Skip text inside an existing pin badge (so re-anchoring doesn't latch
    // onto its own residue from a previous render).
    if (node.parentElement?.closest?.('.intake-plan-pin-badge')) continue;
    const txt = node.textContent;
    for (let i = 0; i < txt.length; i++) {
      const ch = txt[i];
      const isWs = /\s/.test(ch);
      if (isWs) {
        if (prevWs) continue;
        normStr += ' ';
        map.push({ node, offset: i });
        prevWs = true;
      } else {
        normStr += ch;
        map.push({ node, offset: i });
        prevWs = false;
      }
    }
  }
  while (normStr.endsWith(' ')) { normStr = normStr.slice(0, -1); map.pop(); }
  const idx = normStr.indexOf(target);
  if (idx < 0) return null;
  const startMap = map[idx];
  const endMap = map[idx + target.length - 1];
  if (!startMap || !endMap) return null;
  const r = document.createRange();
  try {
    r.setStart(startMap.node, startMap.offset);
    r.setEnd(endMap.node, endMap.offset + 1);
  } catch { return null; }
  return r;
}

function clearInlinePins() {
  const body = intakePlanBodyEl();
  if (!body) return;
  for (const m of body.querySelectorAll('mark.intake-plan-pin')) {
    while (m.firstChild) m.parentNode.insertBefore(m.firstChild, m);
    m.remove();
  }
  for (const b of body.querySelectorAll('.intake-plan-pin-badge')) b.remove();
}

// Walk pendingComments and try to wrap each one's passage. Sets
// `c.anchored` so renderPendingComments can skip the ones that landed
// inline (the bottom strip becomes an "orphan" overflow only).
function anchorInlinePins() {
  const body = intakePlanBodyEl();
  if (!body) return;
  for (const c of pendingComments) c.anchored = false;
  for (let i = 0; i < pendingComments.length; i++) {
    const c = pendingComments[i];
    const r = findFirstTextRangeIn(body, c.selection);
    if (!r) continue;
    const mark = wrapRangeWithPin(r, i, c.comment);
    if (mark) c.anchored = true;
  }
  renderPendingComments();
}
function reanchorInlinePins() {
  clearInlinePins();
  anchorInlinePins();
}

// Pending = user comments that came after the most recent assistant turn.
// On each finalize the assistant turn (the regenerated curriculum reply)
// pushes them into the past, so they auto-clear from the cache.
function derivePendingComments(history) {
  let lastAssistantIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant') { lastAssistantIdx = i; break; }
  }
  const out = [];
  for (let i = lastAssistantIdx + 1; i < history.length; i++) {
    const m = history[i];
    if (m.role !== 'user') continue;
    const parsed = parseCommentMessage(m.content);
    if (parsed) out.push({ ...parsed, _idx: i });
  }
  return out;
}

function parseCommentMessage(content) {
  const text = String(content || '');
  if (!text.startsWith(COMMENT_TAG)) return null;
  const rest = text.slice(COMMENT_TAG.length).replace(/^\n+/, '');
  const m = /^> "([\s\S]*?)"\n([\s\S]*)$/m.exec(rest);
  if (!m) return null;
  return { selection: m[1], comment: m[2].trim() };
}

function formatCommentMessage(selection, comment) {
  const sel = (selection || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  return `${COMMENT_TAG}\n> "${sel}"\n${comment.trim()}`;
}

function renderPendingComments() {
  const wrap = document.getElementById('intake-plan-comments');
  const list = document.getElementById('intake-plan-comments-list');
  const head = wrap?.querySelector('.intake-plan-comments-head');
  if (!wrap || !list) return;
  // Anchored pins are surfaced inline at their passage. The bottom strip
  // is a fallback for orphans (couldn't be re-anchored, e.g. the curriculum
  // was regenerated and the original passage no longer exists).
  const orphanIdxs = pendingComments
    .map((c, i) => (c.anchored ? -1 : i))
    .filter((i) => i >= 0);
  if (!orphanIdxs.length) {
    wrap.hidden = true;
    list.innerHTML = '';
    return;
  }
  wrap.hidden = false;
  if (head) {
    head.innerHTML = '<span>📌 Unanchored comments</span>'
      + ' <span class="hint intake-plan-comments-hint">— passage no longer in the plan, still queued for next regenerate</span>';
  }
  list.innerHTML = orphanIdxs.map((i) => {
    const c = pendingComments[i];
    return `<li>
      <div class="pc-quote">
        <span class="pc-quote-text">"${escapeHtml(c.selection.slice(0, 180))}${c.selection.length > 180 ? '…' : ''}"</span>
        <span class="pc-comment">${escapeHtml(c.comment)}</span>
      </div>
      <button type="button" class="pc-remove" data-action="remove-pending-comment" data-idx="${i}" title="discard this comment (also drops it from the chat)" aria-label="discard">×</button>
    </li>`;
  }).join('');
}

let intakeStreamController = null;
function setIntakeSubmitMode(mode) {
  const btn = document.querySelector('#intake-form button[type="submit"]');
  if (!btn) return;
  // Same icon-swap pattern as the chat send button — don't touch innerHTML
  // because the SVG send / stop icons live inside the button.
  btn.dataset.mode = mode;
  btn.setAttribute('aria-label', mode === 'stop' ? 'Stop' : 'Send');
  btn.title = mode === 'stop' ? 'Stop (Esc)' : 'Send (Enter)';
}

async function sendIntakeTurn(userMessage, finalize) {
  if (userMessage) {
    intakeHistory.push({ role: 'user', content: userMessage });
    appendIntakeMsg('user', userMessage);
  }
  const placeholder = appendIntakeMsg('assistant', '…');
  placeholder.classList.add('streaming');
  setStatus(finalize ? 'finalizing curriculum…' : 'intake (thinking…)');
  setIntakeSubmitMode('stop');

  const historyBefore = intakeHistory.filter((m) => m.role === 'assistant' || (userMessage && m.content !== userMessage));
  // Send history WITHOUT the just-pushed user message (server adds it via user_message)
  const histPayload = userMessage ? intakeHistory.slice(0, -1) : intakeHistory.slice();
  intakeStreamController = new AbortController();

  try {
    const resp = await fetch('/api/intake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        track: intakeTrack,
        user_message: userMessage,
        history: histPayload,
        action: finalize ? 'finalize' : 'ask',
      }),
      signal: intakeStreamController.signal,
    });
    if (!resp.ok || !resp.body) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`stream open failed: ${resp.status} ${txt.slice(0, 200)}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let fullText = '';
    let meta = null;
    let errMsg = null;
    placeholder.textContent = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        if (!chunk.startsWith('data: ')) continue;
        let ev;
        try { ev = JSON.parse(chunk.slice(6)); } catch { continue; }
        if (ev.type === 'delta') {
          fullText += ev.text;
          placeholder.innerHTML = md.render(fullText, {});
          // Auto-scroll the messages container (not window) — the chat-pane
          // itself doesn't scroll; only #intake-messages does.
          const msgs = document.getElementById('intake-messages');
          if (msgs) msgs.scrollTop = msgs.scrollHeight;
        } else if (ev.type === 'done') {
          meta = ev;
        } else if (ev.type === 'error') {
          errMsg = ev.error;
        }
      }
    }
    placeholder.classList.remove('streaming');
    if (errMsg) throw new Error(errMsg);
    if (!fullText && meta?.full_text) {
      fullText = meta.full_text;
      placeholder.innerHTML = md.render(fullText, {});
    }
    intakeHistory.push({ role: 'assistant', content: fullText });
    setStatus(`intake (${(meta?.duration_ms / 1000).toFixed(1)}s, $${meta?.cost_usd?.toFixed(3)})`);
    if (finalize) {
      // Plan-mode: stay in the intake view, refetch curriculum.md, refresh
      // the right pane in place. The user clicks `Start learning →` when
      // they're satisfied with the plan; auto-bouncing to the reader (the
      // old behaviour) prevented the iterate → comment → regenerate loop.
      setStatus(`curriculum updated · ${(meta?.duration_ms / 1000).toFixed(1)}s · $${meta?.cost_usd?.toFixed(3)}`);
      try {
        const cur = await fetch(`/api/tracks/${encodeURIComponent(intakeTrack)}/curriculum`).then((r) => r.json());
        if (cur?.ok) {
          setIntakePhase('has-plan');
          renderPlanPane(cur.content || '');
        }
      } catch {}
      // The just-finished assistant turn pushes any prior pending comments
      // into the past — recompute the cache.
      pendingComments = derivePendingComments(intakeHistory);
      renderPendingComments();
    }
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    placeholder.classList.remove('streaming');
    if (aborted) {
      if (!placeholder.textContent) placeholder.textContent = '(interrupted)';
      placeholder.classList.add('interrupted');
      setStatus('intake interrupted');
    } else {
      placeholder.textContent = '✗ ' + e.message;
      placeholder.classList.add('error');
      setStatus('intake error: ' + e.message);
    }
  } finally {
    intakeStreamController = null;
    setIntakeSubmitMode('ask');
  }
}

function appendIntakeMsg(role, content) {
  const msg = document.createElement('div');
  msg.className = `intake-msg ${role}`;
  if (role === 'user') {
    const parsed = parseCommentMessage(content);
    if (parsed) {
      // Inline-comment style: a quote of the highlighted passage + the
      // user's note. Visually distinct via the .comment class (pinned
      // badge + muted quote rail).
      msg.classList.add('comment');
      const body = document.createElement('div');
      body.className = 'sg-chat-msg-body';
      body.innerHTML =
        `<span class="pc-quote-text">"${escapeHtml(parsed.selection)}"</span>` +
        `<span class="pc-comment">${escapeHtml(parsed.comment)}</span>`;
      msg.appendChild(body);
    } else {
      const body = document.createElement('div');
      body.className = 'sg-chat-msg-body';
      body.textContent = content;
      msg.appendChild(body);
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'sg-chat-msg-edit-btn';
      editBtn.dataset.action = 'edit-intake-msg';
      editBtn.title = 'edit this message and re-run from here';
      editBtn.setAttribute('aria-label', 'edit');
      editBtn.textContent = '✎';
      msg.appendChild(editBtn);
    }
  } else if (content !== '…') {
    msg.innerHTML = md.render(content, {});
  } else {
    msg.textContent = content;
  }
  document.getElementById('intake-messages').appendChild(msg);
  return msg;
}

async function editIntakeMsgAndRerun(msgEl) {
  const idx = indexOfUserMsg(msgEl, intakeHistory);
  if (idx < 0) return;
  const original = intakeHistory[idx]?.content || '';
  enterMsgEditMode(msgEl, original, async (newText) => {
    const preHistory = intakeHistory.slice(0, idx);
    try {
      await fetch(`/api/tutor/${encodeURIComponent(intakeTrack)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history: preHistory }),
      });
    } catch (e) {
      setStatus('edit failed: ' + e.message);
      return;
    }
    intakeHistory = preHistory;
    const msgs = document.getElementById('intake-messages');
    // Strip the running curriculum-note too — it'll be re-appended by the
    // next enterIntake if relevant.
    msgs.innerHTML = '';
    for (const m of intakeHistory) appendIntakeMsg(m.role, m.content);
    sendIntakeTurn(newText, false);
  });
}

document.getElementById('intake-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const btn = ev.target.querySelector('button[type="submit"]');
  if (btn?.dataset.mode === 'stop') {
    if (intakeStreamController) { try { intakeStreamController.abort(); } catch {} }
    return;
  }
  const input = document.getElementById('intake-input');
  const val = input.value.trim();
  if (!val) return;
  pushIntakeInputHistory(val);
  input.value = '';
  autosizeTextarea(input);
  sendIntakeTurn(val, false);
});

// Intake input — Esc aborts an in-flight intake turn; ↑/↓ cycle history
// (only when cursor is at start, so multi-line editing isn't hijacked).
const intakeInputEl = document.getElementById('intake-input');
intakeInputEl?.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    if (intakeStreamController) {
      ev.preventDefault();
      try { intakeStreamController.abort(); } catch {}
    }
    return;
  }
  // Enter submits, Shift+Enter inserts a newline (Claude.app-style).
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) {
    ev.preventDefault();
    const form = document.getElementById('intake-form');
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    return;
  }
  if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
  // Only trigger when caret is at the very start (Up) or very end (Down)
  // so the user can still navigate inside multi-line text.
  const atStart = intakeInputEl.selectionStart === 0 && intakeInputEl.selectionEnd === 0;
  const atEnd = intakeInputEl.selectionStart === intakeInputEl.value.length;
  if (ev.key === 'ArrowUp' && !atStart) return;
  if (ev.key === 'ArrowDown' && !atEnd) return;
  const dir = ev.key === 'ArrowUp' ? 'up' : 'down';
  const ref = { value: intakeInputHistoryIdx };
  const handled = navigateInputHistory(intakeInputEl, intakeInputHistory, ref, dir);
  intakeInputHistoryIdx = ref.value;
  if (handled) ev.preventDefault();
});
intakeInputEl?.addEventListener('input', () => {
  intakeInputHistoryIdx = -1;
  autosizeTextarea(intakeInputEl);
});

// Edit-button delegate for past intake user messages.
document.getElementById('intake-messages').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-action="edit-intake-msg"]');
  if (!btn) return;
  const msg = btn.closest('.intake-msg.user');
  if (msg) editIntakeMsgAndRerun(msg);
});

// "Plan curriculum →" + plan-mode action buttons
document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'finalize-intake' || action === 'regenerate-plan') {
    ev.preventDefault();
    const pendingMsg = document.getElementById('intake-input').value.trim();
    document.getElementById('intake-input').value = '';
    sendIntakeTurn(pendingMsg || null, true);
  } else if (action === 'start-learning') {
    ev.preventDefault();
    if (intakeTrack) location.hash = `#/t/${encodeURIComponent(intakeTrack)}/`;
  } else if (action === 'back-to-plan') {
    ev.preventDefault();
    if (currentTrack) location.hash = `#/t/${encodeURIComponent(currentTrack)}/intake`;
  } else if (action === 'submit-inline-comment') {
    ev.preventDefault();
    submitInlineComment();
  } else if (action === 'cancel-inline-comment') {
    ev.preventDefault();
    hideCommentPopover();
  } else if (action === 'remove-pending-comment') {
    ev.preventDefault();
    const idx = Number(btn.dataset.idx);
    if (Number.isInteger(idx) && pendingComments[idx]) removePendingComment(idx);
  } else if (action === 'open-pin-view') {
    ev.preventDefault();
    const idx = Number(btn.dataset.idx);
    if (Number.isInteger(idx) && pendingComments[idx]) openPinView(idx, btn);
  } else if (action === 'close-pin-view') {
    ev.preventDefault();
    closePinView();
  } else if (action === 'delete-pin') {
    ev.preventDefault();
    const idx = _pinViewIdx;
    closePinView();
    if (Number.isInteger(idx) && pendingComments[idx]) removePendingComment(idx);
  }
});

// ---- pin-view popover (click on a 💬 badge) ---------------------------
let _pinViewIdx = -1;
function openPinView(idx, anchorEl) {
  const pop = document.getElementById('intake-pin-view');
  const txt = document.getElementById('intake-pin-view-text');
  if (!pop || !txt) return;
  if (pop.parentNode !== document.body) document.body.appendChild(pop);
  _pinViewIdx = idx;
  txt.textContent = pendingComments[idx]?.comment || '';
  pop.hidden = false;
  // Position below the badge, clamped to viewport.
  const r = anchorEl.getBoundingClientRect();
  const padding = 12;
  const popW = 280;
  let left = window.scrollX + r.left;
  const maxLeft = window.scrollX + document.documentElement.clientWidth - popW - padding;
  if (left > maxLeft) left = maxLeft;
  if (left < window.scrollX + padding) left = window.scrollX + padding;
  pop.style.left = left + 'px';
  pop.style.top = (window.scrollY + r.bottom + 6) + 'px';
}
function closePinView() {
  const pop = document.getElementById('intake-pin-view');
  if (pop) pop.hidden = true;
  _pinViewIdx = -1;
}
// Esc closes; click outside closes (but not when clicking another pin badge —
// that triggers a fresh open).
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  const pop = document.getElementById('intake-pin-view');
  if (pop && !pop.hidden) { ev.preventDefault(); closePinView(); }
});
document.addEventListener('mousedown', (ev) => {
  const pop = document.getElementById('intake-pin-view');
  if (!pop || pop.hidden) return;
  if (pop.contains(ev.target)) return;
  if (ev.target.closest?.('.intake-plan-pin-badge')) return; // re-open path
  closePinView();
});
// Keyboard activation of the badge (Enter / Space)
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  const badge = ev.target.closest?.('.intake-plan-pin-badge');
  if (!badge) return;
  ev.preventDefault();
  const idx = Number(badge.dataset.idx);
  if (Number.isInteger(idx) && pendingComments[idx]) openPinView(idx, badge);
});

// ---------- Plan-pane inline-comment flow ----------

// State for an in-progress comment popover. We capture the selection range +
// text the moment the popover opens so the click that focuses the textarea
// doesn't lose the selection.
let _commentSelText = '';
let _commentSelRange = null;

function intakePlanBodyEl() {
  return document.getElementById('intake-plan-body');
}

function ensurePopoverInBody() {
  // The popover is authored inside #view-intake; move it under <body> so we
  // can position it via document coordinates without parent-clipping.
  const pop = document.getElementById('intake-comment-popover');
  if (pop && pop.parentNode !== document.body) document.body.appendChild(pop);
  return pop;
}

function showCommentPopover(selectionText, anchorRect, sourceRange) {
  const pop = ensurePopoverInBody();
  if (!pop) return;
  _commentSelText = selectionText;
  // Snapshot the live range so we can wrap it on submit; the popover's
  // textarea-focus would otherwise collapse the user's selection.
  _commentSelRange = sourceRange?.cloneRange?.() || null;
  document.getElementById('intake-comment-popover-quote').textContent =
    `"${selectionText.length > 200 ? selectionText.slice(0, 200) + '…' : selectionText}"`;
  const ta = document.getElementById('intake-comment-popover-input');
  ta.value = '';
  pop.hidden = false;
  // Position below the selection's end, clamped to the viewport.
  const popW = 320;
  const padding = 12;
  let left = window.scrollX + anchorRect.left;
  const maxLeft = window.scrollX + document.documentElement.clientWidth - popW - padding;
  if (left > maxLeft) left = maxLeft;
  if (left < window.scrollX + padding) left = window.scrollX + padding;
  const top = window.scrollY + anchorRect.bottom + 6;
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  setTimeout(() => ta.focus(), 0);
}

function hideCommentPopover() {
  const pop = document.getElementById('intake-comment-popover');
  if (pop) pop.hidden = true;
  _commentSelText = '';
  _commentSelRange = null;
}

async function submitInlineComment() {
  const ta = document.getElementById('intake-comment-popover-input');
  const text = (ta?.value || '').trim();
  if (!text || !_commentSelText || !intakeTrack) return hideCommentPopover();
  // Snapshot the captured range BEFORE async work + DOM mutation. We'll wrap
  // it with a pin once the persist succeeds.
  const liveRange = _commentSelRange ? _commentSelRange.cloneRange() : null;
  const payload = formatCommentMessage(_commentSelText, text);
  // Persist server-side (so a reload before regenerate doesn't lose it).
  try {
    const r = await fetch(`/api/tutor/${encodeURIComponent(intakeTrack)}/append`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: payload }),
    }).then((r) => r.json());
    if (!r?.ok) throw new Error(r?.error || 'append failed');
  } catch (e) {
    setStatus('comment failed: ' + e.message);
    return;
  }
  // Optimistic local update: push to history + render in chat + refresh cache.
  intakeHistory.push({ role: 'user', content: payload });
  appendIntakeMsg('user', payload);
  pendingComments = derivePendingComments(intakeHistory);
  // Drop pre-existing pins first, then pin the new comment using the live
  // range (or fall back to a text-based re-anchor through anchorInlinePins).
  clearInlinePins();
  const newIdx = pendingComments.length - 1;
  if (liveRange) {
    const mark = wrapRangeWithPin(liveRange, newIdx, text);
    if (mark) pendingComments[newIdx].anchored = true;
  }
  // Re-anchor the others (and the new one if liveRange wrap failed).
  for (let i = 0; i < pendingComments.length; i++) {
    const c = pendingComments[i];
    if (c.anchored) continue;
    const r = findFirstTextRangeIn(intakePlanBodyEl(), c.selection);
    if (!r) continue;
    const m = wrapRangeWithPin(r, i, c.comment);
    if (m) c.anchored = true;
  }
  renderPendingComments();
  // Clear selection + popover (after the wrap, so we don't lose the range).
  try { window.getSelection()?.removeAllRanges(); } catch {}
  hideCommentPopover();
  setStatus('comment queued — click 🔄 Regenerate to apply');
}

async function removePendingComment(uiIdx) {
  const target = pendingComments[uiIdx];
  if (!target) return;
  // Drop from local history and PUT the truncated history back to the server.
  // We identify the entry by its _idx into intakeHistory.
  const newHistory = intakeHistory.filter((_, i) => i !== target._idx);
  try {
    const r = await fetch(`/api/tutor/${encodeURIComponent(intakeTrack)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: newHistory }),
    }).then((r) => r.json());
    if (!r?.ok) throw new Error(r?.error || 'remove failed');
  } catch (e) {
    setStatus('remove failed: ' + e.message);
    return;
  }
  intakeHistory = newHistory;
  // Re-render the chat from history (simplest correct approach).
  const msgs = document.getElementById('intake-messages');
  msgs.innerHTML = '';
  for (const m of intakeHistory) appendIntakeMsg(m.role, m.content);
  pendingComments = derivePendingComments(intakeHistory);
  reanchorInlinePins();
}

// Selection on the curriculum pane → show the comment popover.
//
// Why mouseup-based instead of selectionchange-based: while the user is
// drag-selecting, selectionchange fires continuously. Showing the popover
// mid-drag is bad on its own (jumpy UX) and worse because the popover
// auto-focuses its textarea, which steals window focus and *collapses
// the in-progress selection* — the user sees their drag "break" the
// instant they start. Waiting for mouseup means the selection is final
// and stable before we touch the DOM. We also gate on a small post-up
// timeout so the browser's selection has settled (some browsers update
// the Selection model just after mouseup).
function maybeOpenCommentPopover() {
  const pane = intakePlanBodyEl();
  if (!pane) return;
  const root = document.getElementById('view-intake');
  if (!root || root.hidden) return;
  if (root.dataset.phase !== 'has-plan') return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
  let node = sel.anchorNode;
  if (node && node.nodeType === 3) node = node.parentNode;
  if (!node || !pane.contains(node)) return;
  const text = selectionToTextWithLatex(sel);
  if (!text || text.length < 3) return;
  const range = sel.getRangeAt(0);
  const rects = range.getClientRects?.();
  const lastRect = (rects && rects.length) ? rects[rects.length - 1] : range.getBoundingClientRect();
  if (!lastRect) return;
  showCommentPopover(text, lastRect, range);
}
// Mouse-driven selection: open on mouseup inside (or starting in) plan body.
let _planMouseDown = false;
document.addEventListener('mousedown', (ev) => {
  if (intakePlanBodyEl()?.contains(ev.target)) _planMouseDown = true;
});
document.addEventListener('mouseup', (ev) => {
  if (!_planMouseDown) return;
  _planMouseDown = false;
  // Defer one tick so the Selection has settled.
  setTimeout(maybeOpenCommentPopover, 0);
});
// Keyboard-driven selection (shift+arrow, ctrl+a inside the pane) — open on
// keyup so a multi-keystroke selection only triggers once it's done.
document.addEventListener('keyup', (ev) => {
  if (!ev.shiftKey && ev.key !== 'Shift' && !(ev.ctrlKey || ev.metaKey)) return;
  if (!intakePlanBodyEl()?.contains(document.activeElement)
      && !intakePlanBodyEl()?.contains(window.getSelection()?.anchorNode)) return;
  setTimeout(maybeOpenCommentPopover, 0);
});
// If the user clicks elsewhere (collapsing the selection) while the popover
// is showing, hide it. Don't hide on every selectionchange — that would
// fight with our own `submitInlineComment` which clears the selection.
document.addEventListener('selectionchange', () => {
  const pop = document.getElementById('intake-comment-popover');
  if (!pop || pop.hidden) return;
  // Selection inside the popover textarea? leave it alone.
  if (pop.contains(document.activeElement)) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) hideCommentPopover();
});

// Esc dismisses the popover. Click outside (anywhere not the popover) too.
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  const pop = document.getElementById('intake-comment-popover');
  if (pop && !pop.hidden) { ev.preventDefault(); hideCommentPopover(); }
});
document.addEventListener('mousedown', (ev) => {
  const pop = document.getElementById('intake-comment-popover');
  if (!pop || pop.hidden) return;
  if (pop.contains(ev.target)) return;
  // Don't dismiss if the user is selecting more text inside the plan body.
  if (intakePlanBodyEl()?.contains(ev.target)) return;
  hideCommentPopover();
});

// Enter submits the inline comment, Shift+Enter for newline.
document.getElementById('intake-comment-popover-input')?.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) {
    ev.preventDefault();
    submitInlineComment();
  }
});

// ---------- intake material viewer + 3-column resize ----------
// Parallel to the reader's `materialViewer` IIFE but specialised for the
// plan view: separate DOM nodes, separate width var, no narrow-viewport
// gating (the viewport already collapses to a stacked layout < 1100px).

const intakeMaterialViewer = (() => {
  const root    = document.getElementById('intake-mv-pane');
  const handle  = document.querySelector('.intake-resize-handle[data-resize="mv"]');
  const nameEl  = document.getElementById('intake-mv-name');
  const bodyEl  = document.getElementById('intake-mv-body');
  const openLink = document.getElementById('intake-mv-open');
  let state = { track: null, name: null };

  function isPdf(name)   { return /\.pdf$/i.test(name); }
  function isImage(name) { return /\.(png|jpe?g|gif|webp|svg)$/i.test(name); }
  function isText(name)  { return /\.(md|txt|json|js|py|css|html|csv)$/i.test(name); }
  function isMd(name)    { return /\.md$/i.test(name); }
  function urlFor(track, name) { return `/api/tracks/${encodeURIComponent(track)}/materials/${encodeURIComponent(name)}`; }

  function syncListActive() {
    const list = document.getElementById('intake-materials-list');
    if (!list) return;
    for (const item of list.querySelectorAll('.material-item')) {
      const match = state.name && item.dataset.name === state.name && item.dataset.track === state.track;
      item.classList.toggle('is-open', !!match);
    }
  }

  async function render() {
    bodyEl.innerHTML = '<div class="material-loading">loading…</div>';
    const { track, name } = state;
    const url = urlFor(track, name);
    openLink.href = url;
    if (isPdf(name)) {
      bodyEl.innerHTML = `<iframe src="${escapeHtml(url)}" title="${escapeHtml(name)}"></iframe>`;
      return;
    }
    if (isImage(name)) {
      bodyEl.innerHTML = `<img class="material-preview" src="${escapeHtml(url)}" alt="${escapeHtml(name)}">`;
      return;
    }
    if (isText(name)) {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const text = await r.text();
        if (state.track !== track || state.name !== name) return;
        if (isMd(name)) bodyEl.innerHTML = `<div class="material-md">${md.render(text, {})}</div>`;
        else bodyEl.innerHTML = `<pre class="material-text">${escapeHtml(text)}</pre>`;
      } catch (e) {
        bodyEl.innerHTML = `<div class="material-error">failed to load: ${escapeHtml(e.message || String(e))}</div>`;
      }
      return;
    }
    bodyEl.innerHTML =
      `<div class="material-unsupported">Preview not available for this file type.` +
      `<br><a href="${escapeHtml(url)}" target="_blank" rel="noopener">Open / download ↗</a></div>`;
  }

  function open(track, name) {
    if (!track || !name) return;
    state = { track, name };
    nameEl.textContent = name;
    nameEl.title = name;
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    if (handle) handle.hidden = false;
    syncListActive();
    render();
  }
  function close() {
    state = { track: null, name: null };
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    if (handle) handle.hidden = true;
    bodyEl.innerHTML = '';
    nameEl.textContent = '';
    syncListActive();
  }
  function toggle(track, name) {
    if (state.track === track && state.name === name && !root.hidden) close();
    else open(track, name);
  }
  function isOpen() { return !root.hidden; }
  return { open, close, toggle, isOpen, get state() { return state; }, syncListActive };
})();

// Re-route material clicks while the intake/plan view is showing — the
// reader's materialViewer is gated on `#view-reader .app` and would no-op.
function intakeIsActive() {
  const v = document.getElementById('view-intake');
  return v && !v.hidden;
}
document.addEventListener('click', (ev) => {
  if (!intakeIsActive()) return;
  const node = ev.target.closest?.('[data-action]');
  if (!node) return;
  const action = node.dataset.action;
  if (action === 'open-material') {
    ev.preventDefault();
    ev.stopPropagation();
    intakeMaterialViewer.toggle(node.dataset.track || intakeTrack, node.dataset.name);
  } else if (action === 'close-intake-material') {
    ev.preventDefault();
    intakeMaterialViewer.close();
  } else if (action === 'toggle-intake-mat') {
    ev.preventDefault();
    toggleIntakeMaterials();
  }
}, true); // capture so we run before the reader's open-material handler

// Sync the active-row highlight whenever the materials list re-renders.
const _intakeMatList = document.getElementById('intake-materials-list');
if (_intakeMatList) {
  new MutationObserver(() => intakeMaterialViewer.syncListActive())
    .observe(_intakeMatList, { childList: true });
}

// --- Materials sidebar collapse / reopen --------------------------------
function toggleIntakeMaterials() {
  const pane = document.getElementById('intake-mat-pane');
  const reopen = document.querySelector('.intake-mat-reopen');
  const handle = document.querySelector('.intake-resize-handle[data-resize="mat"]');
  if (!pane || !reopen) return;
  const collapse = !pane.hidden;
  pane.hidden = collapse;
  reopen.hidden = !collapse;
  if (handle) handle.hidden = collapse; // hide the drag handle when collapsed
  try { localStorage.setItem('sg.intakeMatCollapsed', collapse ? '1' : '0'); } catch {}
}
// Restore collapsed state on first load.
(function restoreIntakeMatState() {
  let collapsed = false;
  try { collapsed = localStorage.getItem('sg.intakeMatCollapsed') === '1'; } catch {}
  if (!collapsed) return;
  const pane = document.getElementById('intake-mat-pane');
  const reopen = document.querySelector('.intake-mat-reopen');
  const handle = document.querySelector('.intake-resize-handle[data-resize="mat"]');
  if (pane) pane.hidden = true;
  if (reopen) reopen.hidden = false;
  if (handle) handle.hidden = true;
})();

// --- Resize handles (3 dividers, one set of drag logic) ----------------
// Each handle is identified by `data-resize`:
//   mat  → drags the right edge of the materials pane (--intake-mat-w grows)
//   mv   → drags the right edge of the viewer pane (--intake-mv-w grows)
//   chat → drags the chat | plan boundary (--intake-plan-w grows on left-drag)
// Widths persist in localStorage; restored on init below.
const INTAKE_RESIZE_VARS = {
  mat:  { name: '--intake-mat-w',  min: 160, max: 600, dir: +1 },
  mv:   { name: '--intake-mv-w',   min: 280, max: 900, dir: +1 },
  chat: { name: '--intake-plan-w', min: 320, max: 1200, dir: -1 },
};
function getCssPx(varName, fallback) {
  const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue(varName), 10);
  return Number.isFinite(v) ? v : fallback;
}
function setCssPx(varName, px, opts = {}) {
  document.documentElement.style.setProperty(varName, Math.round(px) + 'px');
  if (!opts.transient) {
    try { localStorage.setItem('sg.intake' + varName, String(Math.round(px))); } catch {}
  }
}
// Restore persisted widths.
(function restoreIntakeWidths() {
  for (const cfg of Object.values(INTAKE_RESIZE_VARS)) {
    let v;
    try { v = parseInt(localStorage.getItem('sg.intake' + cfg.name) || '', 10); } catch {}
    if (Number.isFinite(v)) {
      setCssPx(cfg.name, Math.max(cfg.min, Math.min(cfg.max, v)), { transient: true });
    }
  }
})();

let _resizeRaf = 0;
let _resizeCfg = null;
let _resizeStartW = 0;
let _resizeStartX = 0;
let _resizePendX = 0;
function _applyResize() {
  _resizeRaf = 0;
  const dx = (_resizePendX - _resizeStartX) * _resizeCfg.dir;
  const w = Math.max(_resizeCfg.min, Math.min(_resizeCfg.max, _resizeStartW + dx));
  setCssPx(_resizeCfg.name, w, { transient: true });
}
function _onResizeMove(ev) {
  _resizePendX = ev.clientX;
  if (!_resizeRaf) _resizeRaf = requestAnimationFrame(_applyResize);
}
function _onResizeEnd() {
  document.removeEventListener('pointermove', _onResizeMove);
  document.removeEventListener('pointerup', _onResizeEnd);
  if (_resizeRaf) { cancelAnimationFrame(_resizeRaf); _resizeRaf = 0; _applyResize(); }
  // Persist final width.
  setCssPx(_resizeCfg.name, getCssPx(_resizeCfg.name, _resizeStartW));
  document.getElementById('view-intake')?.classList.remove('intake-dragging');
  document.querySelectorAll('.intake-resize-handle.dragging')
    .forEach((h) => h.classList.remove('dragging'));
  _resizeCfg = null;
}
document.addEventListener('pointerdown', (ev) => {
  const handle = ev.target.closest?.('.intake-resize-handle');
  if (!handle || handle.hidden) return;
  if (ev.button !== 0) return;
  const cfg = INTAKE_RESIZE_VARS[handle.dataset.resize];
  if (!cfg) return;
  ev.preventDefault();
  _resizeCfg = cfg;
  _resizeStartX = ev.clientX;
  _resizePendX = ev.clientX;
  _resizeStartW = getCssPx(cfg.name, 320);
  handle.classList.add('dragging');
  document.getElementById('view-intake')?.classList.add('intake-dragging');
  try { handle.setPointerCapture(ev.pointerId); } catch {}
  document.addEventListener('pointermove', _onResizeMove);
  document.addEventListener('pointerup', _onResizeEnd);
});
// Keyboard resize: focused handle + Left/Right.
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
  const handle = ev.target.closest?.('.intake-resize-handle');
  if (!handle || handle.hidden) return;
  const cfg = INTAKE_RESIZE_VARS[handle.dataset.resize];
  if (!cfg) return;
  const step = ev.shiftKey ? 40 : 12;
  const dx = (ev.key === 'ArrowRight' ? +1 : -1) * cfg.dir * step;
  const cur = getCssPx(cfg.name, 320);
  const next = Math.max(cfg.min, Math.min(cfg.max, cur + dx));
  setCssPx(cfg.name, next);
  ev.preventDefault();
});

async function renderHome() {
  trackGrid.innerHTML = '<p class="hint" style="grid-column:1/-1">loading…</p>';
  try {
    const r = await fetch('/api/tracks').then((r) => r.json());
    const tracks = r.tracks || [];
    const cards = tracks.map(trackCardHtml).join('');
    trackGrid.innerHTML =
      cards +
      `<button class="track-card create" data-action="open-new-track">
        <span class="track-emoji">+</span>
        <span class="track-title">New course</span>
        <span class="track-desc">Set a title, drop in materials, start reading.</span>
      </button>`;
  } catch (e) {
    trackGrid.innerHTML = `<p class="hint" style="grid-column:1/-1">failed to load tracks: ${escapeHtml(e.message)}</p>`;
  }
}

function trackCardHtml(t) {
  const meta = `${t.lesson_count || 0} lessons · ${t.material_count || 0} materials`;
  const hasDesc = (t.description || '').trim().length > 0;
  // Plan-mode routing: courses with no lessons yet open in the plan view
  // (where the user can keep iterating on the curriculum). Once lesson 01
  // exists, home clicks open the reader directly.
  const target = (t.lesson_count || 0) > 0
    ? `#/t/${encodeURIComponent(t.slug)}/`
    : `#/t/${encodeURIComponent(t.slug)}/intake`;
  return `<a class="track-card ${t.is_current_track ? 'current' : ''}" href="${target}" data-action="open-track" data-slug="${escapeHtml(t.slug)}">
    <span class="track-card-actions">
      <button class="track-edit" data-action="edit-track" data-slug="${escapeHtml(t.slug)}" title="edit title / description / cover" aria-label="edit">✎</button>
      <button class="track-export" data-action="export-track" data-slug="${escapeHtml(t.slug)}" title="download course as .tgz" aria-label="export">⬇</button>
      <button class="track-delete" data-action="delete-track" data-slug="${escapeHtml(t.slug)}" title="delete course" aria-label="delete">×</button>
    </span>
    <span class="track-emoji">${escapeHtml(t.emoji || COVER_EMOJIS[0])}</span>
    <span class="track-title">${escapeHtml(t.title || t.slug)}</span>
    <span class="track-desc">${hasDesc ? escapeHtml(t.description) : '<i style="opacity:0.55">no description</i>'}</span>
    <span class="track-meta">${escapeHtml(meta)}</span>
  </a>`;
}

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-action]');
  if (!t) return;
  const action = t.dataset.action;
  if (action === 'open-new-track') {
    ev.preventDefault();
    // Always start fresh — the form holds onto whatever the user clicked
    // last time even if they hit Cancel, which is surprising.
    newTrackForm.reset();
    setEmojiPickerValue(_ntPicker, document.getElementById('nt-emoji'), COVER_EMOJIS[0]);
    newTrackDialog.showModal();
    setTimeout(() => newTrackDialog.querySelector('#nt-title').focus(), 30);
  } else if (action === 'close-dialog') {
    ev.preventDefault();
    newTrackDialog.close();
    newTrackForm.reset();
    setEmojiPickerValue(_ntPicker, document.getElementById('nt-emoji'), COVER_EMOJIS[0]);
  } else if (action === 'close-edit-dialog') {
    ev.preventDefault();
    editTrackDialog.close();
  } else if (action === 'edit-track') {
    ev.preventDefault();
    ev.stopPropagation();
    openEditTrack(t.dataset.slug);
  } else if (action === 'delete-track') {
    ev.preventDefault();
    ev.stopPropagation();
    const slug = t.dataset.slug;
    if (!confirm(`Delete course "${slug}"?\n\nThis removes the entire tracks/${slug}/ folder (lessons, exercises, materials, threads, curriculum). Irreversible.`)) return;
    try {
      const r = await fetch(`/api/tracks/${encodeURIComponent(slug)}`, { method: 'DELETE' }).then((r) => r.json());
      if (!r.ok) throw new Error(r.error || 'delete failed');
      invalidateTrackSlugCache();
      renderHome();
    } catch (e) {
      alert('delete failed: ' + e.message);
    }
  } else if (action === 'export-track') {
    ev.preventDefault();
    ev.stopPropagation();
    const slug = t.dataset.slug;
    // Trigger download via anchor
    const a = document.createElement('a');
    a.href = `/api/tracks/${encodeURIComponent(slug)}/export`;
    a.download = `${slug}.tgz`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus(`exporting ${slug}.tgz…`);
  } else if (action === 'import-track') {
    ev.preventDefault();
    importTrackFileInput.click();
  }
});

// Hidden file input for course import
const importTrackFileInput = document.createElement('input');
importTrackFileInput.type = 'file';
importTrackFileInput.accept = '.tgz,.tar.gz,application/gzip,application/x-gzip,application/octet-stream';
importTrackFileInput.style.display = 'none';
importTrackFileInput.addEventListener('change', async (ev) => {
  const f = ev.target.files?.[0];
  if (!f) return;
  setStatus(`importing ${f.name}…`);
  try {
    const buf = await f.arrayBuffer();
    const r = await fetch('/api/tracks/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip' },
      body: buf,
    }).then((r) => r.json());
    if (!r.ok) throw new Error(r.error || 'import failed');
    invalidateTrackSlugCache();
    setStatus(`imported as "${r.slug}"`);
    location.hash = `#/t/${encodeURIComponent(r.slug)}/`;
  } catch (e) {
    setStatus('import error: ' + e.message);
    alert('import failed: ' + e.message);
  }
  ev.target.value = '';
});
document.body.appendChild(importTrackFileInput);

newTrackForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(newTrackForm);
  try {
    const r = await fetch('/api/tracks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: fd.get('title'),
        description: fd.get('description'),
        emoji: fd.get('emoji'),
      }),
    }).then((r) => r.json());
    if (!r.ok) throw new Error(r.error || 'create failed');
    invalidateTrackSlugCache();
    newTrackDialog.close();
    newTrackForm.reset();
    setEmojiPickerValue(_ntPicker, document.getElementById('nt-emoji'), COVER_EMOJIS[0]);
    // Land in intake for new tracks
    location.hash = `#/t/${encodeURIComponent(r.track.slug)}/intake`;
  } catch (e) {
    alert('create failed: ' + e.message);
  }
});

async function openEditTrack(slug) {
  if (!slug) return;
  try {
    const r = await fetch(`/api/tracks/${encodeURIComponent(slug)}`).then((r) => r.json());
    if (!r.ok) throw new Error(r.error || 'not found');
    const t = r.track;
    editTrackForm.dataset.slug = slug;
    setEmojiPickerValue(_etPicker, document.getElementById('et-emoji'), t.emoji || COVER_EMOJIS[0]);
    document.getElementById('et-title').value = t.title || '';
    document.getElementById('et-desc').value = t.description || '';
    document.getElementById('et-slug-hint').textContent =
      `slug: ${slug} (locked — won't rename folder or URLs)`;
    editTrackDialog.showModal();
    setTimeout(() => document.getElementById('et-title').focus(), 30);
  } catch (e) {
    alert('could not load course: ' + e.message);
  }
}

editTrackForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const slug = editTrackForm.dataset.slug;
  if (!slug) return;
  const fd = new FormData(editTrackForm);
  try {
    const r = await fetch(`/api/tracks/${encodeURIComponent(slug)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: (fd.get('title') || '').toString().trim(),
        description: (fd.get('description') || '').toString().trim(),
        emoji: (fd.get('emoji') || '').toString().trim() || COVER_EMOJIS[0],
      }),
    }).then((r) => r.json());
    if (!r.ok) throw new Error(r.error || 'update failed');
    editTrackDialog.close();
    renderHome();
    setStatus(`updated "${r.track.title}"`);
  } catch (e) {
    alert('update failed: ' + e.message);
  }
});

// ---------- Command palette ----------
const cmdDialog = document.getElementById('cmd-palette');
const cmdInput = document.getElementById('cmd-input');
const cmdList = document.getElementById('cmd-list');
let cmdItems = [];
let cmdActiveIdx = 0;

async function buildCmdItems(query) {
  const q = (query || '').trim().toLowerCase();
  const items = [];
  // Actions
  const actions = [
    { label: 'Go to home', icon: '⌂', run: () => (location.hash = '#/'), group: 'actions' },
    { label: 'Cycle theme', hint: getStoredTheme(), icon: '◐', run: () => {
        const cur = getStoredTheme();
        const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
        localStorage.setItem('sg-theme', next); applyTheme(next);
      }, group: 'actions' },
  ];
  if (currentTrack) {
    actions.push({ label: 'Generate next lesson', icon: '＋', hint: 'streams', run: () => btnNext.click(), group: 'actions' });
    if (currentSlug) {
      actions.push({ label: 'Recap current lesson', icon: '↻', hint: currentSlug, run: () => btnRecap.click(), group: 'actions' });
      actions.push({ label: 'Add material to current course', icon: '⬆', run: () => materialFileInput.click(), group: 'actions' });
    }
  }
  for (const a of actions) {
    if (!q || (a.label + ' ' + (a.hint || '')).toLowerCase().includes(q)) items.push(a);
  }
  // Lessons (within current track)
  if (currentTrack && _allLessons.length) {
    for (const slug of _allLessons) {
      const label = 'Go to ' + slug.replace(/^\d+-/, '').replace(/-/g, ' ');
      if (!q || (label + ' ' + slug).toLowerCase().includes(q)) {
        items.push({ label, hint: slug, icon: '§', run: () => loadLesson(slug), group: 'lessons' });
      }
    }
  }
  // Courses (across tracks)
  try {
    const r = await fetch('/api/tracks').then((r) => r.json());
    for (const t of r.tracks || []) {
      const label = `Open course: ${t.title || t.slug}`;
      if (!q || (label + ' ' + t.slug + ' ' + (t.description || '')).toLowerCase().includes(q)) {
        items.push({
          label,
          hint: `${t.lesson_count}L · ${t.material_count}M`,
          icon: t.emoji || COVER_EMOJIS[0],
          run: () => (location.hash = `#/t/${encodeURIComponent(t.slug)}/`),
          group: 'courses',
        });
      }
    }
  } catch {}
  return items;
}

function renderCmdList() {
  if (!cmdItems.length) {
    cmdList.innerHTML = '<li class="cmd-item" style="color:var(--text-faint)"><span class="cmd-icon">·</span><span class="cmd-label">no matches</span></li>';
    return;
  }
  let html = '';
  let prevGroup = null;
  cmdItems.forEach((it, idx) => {
    if (it.group !== prevGroup) {
      html += `<li class="cmd-group-label">${escapeHtml(it.group)}</li>`;
      prevGroup = it.group;
    }
    html += `<li class="cmd-item ${idx === cmdActiveIdx ? 'active' : ''}" data-idx="${idx}">
      <span class="cmd-icon">${escapeHtml(it.icon || '·')}</span>
      <span class="cmd-label">${escapeHtml(it.label)}</span>
      ${it.hint ? `<span class="cmd-hint-text">${escapeHtml(it.hint)}</span>` : ''}
    </li>`;
  });
  cmdList.innerHTML = html;
}

async function refreshCmd() {
  cmdItems = await buildCmdItems(cmdInput.value);
  cmdActiveIdx = Math.min(cmdActiveIdx, Math.max(0, cmdItems.length - 1));
  renderCmdList();
}

function openCmdPalette() {
  if (cmdDialog.open) return;
  cmdInput.value = '';
  cmdActiveIdx = 0;
  refreshCmd().then(() => {
    cmdDialog.showModal();
    setTimeout(() => cmdInput.focus(), 30);
  });
}

cmdInput.addEventListener('input', () => { cmdActiveIdx = 0; refreshCmd(); });
cmdInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowDown') {
    ev.preventDefault();
    if (cmdItems.length) { cmdActiveIdx = (cmdActiveIdx + 1) % cmdItems.length; renderCmdList(); }
  } else if (ev.key === 'ArrowUp') {
    ev.preventDefault();
    if (cmdItems.length) { cmdActiveIdx = (cmdActiveIdx - 1 + cmdItems.length) % cmdItems.length; renderCmdList(); }
  } else if (ev.key === 'Enter') {
    ev.preventDefault();
    const it = cmdItems[cmdActiveIdx];
    if (it) { cmdDialog.close(); it.run(); }
  }
});
cmdList.addEventListener('click', (ev) => {
  const li = ev.target.closest('.cmd-item');
  if (!li) return;
  const idx = Number(li.dataset.idx);
  const it = cmdItems[idx];
  if (it) { cmdDialog.close(); it.run(); }
});

// Centralised Escape dispatcher — fires in capture phase before any of the
// per-feature handlers (palette / chat / viewer / outline popover), picks
// the top-most open layer, closes only that one, and stops propagation so
// only one layer closes per Esc press. Without this, every independent
// document-level Esc handler fires on the same press and collapses
// multiple layers at once.
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  // Priority: cmd palette > chat panel > material viewer > outline popover.
  if (cmdDialog?.open) {
    cmdDialog.close();
  } else if (document.querySelector('.sg-chat-panel.show')) {
    // Inline the chat-Esc logic so we can stopImmediatePropagation here.
    // If a turn is streaming, abort it; otherwise close the panel.
    if (currentPanelKey && inflightStreams.has(currentPanelKey)) {
      abortInflight(currentPanelKey);
    } else {
      closeChatPanel();
    }
  } else if (!document.getElementById('material-viewer')?.hidden) {
    materialViewer?.close?.();
  } else if (document.body.classList.contains('outline-pop-open')) {
    setOutlinePopOpen(false);
  } else {
    return; // nothing to close; let other handlers (textarea, etc.) run
  }
  ev.stopImmediatePropagation();
  ev.preventDefault();
}, true); // capture phase

document.addEventListener('keydown', (ev) => {
  const isCmdK = (ev.metaKey || ev.ctrlKey) && (ev.key === 'k' || ev.key === 'K');
  if (isCmdK) {
    ev.preventDefault();
    openCmdPalette();
  } else if ((ev.metaKey || ev.ctrlKey) && ev.key === '/') {
    // ⌘/ — quick selection-to-btw shortcut (if anything selected in lesson)
    const winSel = window.getSelection();
    if (winSel && view.contains(winSel.anchorNode)) {
      const sel = selectionToTextWithLatex(winSel);
      if (sel && sel.length > 3) {
        ev.preventDefault();
        openChatPanel(sel);
      }
    }
  }
});

window.addEventListener('hashchange', route);
route();
