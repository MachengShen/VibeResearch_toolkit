---
name: requirements-intake-for-ml-research
description: Use when a user asks for a new ML capability or workflow change; convert natural-language intent into a 1-page executable spec with acceptance tests and rollout plan.
version: 1.0
---

# Requirements Intake For ML Research

## Purpose

Turn vague requests into a concrete implementation spec before coding or launching experiments.

## When to use

Use when the user asks for a new feature, workflow change, automation behavior, or experiment protocol.

## Required output

Produce a compact spec sheet with these sections:

1. Goal
2. Out of scope
3. Target user flow (3-5 steps)
4. Contracts/invariants (required files, logs, metrics)
5. Failure policy (fail-closed vs fail-open)
6. Budgets (max wallclock/steps/runs)
7. Acceptance tests (copy/paste commands)
8. Rollout plan (feature flags + canary)

## Working rules

- Ask only high-value clarifications.
- If details are missing, state default assumptions and continue.
- Prefer concrete examples for command, run dir, metrics key, and expected artifact paths.
- Keep the spec to about one page.

## Output template

```markdown
## Goal
- ...

## Out Of Scope
- ...

## Target User Flow
1. ...
2. ...
3. ...

## Contracts / Invariants
- Required artifacts:
- Required IDs (`run_id`, `job_id`, `task_id`, `commit`, `dirty`):

## Failure Policy
- fail-closed/fail-open choice:
- recovery trigger:

## Budgets
- max wallclock:
- max retries:
- max concurrent jobs:

## Acceptance Tests
```bash
# copy/paste commands
```

## Rollout
- feature flags:
- canary scope:
- rollback command/path:
```
