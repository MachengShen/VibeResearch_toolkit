# Codex Discord Relay

Direct Discord -> agent CLI relay so you can chat with Codex or Claude from Discord (including iPhone) without going through OpenClaw.

## What it does

- Replies in DMs. In guild channels it replies when mentioned; in threads it can auto-respond without mention (see `RELAY_THREAD_AUTO_RESPOND`).
- Persists an agent session id per Discord conversation.
- Queues messages per conversation to avoid overlap.
- (Optional) Allows the agent to request relay-side actions (e.g. start/watch a long-running shell job) via a `[[relay-actions]]...[[/relay-actions]]` JSON block (disabled by default; DM-only by default).
- Supports two backends via `RELAY_AGENT_PROVIDER`:
  - `codex` (default): uses `codex exec` / `codex exec resume`
  - `claude`: uses `claude -p --output-format json --resume`
- Supports quick commands:
  - `/status`
  - `/ask <question...>`
  - `/inject <instruction...>`
  - `/reset`
  - `/workdir /absolute/path`
  - `/attach <session_id>`
  - `/upload <path>`
  - `/context`
  - `/context reload`
  - `/task ...`
  - `/worktree ...`
  - `/plan ...`
  - `/handoff ...`
  - `/research ...`
  - `/auto ...`
  - `/go ...`
  - `/overnight ...`
  - `/exp ...`
  - `/help`

## Setup

1. Install dependencies:

```bash
cd /root/codex-discord-relay
npm install
```

2. Create runtime env:

```bash
cp /root/codex-discord-relay/.env.example /root/.codex-discord-relay.env
chmod 600 /root/.codex-discord-relay.env
```

If you want Claude backend, set in `/root/.codex-discord-relay.env`:

```bash
RELAY_AGENT_PROVIDER=claude
CLAUDE_BIN=claude
# optional:
# CLAUDE_MODEL=sonnet
# CLAUDE_PERMISSION_MODE=acceptEdits
# CLAUDE_ALLOWED_TOOLS=Bash,Read,Glob,Grep,Write,Edit,NotebookEdit,TodoWrite,Task,TaskOutput,TaskStop,EnterPlanMode,ExitPlanMode,ToolSearch,AskUserQuestion,Skill,WebSearch,WebFetch
# RELAY_AGENT_TIMEOUT_MS=900000
```

3. Start/recover service:

```bash
/usr/local/bin/codex-discord-relay-ensure.sh

# If multi-instance wrappers are installed on this machine:
/usr/local/bin/codex-discord-relay-ensure-multi.sh
```

4. Check logs:

```bash
tail -f /root/.codex-discord-relay/relay.log
```

## Operate

Single-instance commands:

```bash
codex-discord-relayctl status
codex-discord-relayctl restart
codex-discord-relayctl logs
```

Multi-instance commands (if installed):

```bash
codex-discord-relay-multictl list
codex-discord-relay-multictl status all
codex-discord-relay-multictl restart default
codex-discord-relay-multictl logs default
```

Restart safety guard:

- `codex-discord-relay-multictl restart <name|all>` refuses when target instance state shows active runs (`agentRun.status=running`) to avoid interrupting in-flight conversations.
- Unsafe override (only when intentional): `CODEX_RELAY_RESTART_FORCE=1 codex-discord-relay-multictl restart <name|all>`

## Instance Layout (multi-instance mode)

- Default env: `/root/.codex-discord-relay.env`
- Extra env files: `/root/.codex-discord-relay/instances.d/<name>.env`
- Default state: `/root/.codex-discord-relay`
- Extra state: `/root/.codex-discord-relay/instances/<name>/`

## Notes

- `RELAY_AGENT_PROVIDER=codex|claude` selects the backend.
- `RELAY_AGENT_TIMEOUT_MS` controls max runtime per agent call (default `600000` ms, set `0` to disable).
- `RELAY_CODEX_TRANSIENT_RETRY_ENABLED=true|false` controls one-shot retry for likely transient Codex failures (default `true`).
- `RELAY_CODEX_TRANSIENT_RETRY_MAX=<int>` controls max transient retries for Codex (`0..3`, default `1`).
- `CLAUDE_PERMISSION_MODE=acceptEdits` is recommended when relay runs as root.
- `CLAUDE_ALLOWED_TOOLS` can pre-allow specific Claude tools (comma or space separated) to avoid interactive approval prompts in relay flows.
- Agent context bootstrap is enabled by default. The relay injects runtime context into prompts so agents know they are replying via Discord and can request uploads with `[[upload:...]]`.
  Tune with `RELAY_CONTEXT_ENABLED`, `RELAY_CONTEXT_EVERY_TURN`, `RELAY_CONTEXT_VERSION`, `RELAY_CONTEXT_FILE`, `RELAY_CONTEXT_MAX_CHARS`, and `RELAY_CONTEXT_MAX_CHARS_PER_FILE`.
