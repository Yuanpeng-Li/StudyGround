---
name: recap
description: Compact a lesson by folding answered ?> Q&A pairs into <details> blocks, so a re-read flows past them. Run after the user has worked through a lesson.
---

# studyground: recap

Fold the consumed Q&A in a lesson into collapsed `<details>` blocks. Leave the
main narrative intact.

## Steps

1. Read `lessons/<slug>.md`.
2. For each pair of `?> question` followed by `<!-- answer:start --> ... <!-- answer:end -->`, replace **both** the question line AND the answer block with:

   ```
   <details>
   <summary>?> {question text}</summary>

   {original answer body, verbatim}

   </details>
   ```

3. Leave `?>>` btw markers (they're already folded), `:::exercise` blocks,
   and `<!-- feedback:start --> ... <!-- feedback:end -->` blocks untouched.
4. Do not touch `<!-- answer:pending -->` markers (those haven't been asked
   yet — keep them visible so the user knows there's a question pending).
5. Save the file.

## Constraints

- Preserve the question text verbatim.
- Preserve the answer body verbatim (don't summarize or shorten).
- Don't add anything else (no "Q&A archive", no extra headings).
- Don't update progress.json.

## Why this exists

After 4–5 `?>` markers in one lesson have been asked and answered inline, the
file gets long and the main narrative is harder to skim on a second read. Folding
collapses the Q&A behind a single line, but keeps it one click away.

Note: in the reader, an answered `?>` is **open by default** (so the learner
sees the answer they earned). Recap is the explicit "I've already absorbed
this, now hide it on re-read" action — it overrides the default by rewriting
the source into a raw `<details>` block.
