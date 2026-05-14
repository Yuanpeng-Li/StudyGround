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
  const label = kind === 'btw' ? 'btw' : 'q';
  const dig = kind === 'btw'
    ? `<button class="sg-q-dig" data-action="dig-deeper" data-question="${escapeHtml(text)}" title="dig deeper into this">dig deeper</button>`
    : '';
  return `<div class="sg-question ${kind}" data-index="${index}" data-kind="${kind}" data-source="${escapeHtml(text)}">
    <span class="sg-q-label">${label}</span>
    <span class="sg-q-text">${rendered}</span>
    ${dig}
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
}

// ---------- App state ----------
// ---------- Theme toggle (works for any .theme-toggle on the page) ----------
const THEMES = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: 'auto', light: 'light', dark: 'dark' };
function getStoredTheme() {
  return localStorage.getItem('sg-theme') || 'auto';
}
function applyTheme(theme) {
  const root = document.documentElement;
  const actual = theme === 'auto'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  root.setAttribute('data-theme', actual);
  for (const btn of document.querySelectorAll('.theme-toggle')) {
    btn.textContent = THEME_LABEL[theme];
  }
}
applyTheme(getStoredTheme());
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (getStoredTheme() === 'auto') applyTheme('auto');
});
document.addEventListener('DOMContentLoaded', () => {
  for (const btn of document.querySelectorAll('.theme-toggle')) {
    btn.textContent = THEME_LABEL[getStoredTheme()];
  }
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

async function loadList() {
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
    items.push({ level: h.tagName, html: clone.innerHTML.trim(), id });
  }
  sidebarOutline.innerHTML = items
    .map(
      (it) =>
        `<li class="outline-li">
          <a href="#${it.id}" data-action="jump-section" data-id="${it.id}" class="outline-${it.level === 'H2' ? 2 : 3}">${it.html}</a>
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
        return `<li><div class="material-item">
          <span class="material-name" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</span>
          <span class="material-size">${sizeKb}</span>
          <button class="material-del" data-action="delete-material" data-name="${escapeHtml(m.name)}" data-track="${escapeHtml(track)}" title="delete" aria-label="delete">×</button>
        </div></li>`;
      })
      .join('');
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
    setStatus(`uploaded ${r.name}`);
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

// Hidden file input — dataset.track tells the change handler where to upload.
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
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'add-material') {
    ev.preventDefault();
    materialFileInput.dataset.track = currentTrack || '';
    materialFileInput.click();
  } else if (btn.dataset.action === 'add-intake-material') {
    ev.preventDefault();
    materialFileInput.dataset.track = intakeTrack || '';
    materialFileInput.click();
  } else if (btn.dataset.action === 'delete-material') {
    ev.preventDefault();
    deleteMaterial(btn.dataset.track || currentTrack, btn.dataset.name);
  }
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
        const preview = (t.first_question || t.selection || '').slice(0, 60);
        const ago = relTime(t.updated_at);
        return `<li class="thread-li">
          <button class="thread-item" data-action="open-thread" data-id="${escapeHtml(t.id)}" title="${escapeHtml(t.selection || '')}">
            <span class="thread-preview">${escapeHtml(preview)}</span>
            <span class="thread-meta">${t.turns}T · ${ago}</span>
          </button>
          <div class="thread-actions">
            <button class="thread-act" data-action="download-thread" data-id="${escapeHtml(t.id)}" title="download .md" aria-label="download">⬇</button>
            <button class="thread-act" data-action="delete-thread" data-id="${escapeHtml(t.id)}" title="delete" aria-label="delete">×</button>
          </div>
        </li>`;
      })
      .join('');
  } catch {}
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