- Default `CODEX_APPROVAL=never` (Codex mode) prevents approval prompts from blocking mobile usage.
- Default `CODEX_SANDBOX=danger-full-access` matches the YOLO/no-permission flow; set it to `workspace-write` if you want tighter sandboxing.
- `/workdir` is restricted by `CODEX_ALLOWED_WORKDIR_ROOTS`.
- `/task ...` is a persistent per-conversation task queue with an auto-runner ("Ralph loop"). Tune with `RELAY_TASKS_ENABLED`, `RELAY_TASKS_MAX_PENDING`, `RELAY_TASKS_STOP_ON_ERROR`, `RELAY_TASKS_POST_FULL_OUTPUT`.
- `/worktree ...` manages `git worktree` under `RELAY_WORKTREE_ROOT_DIR` (must be inside `CODEX_ALLOWED_WORKDIR_ROOTS`).
- Agent relay actions (jobs): when enabled, the agent can output a `[[relay-actions]]...[[/relay-actions]]` JSON block to ask the relay to start/watch/stop a long-running shell job. This is gated by `RELAY_AGENT_ACTIONS_*` (disabled by default; DM-only by default). Job logs are stored under `$RELAY_STATE_DIR/jobs/<conversationKey>/<jobId>/job.log`.
- `/research ...` enables a guarded research control plane (disabled by default) with on-disk project state/events, a manager decision parser (`[[research-decision]]...[[/research-decision]]`), and fail-closed research-only action execution.
- `/go ...` is a task macro: queue and run immediately. Long-run intents (train/sweep/ablation/eval/experiment keywords) auto-wrap into a `job_start` + watcher callback task, while non-long tasks keep the task + handoff-update behavior.
- `/exp ...` is a first-class ML automation command family:
  - `/exp run <template_id> ...` launches template-backed runs via `scripts/vr_run.sh` and chains deterministic post-run automation.
  - `/exp best ...` selects the current best successful run from `exp/registry.jsonl`.
  - `/exp report ...` writes a markdown run table from the registry.
- `/ask ...` is a priority interrupt: it bypasses the queue, attempts to pause the active run, answers your question quickly, then resumes the paused run automatically.
- `/inject ...` is a hard-preempt run-replacement interrupt: it invalidates queued not-yet-started requests in the same conversation, requests stop on the active run, then launches a new run with your injected instruction.
- `/ask` now injects a relay-built run snapshot into the stateless priority prompt (recent progress lines, recent jobs, and latest run-log excerpt). For small logs it can include the full log body; for large logs it includes a capped head+tail excerpt.
- `/overnight ...` is a research macro: one command to start/status/stop unattended research loops.
- The relay edits the initial `Running ...` message with human-readable intermediate progress (see `RELAY_PROGRESS*` env vars).
- If the relay process restarts mid-run, it now marks the run as interrupted and posts a terminal interruption status instead of leaving a silent dangling "Running ..." line.
- `DISCORD_ALLOWED_CHANNELS` is matched against the thread parent channel as well, so threads created under an allowed channel work without adding each thread id.
- File uploads: Codex can ask the relay to upload a local file by including `[[upload:some-file.ext]]` in its response (or you can use `/upload some-file.ext`). Files are resolved relative to the per-conversation `upload_dir` shown by `/status`. Discord usually renders images inline and keeps text/PDF files downloadable.
- Incoming attachments: when you attach a small text file in Discord (e.g. `.md`, `.txt`, `.json`), the relay downloads it into `<upload_dir>/attachments/` and appends its contents to the prompt automatically. Optional guarded `.zip` ingest can be enabled to extract text-like entries only (`RELAY_DISCORD_ATTACHMENTS_ZIP_ENABLED=true`). Tune with `RELAY_DISCORD_ATTACHMENTS_*`.
- If Discord is blocked on your network, the relay supports proxies via `DISCORD_GATEWAY_PROXY` / `HTTPS_PROXY` / `HTTP_PROXY`.
  It will also automatically source `/root/.openclaw/proxy.env` when starting (same proxy config used by OpenClaw).
- `/attach` is **DM-only by default**. Set `RELAY_ATTACH_ALLOW_GUILDS=true` if you intentionally want to allow attaching sessions in guild channels.

## Agent Relay Actions (Jobs)

The relay can execute a small set of allowlisted actions requested by the agent itself (for long-running training jobs).

Marker syntax (agent output):

```text
[[relay-actions]]
{"actions":[
  {"type":"job_start",
   "description":"Train baseline sweep (seed 1/3)",
   "command":"python train.py --config cfg.yaml",
   "watch":{"everySec":300,"tailLines":20,
            "thenTask":"Analyze results and write a short report in HANDOFF_LOG.md",
            "thenTaskDescription":"Analyze final metrics + failures for seed 1/3",
            "runTasks":true,
            "requireFiles":["exp/results/r0007/metrics.json","exp/results/r0007/meta.json","exp/results/r0007/train.log"],
            "readyTimeoutSec":900,
            "readyPollSec":15,
            "onMissing":"block"}
  }
]}
[[/relay-actions]]
```

