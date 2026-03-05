# Agent Playbook

Objective: on a fresh machine, set up:
- OpenClaw Gateway + dashboard
- OpenClaw Discord channel (optional)
- Proxy env for China/GFW (optional)
- Codex Discord Relay (Codex via Discord)
- Cron watchdogs so it auto-recovers after reboot/network blips

## Mandatory Skill Map (Relay + ML Workflows)

When working in this repo, apply these skills by default:

- new capability/spec intake: `requirements-intake-for-ml-research`
- long-run experiment launch: `relay-long-task-callback` + `ml-run-contract-enforcer`
- PR/runtime acceptance evidence: `pr-acceptance-tests-writer`
- robustness validation after runtime changes: `robustness-execution-suite-runner`
- overnight failure response: `incident-triage-playbook`
- pre-release hardening: `release-hardening-checklist`

Guideline: keep foreground turns short; do not use foreground `sleep + tail` monitor loops for long runs.

## One-shot run

1. Copy env template:

- `cp config/setup.env.example config/setup.env`
- Fill tokens/IDs and proxy URL.

2. Run bootstrap as root:

- `sudo ./bootstrap.sh`

## Verification

- `openclaw gateway health`
- `openclaw status`
- `codex-discord-relayctl status`
- DM the Codex relay bot in Discord.

## Security

Never commit real tokens/keys. Rotate any token ever pasted into chat logs.