let _sectionObserver = null;
function setupSectionObserver(items) {
  if (_sectionObserver) _sectionObserver.disconnect();
  if (!items.length) return;
  _sectionObserver = new IntersectionObserver(
    (entries) => {
      // Find topmost entry that's intersecting from above
      let bestId = null;
      let bestTop = -Infinity;
      for (const e of entries) {
        if (e.isIntersecting) {
          const top = e.boundingClientRect.top;
          if (top <= 80 && top > bestTop) {
            bestTop = top;
            bestId = e.target.id;
          }
        }
      }
      if (bestId) markOutlineActive(bestId);
    },
    { rootMargin: '-60px 0px -70% 0px', threshold: [0, 1] },
  );
  for (const it of items) {
    const el = document.getElementById(it.id);
    if (el) _sectionObserver.observe(el);
  }
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
  if (action === 'dig-deeper') {
    ev.preventDefault();
    const q = ev.target.dataset.question;
    if (q) openChatPanel(q);
  }
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
    window.location.href = r.vscode_uri;
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
    if (!threadId || !chatSelection) return;
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
  lines.push(`# btw chat — ${(thread.updated_at || '').slice(0, 10)}`);
  lines.push('');
  lines.push(`> _Selected from_ \`lessons/${thread.lesson}.md\``);
  lines.push('>');
  for (const line of String(thread.selection || '').split('\n')) {
    lines.push('> ' + line);
  }
  lines.push('');
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

function ensureSelToolbar() {
  if (selToolbar) return selToolbar;
  selToolbar = document.createElement('div');
  selToolbar.className = 'sg-sel-toolbar';
  selToolbar.innerHTML = `<button data-action="btw-ask-selection" title="ask Claude about the highlighted passage"><span class="sg-sel-icon">✦</span><span class="sg-sel-text">ask</span></button>`;
  selToolbar.addEventListener('mousedown', (ev) => ev.preventDefault()); // don't clear selection
  selToolbar.addEventListener('click', (ev) => {
    if (ev.target.dataset?.action === 'btw-ask-selection') {
      const sel = window.getSelection()?.toString().trim();
      if (sel) openChatPanel(sel);
    }
  });
  document.body.appendChild(selToolbar);
  return selToolbar;
}

function hideSelToolbar() {
  if (selToolbar) selToolbar.classList.remove('show');
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

  // Clone the selected content and replace math nodes with $...$ / $$...$$
  const range = sel.getRangeAt(0);
  const frag = range.cloneContents();
  const walker = document.createTreeWalker(frag, NodeFilter.SHOW_ELEMENT);
  const toReplace = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.classList && node.classList.contains('sg-math')) toReplace.push(node);
  }
  let hadMath = false;
  for (const el of toReplace) {
    const latex = el.getAttribute('data-latex') || '';
    const isBlock = el.classList.contains('sg-math-block');
    const wrapped = isBlock ? `$$${latex}$$` : `$${latex}$`;
    el.replaceWith(document.createTextNode(wrapped));
    hadMath = true;
  }
  if (!hadMath) return; // let the default copy work for plain text

  // Serialize with reasonable block-level newlines by attaching off-screen briefly
  const tmp = document.createElement('div');
  tmp.style.cssText = 'position:absolute;left:-99999px;top:0;white-space:pre-wrap;';
  tmp.appendChild(frag);
  document.body.appendChild(tmp);
  const text = tmp.innerText;
  tmp.remove();

  try {
    ev.clipboardData.setData('text/plain', text);
    ev.preventDefault();
  } catch {
    // If clipboardData unavailable, fall through to default
  }
});

document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return hideSelToolbar();
  const text = sel.toString().trim();
  if (text.length < 3) return hideSelToolbar();
  const range = sel.getRangeAt(0);
  // Only show when selection is inside the lesson view
  let node = range.commonAncestorContainer;
  if (node.nodeType === 3) node = node.parentNode;
  if (!view.contains(node)) return hideSelToolbar();
  // Also don't trigger inside the chat panel itself
  if (chatPanel && chatPanel.contains(node)) return hideSelToolbar();
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return hideSelToolbar();
  const tb = ensureSelToolbar();
  // Position above the selection, center on it; pill self-centers via translateX(-50%).
  tb.style.top = window.scrollY + rect.top - 44 + 'px';
  tb.style.left = window.scrollX + rect.left + rect.width / 2 + 'px';
  tb.classList.add('show');
});

