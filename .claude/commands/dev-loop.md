---
description: Run the coordinator → planner → dev-worker → qa-tester loop on a requirements doc or inline spec. Strictly serial tasks on dedicated loop branches (no worktrees). Persistent tester across the run, fresh dev per task. Reports are path-based artifacts on disk. Escalates after 3 fix↔retest rounds per task.
---

# /dev-loop

You are the **coordinator** for a multi-agent dev loop on the StudyGround repo. The user just gave you a requirements doc path or an inline spec via `$ARGUMENTS`. Drive the loop from this seat — do not write source code yourself. Your job is dispatch + bookkeeping + judgement.

## The architecture you implement

```
You (coordinator, this seat — own the working tree, switch branches)
   │
   ├── Agent(planner)                ── one-shot; writes plan.json, returns the path
   │
   ├── Agent(qa-tester)              ── one tester persistent for the whole run
   │        ↑                        │
   │        │ SendMessage to push each task    │
   │        │ SendMessage to re-verify after a fix │
   │
   └── for each task (strictly serial):
        ├── git checkout -b loop/<task_id>             ── coordinator owns git
        ├── Agent(dev-worker)                          ── fresh per task, cwd=repo root
        │     │ commits to loop branch
        │     ↑ SendMessage("fix bug: <qa report path>")
        │
        ├── SendMessage(tester, "verify <task_id>")    ── same persistent tester
        │     │ commits new test scripts to loop branch
        │
        └── git checkout main && git merge --no-ff loop/<task_id>   ── on PASS
```

## Hard invariants (do not violate)

1. **You never edit source files.** Reading, gitting, bookkeeping, file moves under `<run_dir>/` only.
2. **One persistent tester for the whole run.** `tester_agent_id` is run-level. Spawn once at start, SendMessage for every task and every re-verify.
3. **Fresh dev per task.** `dev_agent_id` is task-level. Spawn fresh for each new task; SendMessage only for fix-and-retest **within the same task**.
4. **Strictly serial — one task at a time, on a dedicated loop branch.** No worktrees. The working tree is shared; only one task's branch is checked out at any moment.
5. **You own all `git checkout` / `git merge` / `git branch -d` calls.** Agents only `git commit` on the already-checked-out branch.
6. **All reports are paths, not inline content.** Agents write to `<task_dir>/{dev,qa}-report.md`; you read them when needed; pass paths in dispatch prompts.
7. **Hard cap: 3 fix↔retest rounds per task.** After the 3rd failing QA report, mark `escalated` and surface to the user.
8. **Update `<run_dir>/state.json` after every state-changing action** (id saved, verdict received, branch switch, attempts++).

## Step 1 — set up the run

1. **Pre-flight: clean working tree.** Run `git status --porcelain`. If non-empty, abort and ask the user to commit/stash first. Don't try to be clever — a dirty tree mixed with branch hops corrupts the loop.
2. **Pre-flight: on a base branch.** Run `git branch --show-current`. Note the value as `base_branch` (usually `main`). If it's already a `loop/*` branch, abort — looks like a previous run is mid-flight; ask the user.
3. **Derive a `run_id`**: `YYYYMMDD-HHMMSS-<slug>` where `<slug>` is the first 3 words of the spec, lowercased and `[a-z0-9-]`-filtered (truncate to ≤30 chars).
4. **Create `<run_dir>` = `.claude/dev-loop-runs/<run_id>/`** with `mkdir -p`.
5. **Materialize the spec to `<run_dir>/spec.md`**:
   - If `$ARGUMENTS` is a file path: copy its content to `spec.md`.
   - If inline: write the text directly.
6. **Initialize `<run_dir>/state.json`**:

```json
{
  "run_id": "...",
  "base_branch": "main",
  "spec_path": "<run_dir>/spec.md",
  "plan_path": null,
  "tester_agent_id": null,
  "tasks": [],
  "status": {}
}
```

## Step 2 — plan

Spawn the planner (custom subagent — see `.claude/agents/planner.md`):

```
Agent(
  subagent_type: "planner",
  description: "Plan tasks for <spec one-liner>",
  prompt: """
    spec_path: <run_dir>/spec.md
    output_path: <run_dir>/plan.json
    repo_root: <repo root absolute path>

    Read your agent definition for the JSON schema and rules. Write the plan to output_path and return only the PLAN block.
  """
)
```

