# PR Reviewer Checklist

Use this checklist in PR reviews for runtime, relay, or ML automation changes.

## A1. Static sanity

- [ ] `git status --porcelain` is clean after running checks.
- [ ] No bash scripts have trailing code on shebang line:

  ```bash
  grep -RIn --include="*.sh" '^#!/usr/bin/env bash .\+' .
  ```

- [ ] No node scripts have trailing code on shebang line:

  ```bash
  grep -RIn --include="*.js" '^#!/usr/bin/env node .\+' codex-discord-relay
  ```

- [ ] No python scripts have trailing code on shebang line:

  ```bash
  grep -RIn --include="*.py" '^#!/usr/bin/env python3 .\+' tools
  ```

- [ ] Lint entrypoint passes:

  ```bash
  bash scripts/lint_repo.sh
  ```

## A2. Local runtime smoke (no Discord required)

- [ ] Relay parse smoke:

  ```bash
  node codex-discord-relay/relay.js --help || true
  ```

- [ ] ML CLI help commands pass:

  ```bash
  bash scripts/vr_run.sh --help
  python3 tools/exp/validate_metrics.py --help
  python3 tools/exp/append_registry.py --help
  python3 tools/exp/summarize_run.py --help
  python3 tools/exp/render_template.py --help
  python3 tools/exp/best_run.py --help
  ```

## A3. Contract checks (no Discord required)

- [ ] Wrapper success path creates valid artifacts:

  ```bash
  rm -rf /tmp/vrtest && mkdir -p /tmp/vrtest
  bash scripts/vr_run.sh --run-id r_smoke --run-dir /tmp/vrtest/r_smoke -- bash -lc 'echo hello; exit 0'
  test -f /tmp/vrtest/r_smoke/meta.json
  test -f /tmp/vrtest/r_smoke/train.log
  test -f /tmp/vrtest/r_smoke/metrics.json
  python3 tools/exp/validate_metrics.py /tmp/vrtest/r_smoke/metrics.json
  ```

- [ ] Cancellation path preserves valid metrics:

  ```bash
  rm -rf /tmp/vrcancel && mkdir -p /tmp/vrcancel
  ( bash scripts/vr_run.sh --run-id r_cancel --run-dir /tmp/vrcancel/r_cancel -- bash -lc 'sleep 30' ) &
  pid=$!
  sleep 2
  kill -TERM "$pid"
  sleep 2
  python3 tools/exp/validate_metrics.py /tmp/vrcancel/r_cancel/metrics.json
  ```

- [ ] Registry append and duplicate rejection:

  ```bash
  rm -f /tmp/vr_registry.jsonl
  python3 tools/exp/append_registry.py --registry /tmp/vr_registry.jsonl --run-dir /tmp/vrtest/r_smoke
  wc -l /tmp/vr_registry.jsonl | grep -q '1'
  python3 tools/exp/append_registry.py --registry /tmp/vr_registry.jsonl --run-dir /tmp/vrtest/r_smoke && echo "UNEXPECTED duplicate allowed" || echo "OK duplicate rejected"
  ```

## A4. Discord runtime checks (manual; runtime-impacting changes only)

- [ ] Long watched job posts progress, completes, and runs `thenTask`.
- [ ] Artifact gating blocks `thenTask` until required files exist.
- [ ] Wait-loop guard warns/rejects self-matching `pgrep -f` patterns.
- [ ] Visibility SLO marks missing heartbeat/degraded visibility without crash.
- [ ] Restart recovery behavior is verified (watch/callback state after restart).

## Evidence requirements

Provide one of the following in the PR:

- [ ] CI artifact link for `reports/essential_exec/**` from required `essential-exec` job.
- [ ] Local exceptional evidence bundle:
  - `reports/essential_exec/<timestamp>/summary.json`
  - `reports/essential_exec/<timestamp>/suite_log.md`
- [ ] If runtime-affecting changes are present, include manual runtime check evidence paths/log links for A4.
