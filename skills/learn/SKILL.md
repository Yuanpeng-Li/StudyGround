---
name: learn
description: Start a new learning track on a topic. Generates the first lesson under $STUDYGROUND_DIR/lessons/ and updates progress.json. Use when the user says "let's learn X" or invokes /studyground:learn.
---

# studyground: learn

You are tutoring the user in **studyground** — a local learning environment where lessons live as markdown files under `$STUDYGROUND_DIR`. The user reads them in a web renderer with full math and code rendering, so write rich markdown.

## Inputs
- Topic the user wants to learn (from invocation argument or recent context)
- `$STUDYGROUND_DIR/progress.json` — current state
- `$STUDYGROUND_DIR/memory/MEMORY.md` — index of cross-course memory entries (Read it, then Read the entries relevant to this turn; default = `memory/learner-profile.md` for style/pace/depth/goals; also `type: project` entries when their description touches this track)
- `$STUDYGROUND_DIR/tracks/<track-slug>/curriculum.md` — **if present, this is the authoritative plan** produced by the intake skill. The first lesson must match its "1. {title} — {scope}" entry. Do not invent a different sequence.
- `$STUDYGROUND_DIR/tracks/<track-slug>/materials/` — user-uploaded reference materials (PDFs, notes, web snippets). **Start with `Read tracks/<track>/materials/INDEX.md`** — the auto-generated listing shows every file with page count, ≈ token count, and status. **For content, prefer `Bash(sg-search "<topic>" --track <track> --k 8)`** to find the most relevant passages across all files; cite as `[<filename>, p.<N>]`. To zoom in, open `materials/.text/<file>.md` (page-anchored mirror) at the matching `## p. N`. For image-pdf / pending / failed files, fall back to native `Read(file.pdf, pages: "1-N")` (≤20 pages per call). Don't try `pdftotext` via Bash. If materials conflict with your priors, materials win. Full retrieval reference: `skills/_shared/materials.md`.

## Output
Create exactly one new lesson file at `$STUDYGROUND_DIR/tracks/<current_track>/lessons/<NN>-<slug>.md`, where `NN` is the next zero-padded index (start at `01` for a new track).

## Lesson format
See `_shared/lesson-format.md` for the full spec. Highlights:
- Frontmatter with `title`, `track`, `index`, `prereqs`
- H2 sections; never deeper than H3
- Math with `$...$` and `$$...$$`
- Code with fenced blocks; ` ```python run` for in-browser executable, plain ` ```python` for read-only
- **Tables: real markdown pipe syntax** (`| col | col |` with a `---` separator row). NEVER a code fence containing space-aligned text — that renders as `<pre>`, not as a table, and ignores all table styling. Pipe tables get header underline, row separators, zebra, hover, and inline-code chips automatically.
- `?>` markers: write the question AND a pre-written answer wrapped in `<!-- answer:start --> … <!-- answer:end -->` (1-4 sentences, matching the lesson's voice — longer only if the answer truly needs it). The reader folds these by default so the learner can pause and think before peeking.
- `?>>` markers: write the question AND a short pre-answer wrapped in `<details>` with `<summary>deeper</summary>`. Keep btw answers 1–3 sentences.
- `:::exercise <name>` containers for hands-on practice (creates `exercises/<name>/`)

## After writing
Update `$STUDYGROUND_DIR/progress.json`:
- If the track is new, add an entry
- Set `current_track` and `tracks.<track>.current` to this new lesson's slug

Keep the first lesson short (5–10 min read). Set up the mental model; don't try to cover everything.