Notes:

- The relay removes the `[[relay-actions]]...[[/relay-actions]]` block before posting the agent's visible reply.
- Actions are executed after posting, inside the per-conversation queue.
- Watchers post periodic updates and can enqueue a follow-up `/task` when the job finishes.
- Default watcher output is compact (summary + output delta) and suppresses no-change spam.
- `job_start.description` and `watch.thenTaskDescription` are optional but recommended so progress updates stay readable.
- `watch.runTasks` is optional. If omitted and `watch.thenTask` is set, relay uses `RELAY_JOBS_THEN_TASK_DEFAULT_RUN_TASKS`.
- Job-finish finalization (`exit_code` detection + `thenTask` enqueue) runs outside the normal conversation queue so callbacks still fire even if a foreground agent run is stuck.
- Optional watch-contract v2 fields:
  - `watch.requireFiles`: callback waits until all listed files exist (when feature flag is enabled).
  - `watch.readyTimeoutSec` / `watch.readyPollSec`: artifact wait timeout and poll interval.
  - `watch.onMissing`: `block` (default) or `enqueue`.
- Optional launch preflight block on `job_start`:
  - `preflight.checks[]` with `path_exists`, `cmd_exit_zero`, `min_free_disk_gb`.
  - `preflight.onFail`: `reject` (default) or `warn`.
- Optional relay-native supervisor block on `job_start` (Phase 1; feature-flagged):
  - set `supervisor.mode="stage0_smoke_gate"` and provide:
    - `runId`, `stateFile`, `smokeCmd`, `fullCmd`
    - optional `smokeRequiredFiles[]`, `fullRequiredFiles[]`, `smokeRunDir`
    - optional `cleanupSmokePolicy=keep_all|keep_manifest_only` (default `keep_manifest_only`)
    - optional `gateOut`, `gateErr`, `readyTimeoutSec`, `readyPollSec`, `onMissing`
  - when enabled, relay compiles and launches the bundled stage0 runner (default under relay `scripts/`) unless overridden via `supervisor.scriptPath`; relay auto-wires watch artifact gates and validates state status/cleanup contract before callback enqueue.
- Wait-pattern guard can warn/reject risky `pgrep -f` self-match loops before launch.
- Visibility gate can mark long jobs as degraded if startup/periodic heartbeats are missing.

Controls:

- `/auto actions on|off`: per-conversation toggle (defaults to `on` when global actions are enabled).

Env knobs:

