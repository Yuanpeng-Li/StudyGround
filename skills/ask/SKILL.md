---
name: ask
description: Answer an inline question marker (?> or ?>>) in a lesson file. Locates the Nth marker of the given kind and writes the answer in-place. Use when /api/ask routes a user question.
---

# studyground: ask

Answer one inline question marker inside a lesson file.

## Invocation context

You are called by `/api/ask`. The request gives:
- `lesson` — slug like `01-attention` (file is `lessons/<slug>.md`)
- `index` — which marker, counting all `?>` and `?>>` from the top (1-based)
- `kind` — `"main"` (for `?>`) or `"btw"` (for `?>>`)
- `question` — the question text as it appears in the file (for verification)

## Main-thread (`?>`) flow

1. Read `lessons/<slug>.md`
2. Count `?>` and `?>>` markers from the top; locate the one at `index` and verify it matches `question` and `kind`
3. Below that marker you will see a line `<!-- answer:pending -->`
4. Replace **that single line** with:

   ```
   <!-- answer:start -->
   {your answer here, markdown, math allowed, multiple paragraphs ok}
   <!-- answer:end -->
   ```

5. Write the file back and exit.

The answer should read as a natural continuation of the lesson — it WILL be
rendered inline as part of the main narrative. 1–4 paragraphs. Use math
(`$...$`, `$$...$$`) and code fences as needed.

## Btw (`?>>`) flow

A `?>>` marker is normally pre-answered at lesson generation time. But if the
user explicitly asks for an answer or a deeper take on a folded btw, you may
be called to **replace** the existing `<details>` block's body.

1. Read the lesson, find the Nth marker (kind=btw)
2. The next block is `<details>...</details>` — replace its contents
   (everything between `<summary>...</summary>` and `</details>`) with your
   new answer
3. Keep the `<summary>btw</summary>` line intact
4. For btw answers, **invoke the `btw-answerer` subagent via the Task tool** so
   the work happens in an isolated context. Pass the question + the
   surrounding lesson excerpt as context. Take the agent's response and write
   it into the file. This keeps the main session lean.

## Constraints

- Edit exactly one block. Don't touch other parts of the file.
- Preserve the question line verbatim (don't reword `?>` text).
- Don't update `progress.json` from this skill.
- If the marker can't be found, exit without writing anything and report
  the mismatch in your reply text.
