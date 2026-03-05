## Summary

- What changed:
- Why:
- Risk level (`low`/`medium`/`high`):

## Execution Evidence (Required)

- [ ] I ran `bash scripts/essential_exec_check.sh` (or CI `essential-exec` ran).
- [ ] I attached one of:
  - CI artifact URL for `reports/essential_exec/**`, or
  - local paths to `summary.json` and `suite_log.md`.

Evidence links/paths:

- Essential summary:
- Essential suite log:
- CI run URL:

## PR Reviewer Checklist (Copy/Paste)

### A1. Static sanity

- [ ] `git status --porcelain` clean after checks.
- [ ] Shebang hygiene checks pass:
  - [ ] `grep -RIn --include="*.sh" '^#!/usr/bin/env bash .\+' .` has no matches.
  - [ ] `grep -RIn --include="*.js" '^#!/usr/bin/env node .\+' codex-discord-relay` has no matches.
  - [ ] `grep -RIn --include="*.py" '^#!/usr/bin/env python3 .\+' tools` has no matches.
- [ ] `bash scripts/lint_repo.sh` passes.

### A2. Local runtime smoke

- [ ] `node codex-discord-relay/relay.js --help || true` does not show syntax/import crash.
- [ ] CLI help checks pass:
  - [ ] `bash scripts/vr_run.sh --help`
  - [ ] `python3 tools/exp/validate_metrics.py --help`
  - [ ] `python3 tools/exp/append_registry.py --help`
  - [ ] `python3 tools/exp/summarize_run.py --help`
  - [ ] `python3 tools/exp/render_template.py --help`
  - [ ] `python3 tools/exp/best_run.py --help`

### A3. Contract tests

- [ ] Wrapper success path produces valid `meta.json`, `train.log`, `metrics.json`.
- [ ] Cancellation path produces schema-valid metrics with cancel/fail reason.
- [ ] Registry append works and duplicate append is rejected.

### A4. Runtime manual checks (required only for runtime-impacting relay changes)

- [ ] Watched long job end-to-end with `thenTask`.
- [ ] Artifact gating blocks callback until files are ready.
- [ ] Wait-loop guard behavior validated.
- [ ] Visibility heartbeat/degraded behavior validated.
- [ ] Restart recovery behavior validated.

Manual runtime evidence paths (if applicable):

- 

## Reviewer Notes

- Full checklist + command snippets: `docs/verification/PR_REVIEW_CHECKLIST.md`
- Execution contract: `docs/verification/EXECUTION_CHECK_CONTRACT.md`