- `RELAY_AGENT_ACTIONS_ENABLED=true|false` (default `false`)
- `RELAY_AGENT_ACTIONS_DM_ONLY=true|false` (default `true`)
- `RELAY_AGENT_ACTIONS_ALLOWED=job_start,job_stop,job_watch` (default: `job_*` only)
- `RELAY_AGENT_ACTIONS_MAX_PER_MESSAGE=<int>` (default `1`)
- `RELAY_MAX_JOB_COMMAND_CHARS=<int>` (default `12000`, minimum enforced `4000`)
- `RELAY_JOBS_AUTO_WATCH=true|false` (default `true` only if actions enabled)
- `RELAY_JOBS_AUTO_WATCH_EVERY_SEC=<int>` (default `300`)
- `RELAY_JOBS_AUTO_WATCH_TAIL_LINES=<int>` (default `50`)
- `RELAY_JOBS_THEN_TASK_DEFAULT_RUN_TASKS=true|false` (default `false`; used when `watch.thenTask` is set and `watch.runTasks` is omitted)
- `RELAY_EXP_COMMANDS_ENABLED=true|false` (default `true`)
- `RELAY_EXP_ALLOW_GUILDS=true|false` (default `true`)
- `RELAY_EXP_DEFAULT_READY_TIMEOUT_SEC=<int>` (default `900`)
- `RELAY_EXP_DEFAULT_READY_POLL_SEC=<int>` (default `15`)
- `RELAY_EXP_EXPERIENCE_LOGGING_ENABLED=true|false` (default `true`)
- `RELAY_EXP_WATCH_SNAPSHOTS_ENABLED=true|false` (default `false`)
- `RELAY_EXP_WATCH_SNAPSHOT_EVERY_SEC=<int>` (default `300`)
- `RELAY_EXP_WATCH_SNAPSHOT_TAIL_LINES=<int>` (default `80`)
- `RELAY_JOBS_WATCH_COMPACT=true|false` (default `true`)
- `RELAY_JOBS_WATCH_POST_NO_CHANGE=true|false` (default `false`)
- `RELAY_JOBS_WATCH_INCLUDE_TAIL_ON_CHANGE=true|false` (default `false`)
- `RELAY_JOBS_WATCH_INCLUDE_TAIL_ON_FINISH=true|false` (default `false`)
- `RELAY_JOBS_WATCH_COMPACT_TAIL_LINES=<int>` (default `3`)
- `RELAY_JOBS_WATCH_COMPACT_TAIL_MAX_CHARS=<int>` (default `600`)
- `RELAY_WATCH_REQUIRE_FILES_ENABLED=true|false` (default `false`)
- `RELAY_WATCH_REQUIRE_FILES_DEFAULT_TIMEOUT_SEC=<int>` (default `900`)
- `RELAY_WATCH_REQUIRE_FILES_DEFAULT_POLL_SEC=<int>` (default `15`)
- `RELAY_SUPERVISOR_PHASE1_ENABLED=true|false` (default `false`)
- `RELAY_SUPERVISOR_PHASE1_DEFAULT_SCRIPT=<path>` (default bundled runner in relay `scripts/`; relative values are resolved against supervisor cwd, then relay dir fallback)
- `RELAY_SUPERVISOR_PHASE1_DEFAULT_EXPECT_STATUS=<status>` (default `success`)
- `RELAY_SUPERVISOR_PHASE1_DEFAULT_READY_TIMEOUT_SEC=<int>` (default `900`)
- `RELAY_SUPERVISOR_PHASE1_DEFAULT_READY_POLL_SEC=<int>` (default `15`)
- `RELAY_JOB_PREFLIGHT_ENABLED=true|false` (default `false`)
- `RELAY_WAIT_PATTERN_GUARD_MODE=off|warn|reject` (default `warn`)
- `RELAY_VISIBILITY_GATE_ENABLED=true|false` (default `false`)
- `RELAY_VISIBILITY_STARTUP_HEARTBEAT_SEC=<int>` (default `60`)
- `RELAY_VISIBILITY_HEARTBEAT_EVERY_SEC=<int>` (default `600`)
- `RELAY_WATCH_STALE_GUARD_ENABLED=true|false` (default `true`)
- `RELAY_WATCH_STALE_MINUTES=<int>` (default `15`; unchanged-log + low-util window before alert)
- `RELAY_WATCH_STALE_ALERT_EVERY_MINUTES=<int>` (default `30`)
- `RELAY_WATCH_STALE_CPU_LOW_PCT=<int>` (default `20`)
- `RELAY_WATCH_STALE_GPU_LOW_PCT=<int>` (default `20`)
- `RELAY_GO_AUTOWRAP_LONG_TASKS=true|false` (default `true`)
- `RELAY_GO_LONG_TASK_WATCH_EVERY_SEC=<int>` (default `300`)
- `RELAY_GO_LONG_TASK_TAIL_LINES=<int>` (default `30`)
- `RELAY_INTERRUPT_QUESTIONS_ENABLED=true|false` (default `true`)
- `RELAY_INTERRUPT_QUESTIONS_AUTO=true|false` (default `false`; when `true`, queued plain-text questions ending in `?` are treated like `/ask`)
- `RELAY_INTERRUPT_QUESTIONS_TIMEOUT_MS=<int>` (default `180000`)
- `RELAY_INTERRUPT_QUESTIONS_SANDBOX=<mode>` (default `read-only`)
- `RELAY_INTERRUPT_QUESTIONS_SNAPSHOT_MAX_CHARS=<int>` (default `18000`)
- `RELAY_INTERRUPT_QUESTIONS_SNAPSHOT_PROGRESS_LINES=<int>` (default `40`)
- `RELAY_INTERRUPT_QUESTIONS_SNAPSHOT_LOG_MAX_BYTES=<int>` (default `2097152`)
- `RELAY_INTERRUPT_QUESTIONS_SNAPSHOT_LOG_MAX_CHARS=<int>` (default `12000`)

### Recommended Long-Run Callback Flow

Use this when you want the agent to launch training, keep running in background, and automatically analyze results when complete.

1. Set repo workdir:
   - `/workdir /root/<repo>`
2. Queue a task with explicit skill invocation:
   - `/task add Use skill relay-long-task-callback. Launch <training command>. Watch everySec=300 tailLines=20. thenTask="Analyze final log <path> and summarize metrics + next steps."`
3. Start runner:
   - `/task run`

Notes:
- `/task add` is recommended for queue controls (`/task list`, `/task stop`) and repeatability.
- You can also use plain natural-language prompting (without `/task`) if the agent emits valid `[[relay-actions]]` JSON.
- `/auto actions on` is usually not needed if global actions are enabled and this conversation has not toggled actions off.
- Avoid foreground `sleep + tail` monitor loops in normal turns; use `job_start + watch + thenTask`.

## Research Manager

