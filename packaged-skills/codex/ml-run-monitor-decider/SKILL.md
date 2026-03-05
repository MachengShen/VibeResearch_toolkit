---
name: ml-run-monitor-decider
description: "Use when launching and monitoring ML runs with checkpoint-based decisions; must report latest metrics, explicit continue/stop/branch decision, and exact next command or config change."
version: 1.0
---

# ML Run Monitor Decider

## Workflow
1. **Snapshot state** before launching.
   - Record GPU usage, active/queued jobs, relevant log paths, and git status.
2. **Define success and stop criteria** before new runs.
   - Examples: loss threshold, collapse threshold, minimum slope improvement, target accuracy.
3. **Launch controlled runs** one change at a time.
   - Isolate one primary variable per treatment branch.
   - Use whatever queue/lock wrappers the project provides.
   - Name jobs and output files clearly.
4. **Monitor on a fixed cadence** and summarize in compact checkpoints.
   - Keep one active run and at least one queued run unless the user requests a pause.
   - For very long runs (≥1000 epochs), default to checkpoints every 100 epochs unless instability appears.
   - Parse epoch summary lines from the training log; keep decision notes tied to exact epoch numbers.
   - Use `metrics.json.error_type` (when available) for deterministic failure triage labels.
5. **Decide** after each checkpoint window: continue, stop early, or branch to next ablation. State why.
6. **Update handoff/work log** after every major action.
   - Include timestamp, log paths, latest epoch, and key metrics.
   - Keep entries concise; avoid repeating unchanged context.
7. **Compare against registry history** before branching.
   - Use `exp/registry.jsonl` + `tools/exp/report_registry.py` for run-table context.

## GPU Quick Status
```bash
nvidia-smi --query-gpu=index,utilization.gpu,memory.used,memory.total \
  --format=csv,noheader,nounits
pgrep -af 'train|queue' || true
```

## Decision Rules
Define explicit criteria before launch. If the user provides criteria, adopt theirs and restate them before starting. Default policy: stop if loss is non-improving for N consecutive checkpoints, or if output collapse is detected.

## Hypothesis Loop
1. State one hypothesis before each run window.
2. Define explicit falsification criteria before launch.
3. Pair treatment with a control whenever possible.
4. Keep at least one queued follow-up run while one is active (never-idle policy).

## Output Style
1. Report latest metrics first (epoch / loss / accuracy / key tokens).
2. State decision (`continue`, `stop`, or `branch`) and why.
3. State next action with exact command or config path.
4. Keep summaries compact; include only deltas since the previous checkpoint.
