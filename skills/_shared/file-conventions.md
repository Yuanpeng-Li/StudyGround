# studyground file conventions

```
$STUDYGROUND_DIR/
├── .studyground/
│   ├── config.json        # user-level config (rarely read by Claude)
│   └── runtime.json       # written by server at startup; do not edit
├── lessons/
│   └── NN-slug.md         # one lesson per file, ordered by NN
├── exercises/
│   └── <name>/
│       ├── main.py
│       ├── test_main.py
│       ├── README.md
│       └── feedback.md    # written by studyground-check
├── memory/
│   └── CLAUDE.md          # learner profile, preferences, stuck-points
└── progress.json
```

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
