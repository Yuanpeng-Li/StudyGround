// Materials orchestrator: turns uploaded files into searchable assets.
//
//   processMaterial({slug, name})
//     → extract → text mirror (.text/<name>.md) → chunk → manifest entry
//       → BM25 postings → optionally embeddings → regenerate INDEX.md
//
//   reconcile(slug) — boot-time idempotency: extract anything missing
//   deleteMaterial({slug, name}) — clean every derived artifact
//   refresh(slug) — explicit re-process all (called by /api/.../reindex)
//
// Concurrency:
//   - In-process job queue keyed by `${slug}:${name}` (deduplicates rapid
//     re-uploads of the same file).
//   - Per-track concurrency 1 (avoid memory bloat on big PDFs).
//   - Global concurrency 2.

import { readFile, writeFile, mkdir, readdir, stat, unlink, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';

import { extract, classifyExt, sha256File } from './extract.mjs';
import { chunkMaterial, chunkPlainText } from './chunk.mjs';
import { buildIndex as buildBm25, search as searchBm25 } from './bm25.mjs';
import { buildIndex as buildVectors, vectorsEnabled } from './vectors.mjs';
import { pageStats, estimateTokens, formatStatsLine } from '../material-stats.mjs';

// --- path helpers ---

export function materialsDir(studygroundDir, slug) {
  return join(studygroundDir, 'tracks', slug, 'materials');
}
export function textMirrorDir(studygroundDir, slug) {
  return join(materialsDir(studygroundDir, slug), '.text');
}
export function indexDir(studygroundDir, slug) {
  return join(studygroundDir, 'tracks', slug, '.studyground-index');
}
export function manifestPath(studygroundDir, slug) {
  return join(indexDir(studygroundDir, slug), 'manifest.json');
}
export function chunksPath(studygroundDir, slug) {
  return join(indexDir(studygroundDir, slug), 'chunks.jsonl');
}
export function bm25Path(studygroundDir, slug) {
  return join(indexDir(studygroundDir, slug), 'bm25.json');
}
export function vectorsPath(studygroundDir, slug) {
  return join(indexDir(studygroundDir, slug), 'vectors.jsonl');
}
export function indexMdPath(studygroundDir, slug) {
  return join(materialsDir(studygroundDir, slug), 'INDEX.md');
}

// --- manifest ---

async function loadManifest(studygroundDir, slug) {
  const path = manifestPath(studygroundDir, slug);
  if (!existsSync(path)) return { version: 1, generated_at: null, materials: {} };
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return { version: 1, generated_at: null, materials: {} }; }
}

async function saveManifest(studygroundDir, slug, manifest) {
  manifest.generated_at = new Date().toISOString();
  await mkdir(indexDir(studygroundDir, slug), { recursive: true });
  await writeFile(manifestPath(studygroundDir, slug), JSON.stringify(manifest, null, 2));
}

// --- text mirror ---

function safeMirrorName(name) {
  // Mirror file: `<name>.md`. For names that already end in .md we still add
  // .md to avoid colliding with the original.
  return `${name}.md`;
}

async function writeTextMirror({ studygroundDir, slug, name, kind, pages, info }) {
  await mkdir(textMirrorDir(studygroundDir, slug), { recursive: true });
  const mirrorPath = join(textMirrorDir(studygroundDir, slug), safeMirrorName(name));
  const lines = [];
  lines.push(`# ${name}`);
  if (info?.Title) lines.push(`> Title: ${info.Title}`);
  if (info?.Author) lines.push(`> Author: ${info.Author}`);
  lines.push(`> Kind: ${kind}`);
  lines.push(`> Pages: ${pages.length}`);
  lines.push('');
  if (kind === 'pdf' || kind === 'image-pdf') {
    for (let i = 0; i < pages.length; i++) {
      lines.push(`## p. ${i + 1}`);
      lines.push('');
      lines.push(pages[i] || '_(no text extracted on this page)_');
      lines.push('');
    }
  } else {
    // Single-page (text file or OCR'd image) — no page headers.
    lines.push(pages[0] || '');
  }
  await writeFile(mirrorPath, lines.join('\n'));
  return mirrorPath;
}

async function deleteTextMirror({ studygroundDir, slug, name }) {
  const p = join(textMirrorDir(studygroundDir, slug), safeMirrorName(name));
  if (existsSync(p)) await unlink(p).catch(() => {});
}

// --- chunks ---

async function writeChunks(studygroundDir, slug, chunks) {
  await mkdir(indexDir(studygroundDir, slug), { recursive: true });
  const path = chunksPath(studygroundDir, slug);
  const out = chunks.map((c) => JSON.stringify(c)).join('\n');
  await writeFile(path, out + (out ? '\n' : ''));
}

