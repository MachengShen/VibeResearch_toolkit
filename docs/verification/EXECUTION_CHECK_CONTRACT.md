# Execution Check Contract

This document defines the required execution assurance model for `vibe-research-toolkit`.

## Objective
Prevent robustness regressions from merging by making execution checks mandatory and reproducible.

## Verification Tiers

### Tier 1: Required PR Gate (must pass)
Command:

```bash
bash scripts/essential_exec_check.sh
```

Scope:
- static sanity and shebang hygiene
- repository lint (`bash scripts/lint_repo.sh`)
- relay runtime parse smoke
- ML CLI help checks
- run wrapper contract checks:
  - success path
  - failure path
  - cancellation path
- schema validation of generated metrics
- registry append + duplicate rejection behavior

Artifacts:
- `reports/essential_exec/<timestamp>/suite_log.md`
- `reports/essential_exec/<timestamp>/summary.json`

SLA:
- target runtime <= 10 minutes in CI
- any required check failure must fail PR CI
- `summary.json` must pass schema validation:

  ```bash
  python3 tools/verification/check_summary.py --summary reports/essential_exec/<timestamp>/summary.json --suite-log reports/essential_exec/<timestamp>/suite_log.md
  ```

### Tier 2: Extended Robustness Suite (nightly/manual)
Command:

```bash
bash scripts/robustness_exec_suite.sh
```

Scope:
- toy train happy/fail/cancel/corrupt scenarios
- delayed artifact readiness simulation
- registry concurrency stress
- manual runtime checks recorded as advisory:
  - wait-loop guard behavior
  - visibility heartbeat/degraded behavior
  - restart recovery

Artifacts:
- `reports/robustness_suite/YYYY-MM-DD/suite_log.md`
- `reports/robustness_suite/YYYY-MM-DD/summary.json`
- summary schema validation command:

  ```bash
  python3 tools/verification/check_summary.py --summary reports/robustness_suite/YYYY-MM-DD/summary.json --suite-log reports/robustness_suite/YYYY-MM-DD/suite_log.md
  ```

### Tier 3: Runtime Canary (Discord/manual)
Used for behaviors that cannot be fully validated offline.

Scope:
- watched `/job` end-to-end with `thenTask`
- artifact gating defers callback until files exist
- wait-pattern guard in live relay flow
- visibility SLO in live long silent jobs
- restart recovery in active watched jobs

## Required Evidence For Review
For runtime-impacting PRs, provide one of:
1. CI artifact links for Tier 1 (required), plus Tier 2 if available.
2. Local run artifacts (`suite_log.md` + `summary.json`) attached to PR.

## Failure Policy
- Tier 1 required check fails: PR is blocked.
- Tier 2 failures: open follow-up issue + link logs, unless tier-2 is explicitly promoted to required for the branch.
- Tier 3 manual failures: do not roll out to default runtime flags; keep canary-only until resolved.

## Rollout Plan

Phase 0 (stabilization):
- run `bash scripts/essential_exec_check.sh` manually on active branches and tune flakes

Phase 1 (mandatory gate):
- require CI `essential-exec` for merge

Phase 2 (trend monitoring):
- run nightly/manual robustness suite and track failures over time

Phase 3 (runtime canary):
- execute Tier 3 Discord/manual checks for runtime-affecting relay changes before broad rollout

## Definition Of Done

- every PR runs and passes `scripts/essential_exec_check.sh` in CI
- CI artifacts include `summary.json` and `suite_log.md` with valid schema
- wrapper success/failure/cancel contracts are automatically validated
- registry duplicate/concurrency safeguards are exercised by automation
- reviewer checklist is available in PR template and verification docs
- `scripts/robustness_exec_suite.sh` can be executed by a test agent via one documented command
- execution regressions fail CI before merge
