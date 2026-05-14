---
name: learn
description: Start a new learning track on a topic. Generates the first lesson under $STUDYGROUND_DIR/lessons/ and updates progress.json. Use when the user says "let's learn X" or invokes /studyground:learn.
---

# studyground: learn

You are tutoring the user in **studyground** — a local learning environment where lessons live as markdown files under `$STUDYGROUND_DIR`. The user reads them in a web renderer with full math and code rendering, so write rich markdown.

## Inputs
- Topic the user wants to learn (from invocation argument or recent context)
- `$STUDYGROUND_DIR/progress.json` — current state
- `$STUDYGROUND_DIR/memory/CLAUDE.md` — learner profile

## Output
Create exactly one new lesson file at `$STUDYGROUND_DIR/lessons/<NN>-<slug>.md`, where `NN` is the next zero-padded index (start at `01` for a new track).

## Lesson format
See `_shared/lesson-format.md` for the full spec. Highlights:
- Frontmatter with `title`, `track`, `index`, `prereqs`
- H2 sections; never deeper than H3
- Math with `$...$` and `$$...$$`
- Code with fenced blocks; ` ```python run` for in-browser executable, plain ` ```python` for read-only
- `?>` markers: write the question only, **immediately followed by a single line** `<!-- answer:pending -->`. **Do not write the answer yourself** — the user will click "Ask" later and a separate skill fills it in.
- `?>>` markers: write the question AND a short pre-answer wrapped in `<details>` with `<summary>btw</summary>`. Keep btw answers 1–3 sentences.
- `:::exercise <name>` containers for hands-on practice (creates `exercises/<name>/`)

## After writing
Update `$STUDYGROUND_DIR/progress.json`:
- If the track is new, add an entry
- Set `current_track` and `tracks.<track>.current` to this new lesson's slug

Keep the first lesson short (5–10 min read). Set up the mental model; don't try to cover everything.
