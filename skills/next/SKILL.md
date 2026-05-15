---
name: next
description: Generate the next lesson in the current track. Reads progress.json, writes a new lesson file, updates progress. Use when the user is ready to advance.
---

# studyground: next

Generate the next lesson in the user's current track.

## Steps
1. Read `$STUDYGROUND_DIR/progress.json` to find `current_track` and what's been covered.
2. **Read `$STUDYGROUND_DIR/tracks/<current_track>/curriculum.md` first.** If it exists, the next lesson should be the **next item in its Plan that isn't already in `completed[]`**. Match its title and scope closely. If the user's recent activity (stuck-points in memory, btw chats) suggests they need a detour, you may insert one — but in the lesson's "Why this matters" paragraph briefly explain why this isn't the original Plan's next item.
3. **Glob `$STUDYGROUND_DIR/tracks/<current_track>/materials/`.** If anything is there, read it — these are reference sources the user uploaded. `Read` handles PDFs natively; for files >10 pages pass `pages: "1-N"` (max 20 per call) and iterate as needed. Ground the lesson in them; cite specific passages when relevant. Materials are authoritative over your priors. Don't try `pdftotext` or similar via Bash — the Read tool replaces them.
4. Read the most recent lesson file in `tracks/<current_track>/lessons/` to pick up the narrative thread.
5. Skim `$STUDYGROUND_DIR/memory/CLAUDE.md` for learner profile + recent stuck-points.
6. Write `$STUDYGROUND_DIR/tracks/<current_track>/lessons/<NN+1>-<slug>.md` following `_shared/lesson-format.md`.
7. Update `progress.json`: move previous `current` into `completed`, set new lesson as `current`.

## Pacing
- 5–10 min read per lesson
- One main concept per lesson
- 1–2 `?>` markers where a thoughtful student would pause. Each `?>` MUST be followed by a single line `<!-- answer:pending -->` and NO pre-written answer.
- 0–3 `?>>` btw markers, each with a short pre-written answer inside `<details><summary>deeper</summary>...</details>`.
- 0–1 `:::exercise` blocks

## If no track exists
If `progress.json` has no `current_track`, ask which topic to start (or pick something close to the user's recently expressed interest) and then defer to the `learn` skill.
