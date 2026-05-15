// Recursive text chunker for course materials.
//
// Goals:
//   - Chunk size around CHUNK_CHARS (tunable via env).
//   - Chunks never cross page boundaries — page anchors are load-bearing for
//     citations, so each chunk has exactly one (page_start, page_end) value.
//   - Overlap between adjacent chunks within a page (CHUNK_OVERLAP) so a
//     query landing on a boundary still finds context.
//   - Try paragraph boundaries first, then sentences, then char-fallback.
//   - Yield records compatible with BM25 + vectors + sg-search.

import { estimateTokens } from '../material-stats.mjs';

const ENV_CHARS = Number(process.env.STUDYGROUND_CHUNK_CHARS) || 1200;
const ENV_OVERLAP = Number(process.env.STUDYGROUND_CHUNK_OVERLAP) || 200;

function paragraphSplit(text) {
  // Treat 2+ newlines OR a single newline + indent as paragraph break.
  return text.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
}

function sentenceSplit(text) {
  // Cheap multilingual sentence boundary: punctuation + whitespace.
  // For CJK, also break on 。！？．
  const out = [];
  let buf = '';
  for (const ch of text) {
    buf += ch;
    if (/[.!?。！？]/.test(ch)) {
      out.push(buf);
      buf = '';
    } else if (buf.length > 320 && /\s/.test(ch)) {
      // Long runaway sentences (formulas, code) — force a break on whitespace.
      out.push(buf);
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

// Greedy chunker: pack `pieces` into chunks of ~targetChars; if a single
// piece is too big, char-split it. Returns an array of strings.
function packPieces(pieces, targetChars, overlap) {
  const out = [];
  let cur = '';
  for (const piece of pieces) {
    if (piece.length > targetChars) {
      // Flush whatever we've accumulated.
      if (cur) { out.push(cur); cur = ''; }
      // Char-split the oversized piece.
      let i = 0;
      while (i < piece.length) {
        const end = Math.min(i + targetChars, piece.length);
        out.push(piece.slice(i, end));
        if (end >= piece.length) break;
        i = end - overlap;
        if (i <= 0) i = end;
      }
      continue;
    }
    if (cur && (cur.length + piece.length + 1) > targetChars) {
      out.push(cur);
      // Carry forward overlap from the tail of the just-flushed chunk.
      cur = overlap > 0 ? cur.slice(Math.max(0, cur.length - overlap)) : '';
    }
    cur = cur ? (cur + ' ' + piece) : piece;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// Chunk one page's text into chunk records.
function chunkPage({ source, pageNumber, text, chunkChars, chunkOverlap, idCounter }) {
  if (!text || !text.trim()) return [];
  const paragraphs = paragraphSplit(text);
  let units = paragraphs.length ? paragraphs : sentenceSplit(text);
  // If paragraph blocks are themselves bigger than the target, split each into
  // sentences so the packer has finer pieces to work with.
  units = units.flatMap((u) => u.length > chunkChars ? sentenceSplit(u) : [u]);
  const packed = packPieces(units, chunkChars, chunkOverlap);
  const records = [];
  for (const t of packed) {
    const id = `${source}#p${pageNumber}-c${idCounter.value++}`;
    records.push({
      id,
      source,
      page_start: pageNumber,
      page_end: pageNumber,
      char_start: 0,
      char_end: t.length,
      char_count: t.length,
      approx_token_count: estimateTokens(t),
      text: t,
    });
  }
  return records;
}

// Public entrypoint. `pages` is an array of strings (one per PDF page) OR a
// single-element array for plain text. Returns chunk records.
export function chunkMaterial({ source, pages, chunkChars = ENV_CHARS, chunkOverlap = ENV_OVERLAP }) {
  const idCounter = { value: 1 };
  const all = [];
  pages.forEach((text, i) => {
    const pageNumber = i + 1;
    const recs = chunkPage({ source, pageNumber, text, chunkChars, chunkOverlap, idCounter });
    for (const r of recs) all.push(r);
  });
  return all;
}

// For plain text files (no page concept) we still produce chunks tagged with
// page 1 so the on-disk shape is uniform.
export function chunkPlainText({ source, text, chunkChars = ENV_CHARS, chunkOverlap = ENV_OVERLAP }) {
  return chunkMaterial({ source, pages: [text], chunkChars, chunkOverlap });
}
