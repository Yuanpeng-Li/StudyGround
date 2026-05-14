# studyground

A Claude Code plugin for AI-assisted learning. Read rendered lessons in a local
web reader. Ask questions inline. Run Python code in the browser. Code along in
VSCode.

> **Status**: all four milestones implemented & locally end-to-end tested.
> Browser-side rendering / Pyodide execution not yet verified by a human eye —
> open `http://localhost:4321` to check.

## What it does

```
Web reader (localhost)     —  read lessons, click Ask, Run, Check, Recap, Next
Claude Code (background)   —  the tutor; writes lessons/*.md and feedback files
VSCode (deep links)        —  open exercises/<name>/ for hands-on coding
```

All state is files under `$STUDYGROUND_DIR` (default `~/studyground`):

```
lessons/        — written by Claude, rendered by the web reader
exercises/      — scaffolded on first "Open in VSCode" click
memory/CLAUDE.md  — cross-session learner profile
progress.json   — current track and lesson
```

## Quick start

For now (pre-marketplace), use this repo directly:

```bash
# In a CC session, the plugin can be enabled via:
#   claude --plugin-dir /path/to/this/repo …
# or by symlinking into ~/.claude/plugins/cache/ and enabling.
#
# To just run the web reader standalone (no CC integration needed):
./bin/studyground serve
# → http://localhost:4321
```

Click **Next →** to generate the first lesson; from there everything happens
in the browser.

## Skills (CC entry points)

| Skill | What it does |
|---|---|
| `/studyground:serve` | Start the local web reader |
| `/studyground:learn <topic>` | Start a new learning track |
| `/studyground:next` | Generate the next lesson in the current track |
| `/studyground:ask` | (called by `/api/ask`) fill in an inline `?>` answer |
| `/studyground:check` | (called by `/api/check`) review an exercise solution |
| `/studyground:recap` | (called by `/api/recap`) fold answered Q&A in a lesson |

## In-lesson markers

| Marker | Meaning |
|---|---|
| `?> ...` + `<!-- answer:pending -->` | Main question. User clicks **Ask**; CC writes the answer between `<!-- answer:start -->` / `<!-- answer:end -->`. |
| `?>> ...` + `<details>` | Tangential question; pre-answered, folded by default. Doesn't break narrative. |
| ` ```python run ` | In-browser executable cell (Pyodide; numpy preloaded). |
| `:::exercise <name> ... :::` | Hands-on coding block. Scaffolds `exercises/<name>/` and opens in VSCode. |
| `<!-- feedback:start name=... -->` | `/check` review output, rendered as a styled callout. |

## Architecture

```
   ┌─────────────────────┐
   │  Web reader         │  loads markdown-it, KaTeX, Pyodide from CDN
   │  (localhost:4321)   │
   └──────────┬──────────┘
              │ POST /api/{next,ask,check,recap,exercise/scaffold}
              ↓
   ┌─────────────────────┐
   │  Node server        │  node:http, chokidar-free fs.watch, SSE
   │  spawns claude -p   │
   └──────────┬──────────┘
              │ claude -p --plugin-dir <ROOT> --add-dir <STUDYGROUND_DIR>
              ↓                --allowed-tools Read,Edit,Write,Glob,Grep,Skill,Task
   ┌─────────────────────┐
   │  Headless CC        │  invokes the studyground skills, writes files,
   │  (short-lived)      │  exits. SSE pushes the change to the web.
   └─────────────────────┘
```

## What's not in M1–M4

- **Distribution**: not published to a marketplace. Use `--plugin-dir` for now.
- **`?>>` deep-dive ask**: btw markers are pre-answered at generation time;
  the subagent re-deepen flow is wired but not exercised in any UI button.
- **Code execution in `/check`**: static review only. No `pytest` / `python`
  runs from the grader (use Pyodide cells for quick checks, or just run it
  yourself in VSCode).
- **Streaming generation**: the web shows "thinking…" then a full re-render
  when CC finishes. No stream-json plumbing yet.

## Milestones

- **M1** ✓ skeleton, `/next` round-trip, math rendering, plugin manifest validates
- **M2** ✓ inline `?>` / `?>>` Q&A loop, btw subagent
- **M3** ✓ `:::exercise` blocks, `vscode://` jumps (incl. WSL), `/check` grading
- **M4** ✓ Pyodide runner for `python run` cells, `/recap` folding, feedback rendering

## License

MIT
