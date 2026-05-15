# Working with course materials

StudyGround pre-processes uploaded materials (PDFs, text files, images) into
a small on-disk RAG layer that every skill can use **without leaving its
existing toolset**. Read this whenever you're about to look at materials.

## The on-disk layout

```
tracks/<track>/
  materials/
    INDEX.md                    ← human + Claude-readable listing
    <file.pdf>                  ← original upload (kept intact)
    .text/
      <file.pdf>.md             ← page-anchored markdown mirror — Grep this
  .studyground-index/
    manifest.json               ← per-file stats (sha256, pages, ≈ tokens, status)
    chunks.jsonl                ← chunked text for ranked search
    bm25.json                   ← pre-built BM25 postings
    vectors.jsonl               ← optional embeddings (when API key set)
```

## How to use it from a Claude turn

1. **Survey first.** `Read tracks/<track>/materials/INDEX.md` — one line per
   file with kind, page count, ≈ token count, and status. Don't blindly Glob
   the materials dir; the INDEX has everything you need to decide what to
   open.

2. **Retrieve, don't re-read.** For any factual lookup across materials, run

   ```
   Bash(sg-search "your specific query" --track <track> --k 8)
   ```

   Output is one block per chunk: `[filename, p.N]  bm25=… score=…` followed
   by a snippet. Use it like a citation index. Pass `--format json` if you
   want to parse it programmatically.

   **Batch your queries.** One broad `sg-search "transformer attention KV
   cache training inference"` is much cheaper than five narrow ones —
   each `Bash` call burns a turn. You typically have **≤16 turns total**
   for an intake/tutor reply, so plan for 2-4 `sg-search` calls, not 10.

3. **Zoom in.** When `sg-search` points you at `[paper.pdf, p.12]`, open

   ```
   Read tracks/<track>/materials/.text/paper.pdf.md
   ```

   and either Grep for the term or scroll to `## p. 12`. The mirror is plain
   markdown — Read/Grep both work normally.

4. **Fallback to native vision** when a material's status is `image-pdf`,
   `pending`, `failed`, or `unsupported`. The original file is always still
   there:

   ```
   Read tracks/<track>/materials/<file.pdf> pages: "12-15"
   ```

   (Max 20 pages per call. Claude's native PDF Read does vision-based OCR
   on image-only pages.)

## Adding new materials (edit-mode tutors only)

If you're an edit-mode tutor/intake and the learner asks you to drop a new
paper or reference into the track:

1. Land the file in `tracks/<track>/materials/<file>` — `Bash(curl -o ...)`,
   `Bash(git clone ...)`, `Bash(unzip ...)`, or `Bash(python3 -c
   "urllib.request.urlretrieve(...)")` all work.
2. **Kick the index.** The fs watcher doesn't watch `materials/`, so the
   file won't show up in `sg-search` until you trigger a reindex:

   ```
   Bash(curl -s -X POST "http://127.0.0.1:${STUDYGROUND_PORT}/api/tracks/<track>/reindex")
   ```

   `STUDYGROUND_PORT` is in your env (default 4321). The endpoint returns
   immediately; the reconcile runs async. Manifest + INDEX.md update on
   their own — usually within a few seconds for a single PDF, longer for
   a fat dump.

3. Tell the learner what landed and that it'll be searchable shortly. Use
   `sg-search` to confirm once the reindex finishes if they want a
   citation right away.

Don't write into `.studyground-index/` or `.text/` by hand — those are
regenerated.

## Citation format

**Always** cite material-grounded claims as `[<filename>, p.<N>]` — single
square brackets, filename verbatim from INDEX.md, `p.N` for a single page,
`p.N-M` for a range (ASCII hyphen `-` or en-dash `–` both work). Example:

> The transformer's quadratic attention cost comes from the full
> Q·Kᵀ matrix [Vaswani et al. 2017.pdf, p.3].

For a whole-file reference where pages don't apply, drop the page suffix:
`[<filename>]`.

The web reader renders these as small clickable chips. Clicking a chip
opens the file in the inline material viewer panel; for PDFs it jumps
to the cited page (the first number when a range is given).

Don't say "as the paper says" without the bracket. Don't fabricate page
numbers — if you didn't read the page, don't cite it. The exact bracket
form matters — `(file.pdf, p.3)` or `file.pdf p.3` won't be turned into
a clickable chip.

## What you do NOT do

- **Don't try `pdftotext` / `pdfimages` via Bash.** Not allowed, not
  installed. Use the text mirror or native PDF Read.
- **Don't dump entire long PDFs into the conversation** to "see what's in
  there." That's what `sg-search` and `INDEX.md` are for.
- **Don't edit anything under `.studyground-index/`** — it's regenerated
  whenever a material changes.
- **Don't edit the `.text/<file>.md` mirrors** — they're regenerated on
  every re-extraction.

## When status ≠ ok

| status         | what it means                              | what to do                                         |
| -------------- | ------------------------------------------ | -------------------------------------------------- |
| `ok`           | text extracted, mirror + index ready       | Use `sg-search` / Read the mirror.                 |
| `pending`      | extraction running (just uploaded)         | Use native `Read(file.pdf, pages:)` for this turn. |
| `image-pdf`    | scanned/image-only PDF, text extraction blank | Use native `Read(file.pdf, pages:)`; Claude's vision will OCR. |
| `failed`       | extraction errored                         | Fall back to native Read; mention the file may be malformed. |
| `unsupported`  | binary type we don't extract (.docx, .pptx, archives, …) | Tell the learner the file type isn't auto-indexed; offer to read it directly if Claude can. |