Commands:

- `/research start <goal...>`: scaffold a new research project under `RELAY_RESEARCH_PROJECTS_ROOT` and bind it to this conversation.
- `/research status`: show phase/status/budgets/active run.
- `/research run`: set status to running and execute one manager step.
- `/research step`: execute exactly one manager step.
- `/research pause`: pause the loop (`auto_run=false`).
- `/research stop`: mark done and detach this conversation.
- `/research note <text...>`: append deterministic user feedback event for the next manager step.
- `/overnight start <goal...>`: start/resume unattended research mode with defaults and run first step.
- `/overnight status`: quick status alias for overnight mode.
- `/overnight stop`: pause unattended research mode safely.

Action-origin policy:

- `[[relay-actions]]...[[/relay-actions]]` remains for normal agent outputs and is gated by `RELAY_AGENT_ACTIONS_*`.
- `[[research-decision]]...[[/research-decision]]` is parsed **only** inside `/research` manager steps and gated by `RELAY_RESEARCH_*`.
- Outside manager steps, research-decision blocks are ignored (fail-closed).

Current v1 research actions:

- `job_start`, `job_watch`, `job_stop`, `task_add`, `task_run`, `write_report`, `research_pause`, `research_mark_done`

Artifact contract for research-launched runs:

- Relay assigns `runId` and `runDir` under `exp/results/<runId>/`.
- It exports `RUN_ID` and `RUN_DIR` into the job command.
- It requires `metrics.json` in `runDir`; missing/invalid metrics block the loop.
- It appends deterministic run records to `exp/registry.jsonl`.

Env knobs:

- `RELAY_RESEARCH_ENABLED=true|false` (default `false`)
- `RELAY_RESEARCH_DM_ONLY=true|false` (default `true`)
- `RELAY_RESEARCH_PROJECTS_ROOT=/abs/path` (must be inside `CODEX_ALLOWED_WORKDIR_ROOTS`)
- `RELAY_RESEARCH_DEFAULT_MAX_STEPS=<int>` (default `50`)
- `RELAY_RESEARCH_DEFAULT_MAX_WALLCLOCK_MIN=<int>` (default `480`)
- `RELAY_RESEARCH_DEFAULT_MAX_RUNS=<int>` (default `30`)
- `RELAY_RESEARCH_TICK_SEC=<int>` (default `30`)
- `RELAY_RESEARCH_TICK_MAX_PARALLEL=<int>` (default `2`)
- `RELAY_RESEARCH_ACTIONS_ALLOWED=...` (separate allowlist from relay actions)
- `RELAY_RESEARCH_MAX_ACTIONS_PER_STEP=<int>` (default `12`)
- `RELAY_RESEARCH_LEASE_TTL_SEC=<int>` (default `300`)
- `RELAY_RESEARCH_INFLIGHT_TTL_SEC=<int>` (default `900`)
- `RELAY_RESEARCH_POST_ON_APPLIED=true|false` (default `true`)
- `RELAY_RESEARCH_POST_ON_BLOCKED=true|false` (default `true`)
- `RELAY_RESEARCH_POST_EVERY_STEPS=<int>` (default `5`)
- `RELAY_RESEARCH_REQUIRE_NOTE_PREFIX=true|false` (default `false`)
- `RELAY_REGISTRY_LOCK_ENABLED=true|false` (default `true`; used by `tools/exp/append_registry.py`)

### ML Utility Scripts

The toolkit includes experiment-contract helpers used by long-run callbacks:

- `scripts/vr_run.sh`:
  - wraps train/eval commands
  - writes `meta.json`, `train.log`, and schema-valid `metrics.json` even on cancel/failure
- `tools/exp/render_template.py`:
  - render `templates/experiments/*.yaml` by id into command/watch/artifact JSON
- `tools/exp/append_registry.py`:
  - append run entries to `exp/registry.jsonl` with optional duplicate handling and file locking
- `tools/exp/summarize_run.py`:
  - generate markdown summaries from a run directory (`--registry` optional)
- `tools/exp/best_run.py`:
  - select best successful run from `exp/registry.jsonl` for a metric
- `tools/exp/classify_failure.py`:
  - deterministic error taxonomy (`error_type`, `error_hint`, `error_signature`) for failed/canceled runs
- `tools/exp/post_run_pipeline.py`:
  - fail-closed post-run automation (validate -> classify -> registry -> summary -> experience/reflection)
- `tools/exp/report_registry.py`:
  - render markdown report tables from `exp/registry.jsonl`

Examples:

```bash
python3 tools/exp/render_template.py --template-id train_baseline --set seed=1 --set config=cfg.yaml
python3 tools/exp/summarize_run.py --run-dir exp/results/<run_id> --registry exp/registry.jsonl
python3 tools/exp/best_run.py --registry exp/registry.jsonl --metric val_loss --higher-is-better false
python3 tools/exp/report_registry.py --registry exp/registry.jsonl --out reports/exp_report.md --last 30
```