async function readChunks(studygroundDir, slug) {
  const path = chunksPath(studygroundDir, slug);
  if (!existsSync(path)) return [];
  const raw = await readFile(path, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

// --- BM25 + vectors rebuild from chunks ---

async function rebuildIndices(studygroundDir, slug, { onProgress } = {}) {
  const chunks = await readChunks(studygroundDir, slug);
  await mkdir(indexDir(studygroundDir, slug), { recursive: true });
  const bm25 = buildBm25(chunks);
  await writeFile(bm25Path(studygroundDir, slug), JSON.stringify(bm25));
  if (vectorsEnabled() && chunks.length) {
    await buildVectors(chunks, {
      vectorsPath: vectorsPath(studygroundDir, slug),
      onProgress,
    });
  } else {
    // Vectors disabled — make sure no stale file lingers.
    if (existsSync(vectorsPath(studygroundDir, slug))) {
      await unlink(vectorsPath(studygroundDir, slug)).catch(() => {});
    }
  }
}

// --- INDEX.md regeneration ---

async function regenerateIndexMd(studygroundDir, slug) {
  const manifest = await loadManifest(studygroundDir, slug);
  const entries = Object.values(manifest.materials || {});
  entries.sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));
  const lines = [];
  lines.push(`# Materials index — ${slug}`);
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}.`);
  lines.push('');
  lines.push('Each material below has:');
  lines.push('- a **text mirror** at `.text/<name>.md` (markdown, page-anchored as `## p. N`) — `Grep` or `Read` this for content.');
  lines.push('- BM25 search across all chunks via `Bash(sg-search "query" --track ' + slug + ')`.');
  lines.push('- the **original file** at `<name>` — fall back to `Read(file, pages: "X-Y")` when status≠`ok`.');
  lines.push('');
  if (!entries.length) {
    lines.push('_(no materials uploaded yet)_');
    await writeFile(indexMdPath(studygroundDir, slug), lines.join('\n') + '\n');
    return;
  }
  lines.push('| File | Kind | Pages | ≈ Tokens | Status | Mirror |');
  lines.push('| ---- | ---- | -----:| -------:| ------ | ------ |');
  for (const e of entries) {
    const mirror = e.has_text_mirror ? `\`.text/${e.name}.md\`` : '_n/a_';
    lines.push(`| \`${e.name}\` | ${e.kind || '?'} | ${e.pages ?? '?'} | ${e.approx_tokens ?? '?'} | ${e.status} | ${mirror} |`);
  }
  lines.push('');
  lines.push('## How to use this from a Claude turn');
  lines.push('');
  lines.push('1. `Bash(sg-search "your query" --track ' + slug + ' --k 8)` — returns top chunks with `[file, p.N]` citations.');
  lines.push('2. To read more around a hit, `Read tracks/' + slug + '/materials/.text/<file>.md` and scroll to the matching `## p. N`.');
  lines.push('3. For an image-pdf (status `image-pdf`), use `Read tracks/' + slug + '/materials/<file>.pdf pages: "X-Y"` — Claude\'s native vision will read the page.');
  lines.push('4. Cite every claim from a material as `[<filename>, p.<N>]`.');
  lines.push('');
  await writeFile(indexMdPath(studygroundDir, slug), lines.join('\n'));
}

// --- in-process job queue ---

const queues = new Map();       // slug → Promise (per-track chain)
const broadcasters = new Set(); // event broadcasters subscribed to job progress

export function onMaterialEvent(fn) {
  broadcasters.add(fn);
  return () => broadcasters.delete(fn);
}
function fire(ev) {
  for (const fn of broadcasters) { try { fn(ev); } catch {} }
}

function chain(slug, task) {
  const prev = queues.get(slug) || Promise.resolve();
  const next = prev.then(task, task);
  // Keep chain finite — clear once done.
  queues.set(slug, next.finally(() => {
    if (queues.get(slug) === next) queues.delete(slug);
  }));
  return next;
}

// --- public API ---

