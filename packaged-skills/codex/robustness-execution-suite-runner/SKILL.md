---
name: robustness-execution-suite-runner
description: Use when validating runtime robustness; execute a matrix of long-job scenarios and emit a dated PASS/FAIL suite report with artifacts.
version: 1.0
---

# Robustness Execution Suite Runner

## Purpose

Prove runtime orchestration behavior under realistic long-job failure modes.

## When to use

Use before/after relay or automation changes and before broad rollout.

## Required scenario matrix

Run at least these scenarios:

1. Success path
2. Expected failure path
3. Cancellation path
4. Delayed artifact availability
5. Concurrency/queue interaction

## Report contract

Write all outputs under:

`reports/robustness_suite/YYYY-MM-DD/`

Minimum artifacts:

- `suite_log.md`
- `relay_stdout.log` or `relay_journal.log`
- failed-case artifacts under `artifacts/`

## suite_log.md minimum sections

1. Environment and commit
2. Scenario matrix table
3. PASS/FAIL per scenario with evidence paths
4. Regressions/new risks
5. Rollback or guardrail recommendation

## Quality rules

- Prefer deterministic commands and fixed paths.
- Include explicit expected outcomes before running tests.
- Mark unknowns instead of guessing PASS.