function ensureChatPanel() {
  if (chatPanel) return chatPanel;
  chatPanel = document.createElement('aside');
  chatPanel.className = 'sg-chat-panel';
  chatPanel.innerHTML = `
    <div class="sg-chat-resize" title="drag to resize"></div>
    <div class="sg-chat-head">
      <span class="sg-chat-title">btw</span>
      <div class="sg-chat-head-actions">
        <button class="sg-chat-copy" data-action="copy-thread-md" title="copy this conversation as markdown">copy md</button>
        <button class="sg-chat-save" data-action="save-chat" title="save this conversation as a ?>> block in the lesson" disabled>Save to lesson</button>
        <button class="sg-chat-close" data-action="close-chat" title="close (Esc)">×</button>
      </div>
    </div>
    <div class="sg-chat-selection"></div>
    <div class="sg-chat-messages"></div>
    <form class="sg-chat-form">
      <div class="sg-chat-quote-chip" title="this snippet (selected inside the panel) will be sent as context"></div>
      <input type="text" name="q" placeholder="ask about this passage… (or highlight text here to quote it)" autocomplete="off" />
      <button type="submit">Ask</button>
    </form>
  `;
  document.body.appendChild(chatPanel);
  chatPanel.querySelector('[data-action="close-chat"]').addEventListener('click', closeChatPanel);
  chatPanel.querySelector('[data-action="save-chat"]').addEventListener('click', onSaveChat);
  chatPanel.querySelector('.sg-chat-form').addEventListener('submit', onChatSubmit);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && chatPanel.classList.contains('show')) closeChatPanel();
  });
  wireChatResize(chatPanel);
  wireChatPanelSelectionPreview(chatPanel);
  restoreChatWidth(chatPanel);
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
    panel.style.setProperty('--sg-chat-width', w + 'px');
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    panel.classList.remove('dragging');
    const w = panel.style.getPropertyValue('--sg-chat-width');
    try { if (w) localStorage.setItem('sg-chat-width', w); } catch {}
  });
}

function restoreChatWidth(panel) {
  try {
    const saved = localStorage.getItem('sg-chat-width');
    if (saved) panel.style.setProperty('--sg-chat-width', saved);
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
  chip.innerHTML =
    '<span class="sg-chat-quote-text">“' +
    escapeHtml(text.slice(0, 240)) +
    (text.length > 240 ? '…' : '') +
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
  return sel.toString().trim();
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
  } catch {}
}

function openChatPanel(selection, restoreThread = null) {
  hideSelToolbar();
  const panel = ensureChatPanel();
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
  panel.querySelector('.sg-chat-selection').textContent = chatSelection;
  const msgs = panel.querySelector('.sg-chat-messages');
  msgs.innerHTML = '';
  for (const m of chatHistory) appendChatMessage(m.role, m.content);
  panel.querySelector('input[name="q"]').placeholder = 'ask about this passage… (or highlight text here to quote it)';
  panel.classList.add('show');
  setChatSaveEnabled();
  setTimeout(() => panel.querySelector('input[name="q"]').focus(), 50);
}

async function openTutorPanel() {
  if (!currentTrack) { setStatus('open a course first'); return; }
  hideSelToolbar();
  const panel = ensureChatPanel();
  chatMode = 'tutor';
  panel.classList.add('tutor-mode');
  panel.querySelector('.sg-chat-title').textContent = 'tutor · ' + currentTrack;
  panel.querySelector('.sg-chat-selection').style.display = 'none';
  panel.querySelector('.sg-chat-save').style.display = 'none';
  clearPanelQuote(panel);
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
  panel.querySelector('input[name="q"]').placeholder = 'ask the tutor anything… (or highlight text here to quote it)';
  panel.classList.add('show');
  setTimeout(() => panel.querySelector('input[name="q"]').focus(), 50);
  // On first open (no history), trigger an opening status check
  if (chatHistory.length === 0) {
    sendTutorTurn(null);
  }
}

function closeChatPanel() {
  if (chatPanel) chatPanel.classList.remove('show');
  chatHistory = [];
  chatSelection = '';
  threadId = null;
}