### `/exp` command examples

```text
/exp run train_baseline seed=0 config=cfg.yaml study_id=S001
/exp best metric=val_loss higher=false
/exp report last=30 out=reports/exp_report.md
```

## Task Queue (Ralph Loop)

Commands:

- `/task add <text...>`: append a pending task to this conversation.
- `/task list`: show the queue.
- `/task run`: run tasks sequentially until empty/blocked/stopped.
- `/task stop`: stop immediately (kills the in-flight agent child process).
- `/task clear [done|all]`: clear completed tasks (or everything).

Env knobs:

- `RELAY_TASKS_ENABLED=true|false`
- `RELAY_TASKS_MAX_PENDING=<int>` (default `50`)
- `RELAY_TASKS_STOP_ON_ERROR=true|false` (default `false`)
- `RELAY_TASKS_POST_FULL_OUTPUT=true|false` (default `true`)
- `RELAY_TASKS_SUMMARY_AFTER_RUN=true|false` (default `true`)

## Git Worktrees

Commands:

- `/worktree list`: show `git worktree list --porcelain` for the current repo.
- `/worktree new <name> [--from <ref>] [--use]`: create a new worktree (branch `wt/<name>`).
- `/worktree use <name>`: switch workdir to an existing worktree and reset session/context.
- `/worktree rm <name> [--force]`: remove a worktree (refuses if it is active unless `--force`).
- `/worktree prune`: run `git worktree prune`.

Env knobs:

- `RELAY_WORKTREE_ROOT_DIR=/abs/path` (default `$RELAY_STATE_DIR/worktrees`)

## Plans

Commands:

- `/plan <request...>` (or `/plan new <request...>`): generate and save a plan (Codex run uses `--sandbox read-only`).
- `/plan list`: list saved plans for this conversation.
- `/plan show <id|last>`: show a saved plan.
- `/plan queue <id|last> [--run]`: extract the plan's "Task breakdown" list and enqueue items as `/task` entries (optional `--run` starts the task runner).
- `/plan apply <id|last> [--confirm]`: execute a saved plan (agent edits repo).

Notes:

- Plan generation uses `codex exec --sandbox read-only` (stateless) so it cannot write files; the relay saves the resulting Markdown to `$RELAY_STATE_DIR/plans/<conversationKey>/<planId>.md`.
- Plan apply runs the configured agent provider in normal mode (Codex/Claude) and passes the saved plan text as context.
- In guild channels, plan apply may require `--confirm` (see env knob below).

Env knobs:

- `RELAY_PLANS_ENABLED=true|false`
- `RELAY_PLANS_MAX_HISTORY=<int>` (default `20`)
- `RELAY_PLAN_APPLY_REQUIRE_CONFIRM_IN_GUILDS=true|false` (default `true`)

## Handoff And Working Memory

Commands:

- `/handoff`: generate a handoff entry (Codex run uses `--sandbox read-only`) and append it to files.
- `/handoff --commit`: also `git commit` the updated handoff files (repo only).
- `/handoff --push`: push after commit (repo only).

Notes:

- The relay appends to the files itself; Codex is used only to *generate* the text in read-only mode.
- If `RELAY_AUTO_HANDOFF_AFTER_EACH_TASK=true`, a handoff is written after each completed task in `/task run`.
- If `RELAY_AUTO_HANDOFF_AFTER_TASK_RUN=true`, a handoff is written automatically after `/task run` completes.
- If `RELAY_AUTO_HANDOFF_AFTER_PLAN_APPLY=true`, a handoff is written automatically after `/plan apply` completes.
- `RELAY_HANDOFF_AUTO_ENABLED` is a legacy alias for enabling both auto-handoff behaviors above.

Env knobs:

- `RELAY_HANDOFF_ENABLED=true|false`
- `RELAY_HANDOFF_FILES="HANDOFF_LOG.md;docs/WORKING_MEMORY.md"` (semicolon-separated)
- `RELAY_HANDOFF_AUTO_ENABLED=true|false` (legacy; default `false`)
- `RELAY_AUTO_HANDOFF_AFTER_EACH_TASK=true|false` (default `false`)
- `RELAY_AUTO_HANDOFF_AFTER_TASK_RUN=true|false` (default `false`)
- `RELAY_AUTO_HANDOFF_AFTER_PLAN_APPLY=true|false` (default `false`)
- `RELAY_HANDOFF_GIT_AUTO_COMMIT=true|false` (default `false`)
- `RELAY_HANDOFF_GIT_AUTO_PUSH=true|false` (default `false`)
- `RELAY_HANDOFF_GIT_COMMIT_MESSAGE="..."` (default `chore: relay handoff`)

## Optional Git Auto-Commit

