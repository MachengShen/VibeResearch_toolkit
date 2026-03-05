# Essential Execution Check Gate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add mandatory, reproducible execution checks so runtime/ML robustness features are verified by default on every PR, not only by manual spot checks.

**Architecture:** Introduce a 3-tier verification model: (1) required PR execution gate (fast, deterministic, no Discord dependency), (2) extended robustness suite (nightly/manual), and (3) controlled Discord canary checks for runtime behavior that cannot be validated offline. Persist machine-readable results and logs as CI artifacts.

**Tech Stack:** GitHub Actions, Bash, Python 3, Node.js, markdown runbooks, existing `vr_run.sh` and `tools/exp/*` CLIs.

---

### Task 1: Define the execution contract and test tiers

**Files:**
- Create: `docs/verification/EXECUTION_CHECK_CONTRACT.md`
- Modify: `README.md`

**Step 1:** Define required PR gate checks (must-pass):
- static sanity + shebang hygiene
- relay config parse check
- ML CLI help checks
- wrapper success/failure/cancel contract checks
- metrics schema validation
- registry append + duplicate rejection

**Step 2:** Define extended suite checks (nightly/manual):
- corrupt metrics salvage
- delayed artifact readiness gating
- lock/concurrency stress
- wait-loop guard behavior
- visibility degradation behavior
- restart recovery runbook

**Step 3:** Add explicit SLAs:
- PR gate target runtime <= 10 min
- deterministic pass/fail output JSON
- no Discord dependency for required gate

---

### Task 2: Add a required local execution gate script

**Files:**
- Create: `scripts/essential_exec_check.sh`
- Modify: `scripts/lint_repo.sh` (optional: shared helpers only)

**Step 1:** Implement script sections mirroring reviewer checklist A1–A3:
- repo cleanliness guard (warn-only in CI, fail locally if configured)
- shebang grep checks
- `bash scripts/lint_repo.sh`
- `node codex-discord-relay/relay.js --help || true`
- CLI help checks for `vr_run`, `validate_metrics`, `append_registry`, `summarize_run`, `render_template`, `best_run`

**Step 2:** Add contract execution checks:
- success run with `vr_run.sh`
- failure run with non-zero exit
- cancel run with SIGTERM
- schema validation for all produced metrics
- registry duplicate rejection test

**Step 3:** Emit artifacts under:
- `reports/essential_exec/<timestamp>/suite_log.md`
- `reports/essential_exec/<timestamp>/summary.json`

**Step 4:** Exit non-zero on any required check failure.

---

### Task 3: Add extended robustness suite runner

**Files:**
- Create: `scripts/robustness_exec_suite.sh`
- Create: `tools/testbed/toy_train.py`
- Create: `docs/runbooks/ROBUSTNESS_EXEC_SUITE.md`

**Step 1:** Implement scripted matrix for tests 1–8 from feedback.

**Step 2:** Standardize output structure:
- `reports/robustness_suite/YYYY-MM-DD/suite_log.md`
- `reports/robustness_suite/YYYY-MM-DD/summary.json`
- optional copied artifacts/log excerpts

**Step 3:** Mark tests as `required` vs `advisory` in JSON summary.

**Step 4:** Keep Test 9 (restart recovery) in runbook as manual/staging-only.

---

### Task 4: Add CI enforcement for essential execution checks

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/robustness-nightly.yml`

**Step 1:** Extend `ci.yml` with required `essential-exec` job:
- setup Node + Python
- run `bash scripts/essential_exec_check.sh`
- upload `reports/essential_exec/**` artifacts on success/failure

**Step 2:** Keep current lint job or merge lint into essential job with clear logging.

**Step 3:** Add nightly/manual workflow for extended suite:
- trigger: schedule + `workflow_dispatch`
- run `bash scripts/robustness_exec_suite.sh`
- upload robustness artifacts

---

### Task 5: Add PR checklist template and reviewer UX

**Files:**
- Create: `.github/pull_request_template.md`
- Create: `docs/verification/PR_REVIEW_CHECKLIST.md`
- Modify: `CONTRIBUTING.md`

**Step 1:** Paste refined checklist content (from GBDPro doc) into PR template.

**Step 2:** Require linking either:
- passing CI artifact URL, or
- attached local `summary.json` + `suite_log.md` for exceptional cases.

**Step 3:** Document when Discord/manual checks are required (runtime-affecting relay changes only).

---

### Task 6: Add machine-readable quality gate and failure triage hooks

**Files:**
- Create: `tools/verification/check_summary.py`
- Modify: `scripts/essential_exec_check.sh`
- Modify: `scripts/robustness_exec_suite.sh`

**Step 1:** Implement summary schema enforcement (`overall`, per-test status, evidence paths).

**Step 2:** Use `check_summary.py` in CI to avoid false-green runs with malformed logs.

**Step 3:** Auto-print top failing checks + evidence paths at end of CI logs.

---

### Task 7: Rollout plan (safe adoption)

**Files:**
- Modify: `docs/verification/EXECUTION_CHECK_CONTRACT.md`
- Modify: `docs/WORKING_MEMORY.md`
- Modify: `HANDOFF_LOG.md`

**Step 1:** Phase 0 (1–2 days): run gate script manually on active branch and tune flake points.

**Step 2:** Phase 1: make `essential-exec` required for PR merge.

**Step 3:** Phase 2: run nightly robustness suite and track fail trends.

**Step 4:** Phase 3: add periodic Discord canary run (manual checklist + incident log linkage).

---

### Task 8: Acceptance criteria (Definition of Done)

**Files:**
- Modify: `docs/verification/EXECUTION_CHECK_CONTRACT.md`

**Must be true:**
- Every PR runs and passes `essential_exec_check.sh` in CI.
- CI artifact includes machine-readable summary + human-readable suite log.
- Wrapper success/failure/cancel contracts are validated automatically.
- Registry duplicate/concurrency safeguards are exercised by automated checks.
- Reviewer checklist is embedded in PR template.
- Extended robustness suite can be run by a test agent via one documented command.
- Any regression in execution behavior fails CI before merge.
