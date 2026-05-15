# StudyGround — repo guide for Claude Code

StudyGround is a Claude Code plugin: a local web reader (port 4321) plus 9 skills that drive AI-assisted self-study. See README.md for product / user docs. This file is operational notes for when **you** are editing this repo.

## Two directories, don't confuse them

| Path | What it is | Edit when |
|---|---|---|
| `~/projects/studyground/` (this repo) | Plugin source: CLI, server, web reader, skills | Implementing features or fixing bugs |
| `$STUDYGROUND_DIR` (default `~/studyground/`) | Runtime data: courses, lessons, progress, materials | Never via code edits — it's user data |

The repo is the code. `~/studyground/` is the user's courseware. Don't reach across — server/skills read/write `$STUDYGROUND_DIR` at runtime, but the repo never ships user data.

## Where things live

```
bin/studyground         CLI entry: setup, init, serve, doctor, open
bin/sg-search           Materials BM25(+vector) search, used by skills via Bash
server/index.mjs        HTTP + SSE + path-safety + route handlers (60 KB — grep, don't top-read)
server/claude.mjs       Headless `claude -p` spawners, one per skill
server/materials/       PDF text extraction (pdfjs-dist), OCR (tesseract.js), BM25, embeddings
server/watcher.mjs      fs.watch → SSE so the reader live-updates on file changes
web/index.html          Three views: home / intake / reader (single-page, hash routing)
web/main.js             All client logic (158 KB — grep first; never read top-down)
web/style.css           All styles (82 KB — same rule)
skills/<name>/SKILL.md  Prompt + tool allowlist per skill. No restart needed when edited.
skills/_shared/         Canonical specs: lesson-format.md, materials.md, file-conventions.md
templates/studyground/  Seed for `$STUDYGROUND_DIR` on init (progress.json, memory/CLAUDE.md, …)
templates/exercise-scaffold/  Seed for `exercises/<name>/` (main.py, test_main.py, README.md)
scripts/                Playwright tests + screenshot tools (see "Tests" below)
.claude-plugin/plugin.json    Plugin manifest + userConfig schema
hooks/hooks.json        SessionStart hook: auto-runs `studyground init --quiet`
```

## Edit-layer rules (what needs restarting)

- **Skill prompts (`skills/*/SKILL.md`)** — no restart. Each `claude -p` spawn re-reads the file.
- **Server (`server/*.mjs`, `bin/studyground`)** — Ctrl-C and re-run `./bin/studyground serve`.
- **Web (`web/*`)** — just reload the browser. The server serves static files from `web/` directly.
- **`skills/_shared/*.md`** — referenced by multiple skills; changing one updates all of them. Treat as the single source of truth for lesson format, materials handling, and on-disk layout. **Any change to lesson markers / format must update `_shared/lesson-format.md` first**, then audit all skills that produce or consume that marker.

## Server start contract

`bin/studyground serve` spawns `server/index.mjs` with three env vars set:
- `STUDYGROUND_DIR` — runtime data root
- `STUDYGROUND_PORT` — default 4321
- `CLAUDE_PLUGIN_ROOT` — the repo root, used to find `web/` and shell out to `bin/sg-search`

To run the server standalone (rare), set those manually. `STUDYGROUND_DIR` must be an absolute path; `bin/studyground` does the `~` expansion.

## How skills get invoked

Server routes (`/api/next`, `/api/ask`, `/api/check`, `/api/recap`, `/api/intake`, `/api/tutor`, `/api/save-thread`) each spawn a short-lived headless Claude:

```
claude -p --plugin-dir <REPO> --add-dir <STUDYGROUND_DIR> \
  --allowed-tools Read,Edit,Write,Glob,Grep,Skill,Task,Bash(sg-search *) \
  "<skill-specific prompt>"
```

See `server/claude.mjs` for the exact tool allowlist per skill — they differ (e.g., `tutor` read-only mode drops Edit/Write). When changing a skill's tool surface, update both `claude.mjs` and the SKILL.md "Available tools" line.

