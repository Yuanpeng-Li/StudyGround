---
name: next
description: Generate the next lesson in the current track. Reads progress.json, writes a new lesson file, updates progress. Use when the user is ready to advance.
---

# studyground: next

Generate the next lesson in the user's current track.

## Steps
1. Read `$STUDYGROUND_DIR/progress.json` to find `current_track` and what's been covered.
2. Read the most recent lesson file in `lessons/` to understand the narrative thread.
3. Skim `$STUDYGROUND_DIR/memory/CLAUDE.md` for the learner profile and recent stuck-points.
4. Pick the next concept that naturally builds on what's done.
5. Write `$STUDYGROUND_DIR/lessons/<NN+1>-<slug>.md` following `_shared/lesson-format.md`.
6. Update `progress.json`: move previous `current` into `completed`, set new lesson as `current`.

## Pacing
- 5–10 min read per lesson
- One main concept per lesson
- 1–2 `?>` markers where a thoughtful student would pause. Each `?>` MUST be followed by a single line `<!-- answer:pending -->` and NO pre-written answer.
- 0–3 `?>>` btw markers, each with a short pre-written answer inside `<details><summary>btw</summary>...</details>`.
- 0–1 `:::exercise` blocks

## If no track exists
If `progress.json` has no `current_track`, ask which topic to start (or pick something close to the user's recently expressed interest) and then defer to the `learn` skill.
