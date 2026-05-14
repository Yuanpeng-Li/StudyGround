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
md.renderer.rules.math_inline = (tokens, idx) =>
  katex.renderToString(tokens[idx].content, { throwOnError: false });
md.renderer.rules.math_block = (tokens, idx) =>
  `<div class="math-block">${katex.renderToString(tokens[idx].content, {
    displayMode: true,
    throwOnError: false,
  })}</div>`;

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
  const text = t.attrGet('data-text');
  const index = t.attrGet('data-index');
  const escaped = escapeHtml(text);
  const label = kind === 'btw' ? 'btw' : 'q';
  return `<div class="sg-question ${kind}" data-index="${index}" data-kind="${kind}">
    <span class="sg-q-label">${label}</span>
    <span class="sg-q-text">${escaped}</span>
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
        <button class="sg-ex-check" data-action="check-exercise" data-name="${safeName}">Check</button>
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

// ---------- App state ----------
const view = document.getElementById('lesson-view');
const sidebarLessons = document.getElementById('sidebar-lessons');
const sidebarOutline = document.getElementById('sidebar-outline');
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
let _progress = { current_track: null, tracks: {} };

async function loadList() {
  const [lessonsRes, progressRes] = await Promise.all([
    fetch('/api/lessons').then((r) => r.json()),
    fetch('/api/progress').then((r) => r.json()),
  ]);
  _allLessons = lessonsRes.lessons || [];
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
      return `<li><a href="#" data-action="pick-lesson" data-slug="${escapeHtml(slug)}" class="${cls}" title="${escapeHtml(slug)}">${escapeHtml(label)}</a></li>`;
    })
    .join('');
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
    items.push({ level: h.tagName, text: h.textContent.trim(), id });
  }
  sidebarOutline.innerHTML = items
    .map(
      (it) =>
        `<li><a href="#${it.id}" data-action="jump-section" data-id="${it.id}" class="outline-${it.level === 'H2' ? 2 : 3}">${escapeHtml(it.text)}</a></li>`,
    )
    .join('');
  setupSectionObserver(items);
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
  const r = await fetch('/api/lesson/' + encodeURIComponent(slug)).then((r) => r.json());
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
  lessonTitleBar.textContent = meta.title || slug;
  buildOutline();
  renderSidebarLessons();
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
  const text = qBlock.querySelector('.sg-q-text')?.textContent || '';
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
      body: JSON.stringify({ lesson: currentSlug, index, kind, question: text }),
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
      body: JSON.stringify({ lesson: currentSlug, name }),
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
      body: JSON.stringify({ lesson: currentSlug, exercise: name }),
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

btnNext.addEventListener('click', async () => {
  btnNext.disabled = true;
  const prev = btnNext.textContent;
  btnNext.textContent = 'thinking…';
  setStatus('generating next lesson (claude is writing)…');
  try {
    const r = await fetch('/api/next', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).then((r) => r.json());
    if (!r.ok) throw new Error(r.error || 'unknown error');
    setStatus(`generated (${(r.duration_ms / 1000).toFixed(1)}s, $${r.cost_usd?.toFixed(3)})`);
    const lessons = await loadList();
    const newest = lessons[lessons.length - 1];
    if (newest) {
      await loadLesson(newest);
    }
  } catch (e) {
    setStatus('error: ' + e.message);
    alert('next failed: ' + e.message);
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

function ensureSelToolbar() {
  if (selToolbar) return selToolbar;
  selToolbar = document.createElement('div');
  selToolbar.className = 'sg-sel-toolbar';
  selToolbar.innerHTML = `<button data-action="btw-ask-selection">btw ask</button>`;
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
  tb.style.top = window.scrollY + rect.top - 38 + 'px';
  tb.style.left = Math.max(8, window.scrollX + rect.left + rect.width / 2 - 50) + 'px';
  tb.classList.add('show');
});

function ensureChatPanel() {
  if (chatPanel) return chatPanel;
  chatPanel = document.createElement('aside');
  chatPanel.className = 'sg-chat-panel';
  chatPanel.innerHTML = `
    <div class="sg-chat-head">
      <span class="sg-chat-title">btw</span>
      <div class="sg-chat-head-actions">
        <button class="sg-chat-save" data-action="save-chat" title="save this conversation as a ?>> block in the lesson" disabled>Save to lesson</button>
        <button class="sg-chat-close" data-action="close-chat" title="close (Esc)">×</button>
      </div>
    </div>
    <div class="sg-chat-selection"></div>
    <div class="sg-chat-messages"></div>
    <form class="sg-chat-form">
      <input type="text" name="q" placeholder="ask about this passage…" autocomplete="off" />
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
  return chatPanel;
}

function openChatPanel(selection) {
  hideSelToolbar();
  const panel = ensureChatPanel();
  chatSelection = selection;
  chatHistory = [];
  panel.querySelector('.sg-chat-selection').textContent = selection;
  panel.querySelector('.sg-chat-messages').innerHTML = '';
  panel.classList.add('show');
  setTimeout(() => panel.querySelector('input[name="q"]').focus(), 50);
}

function closeChatPanel() {
  if (chatPanel) chatPanel.classList.remove('show');
  chatHistory = [];
  chatSelection = '';
}

async function onChatSubmit(ev) {
  ev.preventDefault();
  const input = ev.target.querySelector('input[name="q"]');
  const question = input.value.trim();
  if (!question || !chatSelection) return;
  input.value = '';
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
        lesson: currentSlug,
        selection: chatSelection,
        question,
        history: historyBefore,
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
      setStatus(`btw answered (${(meta.duration_ms / 1000).toFixed(1)}s, $${meta.cost_usd?.toFixed(3)})`);
    }
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
      body: JSON.stringify({ lesson: currentSlug }),
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

loadList();