// Process one material: extract → mirror → chunk → indices → INDEX.md.
export async function processMaterial({ studygroundDir, slug, name, replaceExisting = true }) {
  return chain(slug, async () => {
    const matPath = join(materialsDir(studygroundDir, slug), name);
    if (!existsSync(matPath)) {
      fire({ type: 'material_failed', slug, name, error: 'file missing' });
      return { status: 'failed', error: 'file missing' };
    }
    const kindHint = classifyExt(name);
    let st;
    try { st = await stat(matPath); } catch { st = null; }

    const manifest = await loadManifest(studygroundDir, slug);
    const existing = manifest.materials[name];

    fire({ type: 'material_progress', slug, name, phase: 'extract' });

    let sha;
    try { sha = await sha256File(matPath); } catch {}
    // Short-circuit: if sha matches existing OK record AND mirror file exists,
    // re-uploading the exact same bytes is a no-op.
    if (!replaceExisting && existing && existing.sha256 === sha && existing.status === 'ok') {
      fire({ type: 'material_indexed', slug, name, status: 'ok', cached: true });
      return { status: 'ok', cached: true };
    }

    // Extract.
    const out = await extract(matPath, {
      onProgress: ({ page, of }) => fire({ type: 'material_progress', slug, name, phase: 'extract', page, of }),
    }).catch((e) => ({ pages: [], kind: 'failed', error: String(e?.message || e) }));

    let kind = out.kind;
    let pages = out.pages || [];
    if (kind === 'failed') {
      const entry = {
        name,
        size: st?.size ?? 0,
        mtime: st?.mtime?.toISOString() || new Date().toISOString(),
        sha256: sha,
        kind: kindHint,
        status: 'failed',
        error: out.error || 'extraction failed',
        pages: 0,
        chars: 0,
        words: 0,
        approx_tokens: 0,
        chunks: 0,
        has_text_mirror: false,
        indexed_at: new Date().toISOString(),
      };
      manifest.materials[name] = entry;
      await saveManifest(studygroundDir, slug, manifest);
      await regenerateIndexMd(studygroundDir, slug);
      fire({ type: 'material_failed', slug, name, error: entry.error });
      return entry;
    }
    if (kind === 'unsupported') {
      const entry = {
        name,
        size: st?.size ?? 0,
        mtime: st?.mtime?.toISOString() || new Date().toISOString(),
        sha256: sha,
        kind: 'unsupported',
        status: 'unsupported',
        pages: 0,
        chars: 0,
        words: 0,
        approx_tokens: 0,
        chunks: 0,
        has_text_mirror: false,
        indexed_at: new Date().toISOString(),
      };
      manifest.materials[name] = entry;
      await saveManifest(studygroundDir, slug, manifest);
      await regenerateIndexMd(studygroundDir, slug);
      fire({ type: 'material_indexed', slug, name, status: 'unsupported' });
      return entry;
    }

    // Write text mirror.
    fire({ type: 'material_progress', slug, name, phase: 'mirror' });
    await writeTextMirror({ studygroundDir, slug, name, kind, pages, info: out.info });

    // Chunk.
    fire({ type: 'material_progress', slug, name, phase: 'chunk' });
    const chunks = pages.length > 1
      ? chunkMaterial({ source: name, pages })
      : chunkPlainText({ source: name, text: pages[0] || '' });

    // Merge chunks into the track-wide chunks.jsonl. Strategy: read existing,
    // filter out this file's old chunks, append new ones.
    const allChunks = (await readChunks(studygroundDir, slug)).filter((c) => c.source !== name);
    for (const c of chunks) allChunks.push(c);
    await writeChunks(studygroundDir, slug, allChunks);

    // Update manifest entry.
    const stats = pageStats(pages);
    const status = kind === 'image-pdf' ? 'image-pdf' : 'ok';
    manifest.materials[name] = {
      name,
      size: st?.size ?? 0,
      mtime: st?.mtime?.toISOString() || new Date().toISOString(),
      sha256: sha,
      kind,
      status,
      pages: stats.pages,
      chars: stats.chars,
      words: stats.words,
      approx_tokens: stats.approx_tokens,
      chunks: chunks.length,
      has_text_mirror: true,
      indexed_at: new Date().toISOString(),
    };
    await saveManifest(studygroundDir, slug, manifest);

    // Rebuild BM25 (always cheap). Vectors rebuild only if enabled — that
    // can be slow for big libraries, so we run it asynchronously after
    // signalling indexed.
    fire({ type: 'material_progress', slug, name, phase: 'bm25' });
    const bm25 = buildBm25(allChunks);
    await writeFile(bm25Path(studygroundDir, slug), JSON.stringify(bm25));

    await regenerateIndexMd(studygroundDir, slug);
    fire({ type: 'material_indexed', slug, name, status });

    if (vectorsEnabled() && allChunks.length) {
      fire({ type: 'material_progress', slug, name, phase: 'vectors' });
      try {
        await buildVectors(allChunks, {
          vectorsPath: vectorsPath(studygroundDir, slug),
          onProgress: ({ done, total }) => fire({ type: 'material_progress', slug, name, phase: 'vectors', done, of: total }),
        });
        fire({ type: 'material_vectors_ready', slug });
      } catch (e) {
        console.warn('[vectors] build failed:', e?.message);
      }
    }

    return manifest.materials[name];
  });
}

