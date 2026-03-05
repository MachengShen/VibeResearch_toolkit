# vibe-research-toolkit

A Discord-native research operations toolkit for ML experimentation with Codex/Claude agents.

This repository combines:
- Discord relay orchestration (`codex-discord-relay`)
- human-in-the-loop research workflows (plan/task/worktree/handoff)
- callback-driven long-running experiment handling
- packaged skills for hypothesis-driven ML research

## Stable Release

- Current stable release: `v1.1.1`
- Release metadata:
  - `VERSION`
  - `CHANGELOG.md`

## Latest Design Feature (v1.1.1)

- **Privacy-hardened release surface**: machine-local continuity/state artifacts are now intended to stay local (`.gitignore` + release cleanup), so public tags avoid leaking personal project paths/history.
- **Cleaner Discord updates**: durable progress can suppress low-signal system milestones with `RELAY_PROGRESS_PERSISTENT_SUPPRESS_SYSTEM_MILESTONES=true`, reducing interleaving noise with assistant responses.
- **Relay-native supervisor contract**: long jobs can launch with `job_start.supervisor` so callback follow-ups are gated by explicit state/artifact checks instead of best-effort process exit handling.

## Why This Is Built For ML Researchers

Most agent tooling optimizes for one-shot automation. Research work is iterative, uncertain, and hypothesis-driven.

`vibe-research-toolkit` is designed for that reality:
- **Research from anywhere**: Discord-first control plane lets you run and monitor from desktop or mobile.
- **Interactive by default**: you can inspect intermediate results, redirect, and refine hypotheses before committing compute.
- **Relay Callback design**: long jobs can auto-enqueue analysis tasks on completion, so experiments continue without manual babysitting.
- **Hypothesis-driven skill stack**: bundled skills bias toward discriminative experiments and structured ablations, not trivial “try random settings” loops.
- **Parallel experiment isolation**: git worktrees make branch-per-hypothesis and parallel ablations clean and reversible.
- **Persistent research memory**: local continuity artifacts (`docs/WORKING_MEMORY.md`, `HANDOFF_LOG.md`) preserve cross-session context without being published in releases.
- **Operational observability**: `/status`, `/task list`, `/job list`, logs, and callback traces expose real run state.
- **Reproducible machine state**: export/apply scripts keep relay + env setup portable across machines.

## Core Design Principles

1. **Human-in-the-loop over full autopilot**
   - Keep the researcher in control at each decision boundary.
2. **One-hypothesis-at-a-time discipline**
   - Prefer high-signal experiments that disambiguate what to do next.
3. **Evidence-backed continuity**
   - Every major action should leave a trace in logs and handoff artifacts.
4. **Reliable long-run execution**
   - Queue-safe relay behavior, background jobs, and callback follow-ups are first-class.

## Quick Start (New Machine)

1. Clone and enter repo:

```bash
git clone https://github.com/MachengShen/vibe-research-toolkit.git
cd vibe-research-toolkit
```

2. Choose an install track:

### Track A: Relay-only (no root)

Use this when you only need the Discord relay process.

```bash
cd codex-discord-relay
cp .env.example .env
$EDITOR .env
npm install
node relay.js
```

Minimum required in `.env`:
- `DISCORD_BOT_TOKEN`

### Track B: Full bootstrap (system services, scripts, templates)

Use this for a full machine setup.

Create config:

```bash
cp config/setup.env.example config/setup.env
$EDITOR config/setup.env
```

Minimum required:
- `CODEX_DISCORD_BOT_TOKEN`

Recommended:
- `OPENCLAW_PROXY_URL` (if your network needs proxy routing)

Run bootstrap:

```bash
sudo ./bootstrap.sh
```

3. Verify:

```bash
codex-discord-relayctl status
codex-discord-relayctl logs
```

Then DM your relay bot in Discord and run `/status`.

## Troubleshooting

- Required env vars:
  - relay-only track: `codex-discord-relay/.env` must include `DISCORD_BOT_TOKEN`
  - full bootstrap track: `config/setup.env` should include `CODEX_DISCORD_BOT_TOKEN`
