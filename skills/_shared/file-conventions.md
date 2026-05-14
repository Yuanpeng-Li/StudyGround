# studyground file conventions

```
$STUDYGROUND_DIR/
├── .studyground/
│   ├── config.json              # user-level config (rarely read by Claude)
│   └── runtime.json             # written by server at startup; do not edit
├── tracks/
│   └── <track-slug>/            # each course is fully self-contained here
│       ├── track.json           # { slug, title, description, emoji, created_at }
│       ├── curriculum.md        # plan written by the intake skill; learn/next read this
│       ├── lessons/
│       │   └── NN-slug.md       # one lesson per file, ordered by NN
│       ├── exercises/
│       │   └── <name>/
│       │       ├── main.py
│       │       ├── test_main.py
│       │       ├── README.md
│       │       └── feedback.md  # written by studyground-check
│       ├── materials/           # user-uploaded reference materials; Claude reads
│       │   ├── *.md
│       │   ├── *.txt
│       │   └── ...
│       └── threads/<id>.json    # persisted side-chat conversations (read-only for Claude)
├── memory/
│   └── CLAUDE.md                # learner profile, preferences, stuck-points (global)
└── progress.json                # { current_track, tracks: {<slug>: {current, completed, started_at}} }
```

**Key invariants**:
- A course is a directory: everything about it lives under `tracks/<slug>/`.
- Lessons declare their own `track:` in frontmatter (matches their parent dir),
  for redundancy / re-classification.
- `progress.json` only tracks pointers (current_track + per-track current/completed).
  Bulk content stays in the track dirs.

## `progress.json` shape

```json
{
  "current_track": "transformers-from-scratch",
  "tracks": {
    "transformers-from-scratch": {
      "current": "03-attention",
      "completed": ["01-vectors", "02-softmax"],
      "started_at": "2026-05-13"
    }
  }
}
```

When advancing: append previous `current` to `completed`, set new `current`.
