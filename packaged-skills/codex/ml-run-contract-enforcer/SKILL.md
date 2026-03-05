---
name: ml-run-contract-enforcer
description: Use when launching ML training/eval runs; enforce run wrapper, artifact contracts, registry updates, and handoff memory updates.
version: 1.0
---

# ML Run Contract Enforcer

## Purpose

Ensure every ML run is auditable, resumable, and safely comparable.

## When to use

Use for training/eval launches, reruns, ablations, and canary experiments.

## Run contract

1. Launch through wrapper
- Use `scripts/vr_run.sh` for all runs.

2. Stable identifiers
- Record `run_id`, `job_id`, `task_id` (if present), `commit`, and `dirty` state.

3. Artifact invariants
- Require run directory with at least:
  - `meta.json`
  - `train.log` (or eval log)
  - `metrics.json` (valid even on fail/cancel)

4. Validation
- Run metrics validator after completion.

5. Registry + memory
- Append run to registry.
- Update `HANDOFF_LOG.md` and `docs/WORKING_MEMORY.md` with evidence and next action.

## Suggested command pattern

```bash
scripts/vr_run.sh --run-id <run_id> --run-dir <run_dir> -- <train_or_eval_command>
python3 tools/exp/validate_metrics.py <run_dir>/metrics.json
python3 tools/exp/append_registry.py --registry exp/registry.jsonl --run-dir <run_dir>
```

## Failure policy

Default to fail-closed on missing required artifacts unless the user explicitly asks for fail-open behavior.