Streaming uses `--output-format stream-json`; the server parses tool-use / text deltas and pushes them over SSE so the reader can show live "thinking…" output.

## Materials RAG conventions (READ BEFORE TOUCHING `server/materials/`)

- Original files in `tracks/<slug>/materials/<file>`. Never modified.
- Page-anchored text mirror in `materials/.text/<file>.md` with `## p. N` headers. Regenerated on extraction.
- Index artefacts in `tracks/<slug>/.studyground-index/`: `manifest.json`, `chunks.jsonl`, `bm25.json`, optional `vectors.jsonl`. **Never hand-edit** — `materials/index.mjs` owns them.
- Skills must use `Bash(sg-search "<query>" --track <slug>)` or read the `.text/` mirror. Never shell out to `pdftotext` / `pdfimages` (not installed, not allowed).
- Image-only PDFs get `status: "image-pdf"` in the manifest; the skill should fall back to native `Read(file.pdf, pages: "1-N")` for those.
- Full reference: `skills/_shared/materials.md`. Keep that file authoritative; don't restate the rules in each SKILL.md.

## Path safety

`server/index.mjs` exports `SAFE_SEGMENT_RE` / `isSafeSegment`. Any user-controlled path segment (slug, lesson, exercise, thread id, material filename) **must** be validated with it before being joined to disk. The whole-app guard is "fail fast and clean" — reject and return 400, don't sanitize.

## Tests & screenshots

`scripts/test-*.mjs` — Playwright e2e per feature. Convention: one file per feature/bugfix. Run with `node scripts/test-<name>.mjs`.

`scripts/shoot-*.mjs` — Playwright screenshot scripts for visual checks. Output to `scripts/.shots/` (gitignored).

`npm test` runs `scripts/test-materials.mjs` (the materials pipeline end-to-end). Other test scripts are run manually — there's no master runner yet. Prefer extending an existing close-fit script over adding a new one.

Tests spin up a fresh `STUDYGROUND_DIR=$(mktemp -d)` and start their own server on a random port. Don't point tests at the user's real `~/studyground/` — it may hold live course data.

## Lesson format quick rules

Full spec in `skills/_shared/lesson-format.md`. Most-violated rules:

- **Tables: pipe syntax only.** Never space-aligned text in a code fence — it renders as `<pre>` and skips all table styling.
- `?>` (main-thread Q) is **pre-answered** with `<!-- answer:start --> … <!-- answer:end -->`. The old "click Ask to fill" pattern (`<!-- answer:pending -->`) is supported as a fallback but new lessons should always pre-write.
- `?>>` (btw Q) is **two separate top-level blocks**: the `?>>` line, blank line, then `<details><summary>deeper</summary>…</details>`. The reader merges them. Never put the question text inside `<summary>`.
- No headings deeper than H3. 800–1500 words per lesson.

## Common gotchas

- `web/main.js` and `web/style.css` are large single files. Use `Grep` to find the symbol/selector, then `Read` with `offset`/`limit`. Don't read top-down.
- `server/index.mjs` mixes HTTP routes, SSE plumbing, lesson lock map, and SSE clients in one file. The route table starts ~halfway down; grep for `pathname ===` or `pathname.startsWith` to navigate.
- `~/studyground/tracks/` accumulates dev junk from test scripts (`next-lock-*`, `*-test`, `*-shot-*`, `intake-autojump-*`) that may sit alongside real user courses. Don't bulk-delete without confirming with the user.
- WSL note: `vscode://` URIs need the `vscode-remote` scheme. `bin/studyground doctor` detects WSL; `exercise.mjs::vscodeUriFor` handles the rewrite.

## Don't

- Don't commit `~/studyground/` data into the repo.
- Don't edit `.studyground-index/` or `materials/.text/*.md` directly — they're regenerated.
- Don't add a `<!-- answer:pending -->` marker to a freshly-generated lesson. Pre-write the answer.
- Don't introduce a second lesson-format authority. If a rule needs to change, change `skills/_shared/lesson-format.md` first.
