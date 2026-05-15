// Lightweight, dependency-free statistics for course materials.
//
// Tokens here are *approximate* — we deliberately avoid pulling in a real
// tokenizer (tiktoken / @anthropic-ai/tokenizer add native deps and weight).
// The heuristic is char-class weighted: CJK characters cost more chars-per-
// token than Latin/ASCII. Good enough for budgeting and UI; never used to
// drive billing.

// Per-character "cost in chars per token", indexed by class.
const CHARS_PER_TOKEN = {
  cjk: 1.7,    // 一 char ≈ 0.6 tokens
  latin: 4.0,  // English: 4 chars per token (industry rule of thumb)
  digit: 3.0,
  punct: 3.0,
  whitespace: 4.0,
  other: 3.5,
};

function classifyCodepoint(cp) {
  // Cheap classification; bias toward CJK detection because that's the case
  // where the 4-chars-per-token rule breaks down badly.
  if (cp >= 0x4e00 && cp <= 0x9fff) return 'cjk';     // CJK Unified
  if (cp >= 0x3040 && cp <= 0x30ff) return 'cjk';     // Hiragana + Katakana
  if (cp >= 0xac00 && cp <= 0xd7af) return 'cjk';     // Hangul syllables
  if (cp >= 0x3400 && cp <= 0x4dbf) return 'cjk';     // CJK Extension A
  if (cp >= 0xf900 && cp <= 0xfaff) return 'cjk';     // CJK Compatibility
  if (cp >= 0x30 && cp <= 0x39) return 'digit';
  if (cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d) return 'whitespace';
  if (cp >= 0x21 && cp <= 0x2f) return 'punct';
  if (cp >= 0x3a && cp <= 0x40) return 'punct';
  if (cp >= 0x5b && cp <= 0x60) return 'punct';
  if (cp >= 0x7b && cp <= 0x7e) return 'punct';
  if (cp >= 0x41 && cp <= 0x7a) return 'latin';
  return 'other';
}

// Estimate ≈ how many tokens `text` would consume. Single function, the
// source of truth for the rest of the codebase.
export function estimateTokens(text) {
  if (!text) return 0;
  const counts = { cjk: 0, latin: 0, digit: 0, punct: 0, whitespace: 0, other: 0 };
  for (const ch of text) {
    counts[classifyCodepoint(ch.codePointAt(0))]++;
  }
  let est = 0;
  for (const k of Object.keys(counts)) {
    est += counts[k] / CHARS_PER_TOKEN[k];
  }
  return Math.max(1, Math.round(est));
}

// English-style word count. For CJK text it under-counts, but UI uses it
// only as a secondary hint alongside char count, so this is acceptable.
export function countWords(text) {
  if (!text) return 0;
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}

// Aggregate per-page texts into one stats record.
export function pageStats(pageTexts) {
  const pages = pageTexts.length;
  let chars = 0;
  let words = 0;
  let approx_tokens = 0;
  for (const t of pageTexts) {
    chars += t.length;
    words += countWords(t);
    approx_tokens += estimateTokens(t);
  }
  return { pages, chars, words, approx_tokens };
}

// Stats for a single blob (no page concept).
export function textStats(text) {
  return {
    pages: 1,
    chars: text.length,
    words: countWords(text),
    approx_tokens: estimateTokens(text),
  };
}

// Pick chunks greedily until we hit the token budget. Assumes chunks are
// already sorted by relevance. Returns the prefix that fits.
export function chunkBudget(chunks, maxTokens) {
  const out = [];
  let used = 0;
  for (const c of chunks) {
    const cost = c.approx_token_count ?? estimateTokens(c.text || '');
    if (used + cost > maxTokens && out.length > 0) break;
    out.push(c);
    used += cost;
  }
  return { chunks: out, tokens: used };
}

// Human-readable summary used in INDEX.md and UI tooltips.
export function formatStatsLine({ pages, approx_tokens, status }) {
  const parts = [];
  if (pages && pages > 1) parts.push(`${pages}pp`);
  if (approx_tokens) {
    parts.push(approx_tokens >= 1000
      ? `~${(approx_tokens / 1000).toFixed(approx_tokens >= 10000 ? 0 : 1)}k tok`
      : `~${approx_tokens} tok`);
  }
  if (status && status !== 'ok') parts.push(`(${status})`);
  return parts.join(' · ');
}