async function onChatSubmit(ev) {
  ev.preventDefault();
  const input = ev.target.querySelector('input[name="q"]');
  const rawQuestion = input.value.trim();
  if (!rawQuestion) return;
  if (chatMode === 'btw' && !chatSelection) return;
  // If the user highlighted text inside this panel before submitting, include
  // it as a quoted preamble so the AI sees what they were referring to.
  const panelSnippet = panelStashedQuote || getPanelSelection(chatPanel);
  const question = panelSnippet
    ? `> quoted from this chat:\n> ${panelSnippet.split('\n').join('\n> ')}\n\n${rawQuestion}`
    : rawQuestion;
  input.value = '';
  clearPanelQuote(chatPanel);
  window.getSelection()?.removeAllRanges();
  if (chatMode === 'tutor') {
    return sendTutorTurn(question);
  }
  input.disabled = true;
  const submitBtn = ev.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  appendChatMessage('user', question);
  const historyBefore = chatHistory.slice();
  chatHistory.push({ role: 'user', content: question });
  const placeholder = appendChatMessage('assistant', '…');
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
        thread_id: threadId,
      }),
    });
    if (!resp.ok || !resp.body) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`stream open failed: ${resp.status} ${errBody.slice(0, 200)}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let fullText = '';
    let meta = null;
    let errorMsg = null;
    const msgs = chatPanel.querySelector('.sg-chat-messages');

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
          fullText += ev.text;
          placeholder.innerHTML = md.render(fullText, {});
          msgs.scrollTop = msgs.scrollHeight;
        } else if (ev.type === 'done') {
          meta = ev;
        } else if (ev.type === 'error') {
          errorMsg = ev.error;
        }
      }
    }
    placeholder.classList.remove('streaming');
    if (errorMsg) throw new Error(errorMsg);
    if (!fullText && meta?.full_text) {
      fullText = meta.full_text;
      placeholder.innerHTML = md.render(fullText, {});
    }
    chatHistory.push({ role: 'assistant', content: fullText });
    setChatSaveEnabled();
    if (meta) {
      // server may have created a thread_id if we didn't supply one
      if (meta.thread_id) threadId = meta.thread_id;
      setStatus(`btw answered (${(meta.duration_ms / 1000).toFixed(1)}s, $${meta.cost_usd?.toFixed(3)})`);
    }
    loadThreads();
  } catch (e) {
    placeholder.textContent = '✗ ' + e.message;
    placeholder.classList.add('error');
    setStatus('btw error: ' + e.message);
  } finally {
    input.disabled = false;
    submitBtn.disabled = false;
    input.focus();
  }
}

async function sendTutorTurn(userMessage) {
  const panel = chatPanel;
  const input = panel.querySelector('input[name="q"]');
  const submitBtn = panel.querySelector('button[type="submit"]');
  input.disabled = true;
  submitBtn.disabled = true;
  if (userMessage) {
    appendChatMessage('user', userMessage);
    chatHistory.push({ role: 'user', content: userMessage });
  }
  const placeholder = appendChatMessage('assistant', '…');
  placeholder.classList.add('streaming');
  setStatus('tutor thinking…');
  const historyBefore = userMessage ? chatHistory.slice(0, -1) : chatHistory.slice();
  try {
    const resp = await fetch('/api/tutor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        track: currentTrack,
        user_message: userMessage,
        history: historyBefore,
      }),
    });
    if (!resp.ok || !resp.body) {
      const t = await resp.text().catch(() => '');
      throw new Error(`stream open failed: ${resp.status} ${t.slice(0, 200)}`);
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
          const msgs = panel.querySelector('.sg-chat-messages');
          msgs.scrollTop = msgs.scrollHeight;
        } else if (ev.type === 'done') {
          meta = ev;
        } else if (ev.type === 'error') {
          errMsg = ev.error;
        }
      }
    }
    placeholder.classList.remove('streaming');
    if (errMsg) throw new Error(errMsg);
    chatHistory.push({ role: 'assistant', content: fullText });
    if (meta) setStatus(`tutor replied (${(meta.duration_ms / 1000).toFixed(1)}s, $${meta.cost_usd?.toFixed(3)})`);
  } catch (e) {
    placeholder.textContent = '✗ ' + e.message;
    placeholder.classList.add('error');
    placeholder.classList.remove('streaming');
    setStatus('tutor error: ' + e.message);
  } finally {
    input.disabled = false;
    submitBtn.disabled = false;
    input.focus();
  }
}

function appendChatMessage(role, content) {
  const msg = document.createElement('div');
  msg.className = `sg-chat-msg ${role}`;
  if (role === 'assistant' && content !== '…') {
    msg.innerHTML = md.render(content, {});
  } else {
    msg.textContent = content;
  }
  const msgs = chatPanel.querySelector('.sg-chat-messages');
  msgs.appendChild(msg);
  msgs.scrollTop = msgs.scrollHeight;
  return msg;
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
  openTutorPanel();
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
es.addEventListener('message', (ev) => {
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
});

// ---------- Router + Home ----------
const viewHome = document.getElementById('view-home');
const viewReader = document.getElementById('view-reader');
const trackGrid = document.getElementById('track-grid');
const newTrackDialog = document.getElementById('new-track-dialog');
const newTrackForm = document.getElementById('new-track-form');

function parseRoute() {
  const hash = location.hash || '#/';
  // #/t/<slug>/intake → intake; #/t/<slug>/ → reader
  const intake = hash.match(/^#\/t\/([^/]+)\/intake\/?$/);
  if (intake) return { name: 'intake', slug: decodeURIComponent(intake[1]) };
  const reader = hash.match(/^#\/t\/([^/]+)\/?/);
  if (reader) return { name: 'reader', slug: decodeURIComponent(reader[1]) };
  return { name: 'home' };
}

async function route() {
  const r = parseRoute();
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
      currentTrack = r.slug;
      try {
        await fetch(`/api/tracks/${encodeURIComponent(r.slug)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'select' }),
        });
      } catch {}
      const lessons = await loadList();
      // Auto-redirect to intake if there's nothing here yet
      if (!lessons.length) {
        const cur = await fetch(`/api/tracks/${encodeURIComponent(r.slug)}/curriculum`).then((x) => x.json()).catch(() => null);
        if (!cur?.ok) {
          location.hash = `#/t/${encodeURIComponent(r.slug)}/intake`;
          return;
        }
      }
      const trackProgress = _progress.tracks?.[r.slug];
      const target = trackProgress?.current && lessons.includes(trackProgress.current)
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

