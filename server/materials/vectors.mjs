// Optional vector embeddings for hybrid retrieval.
//
// Activated only if VOYAGE_API_KEY or OPENAI_API_KEY is set in the env.
// Falls back to "off" silently otherwise — the rest of the system (BM25 +
// text mirror) keeps working without any external API.
//
// Persistence: one JSONL file at .studyground-index/vectors.jsonl
//   - first line: {type: 'meta', provider, model, dim, k}
//   - subsequent lines: {id, vec: [...]}

import { readFile, writeFile, mkdir, unlink, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

const VOYAGE_MODEL = process.env.STUDYGROUND_VOYAGE_MODEL || 'voyage-3-large';
const OPENAI_MODEL = process.env.STUDYGROUND_OPENAI_MODEL || 'text-embedding-3-small';

export function pickProvider() {
  const explicit = (process.env.STUDYGROUND_EMBEDDINGS_PROVIDER || 'auto').toLowerCase();
  if (explicit === 'off') return null;
  if (explicit === 'voyage' && process.env.VOYAGE_API_KEY) return 'voyage';
  if (explicit === 'openai' && process.env.OPENAI_API_KEY) return 'openai';
  if (explicit === 'auto') {
    if (process.env.VOYAGE_API_KEY) return 'voyage';
    if (process.env.OPENAI_API_KEY) return 'openai';
  }
  return null;
}

export function vectorsEnabled() {
  return pickProvider() !== null;
}

async function embedBatchVoyage(texts) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: texts,
      input_type: 'document',
    }),
  });
  if (!res.ok) throw new Error(`voyage ${res.status} ${await res.text().catch(() => '')}`);
  const data = await res.json();
  return data.data.map((d) => d.embedding);
}

async function embedBatchOpenAI(texts) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: texts,
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status} ${await res.text().catch(() => '')}`);
  const data = await res.json();
  return data.data.map((d) => d.embedding);
}

async function embedBatch(provider, texts) {
  if (provider === 'voyage') return embedBatchVoyage(texts);
  if (provider === 'openai') return embedBatchOpenAI(texts);
  throw new Error(`unknown provider ${provider}`);
}

async function embedQuery(provider, text) {
  // Most providers accept identical request shapes for queries vs documents
  // (voyage prefers input_type: 'query'; openai has one input type). We
  // simplify by reusing embedBatch and unwrapping the single result.
  if (provider === 'voyage') {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        model: VOYAGE_MODEL,
        input: [text],
        input_type: 'query',
      }),
    });
    if (!res.ok) throw new Error(`voyage query ${res.status}`);
    const data = await res.json();
    return data.data[0].embedding;
  }
  const vecs = await embedBatch(provider, [text]);
  return vecs[0];
}

// Build/refresh vectors file for a list of chunks. Existing file is
// overwritten — embeddings are cheap to regenerate relative to PDF parsing
// and this avoids any incremental-merge complexity.
export async function buildIndex(chunks, { vectorsPath, batchSize = 32, onProgress } = {}) {
  const provider = pickProvider();
  if (!provider) return { provider: null, count: 0 };
  if (!chunks.length) {
    if (existsSync(vectorsPath)) await unlink(vectorsPath).catch(() => {});
    return { provider, count: 0 };
  }
  await mkdir(dirname(vectorsPath), { recursive: true });
  // Determine dim by running a single test embedding first.
  const probe = await embedBatch(provider, [chunks[0].text]);
  const dim = probe[0].length;
  const lines = [JSON.stringify({ type: 'meta', provider, model: provider === 'voyage' ? VOYAGE_MODEL : OPENAI_MODEL, dim, count: chunks.length })];
  lines.push(JSON.stringify({ id: chunks[0].id, vec: probe[0] }));
  let done = 1;
  for (let i = 1; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    let vecs;
    try {
      vecs = await embedBatch(provider, batch.map((c) => c.text));
    } catch (e) {
      // Don't blow up the whole index build — log and skip this batch.
      console.warn('[vectors] batch failed:', e?.message);
      done += batch.length;
      onProgress?.({ done, total: chunks.length });
      continue;
    }
    for (let j = 0; j < batch.length; j++) {
      lines.push(JSON.stringify({ id: batch[j].id, vec: vecs[j] }));
    }
    done += batch.length;
    onProgress?.({ done, total: chunks.length });
  }
  await writeFile(vectorsPath, lines.join('\n') + '\n');
  return { provider, count: chunks.length, dim };
}

export async function loadIndex(vectorsPath) {
  if (!existsSync(vectorsPath)) return null;
  const raw = await readFile(vectorsPath, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  let meta = null;
  const byId = new Map();
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === 'meta') meta = obj;
    else if (obj.id && Array.isArray(obj.vec)) byId.set(obj.id, obj.vec);
  }
  return { meta, byId };
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function search(vectorsPath, query, k = 10) {
  const provider = pickProvider();
  if (!provider) return [];
  const idx = await loadIndex(vectorsPath);
  if (!idx || idx.byId.size === 0) return [];
  let qv;
  try { qv = await embedQuery(provider, query); }
  catch (e) {
    console.warn('[vectors] query failed:', e?.message);
    return [];
  }
  const scored = [];
  for (const [id, vec] of idx.byId.entries()) {
    scored.push({ id, cos: cosine(qv, vec) });
  }
  scored.sort((a, b) => b.cos - a.cos);
  return scored.slice(0, k);
}
