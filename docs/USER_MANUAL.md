# vibe-research-toolkit User Manual

This manual is for researchers running experiments through the Discord relay + agent stack in this repo.

Stable reference release: `v1.1.1`.

## 1) What you get

`vibe-research-toolkit` provides:
- Discord-to-agent relay (Codex/Claude)
- persistent session/workdir state per Discord context
- plan/task/worktree operations for structured research execution
- long-job callbacks (`job_start` + `watch` + `thenTask`)
- continuity artifacts (`docs/WORKING_MEMORY.md`, `HANDOFF_LOG.md`)

## 2) Mental model

Each Discord DM/channel/thread maps to a **conversation key**.
Each key has a **session** that stores:
- agent thread/session id
- active workdir
- queue/task state
- optional active background jobs

Use this to separate experiments by thread while keeping continuity within each thread.

## 3) Install and verify

### Prerequisites
- Node.js >= 20
- Discord bot token
- Codex CLI (and optional Claude CLI)

### Install
```bash
cp config/setup.env.example config/setup.env
$EDITOR config/setup.env
sudo ./bootstrap.sh
```

### Verify
```bash
codex-discord-relayctl status
codex-discord-relayctl logs
bash scripts/verify_install.sh
```

In Discord, DM the relay bot and run `/status`.

## 4) Core commands

### Session and context
- `/status` — live status + queue/task/job summary
- `/workdir /abs/path` — switch project directory (resets session)
- `/reset` — reset the current session
- `/context` — show context files injected into prompts
- `/context reload` — force context reload on next run

### Structured execution
- `/plan ...` — generate a plan
- `/plan show <id|last>` — inspect plan
- `/plan apply <id|last> --confirm` — execute plan
- `/task add ...` — queue a task
- `/task list` — inspect queue
- `/task run` — execute queue
- `/task stop` — stop active task run

### Parallel experimentation
- `/worktree new <name> [--from <ref>] [--use]`
- `/worktree use <name>`
- `/worktree list`

### Background jobs
- `/job list` — recent jobs in this conversation
- `/job logs <id>` — tail logs for one job

### ML automation
- `/exp run <template_id> ...` — template-backed experiment launch (`vr_run.sh` + post-run pipeline)
- `/exp best ...` — show current best run from registry
- `/exp report ...` — generate markdown run report from registry

### Continuity
- `/handoff` — append/update handoff and memory artifacts

## 5) Standard research loop (recommended)

1. Set workdir:
   - `/workdir /path/to/repo`
2. Define hypothesis + success criteria in prompt.
3. Generate plan:
   - `/plan Test hypothesis H with ablation A/B, metrics M, stop criteria S`
4. Review and apply:
   - `/plan show last`
   - `/plan apply last --confirm`
5. Use `/task run` for execution chunks.
6. For long jobs, use callback pattern (section 6).
7. Capture results:
   - `/handoff`

## 6) Relay Callback for long experiments

When training/evaluation exceeds a few minutes, launch in background and auto-run follow-up analysis.

Example action block:

```text
[[relay-actions]]
{"actions":[{"type":"job_start","description":"hopper seed=2 warmstart ablation","command":"bash scripts/run_hopper_seed2.sh","watch":{"everySec":120,"tailLines":80,"thenTask":"Analyze logs/hopper_seed2.log, summarize final metrics, compare with baseline, and propose next discriminating experiment.","thenTaskDescription":"Analyze hopper seed=2 outcomes","runTasks":true}}]}
[[/relay-actions]]
```

Benefits:
- no manual polling loop
- deterministic callback task with explicit analysis goals
- continuity even if conversation queue is busy

## 6A) ML automation package (run wrapper + registry)

The toolkit now includes a standard run contract for research experiments:

- Wrapper: `scripts/vr_run.sh`
- Metrics schema: `tools/exp/metrics_schema.json`
- Validator: `tools/exp/validate_metrics.py`
- Registry append tool: `tools/exp/append_registry.py`
- Summary tool: `tools/exp/summarize_run.py`
- Templates: `templates/experiments/*.yaml`

Each run should produce:
- `exp/results/<run_id>/meta.json`
- `exp/results/<run_id>/metrics.json`
- `exp/results/<run_id>/train.log`
- `exp/results/<run_id>/artifacts/`

Example wrapper usage:

```bash
scripts/vr_run.sh --run-id rtest --run-dir exp/results/rtest -- \
  python3 train.py --config cfg.yaml --seed 0
```

Post-run checks:

```bash
python3 tools/exp/validate_metrics.py exp/results/rtest/metrics.json
python3 tools/exp/append_registry.py --registry exp/registry.jsonl --run-dir exp/results/rtest
python3 tools/exp/summarize_run.py --run-dir exp/results/rtest --out-md reports/rolling_report.md --append
```