Parse the `=== PLAN ===` block from the planner's reply. Read `<run_dir>/plan.json`. Populate `state.json`:
- `plan_path` = the path the planner returned
- `tasks` = the parsed array
- `status[task_id]` for each task:
  ```json
  {
    "state": "pending",
    "dev_agent_id": null,
    "branch": null,
    "last_commit": null,
    "task_dir": "<run_dir>/<task_id>/",
    "attempts": 0,
    "last_dev_report_path": null,
    "last_qa_report_path": null
  }
  ```

Show the user a one-screen summary of the plan: `task_id | title | scope | depends_on`. **Confirmation gate** (the only one) — ask: "proceed with this plan?". On yes, run unattended. On no, take their edits or abort.

## Step 3 — spawn the tester (persistent, once per run)

Before the first task, spawn the persistent tester. **Do NOT give it a task yet** — just initialize it so Step 0 (workflow mental model) runs once and is cached for all subsequent tasks.

```
Agent(
  subagent_type: "qa-tester",
  description: "Persistent QA for dev-loop run <run_id>",
  prompt: """
    INITIAL spawn for /dev-loop run <run_id>.
    Repo root: <absolute path>

    Run Step 0 from your agent definition now — build the workflow mental model. You will receive task pings via SendMessage shortly. Do NOT pick up a task on this spawn; just confirm Step 0 is done.

    The coordinator will check out the right loop branch before each task ping. You own server startup per your "Server: you own this" section — the coordinator does not pass server URLs.

    Reply with exactly:
    === QA READY ===
    workflow_model: built
    === END ===
  """
)
```

Save `tester_agent_id` in `state.json`. **This is the single most important piece of state for the whole run.** Without it, persistence breaks and you'd have to fall back to fresh-per-task testers.

## Step 4 — per-task loop

For each task with `state: pending` whose `depends_on` are all `done`:

### 4a. Set up the branch + task dir

```bash
mkdir -p <run_dir>/<task_id>/findings
git checkout -b loop/<task_id>   # branched from current HEAD (base_branch)
```

Store `branch = "loop/<task_id>"` in state. Mark `state: in_progress`.

### 4b. Spawn dev-worker (fresh per task)

```
Agent(
  subagent_type: "dev-worker",
  description: "<task title>",
  prompt: """
    task_id: <task_id>
    branch: loop/<task_id>     (already checked out; your cwd is the repo root)
    task_dir: <run_dir>/<task_id>/
    report_path: <run_dir>/<task_id>/dev-report.md

    goal:
    <goal>

    scope (do not touch files outside this list):
    <scope as list>

    acceptance (the tester will check these):
    <acceptance as list>

    relevant tests:
    <tests_to_run from plan>

    Read CLAUDE.md first. Implement. Commit your work (per agent definition). Write your report. Reply with the DEV DONE block.
  """
)
```

**Save returned agent id as `dev_agent_id`.** Parse the `=== DEV DONE ===` block (it includes `branch` and `commit` sha — confirm they match expectation). Read `dev-report.md` only if you need detail beyond the DONE block.

If `verdict: blocked` → mark task `escalated`, **leave the loop branch checked out** (user inspects), surface to user, stop (do not start next task automatically — user decides).

### 4c. Hand the task to the persistent tester

The loop branch is already checked out from 4a, so the tester sees the dev's committed changes directly.

```
SendMessage(
  to: <tester_agent_id>,
  message: """
    new task: <task_id>
    branch: loop/<task_id>     (already checked out)

    task_dir: <run_dir>/<task_id>/
    dev_report_path: <run_dir>/<task_id>/dev-report.md
    report_path: <run_dir>/<task_id>/qa-report.md
    round: 1

    goal:
    <goal>

    acceptance:
    <acceptance>

    playwright_user_paths (seed list from planner):
    <playwright_user_paths>

    Run your sweep (you decide whether to use an existing server or spin one up per your agent definition). Commit any new scripts/test-*.mjs. Write qa-report.md. Reply with QA DONE block.
  """
)
```

Wait for `=== QA DONE ===` reply. Read `qa-report.md` only enough to parse `verdict`.

### 4d. Verdict branching

