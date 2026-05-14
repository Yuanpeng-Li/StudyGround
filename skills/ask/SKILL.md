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
user explicitly asks for a deeper take, you'll be called to **replace** the
existing `<details>` block's body.

1. Read the lesson, find the Nth marker (kind=btw)
2. The next block is `<details>...</details>` — replace its contents
   (everything between `<summary>...</summary>` and `</details>`) with a deeper
   answer that builds on the original short one
3. Keep the `<summary>btw</summary>` line intact

You don't need to delegate this — the entire `claude -p` call is already a
short-lived isolated process, so there's no main context to protect.

## Constraints

- Edit exactly one block. Don't touch other parts of the file.
- Preserve the question line verbatim (don't reword `?>` text).
- Don't update `progress.json` from this skill.
- If the marker can't be found, exit without writing anything and report
  the mismatch in your reply text.
