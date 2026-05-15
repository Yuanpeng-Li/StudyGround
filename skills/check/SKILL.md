---
name: check
description: Review the user's solution for one studyground exercise. Reads exercises/<name>/main.py, gives feedback, writes it to exercises/<name>/feedback.md and to a feedback block in the calling lesson.
---

# studyground: check

Review the user's attempt at one exercise.

## Invocation context

You are called by `/api/check`. The request gives:
- `lesson` — slug like `01-attention` (where the `:::exercise` block was authored)
- `exercise` — name like `linear-attention` (corresponds to `exercises/<name>/`)

## Steps

1. Read `exercises/<exercise>/main.py` (and any other .py files there). If `main.py` is unmodified from the scaffold (`# TODO: implement` still present and no other code), say so politely and stop — don't fabricate feedback for empty code.
2. Read `exercises/<exercise>/README.md` to recall the goal.
3. Read the source `:::exercise <exercise>` block in `lessons/<lesson>.md` for the original framing.
4. Review the code:
   - Correctness vs the goal
   - Common gotchas (shape errors, off-by-one, missing edge cases)
   - Style nits (only if they obscure intent — don't be pedantic)
5. Write your review to `exercises/<exercise>/feedback.md`, replacing any existing content. Use markdown. 2–6 paragraphs. Lead with the bottom line ("Looks correct, here's one concern…" or "Close, but the shape is off in the matmul step…"). Don't open with "Great work!" / "Excellent job!" or other warm-up boilerplate — write like a code reviewer, not a cheerleader.
6. Append (or replace if it exists) a feedback block in `lessons/<lesson>.md`, immediately below the matching `:::exercise <exercise>` ... `:::` block. Use this exact format:

   ```
   <!-- feedback:start name="<exercise>" -->
   *Last checked: <YYYY-MM-DD>* — one-sentence summary.

   <details>
   <summary>Full review</summary>

   {full review markdown here}

   </details>
   <!-- feedback:end -->
   ```

   If a `<!-- feedback:start name="<exercise>" -->` ... `<!-- feedback:end -->` block already exists for this exercise, replace it. Don't accumulate stale reviews.

## Constraints

- Do not edit `main.py` or `test_main.py` — those are the user's workspace.
- Don't update `progress.json` from this skill.
- If `main.py` has obvious off-the-rails issues (wrong language, totally unrelated code), say so plainly — don't pretend it's "almost there".
- **If the caller granted Bash(python *) / Bash(pytest *) access**, run `test_main.py` with pytest and include the result in your feedback (PASS/FAIL summary at top, then a quick interpretation if anything failed). Otherwise the review is static-only.
