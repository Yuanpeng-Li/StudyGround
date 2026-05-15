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

Modern lessons are **pre-answered at generation time** — the marker already
has an `<!-- answer:start --> … <!-- answer:end -->` body sitting under it.
This endpoint is therefore mostly used in two cases:

- The lesson predates the pre-write rule and still has `<!-- answer:pending -->`.
- The learner clicked Ask on an already-answered question to ask for a
  different / deeper take, and the caller is asking you to rewrite the body.

The flow:

1. Read `lessons/<slug>.md`.
2. Count `?>` and `?>>` markers from the top; locate the one at `index` and
   verify it matches `question` and `kind`.
3. Look at what's directly under that marker:
   - If you see `<!-- answer:pending -->`, replace that single line with the
     `answer:start` / `answer:end` block in step 4 below.
   - If you see an existing `<!-- answer:start -->` … `<!-- answer:end -->`
     block, **replace its body** (the markdown between the start/end
     comments — keep both comments) with the new answer.
   - If you see neither, that's an unexpected lesson shape: exit without
     writing and report the mismatch.
4. The block has this exact form:

   ```
   <!-- answer:start -->
   {your answer here, markdown, math allowed, multiple paragraphs ok}
   <!-- answer:end -->
   ```

5. Write the file back and exit.

The reader auto-expands a pre-answered `<details>` so the answer reads as a
natural continuation of the lesson. 1–4 paragraphs. Use math
(`$...$`, `$$...$$`) and code fences as needed. Don't open with "Great
question!" or other ChatGPT preamble — write like the lesson author.

## Btw (`?>>`) flow

A `?>>` marker is normally pre-answered at lesson generation time. But if the
user explicitly asks for a deeper take, you'll be called to **replace** the
existing `<details>` block's body.

1. Read the lesson, find the Nth marker (kind=btw)
2. The next block is `<details>...</details>` — replace its contents
   (everything between `<summary>...</summary>` and `</details>`) with a deeper
   answer that builds on the original short one
3. Keep the `<summary>deeper</summary>` line intact

You don't need to delegate this — the entire `claude -p` call is already a
short-lived isolated process, so there's no main context to protect.

## Constraints

- Edit exactly one block. Don't touch other parts of the file.
- Preserve the question line verbatim (don't reword `?>` text).
- Don't update `progress.json` from this skill.
- If the marker can't be found, exit without writing anything and report
  the mismatch in your reply text.