Registry behavior:
- `exp/registry.jsonl` is append-only.
- duplicate `run_id` is rejected by default (fail-closed).

## 6C) ML Automation (Exp Commands)

The relay exposes first-class experiment commands that build on the run contract tools.

Examples:

```text
/exp run train_baseline seed=0 config=cfg.yaml study_id=S001
/exp best metric=loss higher=false
/exp report last=30
```

`/exp run` flow:
1. Render template (`tools/exp/render_template.py`)
2. Launch run via `scripts/vr_run.sh`
3. Auto-run post pipeline (`tools/exp/post_run_pipeline.py`)

Post pipeline outputs:
- deterministic failure taxonomy (`error_type`, `error_hint`, `error_signature`)
- registry append (`exp/registry.jsonl`)
- rolling markdown summary (`reports/rolling_report.md`)
- experience log (`exp/experience.jsonl`)
- reflection stub (`exp/reflections/<run_id>.md`)

## 6B) Supervisor-backed long runs (recommended in v1.1.1)

For high-value long jobs, prefer the relay supervisor path so callback analysis only runs after explicit state/artifact checks.

Operational prerequisites:
- `RELAY_AGENT_ACTIONS_ENABLED=true`
- `RELAY_SUPERVISOR_PHASE1_ENABLED=true`
- relay restart completed (`codex-discord-relay-multictl restart default`)

Minimal action example:

```text
[[relay-actions]]
{"actions":[{"type":"job_start","description":"phase1 canary","command":"echo use-supervisor-contract","supervisor":{"mode":"stage0_smoke_gate","runId":"r_phase1_canary","stateFile":"exp/results/r_phase1_canary/state.json","smokeCmd":"python -c 'print(\"smoke\")'","fullCmd":"python train.py --config cfg.yaml","cleanupSmokePolicy":"keep_manifest_only"},"watch":{"everySec":300,"tailLines":30,"thenTask":"Analyze final artifacts and summarize metrics.","runTasks":true}}]}
[[/relay-actions]]
```

Best-practice rollout:
1. Run one canary in a single thread after restart.
2. Confirm `state.json` status and expected cleanup behavior.
3. Expand to normal long-run workflows.

## 7) Features designed for ML researchers

### Your requested highlights
1. **Research anywhere via Discord**
   - monitor and steer from phone or laptop.
2. **Interactive iteration**
   - inspect intermediate logs/plots and redirect quickly.
3. **Relay Callback design**
   - run long jobs and auto-trigger post-run analysis.
4. **Hypothesis-driven skill design**
   - bias toward high-signal, non-trivial experiments.

### Additional high-value features
5. **Parallel ablations with worktrees**
   - isolate branch-per-hypothesis safely.
6. **Persistent continuity memory**
   - cross-session handoff with explicit evidence paths.
7. **Operational observability**
   - queue/job/task status exposed in commands and logs.
8. **Reproducible infra state**
   - export/apply machine-state snapshots.
9. **Proxy-aware operation**
   - resilient operation in constrained networks.
10. **Fast status command bypass**
   - introspection commands remain responsive during long runs.

## 8) Monitoring and diagnostics

### First-line checks
```bash
codex-discord-relayctl status
codex-discord-relayctl logs
tail -n 200 /root/.codex-discord-relay/relay.log
```

### Multi-instance checks
```bash
codex-discord-relay-multictl list
codex-discord-relay-multictl status all
codex-discord-relay-multictl logs default
codex-discord-relay-multictl logs claude
```

### Lint/runtime checks
```bash
bash scripts/lint_repo.sh
node --check codex-discord-relay/relay.js
```

## 9) Prompt templates for high-signal research

### Hypothesis setup
`Design one discriminating experiment to test hypothesis H against baseline B. Define stop criteria, expected signatures for each outcome, and follow-up branch logic.`

### Mid-run interpretation
`Given the current logs and metrics, identify whether evidence supports H, rejects H, or is inconclusive. Recommend exactly one next experiment with highest expected information gain.`

### Post-run callback analysis
`Summarize final metrics, compare against baseline and previous runs, list failure modes, and propose one next high-value ablation.`

## 10) Safety and quality practices

- Keep secrets out of repo and chat logs.
- Keep allowed workdir roots constrained.
- Prefer one hypothesis per run unless throughput constraints justify batching.
- Require explicit confirmation for destructive actions.
- Always attach evidence paths when concluding experimental outcomes.

## 11) Related docs

- `README.md` — project overview and quickstart
- `docs/ML_RESEARCH_DESIGN.md` — design rationale for researchers
- `docs/WORKING_MEMORY.md` — living snapshot
- `HANDOFF_LOG.md` — append-only chronology