If enabled, the relay will `git add -A && git commit` after successful `/task` steps and/or `/plan apply` when the repo has changes. It never auto-pushes.

Env knobs:

- `RELAY_GIT_AUTO_COMMIT=true|false` (default `false`)
- `RELAY_GIT_AUTO_COMMIT_SCOPE=task|plan|both` (default `both`)
- `RELAY_GIT_COMMIT_PREFIX="ai:"` (default `ai:`)

## Agent Context Bootstrap

By default, the relay prepends a small runtime context block before forwarding a user prompt to Codex/Claude. This makes agents aware of:

- They are being used via Discord relay
- Replies are routed back to Discord
- Upload marker syntax (`[[upload:path]]`) for attachments
- Slash-command boundaries (`/status`, `/reset`, etc. are user-side)

Controls:

- `RELAY_CONTEXT_ENABLED=true|false`
- `RELAY_CONTEXT_EVERY_TURN=true|false` (default false)
- `RELAY_CONTEXT_VERSION=<int>` (default `1`; bump to force re-bootstrap on existing sessions)
- `RELAY_CONTEXT_FILE=<spec1>;<spec2>;...` (optional per-instance extra context list)
  - Prefix each spec with `head:`, `tail:`, or `headtail:`. If omitted, `head:` is used.
  - Absolute paths are loaded directly.
  - Relative paths resolve against the active session workdir (`/workdir`).
- `RELAY_CONTEXT_MAX_CHARS=<int>` (default `40000`)
- `RELAY_CONTEXT_MAX_CHARS_PER_FILE=<int>` (default `2000` in templates; runtime default falls back to total budget)

Example:

```bash
RELAY_CONTEXT_FILE="/root/.codex-discord-relay/global-context.md;tail:docs/WORKING_MEMORY.md;tail:HANDOFF_LOG.md;tail:/root/SYSTEM_SETUP_WORKING_MEMORY.md;tail:/root/HANDOFF_LOG.md"
RELAY_CONTEXT_MAX_CHARS=40000
RELAY_CONTEXT_MAX_CHARS_PER_FILE=20000
```

Tips:

- `/status` shows `context_bootstrap` state and current session context version.
- `/context` prints resolved context specs, file status, and estimated injected chars for the current workdir.
- `/context reload` forces one-time context re-injection on the next user message without resetting the agent session.
- After changing `RELAY_CONTEXT_FILE`, either bump `RELAY_CONTEXT_VERSION`, run `/context reload`, or run `/reset`.

## Progress Message Tuning

These `.env` variables control intermediate status edits in Discord:

- `RELAY_PROGRESS=true|false`
- `RELAY_PROGRESS_MIN_EDIT_MS` (default `5000`)
- `RELAY_PROGRESS_HEARTBEAT_MS` (default `20000`)
- `RELAY_PROGRESS_MAX_LINES` (default `6`)
- `RELAY_PROGRESS_SHOW_COMMANDS=false` (recommended; avoid leaking sensitive command text)
- `RELAY_PROGRESS_PERSISTENT_ENABLED=true|false` (default `false`; post throttled persistent milestone updates)
- `RELAY_PROGRESS_PERSISTENT_EVERY_MS=<int>` (default `45000`; min interval between persistent updates)
- `RELAY_PROGRESS_PERSISTENT_ORCHESTRATOR_EVERY_MS=<int>` (default `15000`; min interval between durable orchestrator updates)
- `RELAY_PROGRESS_PERSISTENT_MAX_PER_RUN=<int>` (default `6`)
- `RELAY_PROGRESS_PERSISTENT_ADAPTIVE_ENABLED=true|false` (default `false`; scale persistent intervals up as runtime grows)
- `RELAY_PROGRESS_PERSISTENT_ADAPTIVE_RAMP_EVERY_MS=<int>` (default `60000`; interval grows by one step each ramp window)
- `RELAY_PROGRESS_PERSISTENT_ADAPTIVE_MAX_SCALE=<int>` (default `8`; cap for adaptive interval multiplier)
- `RELAY_PROGRESS_PERSISTENT_SUPPRESS_SYSTEM_MILESTONES=true|false` (default `true`; hide system checkpoint milestones like queued/waiting/start/context to reduce interleaving with assistant replies)
- `RELAY_PROGRESS_PERSISTENT_MODE=all|narrative|narrative+milestones|narrative+milestones+orchestrator|off` (default `all`; `narrative` suppresses low-signal command/tool trace lines; `narrative+milestones` also posts explicit relay checkpoint summaries; `narrative+milestones+orchestrator` additionally persists "Thinking: ..." style orchestration notes)
- `RELAY_PROGRESS_PERSISTENT_MIN_CHARS=<int>` (default `32`; narrative mode drops very short notes)
- `RELAY_PROGRESS_PERSISTENT_MAX_CHARS=<int>` (default `320`; cap each durable progress note)
- `RELAY_PROGRESS_TRACE_ENABLED=true|false` (default `false`; emit `agent.progress.note` telemetry to relay log)
- `RELAY_PROGRESS_TRACE_INCLUDE_SYNTHETIC=true|false` (default `false`; include synthetic stall warnings)
- `RELAY_PROGRESS_TRACE_MAX_CHARS=<int>` (default `220`)