- Logs:
  - service logs: `codex-discord-relayctl logs`
  - runtime logs: `/root/.codex-discord-relay/relay.log`
- Discord bot permissions:
  - verify bot is invited to the target server
  - ensure it can view channels, read message history, send messages, and create/send thread replies where needed
  - if using slash commands, re-install/sync application commands for the bot app if commands are missing

## Daily Research Workflow

1. Set project workdir in Discord:
   - `/workdir /absolute/path/to/project`
2. Plan the next hypothesis test:
   - `/plan Design an experiment to test <hypothesis>; include metrics and stop criteria`
3. Execute with task queue:
   - `/plan apply last --confirm`
   - `/task run`
4. Launch long runs with callback where needed (`job_start + watch + thenTask`).
5. Inspect results and update memory:
   - `/handoff --commit` (optional)

## Mandatory Skill Map (Workflow)

For relay + ML workflow changes, use this minimum skill mapping:

- New capability/change request: `requirements-intake-for-ml-research`
- Long-running experiment launch: `relay-long-task-callback` + `ml-run-contract-enforcer`
- PR validation/evidence writing: `pr-acceptance-tests-writer`
- Runtime robustness verification: `robustness-execution-suite-runner`
- Overnight failure triage: `incident-triage-playbook`
- Pre-release hardening: `release-hardening-checklist`
- Session continuity updates: `experiment-working-memory-handoff`

Rule of thumb: do not keep foreground `sleep + tail` monitor loops in normal turns; use callback jobs (`job_start + watch + thenTask`) and keep foreground turns short.

## Relay Callback Pattern (Why it matters)

For long training/eval/sweep jobs, use relay actions so completion triggers analysis automatically.

```text
[[relay-actions]]
{"actions":[{"type":"job_start","description":"baseline ablation seed=1","command":"bash scripts/run_ablation_seed1.sh","watch":{"everySec":300,"tailLines":30,"thenTask":"Analyze logs/ablation_seed1.log and summarize final metrics, failures, and next experiment.","thenTaskDescription":"Analyze seed=1 results","runTasks":true}}]}
[[/relay-actions]]
```

This avoids dead time between run completion and interpretation.

## Command Surface (Most Used)

- `/status` — active run, queue state, task summary
- `/task add|list|run|stop|clear` — persistent execution queue
- `/job list` and `/job logs <id>` — background job history and logs
- `/plan new|list|show|apply` — plan-first workflow
- `/worktree new|use|list|rm` — isolate parallel experiments
- `/handoff` — update continuity artifacts
- `/context` — inspect prompt context/memory injection state

## Documentation

- User manual: `docs/USER_MANUAL.md`
- ML design guide: `docs/ML_RESEARCH_DESIGN.md`
- Local working memory snapshot (gitignored): `docs/WORKING_MEMORY.md`
- Local handoff history (gitignored): `HANDOFF_LOG.md`

## Development / CI

Run local lint:

```bash
bash scripts/lint_repo.sh
```

Run the required execution gate (PR-equivalent):

```bash
bash scripts/essential_exec_check.sh
```

Validate generated summary schema:

```bash
summary="$(ls -1dt reports/essential_exec/*/summary.json | head -n1)"
python3 tools/verification/check_summary.py --summary "$summary" --suite-log "$(dirname "$summary")/suite_log.md"
```

Run the extended robustness suite:

```bash
bash scripts/robustness_exec_suite.sh
```

CI (`.github/workflows/ci.yml`) runs lint + the required execution gate on every push and pull request.
Nightly/manual robustness runs are defined in `.github/workflows/robustness-nightly.yml`.
PR reviewer checklist references:
- `.github/pull_request_template.md`
- `docs/verification/PR_REVIEW_CHECKLIST.md`

Lint enforces publishability invariants:
- Bash headers and strict mode (`#!/usr/bin/env bash`, `set -euo pipefail`)
- Node shebang hygiene (`#!/usr/bin/env node`)
- `bash -n` shell syntax checks
- CRLF rejection on `.sh`/`.js`
- packaged skill metadata checks

## Security Notes

- Never commit real tokens/secrets.
- Keep workdir allowlists tight.
- Prefer explicit confirm flags for high-impact automation in shared channels.
