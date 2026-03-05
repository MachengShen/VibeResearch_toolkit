# Pipeline + ML Robustness v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement fail-closed callback gating, launch preflight guards, and hardened ML run/registry tooling for unattended research jobs.

**Architecture:** Extend relay watch/action contracts with optional gated fields behind feature flags, then harden ML wrapper/tools to guarantee artifact completeness and deterministic registry behavior. Preserve backward compatibility by keeping all new enforcement opt-in via env flags.

**Tech Stack:** Node.js (relay runtime), Bash (run wrapper), Python 3 (tooling), JSON/JSONL artifacts.

---

### Task 1: Runtime flag surface + docs

**Files:**
- Modify: `codex-discord-relay/.env.example`
- Modify: `codex-discord-relay/README.md`
- Modify: `codex-discord-relay/relay.js`

Steps:
1. Add feature flags for requireFiles gating, preflight, wait-pattern guard, visibility gate.
2. Wire config parsing in `relay.js` with safe defaults.
3. Update README with behavior and rollout notes.

### Task 2: Watch Contract v2 + lifecycle transitions

**Files:**
- Modify: `codex-discord-relay/relay.js`

Steps:
1. Extend watch schema parser to accept `requireFiles`, `readyTimeoutSec`, `readyPollSec`, `onMissing`.
2. Persist lifecycle transitions (`queued/running/exited/awaiting_artifacts/callback_queued/callback_running/completed/blocked/failed`) with timestamp/reason/details.
3. Gate callback enqueueing on artifact readiness when enabled.

### Task 3: Preflight + unsafe wait guard + visibility gate

**Files:**
- Modify: `codex-discord-relay/relay.js`

Steps:
1. Add `preflight` support in `job_start` action.
2. Implement checks: `path_exists`, `cmd_exit_zero`.
3. Add `pgrep -f` self-match detector with warn/reject policy.
4. Add startup/periodic visibility heartbeat state and status reporting.

### Task 4: ML tooling hardening

**Files:**
- Modify: `scripts/vr_run.sh`
- Modify: `tools/exp/append_registry.py`
- Modify: `tools/exp/summarize_run.py`
- Create: `tools/exp/render_template.py`
- Create: `tools/exp/best_run.py`

Steps:
1. Make wrapper signal-safe with EXIT/INT/TERM traps and guaranteed valid metrics on cancel/fail.
2. Add file-locking and duplicate handling to registry appends.
3. Add `--registry` support to summarize tool.
4. Add template renderer and best-run selector.

### Task 5: Skill + integration docs

**Files:**
- Modify: `packaged-skills/codex/relay-long-task-callback/SKILL.md`
- Modify: `packaged-skills/codex/pipeline-problem-identification-logging/SKILL.md` (if present)

Steps:
1. Require `watch.requireFiles` + timeout/onMissing in research run profile.
2. Include preflight block example.
3. Ensure incident tagging guidance is present.

### Task 6: Verification and safe deployment

**Files:**
- Modify: `HANDOFF_LOG.md`
- Modify: `docs/WORKING_MEMORY.md`

Steps:
1. Run lint/checks and targeted integration scripts.
2. Validate backward compatibility paths without new flags.
3. Sync runtime copy to `/root/codex-discord-relay/` without restart.
4. Update handoff/memory artifacts with exact evidence.
