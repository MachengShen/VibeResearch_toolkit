# GBDPro PR-Style Review Summary — Pipeline + ML Robustness v2

## 1) Handoff Metadata
- Date: `2026-02-23`
- Repo: `MachengShen/vibe-research-toolkit`
- Branch: `p2-ml-automation`
- Base implementation commit: `de0e1b3` (`feat: implement pipeline and ML robustness v2`)
- Follow-up docs/handoff commit: `7151ef8` (`docs: record pushed robustness v2 commit handoff`)
- Prior P2 baseline commit: `64dc6dc` (`feat: add ML experiment run contract automation tools`)

This summary is intentionally self-contained so reviewers do not need a separate link handoff.

## 2) PR Intent (What This Change Set Delivers)
Implements fail-closed callback gating, launch preflight checks, unsafe wait-loop guards, and ML artifact-contract hardening for unattended overnight/research jobs. All runtime enforcement is flag-gated for safe canary rollout.

## 3) Change Summary by Area
### Runtime (`codex-discord-relay/relay.js`)
- Added watch contract fields: `requireFiles`, `readyTimeoutSec`, `readyPollSec`, `onMissing`.
- Added artifact-readiness state transitions and callback enqueue gating.
- Added `job_start.preflight` support with checks:
  - `path_exists`
  - `cmd_exit_zero`
  - `min_free_disk_gb`
- Added unsafe wait-pattern guard for `pgrep -f` self-match risk (`RELAY_WAIT_PATTERN_GUARD_MODE`).
- Added long-job visibility/startup heartbeat degradation tracking.
- Added lifecycle telemetry and state persistence for callback finalization flow.

### Tooling (`scripts/` + `tools/exp/`)
- Hardened `scripts/vr_run.sh` with signal-safe traps (`EXIT`, `INT`, `TERM`) and guaranteed `metrics.json` + `meta.json`.
- Hardened `tools/exp/append_registry.py` with lock-safe writes and deterministic duplicate handling.
- Updated `tools/exp/summarize_run.py` with optional `--registry`.
- Added `tools/exp/render_template.py`.
- Added `tools/exp/best_run.py`.

### Skill guidance
- Updated `packaged-skills/codex/relay-long-task-callback/SKILL.md` to require artifact gating profile (`watch.requireFiles` + readiness timeout) for research runs.

## 4) PR Risk Checklist
- [x] Backward compatibility preserved when new flags are disabled.
- [x] Callback timing race mitigated via artifact-gated enqueue.
- [x] Launch-time invalid config/path risk reduced via preflight checks.
- [x] Wait deadlock class (`pgrep -f` self-match) now detectable and policy-controlled.
- [x] Cancel/fail paths produce schema-valid artifacts (`metrics.json`, `meta.json`).
- [x] Registry append path protected for concurrent writes.
- [ ] Runtime restart still required in deployment window to activate in-memory relay changes.
- [ ] 24h canary run pending to validate false-positive rate for preflight/wait guards.

## 5) Canary Flag Settings (Recommended)
Use these in one project/conversation first:

| Flag | Canary Value | Notes |
|---|---:|---|
| `RELAY_WATCH_REQUIRE_FILES_ENABLED` | `true` | Enables callback artifact gating |
| `RELAY_WATCH_REQUIRE_FILES_DEFAULT_TIMEOUT_SEC` | `900` | 15 min default readiness window |
| `RELAY_WATCH_REQUIRE_FILES_DEFAULT_POLL_SEC` | `15` | Low overhead polling |
| `RELAY_JOB_PREFLIGHT_ENABLED` | `true` | Rejects invalid long jobs before spawn |
| `RELAY_WAIT_PATTERN_GUARD_MODE` | `warn` | Promote to `reject` after stable canary |
| `RELAY_VISIBILITY_GATE_ENABLED` | `true` | Activates startup/heartbeat degradation tracking |
| `RELAY_VISIBILITY_STARTUP_HEARTBEAT_SEC` | `60` | Startup visibility SLO |
| `RELAY_VISIBILITY_HEARTBEAT_EVERY_SEC` | `600` | Periodic visibility SLO |
| `RELAY_REGISTRY_LOCK_ENABLED` | `true` | Keep enabled for append safety |

## 6) Verification Executed
- `node --check codex-discord-relay/relay.js`
- `bash -n scripts/vr_run.sh`
- `python3 -m py_compile tools/exp/append_registry.py tools/exp/summarize_run.py tools/exp/render_template.py tools/exp/best_run.py`
- Smoke checks completed:
  - template rendering
  - wrapper success/failure/cancel artifact validation
  - registry duplicate fail-closed behavior
  - best-run selection output

## 7) Reviewer Questions for GBDPro
1. Should `RELAY_WAIT_PATTERN_GUARD_MODE` move directly to `reject` for research-only profiles?
2. Do we want `onMissing=block` as hard default in all long-run callback recipes?
3. Should preflight include additional checks (GPU availability / config schema) in next PR?
4. Is current visibility SLO sufficient, or should missed heartbeats trigger optional alert tasks?

## 8) Recommended Next Step
Perform a controlled relay restart window, apply the canary flags above in one thread/project for 24 hours, then promote policy from `warn` to `reject` for wait-pattern guard if no regressions are observed.