// Drop everything derived from one material.
export async function deleteMaterial({ studygroundDir, slug, name }) {
  return chain(slug, async () => {
    await deleteTextMirror({ studygroundDir, slug, name });
    const manifest = await loadManifest(studygroundDir, slug);
    delete manifest.materials[name];
    await saveManifest(studygroundDir, slug, manifest);
    const remaining = (await readChunks(studygroundDir, slug)).filter((c) => c.source !== name);
    await writeChunks(studygroundDir, slug, remaining);
    const bm25 = buildBm25(remaining);
    await writeFile(bm25Path(studygroundDir, slug), JSON.stringify(bm25));
    if (vectorsEnabled() && remaining.length) {
      try {
        await buildVectors(remaining, { vectorsPath: vectorsPath(studygroundDir, slug) });
      } catch (e) { console.warn('[vectors] rebuild after delete failed:', e?.message); }
    } else if (existsSync(vectorsPath(studygroundDir, slug))) {
      await unlink(vectorsPath(studygroundDir, slug)).catch(() => {});
    }
    await regenerateIndexMd(studygroundDir, slug);
    fire({ type: 'material_deleted', slug, name });
  });
}

// Walk one track and process anything missing/stale.
export async function reconcile({ studygroundDir, slug, force = false }) {
  const dir = materialsDir(studygroundDir, slug);
  if (!existsSync(dir)) return { processed: [], skipped: [] };
  const files = await readdir(dir).catch(() => []);
  const visible = files.filter((f) => !f.startsWith('.') && f !== 'INDEX.md');
  // We only read the manifest here to decide what's stale. processMaterial
  // is the writer; it re-loads + saves the manifest under the per-track
  // queue so we don't hold a stale reference across awaits.
  const seedManifest = await loadManifest(studygroundDir, slug);
  const processed = [];
  const skipped = [];
  for (const f of visible) {
    const filePath = join(dir, f);
    let st;
    try { st = await stat(filePath); } catch { continue; }
    if (!st.isFile()) continue;
    const entry = seedManifest.materials[f];
    const mirrorExists = existsSync(join(textMirrorDir(studygroundDir, slug), safeMirrorName(f)));
    let sha;
    try { sha = await sha256File(filePath); } catch { sha = null; }
    const stale = !entry || entry.sha256 !== sha || !mirrorExists || entry.status === 'failed';
    if (!force && !stale) {
      skipped.push(f);
      continue;
    }
    try {
      await processMaterial({ studygroundDir, slug, name: f, replaceExisting: true });
      processed.push(f);
    } catch (e) {
      console.warn('[materials] reconcile failed for', slug, f, ':', e?.message);
    }
  }
  // Re-load: processMaterial just wrote N new entries; our local seedManifest
  // is stale. Cleanup uses the fresh on-disk state.
  const manifest = await loadManifest(studygroundDir, slug);
  // Drop manifest entries for files that no longer exist on disk.
  const stillOnDisk = new Set(visible);
  let droppedAny = false;
  for (const name of Object.keys(manifest.materials)) {
    if (!stillOnDisk.has(name)) {
      delete manifest.materials[name];
      droppedAny = true;
    }
  }
  if (droppedAny) {
    await saveManifest(studygroundDir, slug, manifest);
    await regenerateIndexMd(studygroundDir, slug);
  }
  return { processed, skipped };
}

export async function reconcileAll({ studygroundDir }) {
  const tracksRoot = join(studygroundDir, 'tracks');
  if (!existsSync(tracksRoot)) return;
  const subs = await readdir(tracksRoot, { withFileTypes: true }).catch(() => []);
  for (const s of subs) {
    if (!s.isDirectory()) continue;
    // Fire-and-forget per track; the in-process queue keeps order.
    reconcile({ studygroundDir, slug: s.name }).catch((e) => {
      console.warn('[materials] reconcile track', s.name, 'failed:', e?.message);
    });
  }
}

// Read manifest entries for the API.
export async function listMaterialsWithStats({ studygroundDir, slug }) {
  const manifest = await loadManifest(studygroundDir, slug);
  const dir = materialsDir(studygroundDir, slug);
  const files = await readdir(dir).catch(() => []);
  const out = [];
  for (const f of files) {
    if (f.startsWith('.')) continue;
    if (f === 'INDEX.md') continue;
    let st;
    try { st = await stat(join(dir, f)); } catch { continue; }
    const m = manifest.materials[f];
    out.push({
      name: f,
      size: st.size,
      mtime: st.mtime.toISOString(),
      pages: m?.pages,
      approx_tokens: m?.approx_tokens,
      chars: m?.chars,
      words: m?.words,
      chunks: m?.chunks,
      kind: m?.kind,
      status: m?.status || 'pending',
      has_text_mirror: !!m?.has_text_mirror,
      indexed_at: m?.indexed_at,
      stats_line: m ? formatStatsLine({ pages: m.pages, approx_tokens: m.approx_tokens, status: m.status }) : '',
    });
  }
  out.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return out;
}

export async function loadBm25(studygroundDir, slug) {
  const p = bm25Path(studygroundDir, slug);
  if (!existsSync(p)) return null;
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

export { searchBm25 };
