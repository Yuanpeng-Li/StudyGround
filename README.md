<p align="center">
  <img src="docs/logo.png" alt="StudyGround" width="520" />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white" alt="Node ≥ 20" />
  <img src="https://img.shields.io/badge/Claude%20Code-plugin-7C5CFA" alt="Claude Code plugin" />
</p>

**StudyGround** is a Claude Code plugin for AI-assisted self-study. You read
rendered lessons in a local web reader, talk to a tutor that knows your course,
run Python in the browser, and jump into VSCode for hands-on exercises. Claude
Code writes the lessons; you drive the pace.

## Highlights

- **Multi-course home.** Each course is a folder with its own curriculum,
  lessons, materials, threads, and progress. Import / export as `.tgz`.
- **Real intake.** The first session is an open-ended conversation, not a
  form. The tutor writes a curriculum once it has enough to go on.
- **Lessons with live markers.** Inline `?>` questions become **Ask**
  buttons; ```` ```python run ```` blocks execute in the browser via Pyodide;
  `:::exercise <name>:::` blocks scaffold a folder and deep-link into VSCode.
- **Side chats that fold back.** Highlight a passage, chat about it in a
  thread, then **save** — the conversation gets folded into the lesson as a
  collapsible `?>>` btw block, anchored at the highlight.
- **Persistent tutor.** A floating chat that knows the whole course (plan,
  what's done, recent threads, your materials) and suggests next steps.
- **Materials.** Drop PDFs / notes into a course; the tutor and the
  generator ground new lessons in them.
- **Quality-of-life.** Command palette (⌘K), keyboard navigation,
  light / dark / auto theme, outline rail, lesson search across courses.

## Quick start

Requires Node ≥ 20 and the `claude` CLI on `PATH`.

```bash
git clone <this-repo> studyground
cd studyground
./bin/studyground setup        # installs deps, scaffolds ~/studyground, runs doctor
./bin/studyground serve        # → http://localhost:4321
```

Or enable as a Claude Code plugin (point CC at this repo):

```bash
claude --plugin-dir /path/to/studyground
```

From the home view, click **+ New course** (or **Import a course**), talk
to the tutor for a bit, then hit **Plan curriculum →**. After that,
**Next →** generates each lesson.

## Materials (NotebookLM-style RAG)

Drop PDFs / papers / notes / scanned images into a course's `materials/`
folder (via the sidebar **+** button, the intake screen, or directly into
`~/studyground/tracks/<slug>/materials/`). StudyGround processes them
asynchronously:

- **PDF text** is extracted with `pdfjs-dist` and saved as a page-anchored
  markdown mirror at `materials/.text/<file>.md` (`## p. N` headers per
  page) — Claude can `Grep` and `Read` this with its existing tools.
- **Images** (PNG / JPG / TIFF / …) are OCR'd with bundled `tesseract.js`
  (English by default — set `STUDYGROUND_TESS_LANGS=eng+chi_sim` for multi-lang).
- **Image-only PDFs** are flagged `image-pdf`; Claude falls back to its
  native PDF `Read(file, pages:)` (which has vision) — no manual OCR needed.
- **Stats** — pages, ≈ tokens, char count, chunk count — show up on the
  sidebar chips and the auto-generated `materials/INDEX.md`.
- **Search** with `bin/sg-search "query" --track <slug>` returns top
  chunks ranked by BM25 (and embeddings when an API key is set), with
  `[file, p.N]` citations. Skills (intake / tutor / next / learn) are
  wired to use it.
- **Incremental** — re-uploading the same file is a sha256-keyed no-op;
  deleting cleans up all derived artefacts. Drop a file in via VSCode and
  the server reconciles on its next boot (or via "Re-index" in the UI).

**Optional vector embeddings.** Set one of these env vars before `serve`
and StudyGround will build cosine-rankable embeddings alongside BM25,
combining them via `α·bm25 + (1−α)·cosine`:

```bash
export VOYAGE_API_KEY=...    # voyage-3-large
# or
export OPENAI_API_KEY=...    # text-embedding-3-small
```

Without either key, BM25 + the text mirror covers the common cases just
fine — no external services involved.

## CLI

```text
studyground setup          One-shot: npm install, scaffold, doctor
studyground init           Scaffold the studyground directory (~/studyground)
studyground serve          Start the local web reader (auto-runs setup if needed)
studyground open [lesson]  Open the reader in your default browser
studyground doctor         Check environment (claude, node, deps, vector key, per-track index health)
sg-search "<query>" --track <slug>   Search a track's materials (BM25 + optional vectors)
```

## Skills (Claude Code entry points)

