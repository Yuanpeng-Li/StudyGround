---
name: save-thread
description: Fold a side-chat conversation into a lesson as a ?>> btw block, anchored near the passage the user highlighted. Use when /api/save-thread is invoked.
---

# studyground: save-thread

Fold a side-chat conversation into the lesson as a `?>>` block, anchored near
the text the user originally highlighted.

## Inputs (in the prompt)
- `lesson`: slug; file at `lessons/<lesson>.md`
- `selection`: the verbatim passage the user highlighted before starting the chat
- A transcript of the conversation (alternating user / assistant turns)

## Steps

1. Read `lessons/<lesson>.md`.
2. Find the location of `selection` in the file (literal substring match,
   preserving whitespace where possible). The insertion point is **immediately
   after the paragraph block** that contains the selection — that is, after
   the blank line that ends the paragraph.
3. If the selection cannot be found (e.g., a paraphrase), insert at the end of
   the lesson body, just **before** the `## Recap` section if one exists; otherwise at the very end.
4. Write the block in this exact shape:

   ```
   ?>> {short question-form title, 4–12 words, capturing the conversation}

   <details>
   <summary>btw — saved chat</summary>

   > "{selection, single line, truncate to ~140 chars with …}"

   {a synthesized 2–4 paragraph answer that reads as a unified btw — NOT a verbatim
   transcript. Use math (`$...$`, `$$...$$`) and code (` ``` `) where they earn their keep.
   Maintain the lesson's tone.}

   </details>
   ```

5. Save the file. Do not touch `progress.json`.

## Style

- Title in question form, e.g. `?>> What does the input/output "contract" actually mean?`
- The body should *synthesize* what came out of the conversation — the reader
  doesn't need to see the back-and-forth, only the takeaway.
- Match the density and tone of other `?>>` blocks in the same lesson.
- Don't repeat what's already in the main lesson body.
- Always include the `> "..."` blockquote of the selection at the top of the
  `<details>` body — it pins the saved block to its anchor.
