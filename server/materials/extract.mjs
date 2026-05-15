// Material extraction worker — converts uploads to plain text.
//
// Strategy:
//   - PDF: pdfjs-dist (legacy CJS-compatible mjs build, worker disabled).
//     Returns per-page text; if essentially empty, the file is flagged
//     image-pdf — Claude's native Read(pdf, pages:) (which has vision) is the
//     downstream fallback. We do NOT auto-rasterize PDFs (avoids a canvas
//     native-binding dep); proper PDF OCR can be a follow-up.
//   - Plain text (.md/.txt/.csv/.log/.json/.py/.js/.html/.css/...) — read as
//     UTF-8 directly. One "page" so the on-disk shape is uniform.
//   - Image (.png/.jpg/.jpeg/.gif/.bmp/.webp/.tif/.tiff) — tesseract.js.
//   - Anything else → unsupported (still saved on disk; tutor can decide
//     what to do via Read).

import { readFile } from 'node:fs/promises';
import { extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PDF_EXT = new Set(['.pdf']);
const TEXT_EXT = new Set([
  '.md', '.txt', '.csv', '.log', '.json', '.tsv', '.yml', '.yaml',
  '.py', '.js', '.ts', '.mjs', '.cjs', '.html', '.htm', '.css', '.xml',
  '.rs', '.go', '.java', '.c', '.h', '.cpp', '.hpp', '.rb', '.sh',
]);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff']);

// Per-page "empty-ish" threshold. If pdf extraction is below this many chars
// on >= IMAGE_PDF_RATIO of pages, we flag the whole file image-pdf.
const PER_PAGE_EMPTY_CHARS = 20;
const IMAGE_PDF_RATIO = 0.8;

export function classifyExt(filename) {
  const ext = extname(filename).toLowerCase();
  if (PDF_EXT.has(ext)) return 'pdf';
  if (TEXT_EXT.has(ext)) return 'text';
  if (IMAGE_EXT.has(ext)) return 'image';
  return 'unsupported';
}

export async function sha256File(path) {
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

// Extract text from a PDF. Returns { pages: string[], info, kind }.
// kind is 'pdf' for normal text-pdfs, 'image-pdf' when text extraction yielded
// essentially nothing (caller decides whether to OCR / mark image-pdf).
let _pdfjsModule = null;
async function loadPdfjs() {
  if (_pdfjsModule) return _pdfjsModule;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdfjs needs workerSrc set to *something*; in Node the legacy build can
  // resolve a same-thread worker if we point it at the bundled .mjs file.
  // require.resolve handles the path lookup transparently from CJS context.
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
  } catch {
    // Best-effort fallback: leave default. pdfjs will surface a clearer error.
  }
  _pdfjsModule = pdfjs;
  return pdfjs;
}

export async function extractPdf(filePath, { onProgress } = {}) {
  const pdfjs = await loadPdfjs();

  const data = new Uint8Array(await readFile(filePath));
  const loadingTask = pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;
  const numPages = doc.numPages;
  const pages = [];
  let info = null;
  try { info = (await doc.getMetadata())?.info; } catch {}

  for (let i = 1; i <= numPages; i++) {
    let pageText = '';
    try {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      // Build a string with sensible line breaks. pdfjs returns text items
      // with positional info — for our purposes (search + Claude reading), we
      // just want readable text. Use the `hasEOL` hint when present.
      const lines = [];
      let cur = '';
      for (const item of tc.items) {
        if (!item || typeof item.str !== 'string') continue;
        cur += item.str;
        if (item.hasEOL) {
          lines.push(cur);
          cur = '';
        } else if (!item.str.endsWith(' ')) {
          cur += ' ';
        }
      }
      if (cur) lines.push(cur);
      pageText = lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
      page.cleanup();
    } catch (e) {
      pageText = '';
    }
    pages.push(pageText);
    onProgress?.({ page: i, of: numPages });
  }
  try { await doc.cleanup(); } catch {}
  try { await doc.destroy(); } catch {}

  const emptyPages = pages.filter((p) => p.replace(/\s/g, '').length < PER_PAGE_EMPTY_CHARS).length;
  const isImagePdf = numPages > 0 && (emptyPages / numPages) >= IMAGE_PDF_RATIO;
  return { pages, info, kind: isImagePdf ? 'image-pdf' : 'pdf' };
}

// OCR a standalone image with tesseract.js. Single page; English-only by
// default. Multi-language ('eng+chi_sim') can be passed via TESS_LANGS env.
let _tesseractWorker = null;
async function getTesseractWorker() {
  if (_tesseractWorker) return _tesseractWorker;
  const tess = await import('tesseract.js');
  const langs = process.env.STUDYGROUND_TESS_LANGS || 'eng';
  const worker = await tess.createWorker(langs);
  _tesseractWorker = worker;
  return worker;
}

export async function shutdownTesseract() {
  if (!_tesseractWorker) return;
  try { await _tesseractWorker.terminate(); } catch {}
  _tesseractWorker = null;
}

export async function extractImage(filePath) {
  const worker = await getTesseractWorker();
  const { data } = await worker.recognize(filePath);
  const text = (data?.text || '').trim();
  return { pages: [text], kind: 'image' };
}

export async function extractTextFile(filePath) {
  // Treat anything in TEXT_EXT as UTF-8.
  const raw = await readFile(filePath, 'utf8');
  return { pages: [raw], kind: 'text' };
}

// Top-level dispatcher. Returns { pages, kind, info?, error? }.
// kind: 'pdf' | 'image-pdf' | 'text' | 'image' | 'unsupported'
export async function extract(filePath, { onProgress } = {}) {
  const ext = extname(filePath).toLowerCase();
  if (PDF_EXT.has(ext)) {
    try {
      return await extractPdf(filePath, { onProgress });
    } catch (e) {
      return { pages: [], kind: 'failed', error: String(e?.message || e) };
    }
  }
  if (TEXT_EXT.has(ext)) {
    try {
      return await extractTextFile(filePath);
    } catch (e) {
      return { pages: [], kind: 'failed', error: String(e?.message || e) };
    }
  }
  if (IMAGE_EXT.has(ext)) {
    try {
      return await extractImage(filePath);
    } catch (e) {
      return { pages: [], kind: 'failed', error: String(e?.message || e) };
    }
  }
  return { pages: [], kind: 'unsupported' };
}