| Skill                    | What it does                                                            |
| ------------------------ | ----------------------------------------------------------------------- |
| `/studyground:serve`     | Start the local web reader                                              |
| `/studyground:learn`     | Begin a new learning track                                              |
| `/studyground:intake`    | Open-ended first conversation; finalizes `curriculum.md`                |
| `/studyground:next`      | Generate the next lesson in the current track                           |
| `/studyground:tutor`     | Course-level conversation (called by the in-app tutor chat)             |
| `/studyground:ask`       | Fill in an inline `?>` answer (called by **Ask**)                       |
| `/studyground:check`     | Review an exercise solution (called by **Check**)                       |
| `/studyground:recap`     | Fold answered Q&A in a lesson (called by **Recap**)                     |
| `/studyground:save-thread` | Fold a side-chat back into the lesson as a `?>>` btw block            |

## In-lesson markers

| Marker                                        | Meaning                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `?> ...` + `<!-- answer:pending -->`          | Main question — **Ask** triggers a write between `<!-- answer:start -->` / `<!-- answer:end -->` |
| `?>> ...` + `<details>`                       | Tangential question; pre-answered, folded by default                                             |
| ```` ```python run ````                       | In-browser executable cell (Pyodide; numpy preloaded)                                            |
| `:::exercise <name> ... :::`                  | Hands-on coding block — scaffolds `exercises/<name>/` and opens VSCode                           |
| `<!-- feedback:start name=... -->`            | `/check` review output, rendered as a styled callout                                              |

## On-disk layout

Everything lives under `$STUDYGROUND_DIR` (default `~/studyground`):

```
tracks/
  <slug>/
    track.json            title, description, emoji, timestamps
    curriculum.md         the plan (written by intake)
    lessons/              generated lesson .md files
    materials/            user-uploaded PDFs / notes / cheatsheets / images
      INDEX.md            auto-generated listing with stats + status
      .text/<file>.md     page-anchored markdown mirrors (Grep this!)
    .studyground-index/   manifest.json, chunks.jsonl, bm25.json, [vectors.jsonl]
    threads/              saved side-chat JSON files
    exercises/            scaffolded exercise folders
memory/MEMORY.md          index of cross-course memory entries (one line each)
memory/learner-profile.md cross-course learner profile (type=user)
memory/*.md               additional typed entries (allowed types: user / project)
progress.json             current track + per-track lesson cursor
```

Files are the source of truth — point a different editor at the same
directory and you'll see the same state.

## Architecture

```
   ┌─────────────────────┐
   │  Web reader         │  markdown-it + KaTeX + Pyodide from CDN
   │  (localhost:4321)   │  multi-course UI, threads, materials, tutor
   └──────────┬──────────┘
              │ POST /api/{next,ask,check,recap,intake,tutor,save-thread,…}
              ↓
   ┌─────────────────────┐
   │  Node server        │  node:http, fs.watch, SSE for live updates
   │  spawns claude -p   │  stream-json plumbing for live "thinking…"
   └──────────┬──────────┘
              │ claude -p --plugin-dir <ROOT> --add-dir <STUDYGROUND_DIR>
              ↓                --allowed-tools Read,Edit,Write,Glob,Grep,Skill,Task
   ┌─────────────────────┐
   │  Headless CC        │  invokes a studyground skill, writes files, exits.
   │  (short-lived)      │  SSE pushes the change back to the web reader.
   └─────────────────────┘
```

## Configuration

Set via env vars, or via the `userConfig` block in
[`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) when used as a CC plugin:

| Variable                          | Default            | Meaning                                          |
| --------------------------------- | ------------------ | ------------------------------------------------ |
| `STUDYGROUND_DIR`                 | `~/studyground`    | Where courses & state live                       |
| `STUDYGROUND_PORT`                | `4321`             | Local web reader port                            |
| `STUDYGROUND_CHUNK_CHARS`         | `1200`             | Chars per RAG chunk                              |
| `STUDYGROUND_CHUNK_OVERLAP`       | `200`              | Char overlap between chunks                      |
| `STUDYGROUND_TESS_LANGS`          | `eng`              | Tesseract languages, e.g. `eng+chi_sim`          |
| `STUDYGROUND_EMBEDDINGS_PROVIDER` | `auto`             | `auto` / `voyage` / `openai` / `off`             |
| `STUDYGROUND_VOYAGE_MODEL`        | `voyage-3-large`   | Voyage model when provider=voyage                |
| `STUDYGROUND_OPENAI_MODEL`        | `text-embedding-3-small` | OpenAI model when provider=openai          |
| `VOYAGE_API_KEY`                  | _(unset)_          | Activates Voyage embeddings                      |
| `OPENAI_API_KEY`                  | _(unset)_          | Activates OpenAI embeddings (used when no Voyage)|

## License

[MIT](LICENSE)