// ---------- intake view ----------
let intakeTrack = null;
let intakeHistory = [];
const intakeMessagesEl = () => document.getElementById('intake-messages');

async function enterIntake(slug) {
  intakeTrack = slug;
  intakeHistory = [];
  document.getElementById('intake-messages').innerHTML = '';
  document.getElementById('intake-input').value = '';
  try {
    const meta = await fetch(`/api/tracks/${encodeURIComponent(slug)}`).then((r) => r.json());
    document.getElementById('intake-track-name').textContent =
      (meta?.track?.emoji ? meta.track.emoji + ' ' : '') + (meta?.track?.title || slug);
  } catch {
    document.getElementById('intake-track-name').textContent = slug;
  }
  // If curriculum already exists, just show a note + jump-to-reader button
  const cur = await fetch(`/api/tracks/${encodeURIComponent(slug)}/curriculum`).then((r) => r.json()).catch(() => null);
  if (cur?.ok) {
    const msgs = document.getElementById('intake-messages');
    msgs.innerHTML = `<div class="intake-msg assistant">
      <p>This course already has a curriculum. Continue chatting to refine it, or jump straight to reading.</p>
      <p><a href="#/t/${encodeURIComponent(slug)}/">→ Open reader</a></p>
    </div>`;
  }
  // Surface any uploaded materials for this track
  loadMaterials(
    slug,
    document.getElementById('intake-materials-list'),
    'drop in PDFs / notes / cheatsheets — your tutor will see them',
  );
  // Don't auto-send a first turn — let the learner open the conversation.
  setTimeout(() => document.getElementById('intake-input').focus(), 50);
}

async function sendIntakeTurn(userMessage, finalize) {
  if (userMessage) {
    intakeHistory.push({ role: 'user', content: userMessage });
    appendIntakeMsg('user', userMessage);
  }
  const placeholder = appendIntakeMsg('assistant', '…');
  placeholder.classList.add('streaming');
  setStatus(finalize ? 'finalizing curriculum…' : 'intake (thinking…)');

  const historyBefore = intakeHistory.filter((m) => m.role === 'assistant' || (userMessage && m.content !== userMessage));
  // Send history WITHOUT the just-pushed user message (server adds it via user_message)
  const histPayload = userMessage ? intakeHistory.slice(0, -1) : intakeHistory.slice();

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
          window.scrollTo({ top: document.body.scrollHeight });
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
      setStatus('curriculum saved');
      setTimeout(() => { location.hash = `#/t/${encodeURIComponent(intakeTrack)}/`; }, 1400);
    }
  } catch (e) {
    placeholder.textContent = '✗ ' + e.message;
    placeholder.classList.add('error', 'streaming');
    placeholder.classList.remove('streaming');
    setStatus('intake error: ' + e.message);
  }
}

