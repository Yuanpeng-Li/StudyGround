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
# Run the local web reader directly (no plugin install needed):
./bin/studyground serve
#   → http://localhost:4321

# Or enable as a Claude Code plugin (point CC at this repo):
claude --plugin-dir /path/to/studyground
```

From the home view, click **+ New course** (or **Import a course**), talk
to the tutor for a bit, then hit **Plan curriculum →**. After that,
**Next →** generates each lesson.

## CLI

```text
studyground init           Scaffold the studyground directory (~/studyground)
studyground serve          Start the local web reader
studyground open [lesson]  Open the reader in your default browser
studyground doctor         Check environment (claude on PATH, node, WSL, …)
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
    track.json          title, description, emoji, timestamps
    curriculum.md       the plan (written by intake)
    lessons/            generated lesson .md files
    materials/          user-uploaded PDFs / notes / cheatsheets
    threads/            saved side-chat JSON files
    exercises/          scaffolded exercise folders
memory/CLAUDE.md        cross-session learner profile
progress.json           current track + per-track lesson cursor
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

| Variable             | Default          | Meaning                          |
| -------------------- | ---------------- | -------------------------------- |
| `STUDYGROUND_DIR`    | `~/studyground`  | Where courses & state live       |
| `STUDYGROUND_PORT`   | `4321`           | Local web reader port            |

## License

[MIT](LICENSE)
