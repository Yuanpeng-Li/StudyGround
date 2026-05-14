---
name: serve
description: Start the local studyground web reader. Run this first thing in a learning session.
---

# studyground: serve

Start the local web reader so the user can read rendered lessons.

Run:

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/studyground" serve
```

This runs in the foreground. Run it in a separate terminal, or background it (`&`) if the user wants to keep using this Claude Code session.

After it starts, tell the user the URL printed by the command (usually `http://localhost:4321`).

If the command fails:
- Run `"${CLAUDE_PLUGIN_ROOT}/bin/studyground" doctor` and report the output.
- The most common issues are: missing `node` (need >= 20), missing `claude` on PATH, or the port is already in use.