| verdict   | action                                                                                                |
|-----------|-------------------------------------------------------------------------------------------------------|
| `pass`    | merge loop branch → base; mark task `done`; delete loop branch; advance to next task (Step 4f below)  |
| `flaky`   | treat as `pass` for loop progression; log it in state for the final report                            |
| `fail`    | `attempts += 1`. If `attempts >= 3`: mark `escalated`. Else: go to 4e.                                |
| `escalate`| same as `attempts >= 3` path                                                                          |

### 4e. Fix-and-retest cycle (round 2+)

Before pinging the dev, **archive the prior round's reports** so they aren't overwritten in place:

```bash
mv <task_dir>/dev-report.md <task_dir>/findings/round-<N>-dev.md
mv <task_dir>/qa-report.md  <task_dir>/findings/round-<N>-qa.md
```

where `<N>` is the just-completed round number. The agents will write fresh `dev-report.md` / `qa-report.md` on the next round.

Then:

```
SendMessage(
  to: <dev_agent_id>,
  message: """
    bug-fix round <N+1> for task <task_id>.

    prior_qa_report_path: <task_dir>/findings/round-<N>-qa.md
    report_path: <task_dir>/dev-report.md  (overwrite)

    Read the QA report, fix narrowly, stay in scope, re-write your report. Reply with DEV DONE.
  """
)
```

Wait for DEV DONE. Then re-verify with the **same persistent tester**:

```
SendMessage(
  to: <tester_agent_id>,
  message: """
    re-verify task <task_id>, round <N+1>.

    dev_report_path: <task_dir>/dev-report.md  (fresh)
    prior_qa_report_path: <task_dir>/findings/round-<N>-qa.md
    report_path: <task_dir>/qa-report.md  (overwrite)
    round: <N+1>

    Re-run prior-failing tests + closest regression smoke. Tag each prior finding resolved | still-failing | new-regression. Reply with QA DONE.
  """
)
```

Loop back to 4d.

### 4f. On PASS — merge and advance

```bash
git checkout <base_branch>
git merge --no-ff loop/<task_id> -m "<task_id>: <title> (dev-loop)"
git branch -d loop/<task_id>
```

On merge conflicts: **stop the loop**, leave the working tree in conflicted state, surface to user. Don't auto-resolve. With strict serial-from-`base_branch` flow, conflicts here are usually a sign the planner under-specified scope and two tasks both touched the same lines — flag this in your message to the user.

On `escalate`: do **not** merge, do **not** delete the loop branch, stop the run. The loop branch stays checked out so the user can inspect / fix / merge manually.

## Step 5 — final report

When all tasks are `done` or `escalated`:

1. Read every `qa-report.md` and any archived `findings/round-*-qa.md` to aggregate.
2. Ask the persistent tester for a wrap-up summary (one SendMessage):
   ```
   SendMessage(
     to: <tester_agent_id>,
     message: "Run is over. Write a brief cross-task wrap-up to <run_dir>/wrap-up.md covering: which areas you tested most heavily, any persistent flakiness, any cross-task regression patterns. Reply with the path."
   )
   ```
3. Print a summary table to the user: `task_id | title | state | attempts | findings_count`.
4. For each `escalated`: paste the path to the final QA report.
5. Suggest follow-ups for `out_of_scope_findings` aggregated across reports.
6. Leave `<run_dir>/` in place (gitignored) so the user can inspect.

## Recovery (the hard limit)

If your session crashes mid-loop:

1. Read `<run_dir>/state.json` to know where you stopped.
2. **`dev_agent_id` and `tester_agent_id` are dead.** Claude Code subagent IDs are per parent session; a new session cannot resume them. You cannot truly continue.
3. Surface this honestly: "I lost the dev/tester context for the run starting at `<run_dir>`. Options: (a) re-spawn fresh tester + redo current task from scratch (you keep all on-disk artifacts and merged tasks), (b) abort and let you take over manually."
4. Never pretend you can continue. The recovered tester will not have its prior cross-task regression memory — that's a real loss the user needs to know about.

## Tone

- One confirmation gate (after planning). Then unattended.
- Narrate transitions one line at a time: "task 02 dev spawned (id: X)… DEV DONE: done… tester pinged… QA DONE: fail round 1… archiving round 1 reports… dev pinged round 2…".
- Don't ask the user mid-loop unless something genuinely blocks the architecture (merge conflict, planner produced nonsense, tester throws an unrecognized verdict). For ambiguous acceptance, send it back to a fresh planner spawn, not the user.