function appendIntakeMsg(role, content) {
  const msg = document.createElement('div');
  msg.className = `intake-msg ${role}`;
  if (role === 'assistant' && content !== '…') {
    msg.innerHTML = md.render(content, {});
  } else {
    msg.textContent = content;
  }
  document.getElementById('intake-messages').appendChild(msg);
  return msg;
}

document.getElementById('intake-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = document.getElementById('intake-input');
  const val = input.value.trim();
  if (!val) return;
  input.value = '';
  sendIntakeTurn(val, false);
});

// "Plan curriculum →" and "skip intake" buttons
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'finalize-intake') {
    ev.preventDefault();
    const pendingMsg = document.getElementById('intake-input').value.trim();
    document.getElementById('intake-input').value = '';
    sendIntakeTurn(pendingMsg || null, true);
  } else if (btn.dataset.action === 'skip-intake') {
    ev.preventDefault();
    if (!confirm('Skip the intake? You can come back to it later, but lesson generation will be less personalized.')) return;
    location.hash = `#/t/${encodeURIComponent(intakeTrack)}/`;
  }
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
  return `<a class="track-card ${t.is_current_track ? 'current' : ''}" href="#/t/${encodeURIComponent(t.slug)}/" data-action="open-track" data-slug="${escapeHtml(t.slug)}">
    <span class="track-card-actions">
      <button class="track-export" data-action="export-track" data-slug="${escapeHtml(t.slug)}" title="download course as .tgz" aria-label="export">⬇</button>
      <button class="track-delete" data-action="delete-track" data-slug="${escapeHtml(t.slug)}" title="delete course" aria-label="delete">×</button>
    </span>
    <span class="track-emoji">${escapeHtml(t.emoji || '📘')}</span>
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
    newTrackDialog.showModal();
    setTimeout(() => newTrackDialog.querySelector('#nt-title').focus(), 30);
  } else if (action === 'close-dialog') {
    ev.preventDefault();
    newTrackDialog.close();
  } else if (action === 'delete-track') {
    ev.preventDefault();
    ev.stopPropagation();
    const slug = t.dataset.slug;
    if (!confirm(`Delete course "${slug}"?\n\nThis removes the entire tracks/${slug}/ folder (lessons, exercises, materials, threads, curriculum). Irreversible.`)) return;
    try {
      const r = await fetch(`/api/tracks/${encodeURIComponent(slug)}`, { method: 'DELETE' }).then((r) => r.json());
      if (!r.ok) throw new Error(r.error || 'delete failed');
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
    newTrackDialog.close();
    newTrackForm.reset();
    document.getElementById('nt-emoji').value = '📘';
    // Land in intake for new tracks
    location.hash = `#/t/${encodeURIComponent(r.track.slug)}/intake`;
  } catch (e) {
    alert('create failed: ' + e.message);
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
          icon: t.emoji || '📘',
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

document.addEventListener('keydown', (ev) => {
  const isCmdK = (ev.metaKey || ev.ctrlKey) && (ev.key === 'k' || ev.key === 'K');
  if (isCmdK) {
    ev.preventDefault();
    openCmdPalette();
  } else if (ev.key === 'Escape' && cmdDialog.open) {
    cmdDialog.close();
  } else if ((ev.metaKey || ev.ctrlKey) && ev.key === '/') {
    // ⌘/ — quick selection-to-btw shortcut (if anything selected in lesson)
    const sel = window.getSelection()?.toString().trim();
    if (sel && sel.length > 3 && view.contains(window.getSelection()?.anchorNode)) {
      ev.preventDefault();
      openChatPanel(sel);
    }
  }
});

window.addEventListener('hashchange', route);
route();