When persistent milestones are enabled, relay keeps the existing edited "Running ..." status message for fine-grained live detail and also posts occasional durable updates like `Progress update (2m10s): ...` so the thread retains high-signal breadcrumbs.

Recommended for selective persistence in Discord threads:
- set `RELAY_PROGRESS_PERSISTENT_ENABLED=true`
- set `RELAY_PROGRESS_PERSISTENT_MODE=narrative+milestones+orchestrator`
- tune `RELAY_PROGRESS_PERSISTENT_ORCHESTRATOR_EVERY_MS` (e.g., `15000` to `30000`)
- optionally enable runtime scaling with `RELAY_PROGRESS_PERSISTENT_ADAPTIVE_ENABLED=true`
- keep `RELAY_PROGRESS_SHOW_COMMANDS=true|false` based on your transient debug preference

This keeps low-level `run/explore/command` traces in the transient edited status message while preserving a clean durable timeline of narrative updates plus explicit milestones (for example, `Milestone: context loaded`, `Milestone: run started`, `Milestone: ready to summarize`) and orchestrator commentary updates (for example, `Orchestrator: I'm checking runtime state next`).

## Run Workflow Profiling

Use the built-in profiler to quantify where long runs spend time (thinking vs action vs polling vs stall) and get optimization hints:

```bash
python3 /root/VibeResearch_toolkit/scripts/profile_relay_runs.py \
  --conversation-key "discord:1472061022239195304:thread:1472525033799942216" \
  --since-minutes 720 \
  --limit-runs 20
```

JSON mode for automation:

```bash
python3 /root/VibeResearch_toolkit/scripts/profile_relay_runs.py --json > /tmp/relay_profile.json
```

Notes:
- Fine-grained category breakdown needs progress-note telemetry (`RELAY_PROGRESS_TRACE_ENABLED=true` + relay restart).
- Without progress tracing, the profiler still reports run durations/queue delay and flags missing trace coverage.
- Repeated polling patterns (for example, repeated `tail -n` loops) are explicitly detected and surfaced as optimization hints.

## Troubleshooting Stalls

```bash
# 1) Is relay alive?
codex-discord-relay-multictl list

# 2) Are Codex child jobs stuck? (Codex mode only)
pgrep -af "codex .*exec" || true

# 3) Check relay logs
tail -n 200 /root/.codex-discord-relay/relay.log
```

Frequent causes:

- Proxy/network issues: `ETIMEDOUT ...:443` in relay log.
- Old Node runtime: `Cannot find module 'node:fs'` or `node:fs/promises`.
- Hung Codex child run (Codex mode) blocks that conversation queue until process exits or relay restarts.
- `codex-discord-relay-multictl restart` can be intentionally blocked by the drain guard if active runs are present in state; wait for completion or use `/reset`/cancel flow before retrying restart.
- Timeout too low for long prompts: if you see `codex timeout ...` or `claude timeout ...`, increase `RELAY_AGENT_TIMEOUT_MS`.
- Intermittent VPN/proxy/API issues can surface as `codex exit 1` with sparse detail; keep transient retry enabled and inspect relay status summaries for "likely transient connectivity/proxy issue".

## Provider Quota/Billing Incidents (OpenClaw Monitoring)

If OpenClaw monitoring requests fail with provider errors (for example `402 Insufficient Balance` on `deepseek/deepseek-chat` or `429 RESOURCE_EXHAUSTED` on Gemini), treat this as an upstream model availability problem, not a relay crash.

Recommended operator response:

1. Send a status handoff message to OpenClaw with exact failure mode and desired behavior.
2. Instruct OpenClaw to continue monitoring using a fallback provider/model.
3. If all providers are blocked, ask OpenClaw to stop launching new monitor actions and post a single blocked status.

Copy/paste status handoff template:

```text
Status update for monitor:
- Current issue: provider error while handling monitor request.
- Primary model: deepseek/deepseek-chat -> 402 Insufficient Balance.
- Fallback: switch to google/gemini-2.5-flash (or another funded provider) and continue.
- Monitor policy: keep tracking the active Codex experiment; post heartbeat every 10 minutes.
- Escalation policy: if all providers fail, stop issuing new jobs and report "blocked: provider quota/billing".
```

Optional temporary config override (OpenClaw side): set `agents.defaults.model.primary` to a funded provider and keep DeepSeek in `fallbacks` until balance is restored.
