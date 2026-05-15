# Lesson format spec

Every lesson lives at `$STUDYGROUND_DIR/lessons/<NN>-<slug>.md` and follows this format.

## Frontmatter

```yaml
---
title: Attention is just weighted sum
track: transformers-from-scratch
index: 03
prereqs: [01-vectors, 02-softmax]
estimated_minutes: 8
---
```

## Body skeleton

```markdown
# {title}

## Why this matters
One short paragraph framing the concept's role in the bigger picture.

## The idea
Main exposition. Inline math with $math$, display math with $$math$$.

?> A question a thoughtful student would have here, in their voice

<!-- answer:pending -->

## Worked example
Use ` ```python run` for executable cells (Pyodide), plain ` ```python` for read-only.

?>> Tangential question the curious student might wonder about

<details>
<summary>deeper</summary>

A short, pre-written answer to the tangential question. Folded by default so
it doesn't break the main reading flow.

</details>

:::exercise linear-attention
Brief description of the exercise. The web UI renders an "Open in VSCode"
button for this block and creates the scaffold at exercises/<name>/.
:::

## Recap
Three bullets max.
```

## Markers (studyground-specific)

### `?>` — main-thread question (NOT pre-answered)

Place where a thoughtful student would pause and ask. **Do not write the answer.**
The user clicks the marker in the web UI to ask; an answer is then filled in.

Format:

```markdown
?> Question text in the student's voice

<!-- answer:pending -->
```

After the user clicks ask, the `<!-- answer:pending -->` line is replaced with:

```markdown
<!-- answer:start -->
The answer, written as if continuing the lesson narrative.
<!-- answer:end -->
```

So the final shape becomes part of the lesson body.

### `?>>` — btw / tangential question (pre-answered, folded)

For curiosities that would distract from the main thread. **Always pre-write a
short answer**, wrapped in `<details>` so the user can ignore or expand.

Format:

```markdown
?>> Question text

<details>
<summary>deeper</summary>

A 1–3 sentence answer here. Keep it tight — if it needs to be long, it's
probably main-thread material.

</details>
```

**Two separate top-level blocks**: the `?>>` line on its own (blank line
above and below), then the `<details>`. The web reader merges them into a
single rounded callout where the question is the click-to-expand summary
and the body is the deeper answer. The `<summary>` is the literal word
`deeper`, *never* the question text.

❌ Don't do this — the marker leaks into the summary verbatim:

```markdown
<details>
<summary>?>> Question text</summary>
answer
</details>
```

❌ And don't pre-answer a `?>` (main-thread question) by wrapping it in a
details block either. `?>` is **NOT** pre-answered; the user clicks Ask to
generate one. Use `<!-- answer:pending -->` on its own line right after the
`?>` question.

### `:::exercise <name>` — hands-on coding block

```markdown
:::exercise <name>
What the user should build. The web renders an "Open in VSCode" button
for this block and creates exercises/<name>/ if missing.
:::
```

### Code fences

- ` ```python` — read-only code, syntax-highlighted only
- ` ```python run` — in-browser executable (Pyodide, M4+). For now renders with a "run" badge.

## Style rules

- Lead each section with the punchline, then justify
- Skip filler ("In this lesson we'll explore...")
- Don't use headings deeper than H3
- 800–1500 words per lesson. Split, don't sprawl.
- 1–3 `?>` markers per lesson (where a sharp student naturally pauses)
- 0–3 `?>>` markers per lesson (tangents worth noting but not central)
- 0–1 `:::exercise` blocks per lesson
- No images in v1 (text-first)
