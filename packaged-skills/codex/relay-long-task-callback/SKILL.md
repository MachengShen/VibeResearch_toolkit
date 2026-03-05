---
name: relay-long-task-callback
description: Use when a task needs unattended background execution; must emit one valid [[relay-actions]] job_start block with watch.everySec/tailLines/thenTask/runTasks=true so follow-up analysis auto-runs.
version: 1.1
---

# Relay Long Task Callback

Use this skill for long tasks that should continue without manual monitoring and come back with analysis later.

## Goal

Produce one valid relay-action block that starts a background job and configures automatic watch plus follow-up task.

## Required Output Contract

When replying inside a `/task run` step:

1. Emit exactly one `[[relay-actions]] ... [[/relay-actions]]` block.
2. JSON must be valid and contain exactly one action of type `job_start`.
3. Include `watch.everySec`, `watch.tailLines`, `watch.thenTask`, and `watch.runTasks=true`.
4. End with `[[task:done]]` unless blocked.

If required information is missing, do not guess critical paths or commands. Return `[[task:blocked]]` and list what is missing.

## Canonical JSON Template

```text
[[relay-actions]]
{"actions":[{"type":"job_start","command":"<non-interactive shell command>","watch":{"everySec":300,"tailLines":30,"thenTask":"Analyze final log and summarize metrics, failures, and next actions.","runTasks":true}}]}
[[/relay-actions]]
```

## Practical Rules

- Preferred path for template-backed ML runs: ask the user to use `/exp run ...` first, then fall back to raw `job_start` only when template/contract tooling is unavailable.
- Keep JSON on one line and do not include comments or trailing commas.
- Prefer launching a wrapper script, then start it with `bash /tmp/<name>.sh` or a repo-local script path.
- Ensure the command writes logs deterministically so follow-up analysis can inspect them.
- In `thenTask`, include exact log paths, run ids, and metrics to extract.
- Do not use foreground polling loops (`sleep` + `tail`) in normal turns; use watcher callbacks.
- Keep surrounding prose short to avoid drowning the action block.

## Research Run Profile (ML training/eval)

When the task is an ML experiment, the action block should enforce the run contract:

1. Allocate `run_id` and `run_dir` under `exp/results/`.
2. Launch the command through `scripts/vr_run.sh`:
   - `scripts/vr_run.sh --run-id <run_id> --run-dir <run_dir> -- <train/eval command>`
3. Ensure `metrics.json` is generated and validated.
4. Set `watch.requireFiles` to:
   - `<run_dir>/metrics.json`
   - `<run_dir>/meta.json`
   - `<run_dir>/train.log`
5. Set `watch.readyTimeoutSec` (for example `900`) and `watch.onMissing="block"` unless explicitly instructed otherwise.
6. Add `preflight` checks on `job_start`:
   - `{"type":"path_exists","path":"scripts/vr_run.sh"}`
   - optional config/script existence checks relevant to the run
7. Set `watch.thenTask` to run post-run automation steps:
   - `python3 tools/exp/validate_metrics.py <run_dir>/metrics.json`
   - `python3 tools/exp/append_registry.py --registry exp/registry.jsonl --run-dir <run_dir>`
   - `python3 tools/exp/summarize_run.py --run-dir <run_dir> --out-md reports/rolling_report.md --append`
   - update `HANDOFF_LOG.md` and `docs/WORKING_MEMORY.md` using experiment-working-memory-handoff
   - compare with current best run and propose the next discriminating experiment

### Suggested `thenTask` phrasing

```text
Validate <run_dir>/metrics.json, append the run to exp/registry.jsonl, append a markdown run summary to reports/rolling_report.md, update HANDOFF_LOG.md and docs/WORKING_MEMORY.md with evidence paths, compare against the current best run, and propose one next experiment command.
```

## Ready-To-Use Task Text

```text
Use skill relay-long-task-callback.
Launch training in background and output exactly one [[relay-actions]] JSON block using job_start.
Set watch.everySec=300 and tailLines=30.
Set thenTask="Analyze the final training log at <LOG_PATH>, report key metrics/trends/failures, and propose next steps.".
Set runTasks=true.
End with [[task:done]].
```
