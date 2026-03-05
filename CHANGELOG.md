# Changelog

All notable changes to `vibe-research-toolkit` are documented in this file.

## [Unreleased]

### Added
- Open-source governance docs:
  - `LICENSE` (MIT)
  - `CONTRIBUTING.md`
  - `SECURITY.md`

### Changed
- Public-safe defaults in `config/setup.env.example`:
  - `RELAY_UPLOAD_ALLOW_OUTSIDE_CONVERSATION=false`
  - `RELAY_UPLOAD_ALLOWED_ROOTS=/tmp`
  - `CODEX_SANDBOX=workspace-write`
  - `CODEX_APPROVAL_POLICY=on-request`
- `README.md` now includes:
  - relay-only install track (no root)
  - full bootstrap track
  - troubleshooting guidance (env vars, logs, Discord permissions)
- `scripts/lint_repo.sh` now requires packaged skill frontmatter to include `version`.
- Packaged skills now include explicit `version` in YAML frontmatter.

## [1.1.1] - 2026-02-26

### Added
- Relay durable-progress control `RELAY_PROGRESS_PERSISTENT_SUPPRESS_SYSTEM_MILESTONES` (default `true`) to suppress low-signal system milestones (`queued/waiting/start/context/attachments`) that can interleave with assistant output.

### Changed
- Claude heavy-model keyword heuristics now correctly match `investigate` forms (`investigate`, `investigation`, `investigating`).
- Public docs/examples sanitized to remove personal-project wording (for example Maze2D/EBM-specific example text).
- Release branch tracks machine-local continuity/state artifacts as local-only (`HANDOFF_LOG.md`, `docs/WORKING_MEMORY.md`, `machine-state/*` removed from distributable release surface).

## [1.1.0] - 2026-02-24

### Added
- Relay Phase 1 supervisor flow for `job_start` with feature-gated schema validation and finalize-time state checks.
- Bundled portable stage0 supervisor runner at `codex-discord-relay/scripts/stage0_smoke_gate.py` to remove runtime dependency on external repo layout.

### Changed
- Relay docs/env examples updated for `RELAY_SUPERVISOR_PHASE1_*` and `RELAY_MAX_JOB_COMMAND_CHARS`.
- Release metadata and manuals updated to track `v1.1.0`.
- Added operator-facing docs for supervisor best-practice usage and portability context.

## [1.0.0] - 2026-02-22

### Added
- Stable researcher-facing documentation set:
  - `README.md` reworked for ML research adoption
  - `docs/USER_MANUAL.md` operational manual
  - `docs/ML_RESEARCH_DESIGN.md` design rationale
- CI lint workflow at `.github/workflows/ci.yml`.
- Repository lint gate improvements in `scripts/lint_repo.sh`:
  - shell syntax checks across repository scripts
  - shebang/strict-mode invariants
  - CRLF checks for `.sh`/`.js`
  - packaged skill metadata checks

### Changed
- Path defaults/templates now prefer `/root/vibe-research-toolkit` with legacy fallback support.
- `bootstrap.sh` and `scripts/apply_local_state.sh` now allow `--help` without root.

### Research-focused highlights
- Worktree-based parallel ablations.
- Persistent research memory + append-only handoff.
- Observability via `/status`, `/task`, `/job`.
- Reproducible machine-state export/apply.
- Proxy-aware operation and reliability hardening.

### Notes
- OpenClaw optional install may fail under Node 24 in some environments due native dependency build constraints; relay and toolkit workflows remain operational.
