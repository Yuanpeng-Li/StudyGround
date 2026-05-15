// Pure-JS BM25 implementation for course-material retrieval.
//
// - Okapi BM25 with k1=1.5, b=0.75 (industry-standard defaults).
// - Unicode-aware tokenization (\p{L}+\p{N}*), CJK chars indexed individually
//   plus bigrams so Chinese/Japanese queries work without a segmenter.
// - Postings persisted as a single JSON file per track. Index size scales
//   with vocabulary, not corpus size — small for typical course libraries.

const K1 = 1.5;
const B = 0.75;

// Token regex: runs of letters+digits (Unicode-aware). Underscore acts as a
// separator (so identifier-style strings like `foo_bar` become two tokens).
const TOKEN_RE = /[\p{L}\p{N}]+/gu;

// Range check for ideograms / Kana / Hangul that we want to index as
// individual chars + bigrams.
function isCjkChar(cp) {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xf900 && cp <= 0xfaff)
  );
}

export function tokenize(text) {
  if (!text) return [];
  const out = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(TOKEN_RE)) {
    const tok = m[0];
    // For purely-CJK runs, decompose into single chars + bigrams.
    let isCjkRun = true;
    for (let i = 0; i < tok.length; i++) {
      if (!isCjkChar(tok.codePointAt(i))) { isCjkRun = false; break; }
    }
    if (isCjkRun && tok.length > 1) {
      for (let i = 0; i < tok.length; i++) out.push(tok[i]);
      for (let i = 0; i < tok.length - 1; i++) out.push(tok.slice(i, i + 2));
    } else if (isCjkRun) {
      out.push(tok);
    } else {
      out.push(tok);
      // English: also keep short stems by trimming common suffixes — cheap
      // and helps recall ("attention" matches "attentions"). Conservative.
      if (tok.length > 5) {
        if (tok.endsWith('ies')) out.push(tok.slice(0, -3) + 'y');
        else if (tok.endsWith('es') || tok.endsWith('ed')) out.push(tok.slice(0, -2));
        else if (tok.endsWith('s') && !tok.endsWith('ss')) out.push(tok.slice(0, -1));
        else if (tok.endsWith('ing')) out.push(tok.slice(0, -3));
      }
    }
  }
  return out;
}

// Build an index from chunk records. `chunks` is an array of
// {id, source, page_start, page_end, text, ...}. The index includes only the
// fields needed to score and surface matches; chunk text is kept under
// `docs` so search results can return snippets without a second lookup.
export function buildIndex(chunks) {
  const docs = {};
  const termFreq = {};     // doc_id → { term: tf }
  const docFreq = {};      // term → df
  const lengths = {};      // doc_id → length
  let totalLen = 0;
  for (const c of chunks) {
    docs[c.id] = {
      id: c.id,
      source: c.source,
      page_start: c.page_start,
      page_end: c.page_end,
      char_count: c.char_count,
      approx_token_count: c.approx_token_count,
      text: c.text,
    };
    const toks = tokenize(c.text);
    const tf = {};
    for (const t of toks) tf[t] = (tf[t] || 0) + 1;
    termFreq[c.id] = tf;
    lengths[c.id] = toks.length;
    totalLen += toks.length;
    for (const t of Object.keys(tf)) docFreq[t] = (docFreq[t] || 0) + 1;
  }
  const numDocs = chunks.length;
  const avgLen = numDocs > 0 ? totalLen / numDocs : 0;
  return {
    version: 1,
    k1: K1,
    b: B,
    numDocs,
    avgLen,
    docs,
    termFreq,
    docFreq,
    lengths,
  };
}

// Score query against the index. Returns top-k {id, score, source, page_start, page_end, snippet, ...}.
export function search(index, query, k = 10) {
  if (!index || !index.numDocs) return [];
  const qToks = tokenize(query);
  if (qToks.length === 0) return [];
  const scores = {};
  const seenInDoc = {};
  for (const t of qToks) {
    const df = index.docFreq[t];
    if (!df) continue;
    const idf = Math.log(1 + (index.numDocs - df + 0.5) / (df + 0.5));
    for (const id of Object.keys(index.termFreq)) {
      const tf = index.termFreq[id][t];
      if (!tf) continue;
      const len = index.lengths[id] || 1;
      const norm = tf * (index.k1 + 1) /
        (tf + index.k1 * (1 - index.b + index.b * len / (index.avgLen || 1)));
      scores[id] = (scores[id] || 0) + idf * norm;
      seenInDoc[id] = (seenInDoc[id] || new Set());
      seenInDoc[id].add(t);
    }
  }
  const ranked = Object.entries(scores)
    .map(([id, score]) => ({ id, score, matched: Array.from(seenInDoc[id] || []) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return ranked.map((r) => {
    const d = index.docs[r.id] || {};
    return {
      id: r.id,
      score: r.score,
      bm25: r.score,
      matched: r.matched,
      source: d.source,
      page_start: d.page_start,
      page_end: d.page_end,
      char_count: d.char_count,
      approx_token_count: d.approx_token_count,
      text: d.text,
      snippet: snippetAround(d.text || '', r.matched),
    };
  });
}

// Find the first matched term in the doc's text and return a window around it.
function snippetAround(text, matched, window = 220) {
  if (!text) return '';
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of matched) {
    const i = lower.indexOf(t);
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  if (pos < 0) return text.slice(0, Math.min(window * 2, text.length));
  const start = Math.max(0, pos - window);
  const end = Math.min(text.length, pos + window);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}
