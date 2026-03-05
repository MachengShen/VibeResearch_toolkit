#!/usr/bin/env node
"use strict";

const fsp = require("node:fs/promises");
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawn } = require("node:child_process");
const readline = require("node:readline");

const BUNDLED_STAGE0_SUPERVISOR_SCRIPT = path.join(__dirname, "scripts", "stage0_smoke_gate.py");

function resolveDiscordProxyUrl() {
  // Prefer explicit Discord proxy env, then fall back to conventional proxy env vars.
  const candidates = [
    process.env.DISCORD_GATEWAY_PROXY,
    process.env.DISCORD_PROXY_URL,
    process.env.HTTPS_PROXY,
    process.env.HTTP_PROXY,
    process.env.ALL_PROXY,
    process.env.OPENCLAW_PROXY_URL,
  ];
  for (const raw of candidates) {
    const v = (raw || "").trim();
    if (v) return v;
  }
  return null;
}

function installWsProxyIfConfigured(proxyUrl) {
  if (!proxyUrl) return;
  try {
    const { HttpsProxyAgent } = require("https-proxy-agent");
    const ws = require("ws");

    const Original = ws.WebSocket || ws;
    const agent = new HttpsProxyAgent(proxyUrl);

    class ProxiedWebSocket extends Original {
      constructor(address, protocols, options) {
        const opts = options ? { ...options } : {};
        if (!opts.agent) opts.agent = agent;
        super(address, protocols, opts);
      }
    }

    // @discordjs/ws imports `ws` and captures `WebSocket` at module init, so this must
    // run before requiring discord.js.
    ws.WebSocket = ProxiedWebSocket;
  } catch (err) {
    // Don't hard-fail: the relay can still run in environments where Discord isn't blocked.
    console.error(`Failed to install WebSocket proxy (${proxyUrl}): ${String(err.message || err)}`);
  }
}

function buildRestAgentIfConfigured(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    const { ProxyAgent } = require("undici");
    return new ProxyAgent(proxyUrl);
  } catch (err) {
    console.error(`Failed to configure REST proxy (${proxyUrl}): ${String(err.message || err)}`);
    return null;
  }
}

const DISCORD_PROXY_URL = resolveDiscordProxyUrl();
installWsProxyIfConfigured(DISCORD_PROXY_URL);

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const DISCORD_REST_AGENT = buildRestAgentIfConfigured(DISCORD_PROXY_URL);

function parseCsv(value) {
  if (!value) return new Set();
  return new Set(
    value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function parseSemiList(value) {
  if (!value) return [];
  return String(value)
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function parseWaitPatternGuardMode(raw) {
  const mode = String(raw || "warn").trim().toLowerCase();
  if (mode === "off" || mode === "warn" || mode === "reject") return mode;
  return "warn";
}

function parseProgressPersistentMode(raw) {
  const mode = String(raw || "all").trim().toLowerCase();
  if (
    mode === "all" ||
    mode === "narrative" ||
    mode === "off" ||
    mode === "narrative+milestones" ||
    mode === "narrative+milestones+orchestrator"
  ) {
    return mode;
  }
  if (
    mode === "narrative+milestones" ||
    mode === "narrative-milestones" ||
    mode === "narrative_milestones" ||
    mode === "milestones"
  ) {
    return "narrative+milestones";
  }
  if (
    mode === "narrative+milestones+orchestrator" ||
    mode === "narrative-milestones-orchestrator" ||
    mode === "narrative_milestones_orchestrator" ||
    mode === "narrative+orchestrator" ||
    mode === "narrative-orchestrator" ||
    mode === "narrative_orchestrator" ||
    mode === "orchestrator"
  ) {
    return "narrative+milestones+orchestrator";
  }
  return "all";
}

function parseSupervisorExpectedStatus(raw) {
  const v = String(raw || "success").trim().toLowerCase();
  return v || "success";
}

function parseContextSpecEntry(rawEntry) {
  const raw = String(rawEntry || "").trim();
  if (!raw) return null;
  const match = raw.match(/^(headtail|head|tail):(.*)$/i);
  if (!match) {
    return { mode: "head", specPath: raw, rawSpec: raw };
  }
  const specPath = String(match[2] || "").trim();
  if (!specPath) return null;
  return {
    mode: String(match[1] || "head").toLowerCase(),
    specPath,
    rawSpec: raw,
  };
}

function parseContextSpecs(rawValue) {
  const raw = String(rawValue || "");
  if (!raw.trim()) return [];
  return raw
    .split(";")
    .map((entry) => parseContextSpecEntry(entry))
    .filter((entry) => Boolean(entry));
}

function parseToolList(value) {
  if (!value) return [];
  return String(value)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseExtCsv(value, fallback = []) {
  const source = String(value || "").trim();
  const tokens = source
    ? source
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : Array.isArray(fallback)
    ? fallback
    : [];
  const out = new Set();
  for (const raw of tokens) {
    const lower = String(raw || "").trim().toLowerCase();
    if (!lower) continue;
    out.add(lower.startsWith(".") ? lower : `.${lower}`);
  }
  return Array.from(out);
}

function buildChildProcessEnv(extraEnv) {
  const env = { ...process.env };

  // Prevent nested Claude CLI launches when relay itself was started from within
  // a Claude Code session (for example after an in-chat restart).
  delete env.CLAUDECODE;
  for (const k of Object.keys(env)) {
    if (k.startsWith("CLAUDECODE_")) delete env[k];
  }

  if (extraEnv && typeof extraEnv === "object") {
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v == null) {
        delete env[k];
      } else {
        env[k] = String(v);
      }
    }
  }
  return env;
}

function normalizeAgentProvider(value) {
  const v = String(value || "codex").trim().toLowerCase();
  return v === "claude" ? "claude" : "codex";
}

function resolveClaudePermissionMode() {
  const explicit = (process.env.CLAUDE_PERMISSION_MODE || "").trim();
  if (explicit) return explicit;
  // Claude's "bypassPermissions" mode maps to a dangerous flag that is blocked under root.
  // Default to acceptEdits when relay runs as root to avoid silent hangs/failures.
  if (typeof process.getuid === "function" && process.getuid() === 0) return "acceptEdits";
  return "";
}

const ALLOWED_GUILDS = parseCsv(process.env.DISCORD_ALLOWED_GUILDS || "");
const ALLOWED_CHANNELS = parseCsv(process.env.DISCORD_ALLOWED_CHANNELS || "");

const RELAY_STATE_DIR = path.resolve(process.env.RELAY_STATE_DIR || "/root/.codex-discord-relay");
const RELAY_STATE_FILE = path.resolve(
  process.env.RELAY_STATE_FILE || path.join(RELAY_STATE_DIR, "sessions.json")
);
const RELAY_UPLOAD_ROOT_DIR = path.resolve(
  process.env.RELAY_UPLOAD_ROOT_DIR || path.join(RELAY_STATE_DIR, "uploads")
);

const CODEX_ALLOWED_WORKDIR_ROOTS = (() => {
  const roots = parseCsv(process.env.CODEX_ALLOWED_WORKDIR_ROOTS || "/root");
  return Array.from(roots).map((root) => path.resolve(root));
})();

const RAW_RELAY_WORKTREE_ROOT_DIR = (process.env.RELAY_WORKTREE_ROOT_DIR || "").trim();
const RELAY_WORKTREE_ROOT_DIR = path.resolve(
  RAW_RELAY_WORKTREE_ROOT_DIR || path.join(RELAY_STATE_DIR, "worktrees")
);
const RELAY_WORKTREE_ROOT_DIR_ERROR = (() => {
  if (RAW_RELAY_WORKTREE_ROOT_DIR && !path.isAbsolute(RAW_RELAY_WORKTREE_ROOT_DIR)) {
    return "RELAY_WORKTREE_ROOT_DIR must be an absolute path";
  }
  const allowed = CODEX_ALLOWED_WORKDIR_ROOTS.some((root) => {
    const relative = path.relative(root, RELAY_WORKTREE_ROOT_DIR);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
  if (!allowed) {
    return `RELAY_WORKTREE_ROOT_DIR is outside CODEX_ALLOWED_WORKDIR_ROOTS (${CODEX_ALLOWED_WORKDIR_ROOTS.join(", ")})`;
  }
  return "";
})();

const RAW_RELAY_RESEARCH_PROJECTS_ROOT = (process.env.RELAY_RESEARCH_PROJECTS_ROOT || "").trim();
const RELAY_RESEARCH_PROJECTS_ROOT = path.resolve(
  RAW_RELAY_RESEARCH_PROJECTS_ROOT || path.join(RELAY_STATE_DIR, "projects")
);
const RELAY_RESEARCH_PROJECTS_ROOT_ERROR = (() => {
  if (RAW_RELAY_RESEARCH_PROJECTS_ROOT && !path.isAbsolute(RAW_RELAY_RESEARCH_PROJECTS_ROOT)) {
    return "RELAY_RESEARCH_PROJECTS_ROOT must be an absolute path";
  }
  const allowed = CODEX_ALLOWED_WORKDIR_ROOTS.some((root) => {
    const relative = path.relative(root, RELAY_RESEARCH_PROJECTS_ROOT);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
  if (!allowed) {
    return `RELAY_RESEARCH_PROJECTS_ROOT is outside CODEX_ALLOWED_WORKDIR_ROOTS (${CODEX_ALLOWED_WORKDIR_ROOTS.join(", ")})`;
  }
  return "";
})();

const CONFIG = {
  token: (process.env.DISCORD_BOT_TOKEN || "").trim(),
  agentProvider: normalizeAgentProvider(process.env.RELAY_AGENT_PROVIDER || process.env.AGENT_PROVIDER),
  codexBin: (process.env.CODEX_BIN || "codex").trim(),
  claudeBin: (process.env.CLAUDE_BIN || "claude").trim(),
  defaultWorkdir: path.resolve(process.env.CODEX_WORKDIR || "/root"),
  allowedWorkdirRoots: CODEX_ALLOWED_WORKDIR_ROOTS,
  model: (process.env.CODEX_MODEL || "").trim(),
  claudeModel: (process.env.CLAUDE_MODEL || process.env.CODEX_MODEL || "").trim(),
  claudeModelLight: (process.env.CLAUDE_MODEL_LIGHT || process.env.CLAUDE_MODEL || process.env.CODEX_MODEL || "").trim(),
  claudeModelHeavy: (process.env.CLAUDE_MODEL_HEAVY || process.env.CLAUDE_MODEL_OPUS || "").trim(),
  claudeModelRouting: boolEnv("CLAUDE_MODEL_ROUTING", true),
  claudeModelQuotaFallback: boolEnv("CLAUDE_MODEL_QUOTA_FALLBACK", true),
  claudePermissionMode: resolveClaudePermissionMode(),
  claudeAllowedTools: parseToolList(process.env.CLAUDE_ALLOWED_TOOLS || ""),
  agentTimeoutMs: Math.max(0, intEnv("RELAY_AGENT_TIMEOUT_MS", 10 * 60 * 1000)),
  codexTransientRetryEnabled: boolEnv("RELAY_CODEX_TRANSIENT_RETRY_ENABLED", true),
  codexTransientRetryMax: Math.max(0, Math.min(3, intEnv("RELAY_CODEX_TRANSIENT_RETRY_MAX", 1))),
  sandbox: (process.env.CODEX_SANDBOX || "workspace-write").trim(),
  approvalPolicy: (
    process.env.CODEX_APPROVAL_POLICY ||
    process.env.CODEX_APPROVAL ||
    ""
  ).trim(),
  enableSearch: boolEnv("CODEX_ENABLE_SEARCH", true),
  skipGitRepoCheck: boolEnv("CODEX_SKIP_GIT_REPO_CHECK", true),
  configOverrides: (process.env.CODEX_CONFIG_OVERRIDES || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean),
  stateDir: RELAY_STATE_DIR,
  stateFile: RELAY_STATE_FILE,
  maxReplyChars: Number(process.env.RELAY_MAX_REPLY_CHARS || 1800),
  allowAttachInGuilds: boolEnv("RELAY_ATTACH_ALLOW_GUILDS", false),
  allowedGuilds: ALLOWED_GUILDS,
  allowedChannels: ALLOWED_CHANNELS,
  // In threads, it's usually a 1:1 working context. Default to auto-responding there when
  // the relay is already restricted via DISCORD_ALLOWED_CHANNELS; otherwise keep mention-gating.
  threadAutoRespond: boolEnv("RELAY_THREAD_AUTO_RESPOND", ALLOWED_CHANNELS.size > 0),

  uploadEnabled: boolEnv("RELAY_UPLOAD_ENABLED", true),
  uploadRootDir: RELAY_UPLOAD_ROOT_DIR,
  uploadAllowOutsideConversation: boolEnv("RELAY_UPLOAD_ALLOW_OUTSIDE_CONVERSATION", false),
  uploadAllowedRoots: (() => {
    const raw = process.env.RELAY_UPLOAD_ALLOWED_ROOTS;
    const roots = raw == null || raw.trim() === "" ? new Set([RELAY_UPLOAD_ROOT_DIR]) : parseCsv(raw);
    return Array.from(roots).map((root) => path.resolve(root));
  })(),
  uploadMaxFiles: Math.max(0, intEnv("RELAY_UPLOAD_MAX_FILES", 3)),
  uploadMaxBytes: Math.max(0, intEnv("RELAY_UPLOAD_MAX_BYTES", 8 * 1024 * 1024)),

  discordAttachmentsEnabled: boolEnv("RELAY_DISCORD_ATTACHMENTS_ENABLED", true),
  discordAttachmentsMaxFiles: Math.max(0, intEnv("RELAY_DISCORD_ATTACHMENTS_MAX_FILES", 3)),
  discordAttachmentsMaxBytes: Math.max(0, intEnv("RELAY_DISCORD_ATTACHMENTS_MAX_BYTES", 256 * 1024)),
  discordAttachmentsMaxChars: Math.max(200, intEnv("RELAY_DISCORD_ATTACHMENTS_MAX_CHARS", 20000)),
  discordAttachmentsMaxCharsPerFile: Math.max(
    200,
    intEnv("RELAY_DISCORD_ATTACHMENTS_MAX_CHARS_PER_FILE", 8000)
  ),
  discordAttachmentsDownloadTimeoutMs: Math.max(
    1000,
    intEnv("RELAY_DISCORD_ATTACHMENTS_DOWNLOAD_TIMEOUT_MS", 15000)
  ),
  discordAttachmentsZipEnabled: boolEnv("RELAY_DISCORD_ATTACHMENTS_ZIP_ENABLED", false),
  discordAttachmentsZipMaxEntries: Math.max(
    1,
    intEnv("RELAY_DISCORD_ATTACHMENTS_ZIP_MAX_ENTRIES", 10)
  ),
  discordAttachmentsZipMaxBytes: Math.max(
    0,
    intEnv("RELAY_DISCORD_ATTACHMENTS_ZIP_MAX_BYTES", 8 * 1024 * 1024)
  ),
  discordAttachmentsZipMaxEntryBytes: Math.max(
    1024,
    intEnv("RELAY_DISCORD_ATTACHMENTS_ZIP_MAX_ENTRY_BYTES", 128 * 1024)
  ),
  discordAttachmentsZipMaxCharsPerEntry: Math.max(
    200,
    intEnv("RELAY_DISCORD_ATTACHMENTS_ZIP_MAX_CHARS_PER_ENTRY", 4000)
  ),
  discordAttachmentsZipExtractTimeoutMs: Math.max(
    1000,
    intEnv("RELAY_DISCORD_ATTACHMENTS_ZIP_EXTRACT_TIMEOUT_MS", 20000)
  ),
  discordAttachmentsZipAllowedExts: parseExtCsv(
    process.env.RELAY_DISCORD_ATTACHMENTS_ZIP_ALLOWED_EXTS,
    [
      ".txt",
      ".md",
      ".markdown",
      ".json",
      ".yaml",
      ".yml",
      ".toml",
      ".csv",
      ".tsv",
      ".log",
      ".env",
      ".ini",
      ".cfg",
      ".conf",
      ".xml",
      ".html",
      ".css",
      ".js",
      ".ts",
      ".py",
      ".sh",
      ".bash",
      ".zsh",
      ".patch",
      ".diff",
      ".rst",
      ".sql",
      ".proto",
      ".properties",
      ".ps1",
      ".bat",
      ".cmd",
      ".dockerfile",
      ".gitignore",
    ]
  ),

  contextEnabled: boolEnv("RELAY_CONTEXT_ENABLED", true),
  contextEveryTurn: boolEnv("RELAY_CONTEXT_EVERY_TURN", false),
  contextVersion: Math.max(1, intEnv("RELAY_CONTEXT_VERSION", 1)),
  contextMaxChars: Math.max(200, intEnv("RELAY_CONTEXT_MAX_CHARS", 40000)),
  contextMaxCharsPerFile: Math.max(
    200,
    intEnv("RELAY_CONTEXT_MAX_CHARS_PER_FILE", intEnv("RELAY_CONTEXT_MAX_CHARS", 40000))
  ),
  contextSpecs: parseContextSpecs(process.env.RELAY_CONTEXT_FILE || ""),

  tasksEnabled: boolEnv("RELAY_TASKS_ENABLED", true),
  tasksMaxPending: Math.max(1, intEnv("RELAY_TASKS_MAX_PENDING", 50)),
  maxJobCommandChars: Math.max(4000, intEnv("RELAY_MAX_JOB_COMMAND_CHARS", 12000)),
  tasksStopOnError: boolEnv("RELAY_TASKS_STOP_ON_ERROR", false),
  tasksPostFullOutput: boolEnv("RELAY_TASKS_POST_FULL_OUTPUT", true),
  tasksSummaryAfterRun: boolEnv("RELAY_TASKS_SUMMARY_AFTER_RUN", true),
  goAutoWrapLongTasks: boolEnv("RELAY_GO_AUTOWRAP_LONG_TASKS", true),
  goLongTaskWatchEverySec: Math.max(5, intEnv("RELAY_GO_LONG_TASK_WATCH_EVERY_SEC", 300)),
  goLongTaskTailLines: Math.max(10, intEnv("RELAY_GO_LONG_TASK_TAIL_LINES", 30)),
  jobsWatchCompact: boolEnv("RELAY_JOBS_WATCH_COMPACT", true),
  jobsWatchPostNoChange: boolEnv("RELAY_JOBS_WATCH_POST_NO_CHANGE", false),
  jobsWatchIncludeTailOnChange: boolEnv("RELAY_JOBS_WATCH_INCLUDE_TAIL_ON_CHANGE", false),
  jobsWatchIncludeTailOnFinish: boolEnv("RELAY_JOBS_WATCH_INCLUDE_TAIL_ON_FINISH", false),
  jobsWatchCompactTailLines: Math.max(1, intEnv("RELAY_JOBS_WATCH_COMPACT_TAIL_LINES", 3)),
  jobsWatchCompactTailMaxChars: Math.max(80, intEnv("RELAY_JOBS_WATCH_COMPACT_TAIL_MAX_CHARS", 600)),
  watchRequireFilesEnabled: boolEnv("RELAY_WATCH_REQUIRE_FILES_ENABLED", false),
  watchRequireFilesDefaultTimeoutSec: Math.max(10, intEnv("RELAY_WATCH_REQUIRE_FILES_DEFAULT_TIMEOUT_SEC", 900)),
  watchRequireFilesDefaultPollSec: Math.max(1, intEnv("RELAY_WATCH_REQUIRE_FILES_DEFAULT_POLL_SEC", 15)),
  supervisorPhase1Enabled: boolEnv("RELAY_SUPERVISOR_PHASE1_ENABLED", false),
  supervisorPhase1DefaultScript:
    String(process.env.RELAY_SUPERVISOR_PHASE1_DEFAULT_SCRIPT || BUNDLED_STAGE0_SUPERVISOR_SCRIPT).trim() ||
    BUNDLED_STAGE0_SUPERVISOR_SCRIPT,
  supervisorPhase1DefaultExpectStatus: parseSupervisorExpectedStatus(
    process.env.RELAY_SUPERVISOR_PHASE1_DEFAULT_EXPECT_STATUS || "success"
  ),
  supervisorPhase1DefaultReadyTimeoutSec: Math.max(
    10,
    intEnv("RELAY_SUPERVISOR_PHASE1_DEFAULT_READY_TIMEOUT_SEC", 900)
  ),
  supervisorPhase1DefaultReadyPollSec: Math.max(1, intEnv("RELAY_SUPERVISOR_PHASE1_DEFAULT_READY_POLL_SEC", 15)),
  jobPreflightEnabled: boolEnv("RELAY_JOB_PREFLIGHT_ENABLED", false),
  waitPatternGuardMode: parseWaitPatternGuardMode(process.env.RELAY_WAIT_PATTERN_GUARD_MODE || "warn"),
  visibilityGateEnabled: boolEnv("RELAY_VISIBILITY_GATE_ENABLED", false),
  visibilityStartupHeartbeatSec: Math.max(10, intEnv("RELAY_VISIBILITY_STARTUP_HEARTBEAT_SEC", 60)),
  visibilityHeartbeatEverySec: Math.max(30, intEnv("RELAY_VISIBILITY_HEARTBEAT_EVERY_SEC", 600)),
  watchStaleGuardEnabled: boolEnv("RELAY_WATCH_STALE_GUARD_ENABLED", true),
  watchStaleMinutes: Math.max(1, intEnv("RELAY_WATCH_STALE_MINUTES", 15)),
  watchStaleAlertEveryMinutes: Math.max(1, intEnv("RELAY_WATCH_STALE_ALERT_EVERY_MINUTES", 30)),
  watchStaleCpuLowPct: Math.max(0, Math.min(5000, intEnv("RELAY_WATCH_STALE_CPU_LOW_PCT", 20))),
  watchStaleGpuLowPct: Math.max(0, Math.min(100, intEnv("RELAY_WATCH_STALE_GPU_LOW_PCT", 20))),

  worktreeRootDir: RELAY_WORKTREE_ROOT_DIR,
  worktreeRootDirError: RELAY_WORKTREE_ROOT_DIR_ERROR,

  researchEnabled: boolEnv("RELAY_RESEARCH_ENABLED", false),
  researchDmOnly: boolEnv("RELAY_RESEARCH_DM_ONLY", true),
  researchProjectsRoot: RELAY_RESEARCH_PROJECTS_ROOT,
  researchProjectsRootError: RELAY_RESEARCH_PROJECTS_ROOT_ERROR,
  researchDefaultMaxSteps: Math.max(1, intEnv("RELAY_RESEARCH_DEFAULT_MAX_STEPS", 50)),
  researchDefaultMaxWallclockMin: Math.max(1, intEnv("RELAY_RESEARCH_DEFAULT_MAX_WALLCLOCK_MIN", 480)),
  researchDefaultMaxRuns: Math.max(1, intEnv("RELAY_RESEARCH_DEFAULT_MAX_RUNS", 30)),
  researchTickSec: Math.max(5, intEnv("RELAY_RESEARCH_TICK_SEC", 30)),
  researchTickMaxParallel: Math.max(1, intEnv("RELAY_RESEARCH_TICK_MAX_PARALLEL", 2)),
  researchActionsAllowed: (() => {
    const raw = String(process.env.RELAY_RESEARCH_ACTIONS_ALLOWED || "").trim();
    const list = raw
      ? parseToolList(raw)
      : ["job_start", "job_watch", "job_stop", "task_add", "task_run", "write_report", "research_pause", "research_mark_done"];
    return new Set(list.map((s) => String(s || "").trim().toLowerCase()).filter(Boolean));
  })(),
  researchMaxActionsPerStep: Math.max(1, intEnv("RELAY_RESEARCH_MAX_ACTIONS_PER_STEP", 12)),
  researchRequireNotePrefix: boolEnv("RELAY_RESEARCH_REQUIRE_NOTE_PREFIX", false),
  researchLeaseTtlSec: Math.max(15, intEnv("RELAY_RESEARCH_LEASE_TTL_SEC", 300)),
  researchInflightTtlSec: Math.max(60, intEnv("RELAY_RESEARCH_INFLIGHT_TTL_SEC", 900)),
  researchPostOnApplied: boolEnv("RELAY_RESEARCH_POST_ON_APPLIED", true),
  researchPostOnBlocked: boolEnv("RELAY_RESEARCH_POST_ON_BLOCKED", true),
  researchPostEverySteps: Math.max(1, intEnv("RELAY_RESEARCH_POST_EVERY_STEPS", 5)),

  plansEnabled: boolEnv("RELAY_PLANS_ENABLED", true),
  plansMaxHistory: Math.max(1, intEnv("RELAY_PLANS_MAX_HISTORY", 20)),
  planApplyRequireConfirmInGuilds: boolEnv("RELAY_PLAN_APPLY_REQUIRE_CONFIRM_IN_GUILDS", true),

  handoffEnabled: boolEnv("RELAY_HANDOFF_ENABLED", true),
  handoffAutoEnabled: boolEnv("RELAY_HANDOFF_AUTO_ENABLED", false),
  handoffAutoAfterTaskRun: (() => {
    if (process.env.RELAY_AUTO_HANDOFF_AFTER_TASK_RUN != null) {
      return boolEnv("RELAY_AUTO_HANDOFF_AFTER_TASK_RUN", false);
    }
    return boolEnv("RELAY_HANDOFF_AUTO_ENABLED", false);
  })(),
  handoffAutoAfterEachTask: boolEnv("RELAY_AUTO_HANDOFF_AFTER_EACH_TASK", false),
  handoffAutoAfterPlanApply: (() => {
    if (process.env.RELAY_AUTO_HANDOFF_AFTER_PLAN_APPLY != null) {
      return boolEnv("RELAY_AUTO_HANDOFF_AFTER_PLAN_APPLY", false);
    }
    return boolEnv("RELAY_HANDOFF_AUTO_ENABLED", false);
  })(),
  handoffFiles: (() => {
    const raw = (process.env.RELAY_HANDOFF_FILES || "").trim();
    const files = raw ? parseSemiList(raw) : ["HANDOFF_LOG.md", "docs/WORKING_MEMORY.md"];
    return files.map((p) => String(p || "").trim()).filter(Boolean);
  })(),
  handoffGitAutoCommit: boolEnv("RELAY_HANDOFF_GIT_AUTO_COMMIT", false),
  handoffGitAutoPush: boolEnv("RELAY_HANDOFF_GIT_AUTO_PUSH", false),
  handoffGitCommitMessage: (process.env.RELAY_HANDOFF_GIT_COMMIT_MESSAGE || "chore: relay handoff").trim(),

  gitAutoCommitEnabled: boolEnv("RELAY_GIT_AUTO_COMMIT", false),
  gitAutoCommitScope: (process.env.RELAY_GIT_AUTO_COMMIT_SCOPE || "both").trim().toLowerCase(),
  gitCommitPrefix: (process.env.RELAY_GIT_COMMIT_PREFIX || "ai:").trim() || "ai:",

  // Agent-requested relay actions (disabled by default; enable explicitly).
  // These are high-powered primitives intended for trusted environments.
  agentActionsEnabled: boolEnv("RELAY_AGENT_ACTIONS_ENABLED", false),
  agentActionsDmOnly: boolEnv("RELAY_AGENT_ACTIONS_DM_ONLY", true),
  agentActionsAllowed: (() => {
    const raw = String(process.env.RELAY_AGENT_ACTIONS_ALLOWED || "").trim();
    const list = raw ? parseToolList(raw) : ["job_start", "job_stop", "job_watch"];
    return new Set(list.map((s) => String(s || "").trim().toLowerCase()).filter(Boolean));
  })(),
  agentActionsMaxPerMessage: Math.max(0, intEnv("RELAY_AGENT_ACTIONS_MAX_PER_MESSAGE", 1)),

  // Job auto-watch defaults (only relevant when agent actions are enabled).
  jobsAutoWatch: (() => {
    const fallback = boolEnv("RELAY_AGENT_ACTIONS_ENABLED", false);
    return boolEnv("RELAY_JOBS_AUTO_WATCH", fallback);
  })(),
  jobsAutoWatchEverySec: Math.max(1, intEnv("RELAY_JOBS_AUTO_WATCH_EVERY_SEC", 300)),
  jobsAutoWatchTailLines: Math.max(1, intEnv("RELAY_JOBS_AUTO_WATCH_TAIL_LINES", 30)),
  jobsThenTaskDefaultRunTasks: boolEnv("RELAY_JOBS_THEN_TASK_DEFAULT_RUN_TASKS", false),
  expCommandsEnabled: boolEnv("RELAY_EXP_COMMANDS_ENABLED", true),
  expAllowGuilds: boolEnv("RELAY_EXP_ALLOW_GUILDS", true),
  expDefaultReadyTimeoutSec: Math.max(10, intEnv("RELAY_EXP_DEFAULT_READY_TIMEOUT_SEC", 900)),
  expDefaultReadyPollSec: Math.max(1, intEnv("RELAY_EXP_DEFAULT_READY_POLL_SEC", 15)),
  expExperienceLoggingEnabled: boolEnv("RELAY_EXP_EXPERIENCE_LOGGING_ENABLED", true),
  expWatchSnapshotsEnabled: boolEnv("RELAY_EXP_WATCH_SNAPSHOTS_ENABLED", false),
  expWatchSnapshotEverySec: Math.max(30, intEnv("RELAY_EXP_WATCH_SNAPSHOT_EVERY_SEC", 300)),
  expWatchSnapshotTailLines: Math.max(10, intEnv("RELAY_EXP_WATCH_SNAPSHOT_TAIL_LINES", 80)),

  progressEnabled: boolEnv("RELAY_PROGRESS", true),
  progressMinEditMs: Math.max(500, intEnv("RELAY_PROGRESS_MIN_EDIT_MS", 5000)),
  progressHeartbeatMs: Math.max(1000, intEnv("RELAY_PROGRESS_HEARTBEAT_MS", 20000)),
  progressMaxLines: Math.max(1, intEnv("RELAY_PROGRESS_MAX_LINES", 6)),
  progressShowCommands: boolEnv("RELAY_PROGRESS_SHOW_COMMANDS", false),
  progressStallWarnMs: Math.max(0, intEnv("RELAY_PROGRESS_STALL_WARN_MS", 120000)),
  progressEditTimeoutMs: Math.max(1000, intEnv("RELAY_PROGRESS_EDIT_TIMEOUT_MS", 15000)),
  progressTraceEnabled: boolEnv("RELAY_PROGRESS_TRACE_ENABLED", false),
  progressTraceIncludeSynthetic: boolEnv("RELAY_PROGRESS_TRACE_INCLUDE_SYNTHETIC", false),
  progressTraceMaxChars: Math.max(60, intEnv("RELAY_PROGRESS_TRACE_MAX_CHARS", 220)),
  progressPersistentEnabled: boolEnv("RELAY_PROGRESS_PERSISTENT_ENABLED", false),
  progressPersistentEveryMs: Math.max(5000, intEnv("RELAY_PROGRESS_PERSISTENT_EVERY_MS", 45000)),
  progressPersistentMaxPerRun: Math.max(1, intEnv("RELAY_PROGRESS_PERSISTENT_MAX_PER_RUN", 6)),
  progressPersistentMode: parseProgressPersistentMode(process.env.RELAY_PROGRESS_PERSISTENT_MODE || "all"),
  progressPersistentOrchestratorEveryMs: Math.max(
    3000,
    intEnv("RELAY_PROGRESS_PERSISTENT_ORCHESTRATOR_EVERY_MS", 15000)
  ),
  progressPersistentAdaptiveEnabled: boolEnv("RELAY_PROGRESS_PERSISTENT_ADAPTIVE_ENABLED", false),
  progressPersistentAdaptiveRampEveryMs: Math.max(
    5000,
    intEnv("RELAY_PROGRESS_PERSISTENT_ADAPTIVE_RAMP_EVERY_MS", 60000)
  ),
  progressPersistentAdaptiveMaxScale: Math.max(
    1,
    intEnv("RELAY_PROGRESS_PERSISTENT_ADAPTIVE_MAX_SCALE", 8)
  ),
  progressPersistentMinChars: Math.max(1, intEnv("RELAY_PROGRESS_PERSISTENT_MIN_CHARS", 32)),
  progressPersistentMaxChars: Math.max(120, intEnv("RELAY_PROGRESS_PERSISTENT_MAX_CHARS", 320)),
  progressPersistentSuppressSystemMilestones: boolEnv(
    "RELAY_PROGRESS_PERSISTENT_SUPPRESS_SYSTEM_MILESTONES",
    true
  ),
  statusSummaryEnabled: boolEnv("RELAY_STATUS_SUMMARY", true),
  interruptQuestionsEnabled: boolEnv("RELAY_INTERRUPT_QUESTIONS_ENABLED", true),
  interruptQuestionsAuto: boolEnv("RELAY_INTERRUPT_QUESTIONS_AUTO", false),
  interruptQuestionsTimeoutMs: Math.max(15000, intEnv("RELAY_INTERRUPT_QUESTIONS_TIMEOUT_MS", 3 * 60 * 1000)),
  interruptQuestionsSnapshotMaxChars: Math.max(
    1000,
    intEnv("RELAY_INTERRUPT_QUESTIONS_SNAPSHOT_MAX_CHARS", 18000)
  ),
  interruptQuestionsSnapshotProgressLines: Math.max(
    1,
    intEnv("RELAY_INTERRUPT_QUESTIONS_SNAPSHOT_PROGRESS_LINES", 40)
  ),
  interruptQuestionsSnapshotLogMaxBytes: Math.max(
    4096,
    intEnv("RELAY_INTERRUPT_QUESTIONS_SNAPSHOT_LOG_MAX_BYTES", 2 * 1024 * 1024)
  ),
  interruptQuestionsSnapshotLogMaxChars: Math.max(
    1000,
    intEnv("RELAY_INTERRUPT_QUESTIONS_SNAPSHOT_LOG_MAX_CHARS", 12000)
  ),
  interruptQuestionsSandbox: (() => {
    const mode = String(process.env.RELAY_INTERRUPT_QUESTIONS_SANDBOX || "").trim();
    return mode || "read-only";
  })(),
};

const AGENT_LABEL = CONFIG.agentProvider === "claude" ? "Claude" : "Codex";
const AGENT_SESSION_LABEL = CONFIG.agentProvider === "claude" ? "session_id" : "thread_id";

if (
  CONFIG.agentProvider === "claude" &&
  !process.env.CLAUDE_PERMISSION_MODE &&
  CONFIG.claudePermissionMode === "acceptEdits"
) {
  console.warn(
    "CLAUDE_PERMISSION_MODE not set; defaulting to acceptEdits because relay is running as root."
  );
}

if (!CONFIG.token) {
  console.error("DISCORD_BOT_TOKEN is required.");
  process.exit(1);
}

if (!process.env.RELAY_UPLOAD_ROOT_DIR) process.env.RELAY_UPLOAD_ROOT_DIR = CONFIG.uploadRootDir;

function logRelayEvent(event, meta = {}) {
  try {
    console.log(
      JSON.stringify({
        subsystem: "relay-runtime",
        event,
        at: new Date().toISOString(),
        ...meta,
      })
    );
  } catch {
    try {
      console.log(`[relay-runtime] ${event}`);
    } catch {}
  }
}

const state = {
  version: 1,
  sessions: {},
};
let saveChain = Promise.resolve();
const queueByConversation = new Map();
const queueEpochByConversation = new Map();
const activeChildByConversation = new Map();
const interruptProgressByConversation = new Map();
const pausedChildStateByConversation = new Map();
const interruptQuestionInFlightByConversation = new Set();
const taskRunnerByConversation = new Map();
const jobWatchersByKey = new Map();
const researchStepByConversation = new Set();
const researchLastTickByConversation = new Map();
const interruptedAgentRunsAfterRestart = [];
let researchTickTimer = null;
let DISCORD_CLIENT = null;

function isSubPath(parentDir, childDir) {
  const relative = path.relative(parentDir, childDir);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isAllowedWorkdir(workdir) {
  return CONFIG.allowedWorkdirRoots.some((root) => isSubPath(root, workdir));
}

const TEXT_EXTS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".csv",
  ".tsv",
  ".log",
  ".env",
  ".ini",
  ".cfg",
  ".conf",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".ts",
  ".py",
  ".sh",
  ".bash",
  ".zsh",
  ".patch",
  ".diff",
]);

function safeUploadDirName(key) {
  return String(key || "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 180) || "unknown";
}

function getConversationUploadDir(conversationKey) {
  return path.join(CONFIG.uploadRootDir, safeUploadDirName(conversationKey));
}

function normalizeUploadRawPath(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  if (
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('"') && s.endsWith('"'))
  ) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/^file:\/\//i, "");
  s = s.replace(/^file:/i, "");
  return s.trim();
}

function resolveUploadPath(rawPath, baseDir) {
  const cleaned = normalizeUploadRawPath(rawPath);
  if (!cleaned) return null;
  if (path.isAbsolute(cleaned)) return path.resolve(cleaned);
  return path.resolve(baseDir, cleaned);
}

function isAllowedUploadPath(resolvedPath, conversationUploadDir) {
  if (CONFIG.uploadAllowOutsideConversation) {
    return CONFIG.uploadAllowedRoots.some((root) => isSubPath(root, resolvedPath));
  }
  return isSubPath(conversationUploadDir, resolvedPath);
}

function extractUploadMarkers(text) {
  const re = /\[\[upload:([^\]]+)\]\]/gi;
  const rawText = String(text || "");
  let out = "";
  let last = 0;
  const rawPaths = [];
  let m;
  while ((m = re.exec(rawText)) !== null) {
    out += rawText.slice(last, m.index);
    const raw = normalizeUploadRawPath(m[1] || "");
    if (raw) {
      rawPaths.push(raw);
      out += `[uploaded:${path.basename(raw)}]`;
    } else {
      out += m[0];
    }
    last = re.lastIndex;
  }
  out += rawText.slice(last);
  return { text: out, rawPaths };
}

function normalizeRelayActionWatch(rawWatch) {
  if (!rawWatch || typeof rawWatch !== "object" || Array.isArray(rawWatch)) {
    return { ok: true, watch: null };
  }
  const allowedKeys = new Set([
    "everySec",
    "tailLines",
    "thenTask",
    "thenTaskDescription",
    "runTasks",
    "requireFiles",
    "readyTimeoutSec",
    "readyPollSec",
    "onMissing",
    "long",
    "firstPostRegex",
  ]);
  for (const k of Object.keys(rawWatch)) {
    if (!allowedKeys.has(k)) {
      return { ok: false, error: `unknown watch field: ${k}`, watch: null };
    }
  }

  const everySecRaw = rawWatch.everySec;
  const tailLinesRaw = rawWatch.tailLines;
  const thenTaskRaw = rawWatch.thenTask;
  const thenTaskDescriptionRaw = rawWatch.thenTaskDescription;
  const runTasksRaw = rawWatch.runTasks;
  const requireFilesRaw = rawWatch.requireFiles;
  const readyTimeoutSecRaw = rawWatch.readyTimeoutSec;
  const readyPollSecRaw = rawWatch.readyPollSec;
  const onMissingRaw = rawWatch.onMissing;
  const longRaw = rawWatch.long;
  const firstPostRegexRaw = rawWatch.firstPostRegex;

  const everySec = everySecRaw == null ? null : Number(everySecRaw);
  const tailLines = tailLinesRaw == null ? null : Number(tailLinesRaw);
  const readyTimeoutSec = readyTimeoutSecRaw == null ? null : Number(readyTimeoutSecRaw);
  const readyPollSec = readyPollSecRaw == null ? null : Number(readyPollSecRaw);
  const onMissing = onMissingRaw == null ? null : String(onMissingRaw || "").trim().toLowerCase();

  const requireFilesList = Array.isArray(requireFilesRaw)
    ? requireFilesRaw
    : requireFilesRaw == null
    ? []
    : [requireFilesRaw];
  const normalizedRequireFiles = [];
  for (const item of requireFilesList) {
    const p = String(item || "").trim();
    if (!p) continue;
    normalizedRequireFiles.push(p.length > 600 ? p.slice(0, 600) : p);
    if (normalizedRequireFiles.length >= 32) break;
  }
  const onMissingNorm = onMissing === "enqueue" ? "enqueue" : onMissing === "block" ? "block" : null;
  if (onMissing != null && onMissingNorm == null) {
    return { ok: false, error: `invalid onMissing value: ${onMissing}`, watch: null };
  }

  const normalized = {
    everySec:
      everySec == null || !Number.isFinite(everySec) ? null : Math.max(1, Math.min(86400, Math.floor(everySec))),
    tailLines:
      tailLines == null || !Number.isFinite(tailLines) ? null : Math.max(1, Math.min(500, Math.floor(tailLines))),
    thenTask:
      thenTaskRaw == null
        ? null
        : (() => {
            const s = String(thenTaskRaw || "").trim();
            if (!s) return null;
            return s.length > 2000 ? s.slice(0, 2000) : s;
          })(),
    thenTaskDescription:
      thenTaskDescriptionRaw == null
        ? null
        : (() => {
            const s = taskTextPreview(thenTaskDescriptionRaw, 200);
            return s || null;
          })(),
    runTasks: runTasksRaw == null ? null : Boolean(runTasksRaw),
    requireFiles: normalizedRequireFiles,
    readyTimeoutSec:
      readyTimeoutSec == null || !Number.isFinite(readyTimeoutSec)
        ? null
        : Math.max(10, Math.min(86400, Math.floor(readyTimeoutSec))),
    readyPollSec:
      readyPollSec == null || !Number.isFinite(readyPollSec)
        ? null
        : Math.max(1, Math.min(3600, Math.floor(readyPollSec))),
    onMissing: onMissingNorm,
    long: longRaw == null ? null : Boolean(longRaw),
    firstPostRegex:
      firstPostRegexRaw == null
        ? null
        : (() => {
            const s = String(firstPostRegexRaw || "").trim();
            if (!s) return null;
            return s.length > 300 ? s.slice(0, 300) : s;
          })(),
  };

  // If all fields are empty, treat as no watch config.
  const hasAny =
    normalized.everySec != null ||
    normalized.tailLines != null ||
    normalized.thenTask != null ||
    normalized.thenTaskDescription != null ||
    normalized.runTasks != null ||
    normalized.requireFiles.length > 0 ||
    normalized.readyTimeoutSec != null ||
    normalized.readyPollSec != null ||
    normalized.onMissing != null ||
    normalized.long != null ||
    normalized.firstPostRegex != null;
  return { ok: true, watch: hasAny ? normalized : null };
}

function normalizeRelayActionPreflight(rawPreflight) {
  if (rawPreflight == null) return { ok: true, preflight: null };
  if (!rawPreflight || typeof rawPreflight !== "object" || Array.isArray(rawPreflight)) {
    return { ok: false, error: "preflight must be an object", preflight: null };
  }
  const allowedKeys = new Set(["checks", "onFail"]);
  for (const k of Object.keys(rawPreflight)) {
    if (!allowedKeys.has(k)) {
      return { ok: false, error: `unknown preflight field: ${k}`, preflight: null };
    }
  }

  const checks = [];
  const checksRaw = Array.isArray(rawPreflight.checks) ? rawPreflight.checks : [];
  for (let i = 0; i < checksRaw.length; i += 1) {
    const raw = checksRaw[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: `preflight.checks[${i}] must be an object`, preflight: null };
    }
    const type = String(raw.type || "").trim().toLowerCase();
    if (!type) return { ok: false, error: `preflight.checks[${i}] missing type`, preflight: null };
    if (type === "path_exists") {
      const keys = new Set(["type", "path"]);
      for (const k of Object.keys(raw)) {
        if (!keys.has(k)) return { ok: false, error: `preflight.checks[${i}] unknown field: ${k}`, preflight: null };
      }
      const p = String(raw.path || "").trim();
      if (!p) return { ok: false, error: `preflight.checks[${i}] path_exists missing path`, preflight: null };
      checks.push({ type: "path_exists", path: p.length > 800 ? p.slice(0, 800) : p });
      continue;
    }
    if (type === "cmd_exit_zero") {
      const keys = new Set(["type", "cmd", "timeoutSec"]);
      for (const k of Object.keys(raw)) {
        if (!keys.has(k)) return { ok: false, error: `preflight.checks[${i}] unknown field: ${k}`, preflight: null };
      }
      const cmd = String(raw.cmd || "").trim();
      if (!cmd) return { ok: false, error: `preflight.checks[${i}] cmd_exit_zero missing cmd`, preflight: null };
      const timeoutRaw = raw.timeoutSec == null ? null : Number(raw.timeoutSec);
      checks.push({
        type: "cmd_exit_zero",
        cmd: cmd.length > 4000 ? cmd.slice(0, 4000) : cmd,
        timeoutSec:
          timeoutRaw == null || !Number.isFinite(timeoutRaw) ? null : Math.max(1, Math.min(600, Math.floor(timeoutRaw))),
      });
      continue;
    }
    if (type === "min_free_disk_gb") {
      const keys = new Set(["type", "path", "gb"]);
      for (const k of Object.keys(raw)) {
        if (!keys.has(k)) return { ok: false, error: `preflight.checks[${i}] unknown field: ${k}`, preflight: null };
      }
      const gbRaw = Number(raw.gb);
      if (!Number.isFinite(gbRaw) || gbRaw <= 0) {
        return { ok: false, error: `preflight.checks[${i}] min_free_disk_gb invalid gb`, preflight: null };
      }
      const p = raw.path == null ? "." : String(raw.path || "").trim() || ".";
      checks.push({
        type: "min_free_disk_gb",
        path: p.length > 800 ? p.slice(0, 800) : p,
        gb: Math.min(1024, Number(gbRaw)),
      });
      continue;
    }
    return { ok: false, error: `preflight.checks[${i}] unsupported type: ${type}`, preflight: null };
  }

  const onFailRaw = String(rawPreflight.onFail || "").trim().toLowerCase();
  const onFail = onFailRaw === "warn" ? "warn" : "reject";
  if (checks.length === 0) return { ok: true, preflight: null };
  return { ok: true, preflight: { checks, onFail } };
}

function normalizeRelayActionSupervisor(rawSupervisor) {
  if (rawSupervisor == null) return { ok: true, supervisor: null };
  if (!CONFIG.supervisorPhase1Enabled) {
    return {
      ok: false,
      error: "supervisor block is disabled (set RELAY_SUPERVISOR_PHASE1_ENABLED=true)",
      supervisor: null,
    };
  }
  if (!rawSupervisor || typeof rawSupervisor !== "object" || Array.isArray(rawSupervisor)) {
    return { ok: false, error: "supervisor must be an object", supervisor: null };
  }
  const allowedKeys = new Set([
    "mode",
    "runId",
    "projectRoot",
    "cwd",
    "stateFile",
    "smokeCmd",
    "fullCmd",
    "smokeRequiredFiles",
    "fullRequiredFiles",
    "smokeRunDir",
    "cleanupSmokePolicy",
    "scriptPath",
    "gateOut",
    "gateErr",
    "expectStatus",
    "readyTimeoutSec",
    "readyPollSec",
    "onMissing",
  ]);
  for (const k of Object.keys(rawSupervisor)) {
    if (!allowedKeys.has(k)) {
      return { ok: false, error: `supervisor unknown field: ${k}`, supervisor: null };
    }
  }

  const clip = (value, maxLen) => {
    const s = String(value || "").trim();
    if (!s) return "";
    return s.length > maxLen ? s.slice(0, maxLen) : s;
  };
  const requiredString = (label, value, maxLen) => {
    const s = clip(value, maxLen);
    if (!s) return { ok: false, error: `supervisor missing ${label}`, value: "" };
    return { ok: true, error: "", value: s };
  };
  const parseStringList = (raw, maxItems, maxLen) => {
    const src = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
    const out = [];
    for (const item of src) {
      const s = clip(item, maxLen);
      if (!s) continue;
      out.push(s);
      if (out.length >= maxItems) break;
    }
    return out;
  };

  const modeRaw = clip(rawSupervisor.mode || "stage0_smoke_gate", 80).toLowerCase();
  const mode = modeRaw || "stage0_smoke_gate";
  if (mode !== "stage0_smoke_gate") {
    return { ok: false, error: `supervisor unsupported mode: ${mode}`, supervisor: null };
  }

  const runIdRes = requiredString("runId", rawSupervisor.runId, 200);
  if (!runIdRes.ok) return { ok: false, error: runIdRes.error, supervisor: null };
  const stateFileRes = requiredString("stateFile", rawSupervisor.stateFile, 1000);
  if (!stateFileRes.ok) return { ok: false, error: stateFileRes.error, supervisor: null };
  const smokeCmdRes = requiredString("smokeCmd", rawSupervisor.smokeCmd, 4000);
  if (!smokeCmdRes.ok) return { ok: false, error: smokeCmdRes.error, supervisor: null };
  const fullCmdRes = requiredString("fullCmd", rawSupervisor.fullCmd, 4000);
  if (!fullCmdRes.ok) return { ok: false, error: fullCmdRes.error, supervisor: null };

  const cleanupRaw = clip(rawSupervisor.cleanupSmokePolicy || "keep_manifest_only", 80).toLowerCase();
  const cleanupSmokePolicy = cleanupRaw === "keep_all" ? "keep_all" : "keep_manifest_only";
  const onMissingRaw = clip(rawSupervisor.onMissing || "block", 40).toLowerCase();
  const onMissing = onMissingRaw === "enqueue" ? "enqueue" : "block";
  const expectStatus = parseSupervisorExpectedStatus(
    clip(rawSupervisor.expectStatus || CONFIG.supervisorPhase1DefaultExpectStatus || "success", 120)
  );

  const readyTimeoutSecRaw = rawSupervisor.readyTimeoutSec == null ? null : Number(rawSupervisor.readyTimeoutSec);
  const readyPollSecRaw = rawSupervisor.readyPollSec == null ? null : Number(rawSupervisor.readyPollSec);

  return {
    ok: true,
    error: "",
    supervisor: {
      mode,
      runId: runIdRes.value,
      projectRoot: clip(rawSupervisor.projectRoot, 1000) || null,
      cwd: clip(rawSupervisor.cwd, 1000) || null,
      stateFile: stateFileRes.value,
      smokeCmd: smokeCmdRes.value,
      fullCmd: fullCmdRes.value,
      smokeRequiredFiles: parseStringList(rawSupervisor.smokeRequiredFiles, 32, 1000),
      fullRequiredFiles: parseStringList(rawSupervisor.fullRequiredFiles, 32, 1000),
      smokeRunDir: clip(rawSupervisor.smokeRunDir, 1000) || null,
      cleanupSmokePolicy,
      scriptPath: clip(rawSupervisor.scriptPath || CONFIG.supervisorPhase1DefaultScript, 1000) || null,
      gateOut: clip(rawSupervisor.gateOut, 1000) || null,
      gateErr: clip(rawSupervisor.gateErr, 1000) || null,
      expectStatus,
      readyTimeoutSec:
        readyTimeoutSecRaw == null || !Number.isFinite(readyTimeoutSecRaw)
          ? null
          : Math.max(10, Math.min(86400, Math.floor(readyTimeoutSecRaw))),
      readyPollSec:
        readyPollSecRaw == null || !Number.isFinite(readyPollSecRaw)
          ? null
          : Math.max(1, Math.min(3600, Math.floor(readyPollSecRaw))),
      onMissing,
    },
  };
}

function normalizeRelayAction(rawAction) {
  if (!rawAction || typeof rawAction !== "object" || Array.isArray(rawAction)) {
    return { ok: false, error: "action is not an object", action: null };
  }
  const type = String(rawAction.type || "").trim().toLowerCase();
  if (!type) return { ok: false, error: "missing action.type", action: null };

  const assertAllowedKeys = (keys) => {
    const allowed = new Set(keys);
    for (const k of Object.keys(rawAction)) {
      if (!allowed.has(k)) return `unknown action field: ${k}`;
    }
    return "";
  };

  if (type === "job_start") {
    // Also accept thenTask/thenTaskDescription at top level for agent compatibility
    // (agents naturally write them there; auto-migrate into watch).
    const err = assertAllowedKeys([
      "type",
      "command",
      "description",
      "watch",
      "thenTask",
      "thenTaskDescription",
      "preflight",
      "supervisor",
    ]);
    if (err) return { ok: false, error: err, action: null };
    const command = rawAction.command == null ? "" : String(rawAction.command || "").trim();
    if (command.length > CONFIG.maxJobCommandChars) {
      return { ok: false, error: `job_start: command too long (max ${CONFIG.maxJobCommandChars})`, action: null };
    }
    const supervisorRes = normalizeRelayActionSupervisor(rawAction.supervisor);
    if (!supervisorRes.ok) return { ok: false, error: `job_start: ${supervisorRes.error}`, action: null };
    if (!command && !supervisorRes.supervisor) {
      return { ok: false, error: "job_start: missing command (or provide supervisor block)", action: null };
    }
    if (command && supervisorRes.supervisor) {
      return { ok: false, error: "job_start: provide either command or supervisor, not both", action: null };
    }
    const description = rawAction.description == null ? null : taskTextPreview(rawAction.description, 200) || null;
    // Merge top-level thenTask/thenTaskDescription into watch object.
    let mergedWatch = rawAction.watch;
    if (rawAction.thenTask != null || rawAction.thenTaskDescription != null) {
      mergedWatch = Object.assign({}, rawAction.watch || {});
      if (rawAction.thenTask != null && mergedWatch.thenTask == null) mergedWatch.thenTask = rawAction.thenTask;
      if (rawAction.thenTaskDescription != null && mergedWatch.thenTaskDescription == null)
        mergedWatch.thenTaskDescription = rawAction.thenTaskDescription;
    }
    const watchRes = normalizeRelayActionWatch(mergedWatch);
    if (!watchRes.ok) return { ok: false, error: `job_start: ${watchRes.error}`, action: null };
    const preflightRes = normalizeRelayActionPreflight(rawAction.preflight);
    if (!preflightRes.ok) return { ok: false, error: `job_start: ${preflightRes.error}`, action: null };
    return {
      ok: true,
      error: "",
      action: {
        type,
        command: command || null,
        description,
        watch: watchRes.watch,
        preflight: preflightRes.preflight,
        supervisor: supervisorRes.supervisor,
      },
    };
  }

  if (type === "job_watch") {
    const err = assertAllowedKeys(["type", "watch"]);
    if (err) return { ok: false, error: err, action: null };
    const watchRes = normalizeRelayActionWatch(rawAction.watch);
    if (!watchRes.ok) return { ok: false, error: `job_watch: ${watchRes.error}`, action: null };
    return { ok: true, error: "", action: { type, watch: watchRes.watch } };
  }

  if (type === "job_stop") {
    const err = assertAllowedKeys(["type"]);
    if (err) return { ok: false, error: err, action: null };
    return { ok: true, error: "", action: { type } };
  }

  if (type === "task_add") {
    const err = assertAllowedKeys(["type", "text", "description"]);
    if (err) return { ok: false, error: err, action: null };
    const text = String(rawAction.text || "").trim();
    if (!text) return { ok: false, error: "task_add: missing text", action: null };
    const clipped = text.length > 2000 ? text.slice(0, 2000) : text;
    const description = rawAction.description == null ? null : taskTextPreview(rawAction.description, 200) || null;
    return { ok: true, error: "", action: { type, text: clipped, description } };
  }

  if (type === "task_run") {
    const err = assertAllowedKeys(["type"]);
    if (err) return { ok: false, error: err, action: null };
    return { ok: true, error: "", action: { type } };
  }

  return { ok: false, error: `unknown action type: ${type}`, action: null };
}

function extractRelayActions(text, { maxActions = 1 } = {}) {
  const rawText = String(text || "");
  const rawLower = rawText.toLowerCase();
  const startMarker = "[[relay-actions]]";
  const endMarker = "[[/relay-actions]]";

  let out = "";
  let idx = 0;
  const blocks = [];
  const errors = [];

  while (true) {
    const start = rawLower.indexOf(startMarker, idx);
    if (start === -1) break;
    const end = rawLower.indexOf(endMarker, start + startMarker.length);
    if (end === -1) break;
    out += rawText.slice(idx, start);
    const payload = rawText.slice(start + startMarker.length, end).trim();
    blocks.push(payload);
    idx = end + endMarker.length;
  }
  out += rawText.slice(idx);

  const actions = [];
  const budget = Math.max(0, Math.floor(Number(maxActions || 0)));

  if (budget === 0) {
    return { text: out, actions: [], errors: [] };
  }

  for (const block of blocks) {
    if (actions.length >= budget) break;
    let raw = String(block || "").trim();
    // Strip markdown code fences agents sometimes wrap JSON in (```json ... ``` or ``` ... ```).
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    if (!raw) continue;
    if (raw.length > 20000) {
      errors.push("relay-actions block too large (skipped)");
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      errors.push(`relay-actions JSON parse failed: ${String(err && err.message ? err.message : err).slice(0, 200)}`);
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      errors.push("relay-actions JSON must be an object");
      continue;
    }
    const list = parsed.actions;
    if (!Array.isArray(list)) {
      errors.push("relay-actions JSON must include: {\"actions\": [...]}");
      continue;
    }
    for (const rawAction of list) {
      if (actions.length >= budget) break;
      const normalized = normalizeRelayAction(rawAction);
      if (!normalized.ok) {
        errors.push(`relay-action rejected: ${normalized.error}`);
        continue;
      }
      actions.push(normalized.action);
    }
  }

  return { text: out, actions, errors };
}

function buildUploadCandidates(rawPath, { sessionWorkdir, conversationDir }) {
  const cleaned = normalizeUploadRawPath(rawPath);
  if (!cleaned) return [];
  if (path.isAbsolute(cleaned)) return [path.resolve(cleaned)];

  const candidates = [];
  if (sessionWorkdir) candidates.push(path.resolve(sessionWorkdir, cleaned));
  candidates.push(path.resolve(conversationDir, cleaned));
  return Array.from(new Set(candidates));
}

async function resolveAndValidateUploads(conversationKey, rawPaths, sessionWorkdir) {
  const conversationDir = getConversationUploadDir(conversationKey);
  await fsp.mkdir(conversationDir, { recursive: true });

  const files = [];
  const errors = [];
  const seen = new Set();

  const maxFiles = Math.max(0, CONFIG.uploadMaxFiles);
  const maxBytes = Math.max(0, CONFIG.uploadMaxBytes);

  for (const raw of rawPaths || []) {
    if (maxFiles > 0 && files.length >= maxFiles) break;
    const candidates = buildUploadCandidates(raw, {
      sessionWorkdir,
      conversationDir,
    });
    if (candidates.length === 0) continue;

    let pickedPath = null;
    let blockedPath = null;
    let nonFilePath = null;
    let tooLarge = null;

    for (const candidate of candidates) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);

      if (!isAllowedUploadPath(candidate, conversationDir)) {
        blockedPath = candidate;
        continue;
      }

      let st;
      try {
        st = await fsp.stat(candidate);
      } catch {
        continue;
      }

      if (!st.isFile()) {
        nonFilePath = candidate;
        continue;
      }
      if (maxBytes > 0 && st.size > maxBytes) {
        tooLarge = { path: candidate, size: st.size };
        continue;
      }

      pickedPath = candidate;
      break;
    }

    if (pickedPath) {
      files.push({ attachment: pickedPath, name: path.basename(pickedPath) });
      continue;
    }
    if (tooLarge) {
      errors.push(`Upload too large (${tooLarge.size} bytes): \`${path.basename(tooLarge.path)}\``);
      continue;
    }
    if (nonFilePath) {
      errors.push(`Upload is not a file: \`${path.basename(nonFilePath)}\``);
      continue;
    }
    if (blockedPath) {
      errors.push(`Upload blocked (path not allowed): \`${path.basename(blockedPath)}\``);
      continue;
    }
    errors.push(`Upload missing: \`${path.basename(candidates[0])}\``);
  }

  if (maxFiles > 0 && (rawPaths || []).length > maxFiles) {
    errors.push(`Upload limit: max ${maxFiles} file(s).`);
  }

  return { conversationDir, files, errors };
}

function listDiscordAttachments(message) {
  if (!message || !message.attachments || typeof message.attachments.values !== "function") return [];
  return Array.from(message.attachments.values());
}

function isProbablyTextAttachment(attachment) {
  if (!attachment || typeof attachment !== "object") return false;
  const name = String(attachment.name || "").trim();
  const contentType = String(attachment.contentType || "").trim().toLowerCase();
  const ext = path.extname(name).toLowerCase();
  if (TEXT_EXTS.has(ext)) return true;
  if (contentType.startsWith("text/")) return true;
  if (
    contentType.includes("json") ||
    contentType.includes("yaml") ||
    contentType.includes("toml") ||
    contentType.includes("xml") ||
    contentType.includes("csv")
  ) {
    return true;
  }
  return false;
}

function isZipAttachment(attachment) {
  if (!attachment || typeof attachment !== "object") return false;
  const name = String(attachment.name || "").trim().toLowerCase();
  const contentType = String(attachment.contentType || "").trim().toLowerCase();
  if (path.extname(name) === ".zip") return true;
  return contentType.includes("zip");
}

function isIngestibleDiscordAttachment(attachment) {
  if (isProbablyTextAttachment(attachment)) return true;
  if (CONFIG.discordAttachmentsZipEnabled && isZipAttachment(attachment)) return true;
  return false;
}

function hasIngestibleDiscordAttachments(message) {
  if (!CONFIG.discordAttachmentsEnabled) return false;
  const atts = listDiscordAttachments(message);
  return atts.some((att) => isIngestibleDiscordAttachment(att));
}

function sanitizeAttachmentFilename(rawName) {
  let name = String(rawName || "").trim();
  if (!name) name = "attachment.txt";
  name = path.basename(name);
  name = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!name) name = "attachment.txt";
  if (name.length > 160) {
    const ext = path.extname(name);
    const keep = Math.max(1, 160 - ext.length);
    name = `${name.slice(0, keep)}${ext}`;
  }
  return name;
}

function looksBinaryBytes(buf) {
  if (!buf || typeof buf.length !== "number") return true;
  if (buf.length === 0) return false;
  const sampleLen = Math.min(buf.length, 8192);
  let ctrl = 0;
  for (let i = 0; i < sampleLen; i += 1) {
    const b = buf[i];
    if (b === 0) return true;
    if (b === 9 || b === 10 || b === 13) continue;
    if (b < 32 || b === 127) ctrl += 1;
  }
  return ctrl / sampleLen > 0.3;
}

function guessAttachmentTruncMode(filename) {
  const ext = path.extname(String(filename || "")).toLowerCase();
  if (ext === ".log") return "tail";
  return "headtail";
}

function truncateAttachmentByMode(rawText, mode, maxChars) {
  const text = String(rawText || "");
  if (!text) return { text: "", truncated: false };
  if (maxChars <= 0) return { text: "", truncated: text.length > 0 };
  if (text.length <= maxChars) return { text, truncated: false };

  const truncSuffix = "\n...[attachment truncated]";
  const truncPrefix = "...[attachment truncated]\n";
  const truncMiddleSuffix = "\n...[attachment truncated middle]";
  const headTailJoiner = "\n...[snip]...\n";

  const truncateHead = () => {
    if (truncSuffix.length >= maxChars) return truncSuffix.slice(0, maxChars);
    const keep = Math.max(0, maxChars - truncSuffix.length);
    return `${text.slice(0, keep)}${truncSuffix}`;
  };

  const truncateTail = () => {
    if (truncPrefix.length >= maxChars) return truncPrefix.slice(0, maxChars);
    const keep = Math.max(0, maxChars - truncPrefix.length);
    return `${truncPrefix}${text.slice(-keep)}`;
  };

  const truncateHeadTail = () => {
    if (truncMiddleSuffix.length >= maxChars) return truncMiddleSuffix.slice(0, maxChars);
    const bodyBudget = Math.max(0, maxChars - truncMiddleSuffix.length);
    if (bodyBudget <= 0) return truncMiddleSuffix.slice(0, maxChars);

    let body = "";
    if (headTailJoiner.length >= bodyBudget) {
      body = text.slice(0, bodyBudget);
    } else {
      const splitBudget = bodyBudget - headTailJoiner.length;
      const headLen = Math.max(1, Math.floor(splitBudget / 2));
      const tailLen = Math.max(1, splitBudget - headLen);
      const head = text.slice(0, headLen);
      const tail = text.slice(-tailLen);
      body = `${head}${headTailJoiner}${tail}`;
    }
    if (body.length > bodyBudget) body = body.slice(0, bodyBudget);
    return `${body}${truncMiddleSuffix}`;
  };

  if (mode === "tail") return { text: truncateTail(), truncated: true };
  if (mode === "headtail") return { text: truncateHeadTail(), truncated: true };
  return { text: truncateHead(), truncated: true };
}

async function fetchDiscordAttachmentBytes(url, timeoutMs) {
  const rawUrl = String(url || "").trim();
  if (!rawUrl) return { ok: false, error: "missing url", buf: Buffer.alloc(0) };

  const controller = new AbortController();
  const timer =
    timeoutMs && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

  try {
    const res = await fetch(rawUrl, {
      signal: controller.signal,
      ...(DISCORD_REST_AGENT ? { dispatcher: DISCORD_REST_AGENT } : {}),
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, buf: Buffer.alloc(0) };
    }
    const ab = await res.arrayBuffer();
    return { ok: true, error: "", buf: Buffer.from(ab) };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err), buf: Buffer.alloc(0) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function extractTextEntriesFromZip(zipPath, options = {}) {
  const maxEntries = Math.max(1, Number(options.maxEntries || 1));
  const maxEntryBytes = Math.max(1024, Number(options.maxEntryBytes || 1024));
  const maxCharsPerEntry = Math.max(200, Number(options.maxCharsPerEntry || 200));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 1000));
  const allowedExts = Array.isArray(options.allowedExts)
    ? options.allowedExts
        .map((s) => String(s || "").trim().toLowerCase())
        .filter(Boolean)
    : [];
  const pyScript = `
import json, os, sys, zipfile

zip_path = sys.argv[1]
max_entries = max(1, int(sys.argv[2]))
max_entry_bytes = max(1024, int(sys.argv[3]))
max_chars_per_entry = max(200, int(sys.argv[4]))
allowed_exts = set([s.strip().lower() for s in (sys.argv[5] if len(sys.argv) > 5 else "").split(",") if s.strip()])

def is_text_like(data: bytes) -> bool:
    if data is None:
        return False
    if len(data) == 0:
        return True
    if b"\\x00" in data:
        return False
    sample = data[:8192]
    ctrl = 0
    for b in sample:
        if b in (9, 10, 13):
            continue
        if b < 32 or b == 127:
            ctrl += 1
    return (ctrl / max(1, len(sample))) <= 0.3

out = {"ok": True, "entries": [], "errors": [], "scanned": 0, "selected": 0, "skipped": 0}

try:
    zf = zipfile.ZipFile(zip_path, "r")
except Exception as e:
    print(json.dumps({"ok": False, "error": f"failed opening zip: {e}"}))
    sys.exit(0)

with zf:
    for info in zf.infolist():
        if len(out["entries"]) >= max_entries:
            break
        if getattr(info, "is_dir", None):
            if info.is_dir():
                continue
        elif str(info.filename).endswith("/"):
            continue

        out["scanned"] += 1
        name = str(info.filename or "")
        base = os.path.basename(name)
        ext = os.path.splitext(base)[1].lower()
        if allowed_exts and ext not in allowed_exts:
            out["skipped"] += 1
            continue
        if int(info.file_size or 0) > max_entry_bytes:
            out["errors"].append(f"zip entry too large ({int(info.file_size or 0)} > {max_entry_bytes}): {name}")
            continue
        try:
            with zf.open(info, "r") as fh:
                data = fh.read(max_entry_bytes + 1)
        except Exception as e:
            out["errors"].append(f"zip entry read failed ({name}): {e}")
            continue
        if len(data) > max_entry_bytes:
            out["errors"].append(f"zip entry exceeded read limit ({name})")
            continue
        if not is_text_like(data):
            out["errors"].append(f"zip entry appears non-text (skipped): {name}")
            continue
        text = data.decode("utf-8", errors="replace")
        truncated = False
        if len(text) > max_chars_per_entry:
            text = text[:max_chars_per_entry] + "\\n...[zip entry truncated]"
            truncated = True
        out["entries"].append(
            {
                "name": name,
                "size_bytes": int(info.file_size or 0),
                "text": text,
                "truncated": truncated,
            }
        )
        out["selected"] += 1

print(json.dumps(out, ensure_ascii=False))
`;
  const res = await execFileCapture(
    "python3",
    [
      "-c",
      pyScript,
      String(zipPath || ""),
      String(maxEntries),
      String(maxEntryBytes),
      String(maxCharsPerEntry),
      allowedExts.join(","),
    ],
    { timeoutMs }
  );
  if (res.code !== 0) {
    const stderr = String(res.stderr || "").trim();
    return {
      ok: false,
      entries: [],
      errors: [`zip extractor failed (exit ${res.code})${stderr ? `: ${stderr}` : ""}`],
    };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(String(res.stdout || "").trim() || "{}");
  } catch (err) {
    return {
      ok: false,
      entries: [],
      errors: [
        `zip extractor returned invalid JSON: ${String(err && err.message ? err.message : err)}`,
      ],
    };
  }
  if (!parsed || parsed.ok !== true || !Array.isArray(parsed.entries)) {
    const reason = parsed && parsed.error ? String(parsed.error) : "unexpected zip extractor output";
    return { ok: false, entries: [], errors: [reason] };
  }
  const entries = parsed.entries
    .map((entry) => ({
      name: String(entry && entry.name ? entry.name : "entry.txt"),
      text: String(entry && entry.text ? entry.text : ""),
      sizeBytes: Number(entry && entry.size_bytes ? entry.size_bytes : 0) || 0,
      truncated: Boolean(entry && entry.truncated),
    }))
    .filter((entry) => entry.text.length > 0);
  const errors = Array.isArray(parsed.errors)
    ? parsed.errors.map((e) => String(e || "")).filter(Boolean)
    : [];
  return { ok: true, entries, errors };
}

async function ingestDiscordTextAttachments(message, conversationKey, uploadDir, onProgress) {
  const out = {
    ok: true,
    injectedText: "",
    includedFiles: 0,
    totalCandidates: 0,
    savedPaths: [],
    errors: [],
  };

  if (!CONFIG.discordAttachmentsEnabled) return out;
  const candidates = listDiscordAttachments(message).filter((att) => isIngestibleDiscordAttachment(att));
  out.totalCandidates = candidates.length;
  if (candidates.length === 0) return out;

  const maxFiles = Math.max(0, CONFIG.discordAttachmentsMaxFiles);
  const selected = maxFiles > 0 ? candidates.slice(0, maxFiles) : [];
  if (selected.length === 0) return out;

  const attachmentsDir = path.join(uploadDir, "attachments");
  try {
    await fsp.mkdir(attachmentsDir, { recursive: true });
  } catch (err) {
    out.ok = false;
    out.errors.push(`failed creating attachments dir: ${String(err.message || err)}`);
    return out;
  }

  let remaining = Math.max(0, CONFIG.discordAttachmentsMaxChars);
  const pieces = [];

  for (const att of selected) {
    const originalName = String(att.name || "attachment");
    const safeName = sanitizeAttachmentFilename(originalName);
    const url = String(att.url || "").trim();
    const claimedBytes = Number(att.size || 0) || 0;
    const contentType = String(att.contentType || "").trim() || "unknown";
    const asZip = CONFIG.discordAttachmentsZipEnabled && isZipAttachment(att);
    const maxBytes = asZip ? CONFIG.discordAttachmentsZipMaxBytes : CONFIG.discordAttachmentsMaxBytes;

    if (!url) {
      out.errors.push(`missing url for attachment: ${originalName}`);
      continue;
    }
    if (maxBytes > 0 && claimedBytes > maxBytes) {
      out.errors.push(
        `attachment too large (claimed ${claimedBytes} bytes > max ${maxBytes}): ${originalName}`
      );
      continue;
    }

    try {
      if (typeof onProgress === "function") {
        onProgress(`Downloading attachment: ${safeName} (${claimedBytes} bytes)`);
      }
      const fetched = await fetchDiscordAttachmentBytes(url, CONFIG.discordAttachmentsDownloadTimeoutMs);
      if (!fetched.ok) {
        out.errors.push(`failed downloading ${originalName}: ${fetched.error}`);
        continue;
      }
      if (maxBytes > 0 && fetched.buf.length > maxBytes) {
        out.errors.push(
          `attachment too large (downloaded ${fetched.buf.length} bytes > max ${maxBytes}): ${originalName}`
        );
        continue;
      }
      const uniquePrefix = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
      const savedPath = path.join(attachmentsDir, `${uniquePrefix}_${safeName}`);
      if (asZip) {
        await fsp.writeFile(savedPath, fetched.buf);
        out.savedPaths.push(savedPath);
        const extracted = await extractTextEntriesFromZip(savedPath, {
          maxEntries: CONFIG.discordAttachmentsZipMaxEntries,
          maxEntryBytes: CONFIG.discordAttachmentsZipMaxEntryBytes,
          maxCharsPerEntry: CONFIG.discordAttachmentsZipMaxCharsPerEntry,
          timeoutMs: CONFIG.discordAttachmentsZipExtractTimeoutMs,
          allowedExts: CONFIG.discordAttachmentsZipAllowedExts,
        });
        if (!extracted.ok) {
          out.errors.push(
            `zip extraction failed (${originalName}): ${extracted.errors && extracted.errors[0] ? extracted.errors[0] : "unknown"}`
          );
          continue;
        }
        if (extracted.errors.length > 0) {
          out.errors.push(...extracted.errors.slice(0, 6).map((e) => `${originalName}: ${e}`));
        }
        if (extracted.entries.length === 0) {
          out.errors.push(`zip has no eligible text entries: ${originalName}`);
          continue;
        }
        for (const entry of extracted.entries) {
          const sep = pieces.length > 0 ? "\n\n" : "";
          const sepCost = sep.length;
          if (remaining <= sepCost) break;

          const perFileBudget = Math.min(CONFIG.discordAttachmentsMaxCharsPerFile, remaining - sepCost);
          if (perFileBudget <= 0) break;

          const header = [
            `[Discord attachment (zip entry): ${originalName} :: ${entry.name}]`,
            `saved_to: ${savedPath}`,
            `zip_entry_size_bytes: ${entry.sizeBytes}`,
            `zip_entry_truncated: ${entry.truncated ? "yes" : "no"}`,
            `content_type: ${contentType}`,
            "",
          ].join("\n");
          const bodyBudget = Math.max(0, perFileBudget - header.length);
          if (bodyBudget <= 0) break;

          const mode = guessAttachmentTruncMode(entry.name);
          const truncated = truncateAttachmentByMode(entry.text, mode, bodyBudget);
          const chunk = `${header}${truncated.text}`;
          pieces.push(`${sep}${chunk}`);
          remaining -= sepCost + chunk.length;
          out.includedFiles += 1;
        }
        continue;
      }

      if (looksBinaryBytes(fetched.buf)) {
        out.errors.push(`attachment appears non-text (skipped): ${originalName}`);
        continue;
      }

      await fsp.writeFile(savedPath, fetched.buf);
      out.savedPaths.push(savedPath);

      const sep = pieces.length > 0 ? "\n\n" : "";
      const sepCost = sep.length;
      if (remaining <= sepCost) continue;

      const perFileBudget = Math.min(CONFIG.discordAttachmentsMaxCharsPerFile, remaining - sepCost);
      if (perFileBudget <= 0) continue;

      const header = [
        `[Discord attachment: ${originalName}]`,
        `saved_to: ${savedPath}`,
        `size_bytes: ${fetched.buf.length}`,
        `content_type: ${contentType}`,
        "",
      ].join("\n");
      const bodyBudget = Math.max(0, perFileBudget - header.length);
      if (bodyBudget <= 0) continue;

      const decoded = fetched.buf.toString("utf8");
      const mode = guessAttachmentTruncMode(originalName);
      const truncated = truncateAttachmentByMode(decoded, mode, bodyBudget);
      const chunk = `${header}${truncated.text}`;
      pieces.push(`${sep}${chunk}`);
      remaining -= sepCost + chunk.length;
      out.includedFiles += 1;
    } catch (err) {
      out.errors.push(`attachment ingest error (${originalName}): ${String(err && err.message ? err.message : err)}`);
      continue;
    }
  }

  out.injectedText = pieces.join("");
  if (out.errors.length > 0) {
    logRelayEvent("discord.attachments.ingest.warn", {
      conversationKey,
      candidates: out.totalCandidates,
      saved: out.savedPaths.length,
      injectedFiles: out.includedFiles,
      errors: out.errors.slice(0, 5),
    });
  } else {
    logRelayEvent("discord.attachments.ingest.ok", {
      conversationKey,
      candidates: out.totalCandidates,
      saved: out.savedPaths.length,
      injectedFiles: out.includedFiles,
    });
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function ensureTaskLoopShape(session) {
  if (!session || typeof session !== "object") return false;
  let changed = false;
  if (!session.taskLoop || typeof session.taskLoop !== "object") {
    session.taskLoop = { running: false, stopRequested: false, currentTaskId: null };
    return true;
  }
  if (typeof session.taskLoop.running !== "boolean") {
    session.taskLoop.running = false;
    changed = true;
  }
  if (typeof session.taskLoop.stopRequested !== "boolean") {
    session.taskLoop.stopRequested = false;
    changed = true;
  }
  if (session.taskLoop.currentTaskId != null && typeof session.taskLoop.currentTaskId !== "string") {
    session.taskLoop.currentTaskId = null;
    changed = true;
  }
  return changed;
}

function normalizeTaskObject(task, fallbackId) {
  if (!task || typeof task !== "object") return false;
  let changed = false;
  const validStatuses = new Set(["pending", "running", "done", "failed", "blocked", "canceled"]);

  if (typeof task.id !== "string" || !task.id.trim()) {
    task.id = String(fallbackId || `t-${Date.now()}`);
    changed = true;
  }
  if (typeof task.text !== "string") {
    task.text = String(task.text || "");
    changed = true;
  }
  if (task.description != null && typeof task.description !== "string") {
    task.description = String(task.description || "");
    changed = true;
  }
  const normalizedDescription = task.description == null ? "" : String(task.description || "").trim();
  const clippedDescription = normalizedDescription ? taskTextPreview(normalizedDescription, 200) : null;
  if (task.description !== clippedDescription) {
    task.description = clippedDescription;
    changed = true;
  }
  if (!task.description) {
    const derivedDescription = taskTextPreview(task.text || "", 200) || null;
    if (task.description !== derivedDescription) {
      task.description = derivedDescription;
      changed = true;
    }
  }
  if (task.sourceJobId != null && typeof task.sourceJobId !== "string") {
    task.sourceJobId = String(task.sourceJobId || "");
    changed = true;
  }
  const sourceJobId = task.sourceJobId == null ? "" : String(task.sourceJobId || "").trim();
  const normalizedSourceJobId = sourceJobId || null;
  if (task.sourceJobId !== normalizedSourceJobId) {
    task.sourceJobId = normalizedSourceJobId;
    changed = true;
  }
  const status = String(task.status || "pending").toLowerCase();
  if (!validStatuses.has(status)) {
    task.status = "pending";
    changed = true;
  } else if (task.status !== status) {
    task.status = status;
    changed = true;
  }

  if (typeof task.createdAt !== "string" || !task.createdAt) {
    task.createdAt = nowIso();
    changed = true;
  }
  if (task.startedAt != null && typeof task.startedAt !== "string") {
    task.startedAt = null;
    changed = true;
  }
  if (task.finishedAt != null && typeof task.finishedAt !== "string") {
    task.finishedAt = null;
    changed = true;
  }
  if (typeof task.attempts !== "number" || !Number.isFinite(task.attempts) || task.attempts < 0) {
    task.attempts = 0;
    changed = true;
  }
  if (task.lastError != null && typeof task.lastError !== "string") {
    task.lastError = String(task.lastError || "");
    changed = true;
  }
  if (task.lastResultPreview != null && typeof task.lastResultPreview !== "string") {
    task.lastResultPreview = String(task.lastResultPreview || "");
    changed = true;
  }
  return changed;
}

function ensureTasksShape(session) {
  if (!session || typeof session !== "object") return false;
  let changed = false;
  if (!Array.isArray(session.tasks)) {
    session.tasks = [];
    changed = true;
  }
  for (let i = 0; i < session.tasks.length; i += 1) {
    const task = session.tasks[i];
    changed = normalizeTaskObject(task, `t-${String(i + 1).padStart(4, "0")}`) || changed;
  }
  return changed;
}

function normalizePlanObject(plan, fallbackId) {
  if (!plan || typeof plan !== "object") return false;
  let changed = false;

  if (typeof plan.id !== "string" || !plan.id.trim()) {
    plan.id = String(fallbackId || `p-${Date.now()}`);
    changed = true;
  }
  if (typeof plan.createdAt !== "string" || !plan.createdAt) {
    plan.createdAt = nowIso();
    changed = true;
  }
  if (plan.title != null && typeof plan.title !== "string") {
    plan.title = String(plan.title || "");
    changed = true;
  }
  if (!plan.title || !String(plan.title).trim()) {
    const derived = plan.request ? taskTextPreview(plan.request, 72) : "";
    if (derived) {
      plan.title = derived;
      changed = true;
    }
  }
  if (plan.workdir != null && typeof plan.workdir !== "string") {
    plan.workdir = String(plan.workdir || "");
    changed = true;
  }
  if (plan.path != null && typeof plan.path !== "string") {
    plan.path = String(plan.path || "");
    changed = true;
  }
  if (plan.request != null && typeof plan.request !== "string") {
    plan.request = String(plan.request || "");
    changed = true;
  }
  if (plan.text != null && typeof plan.text !== "string") {
    plan.text = String(plan.text || "");
    changed = true;
  }
  return changed;
}

function ensurePlansShape(session) {
  if (!session || typeof session !== "object") return false;
  let changed = false;
  if (!Array.isArray(session.plans)) {
    session.plans = [];
    changed = true;
  }
  for (let i = 0; i < session.plans.length; i += 1) {
    const plan = session.plans[i];
    changed = normalizePlanObject(plan, `p-${String(i + 1).padStart(4, "0")}`) || changed;
  }
  // Keep the most recent plans.
  const maxHistory = Math.max(1, Number(CONFIG.plansMaxHistory || 20));
  if (session.plans.length > maxHistory) {
    session.plans = session.plans.slice(-maxHistory);
    changed = true;
  }
  return changed;
}

function normalizeJobWatchObject(watch) {
  if (!watch || typeof watch !== "object" || Array.isArray(watch)) return null;
  const rawRequireFiles = Array.isArray(watch.requireFiles) ? watch.requireFiles : [];
  const requireFiles = [];
  for (const item of rawRequireFiles) {
    const p = String(item || "").trim();
    if (!p) continue;
    requireFiles.push(p.length > 600 ? p.slice(0, 600) : p);
    if (requireFiles.length >= 32) break;
  }
  const onMissingRaw = String(watch.onMissing || "").trim().toLowerCase();
  const onMissing = onMissingRaw === "enqueue" ? "enqueue" : "block";
  const readyTimeoutSec = Number(watch.readyTimeoutSec);
  const readyPollSec = Number(watch.readyPollSec);
  const supervisorModeRaw = String(watch.supervisorMode || "").trim().toLowerCase();
  const supervisorMode = supervisorModeRaw === "stage0_smoke_gate" ? "stage0_smoke_gate" : null;
  const supervisorStateFile = watch.supervisorStateFile == null ? null : String(watch.supervisorStateFile || "").trim() || null;
  const supervisorExpectStatus =
    watch.supervisorExpectStatus == null ? null : parseSupervisorExpectedStatus(watch.supervisorExpectStatus);
  const supervisorCleanupSmokePolicyRaw = String(watch.supervisorCleanupSmokePolicy || "").trim().toLowerCase();
  const supervisorCleanupSmokePolicy =
    supervisorCleanupSmokePolicyRaw === "keep_all"
      ? "keep_all"
      : supervisorCleanupSmokePolicyRaw === "keep_manifest_only"
      ? "keep_manifest_only"
      : null;
  const out = {
    enabled: Boolean(watch.enabled),
    everySec: Math.max(1, Math.min(86400, Math.floor(Number(watch.everySec || 300) || 300))),
    tailLines: Math.max(1, Math.min(500, Math.floor(Number(watch.tailLines || 30) || 30))),
    thenTask: watch.thenTask == null ? null : String(watch.thenTask || "").trim() || null,
    thenTaskDescription: watch.thenTaskDescription == null ? null : taskTextPreview(watch.thenTaskDescription, 200) || null,
    runTasks: watch.runTasks == null ? null : Boolean(watch.runTasks),
    requireFiles,
    readyTimeoutSec: Number.isFinite(readyTimeoutSec) ? Math.max(10, Math.min(86400, Math.floor(readyTimeoutSec))) : null,
    readyPollSec: Number.isFinite(readyPollSec) ? Math.max(1, Math.min(3600, Math.floor(readyPollSec))) : null,
    onMissing,
    long: watch.long == null ? null : Boolean(watch.long),
    firstPostRegex: watch.firstPostRegex == null ? null : String(watch.firstPostRegex || "").trim() || null,
    supervisorMode,
    supervisorStateFile,
    supervisorExpectStatus,
    supervisorCleanupSmokePolicy,
  };
  if (out.thenTask && out.thenTask.length > 2000) out.thenTask = out.thenTask.slice(0, 2000);
  if (out.firstPostRegex && out.firstPostRegex.length > 300) out.firstPostRegex = out.firstPostRegex.slice(0, 300);
  return out;
}

function normalizeJobObject(job, fallbackId) {
  if (!job || typeof job !== "object") return false;
  let changed = false;
  const validStatuses = new Set(["running", "done", "failed", "canceled", "blocked"]);

  if (typeof job.id !== "string" || !job.id.trim()) {
    job.id = String(fallbackId || `j-${Date.now()}`);
    changed = true;
  }
  if (typeof job.command !== "string") {
    job.command = String(job.command || "");
    changed = true;
  }
  if (job.description != null && typeof job.description !== "string") {
    job.description = String(job.description || "");
    changed = true;
  }
  const normalizedDescription = job.description == null ? "" : String(job.description || "").trim();
  const clippedDescription = normalizedDescription ? taskTextPreview(normalizedDescription, 200) : null;
  if (job.description !== clippedDescription) {
    job.description = clippedDescription;
    changed = true;
  }
  if (typeof job.workdir !== "string" || !job.workdir.trim()) {
    job.workdir = CONFIG.defaultWorkdir;
    changed = true;
  }
  const status = String(job.status || "running").toLowerCase();
  if (!validStatuses.has(status)) {
    job.status = "running";
    changed = true;
  } else if (job.status !== status) {
    job.status = status;
    changed = true;
  }
  if (typeof job.startedAt !== "string" || !job.startedAt) {
    job.startedAt = nowIso();
    changed = true;
  }
  if (job.finishedAt != null && typeof job.finishedAt !== "string") {
    job.finishedAt = null;
    changed = true;
  }
  if (job.exitedAt != null && typeof job.exitedAt !== "string") {
    job.exitedAt = null;
    changed = true;
  }
  if (job.visibilityStatus != null && typeof job.visibilityStatus !== "string") {
    job.visibilityStatus = String(job.visibilityStatus || "");
    changed = true;
  }
  if (!job.visibilityStatus) {
    job.visibilityStatus = "ok";
    changed = true;
  }
  if (job.visibilityLastHeartbeatAt != null && typeof job.visibilityLastHeartbeatAt !== "string") {
    job.visibilityLastHeartbeatAt = String(job.visibilityLastHeartbeatAt || "");
    changed = true;
  }
  if (job.visibilityDegradedAt != null && typeof job.visibilityDegradedAt !== "string") {
    job.visibilityDegradedAt = String(job.visibilityDegradedAt || "");
    changed = true;
  }
  if (job.pid != null && (typeof job.pid !== "number" || !Number.isFinite(job.pid) || job.pid <= 0)) {
    job.pid = null;
    changed = true;
  }
  for (const k of ["jobDir", "logPath", "exitCodePath", "pidPath"]) {
    if (job[k] != null && typeof job[k] !== "string") {
      job[k] = String(job[k] || "");
      changed = true;
    }
  }
  if (job.exitCode != null && (typeof job.exitCode !== "number" || !Number.isFinite(job.exitCode))) {
    job.exitCode = null;
    changed = true;
  }

  const normalizedWatch = normalizeJobWatchObject(job.watch);
  if (normalizedWatch) {
    const before = JSON.stringify(job.watch || {});
    const after = JSON.stringify(normalizedWatch);
    if (before !== after) {
      job.watch = normalizedWatch;
      changed = true;
    }
  } else if (job.watch != null) {
    job.watch = null;
    changed = true;
  }

  const lifecycleStateRaw = String(job.lifecycleState || "").trim().toLowerCase();
  if (!lifecycleStateRaw) {
    job.lifecycleState = job.status === "done" ? "completed" : job.status === "canceled" ? "failed" : job.status;
    changed = true;
  } else if (job.lifecycleState !== lifecycleStateRaw) {
    job.lifecycleState = lifecycleStateRaw;
    changed = true;
  }
  if (job.lifecycleReason != null && typeof job.lifecycleReason !== "string") {
    job.lifecycleReason = String(job.lifecycleReason || "");
    changed = true;
  }
  if (job.lifecycleUpdatedAt != null && typeof job.lifecycleUpdatedAt !== "string") {
    job.lifecycleUpdatedAt = String(job.lifecycleUpdatedAt || "");
    changed = true;
  }
  if (!Array.isArray(job.lifecycle)) {
    job.lifecycle = [];
    changed = true;
  } else {
    const cleaned = [];
    for (const row of job.lifecycle) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const state = String(row.state || "").trim().toLowerCase();
      const at = String(row.at || "").trim();
      if (!state || !at) continue;
      const reason = row.reason == null ? "" : String(row.reason || "");
      const details = row.details && typeof row.details === "object" && !Array.isArray(row.details) ? row.details : null;
      cleaned.push(details ? { state, at, reason, details } : { state, at, reason });
    }
    if (cleaned.length !== job.lifecycle.length) changed = true;
    job.lifecycle = cleaned.slice(-200);
  }
  if (job.lifecycle.length === 0 && job.lifecycleState) {
    job.lifecycle.push({
      state: job.lifecycleState,
      at: job.startedAt || nowIso(),
      reason: job.lifecycleReason || "normalize_bootstrap",
    });
    changed = true;
  }
  if (!job.lifecycleUpdatedAt && job.lifecycle.length > 0) {
    const last = job.lifecycle[job.lifecycle.length - 1];
    job.lifecycleUpdatedAt = String(last.at || nowIso());
    changed = true;
  }
  return changed;
}

function ensureJobsShape(session) {
  if (!session || typeof session !== "object") return false;
  let changed = false;
  if (!Array.isArray(session.jobs)) {
    session.jobs = [];
    changed = true;
  }
  for (let i = 0; i < session.jobs.length; i += 1) {
    const job = session.jobs[i];
    changed = normalizeJobObject(job, `j-${String(i + 1).padStart(4, "0")}`) || changed;
  }
  if (session.jobs.length > 50) {
    session.jobs = session.jobs.slice(-50);
    changed = true;
  }
  return changed;
}

function ensureAutoShape(session) {
  if (!session || typeof session !== "object") return false;
  let changed = false;
  if (!session.auto || typeof session.auto !== "object" || Array.isArray(session.auto)) {
    session.auto = { actions: true, research: true };
    return true;
  }
  if (typeof session.auto.actions !== "boolean") {
    session.auto.actions = true;
    changed = true;
  }
  if (typeof session.auto.research !== "boolean") {
    session.auto.research = true;
    changed = true;
  }
  return changed;
}

function ensureResearchShape(session) {
  if (!session || typeof session !== "object") return false;
  let changed = false;
  if (!session.research || typeof session.research !== "object" || Array.isArray(session.research)) {
    session.research = {
      enabled: false,
      projectRoot: null,
      slug: null,
      managerConvKey: null,
      lastNoteAt: null,
    };
    return true;
  }
  if (typeof session.research.enabled !== "boolean") {
    session.research.enabled = false;
    changed = true;
  }
  for (const key of ["projectRoot", "slug", "managerConvKey", "lastNoteAt"]) {
    const value = session.research[key];
    if (value != null && typeof value !== "string") {
      session.research[key] = String(value || "");
      changed = true;
    }
  }
  if (!session.research.projectRoot) {
    session.research.projectRoot = null;
  }
  if (!session.research.slug) {
    session.research.slug = null;
  }
  if (!session.research.managerConvKey) {
    session.research.managerConvKey = null;
  }
  if (!session.research.lastNoteAt) {
    session.research.lastNoteAt = null;
  }
  return changed;
}

function newAgentRunState() {
  return {
    status: null, // null | queued | running
    provider: null,
    reason: null,
    queuedAt: null,
    startedAt: null,
    pendingMessageId: null,
    channelId: null,
    guildId: null,
    lastInterruptedAt: null,
    lastInterruptedReason: null,
  };
}

function ensureAgentRunShape(session) {
  if (!session || typeof session !== "object") return false;
  let changed = false;
  if (!session.agentRun || typeof session.agentRun !== "object" || Array.isArray(session.agentRun)) {
    session.agentRun = newAgentRunState();
    return true;
  }
  const fields = [
    "status",
    "provider",
    "reason",
    "queuedAt",
    "startedAt",
    "pendingMessageId",
    "channelId",
    "guildId",
    "lastInterruptedAt",
    "lastInterruptedReason",
  ];
  for (const key of fields) {
    const value = session.agentRun[key];
    if (value != null && typeof value !== "string") {
      session.agentRun[key] = String(value || "");
      changed = true;
    }
    if (!session.agentRun[key]) {
      session.agentRun[key] = null;
      changed = true;
    }
  }
  if (session.agentRun.status && !["queued", "running"].includes(session.agentRun.status)) {
    session.agentRun.status = null;
    changed = true;
  }
  return changed;
}

function recordAgentRunStatus(session, patch) {
  if (!session || typeof session !== "object") return;
  ensureAgentRunShape(session);
  const next = patch && typeof patch === "object" ? patch : {};
  session.agentRun = {
    ...session.agentRun,
    ...next,
  };
}

function normalizeSessionAfterLoad(session, conversationKey) {
  if (!session || typeof session !== "object") return false;
  let changed = false;
  changed = ensureTasksShape(session) || changed;
  changed = ensureTaskLoopShape(session) || changed;
  changed = ensurePlansShape(session) || changed;
  changed = ensureJobsShape(session) || changed;
  changed = ensureAutoShape(session) || changed;
  changed = ensureResearchShape(session) || changed;
  changed = ensureAgentRunShape(session) || changed;

  if (session.lastChannelId != null && typeof session.lastChannelId !== "string") {
    session.lastChannelId = null;
    changed = true;
  }
  if (session.lastGuildId != null && typeof session.lastGuildId !== "string") {
    session.lastGuildId = null;
    changed = true;
  }

  // After a relay restart, there is no running in-memory runner/child. Reset any
  // in-flight task state so `/task list` doesn't show stuck tasks.
  if (Array.isArray(session.tasks)) {
    for (const task of session.tasks) {
      if (!task || typeof task !== "object") continue;
      if (task.status === "running") {
        task.status = "pending";
        task.startedAt = null;
        task.finishedAt = null;
        task.lastError = task.lastError || "interrupted by relay restart";
        changed = true;
      }
    }
  }
  if (session.taskLoop && typeof session.taskLoop === "object") {
    if (session.taskLoop.running) {
      session.taskLoop.running = false;
      changed = true;
    }
    if (session.taskLoop.stopRequested) {
      session.taskLoop.stopRequested = false;
      changed = true;
    }
    if (session.taskLoop.currentTaskId) {
      session.taskLoop.currentTaskId = null;
      changed = true;
    }
  }

  if (session.agentRun && (session.agentRun.status === "queued" || session.agentRun.status === "running")) {
    interruptedAgentRunsAfterRestart.push({
      conversationKey: String(conversationKey || ""),
      status: session.agentRun.status,
      provider: session.agentRun.provider || CONFIG.agentProvider,
      reason: session.agentRun.reason || "request",
      queuedAt: session.agentRun.queuedAt || null,
      startedAt: session.agentRun.startedAt || null,
      pendingMessageId: session.agentRun.pendingMessageId || null,
      channelId: session.agentRun.channelId || session.lastChannelId || null,
      guildId: session.agentRun.guildId || session.lastGuildId || null,
    });
    session.agentRun.lastInterruptedAt = nowIso();
    session.agentRun.lastInterruptedReason = "interrupted by relay restart";
    session.agentRun.status = null;
    session.agentRun.provider = null;
    session.agentRun.reason = null;
    session.agentRun.queuedAt = null;
    session.agentRun.startedAt = null;
    session.agentRun.pendingMessageId = null;
    changed = true;
  }
  return changed;
}

async function ensureStateLoaded() {
  await fsp.mkdir(CONFIG.stateDir, { recursive: true });
  if (CONFIG.uploadEnabled || CONFIG.discordAttachmentsEnabled) {
    await fsp.mkdir(CONFIG.uploadRootDir, { recursive: true });
  }
  if (CONFIG.researchEnabled && !CONFIG.researchProjectsRootError) {
    await fsp.mkdir(CONFIG.researchProjectsRoot, { recursive: true });
  }
  try {
    const raw = await fsp.readFile(CONFIG.stateFile, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.sessions && typeof parsed.sessions === "object") {
      state.version = Number(parsed.version || 1);
      state.sessions = parsed.sessions;
      let mutated = false;
      for (const [conversationKey, session] of Object.entries(state.sessions)) {
        mutated = normalizeSessionAfterLoad(session, conversationKey) || mutated;
      }
      if (mutated) await queueSaveState();
      return;
    }
  } catch {}
  await queueSaveState();
}

function queueSaveState() {
  saveChain = saveChain
    .then(async () => {
      const tmp = `${CONFIG.stateFile}.tmp`;
      await fsp.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await fsp.rename(tmp, CONFIG.stateFile);
    })
    .catch((err) => {
      console.error("Failed saving state:", err.message);
    });
  return saveChain;
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let idx = 0;
  while (idx < text.length) {
    let end = Math.min(idx + maxLen, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > idx + 400) end = nl;
    }
    chunks.push(text.slice(idx, end));
    idx = end;
  }
  return chunks;
}

function summarizeContextDiagnostic(diag) {
  const spec = diag && diag.rawSpec ? diag.rawSpec : "(unknown)";
  const resolved = diag && diag.resolvedPath ? diag.resolvedPath : "(unresolved)";
  if (!diag || !diag.exists) {
    const err = diag && diag.error ? ` error=${diag.error}` : "";
    return `- ${spec} -> ${resolved} [missing${err}]`;
  }
  if (!diag.isFile) {
    return `- ${spec} -> ${resolved} [not-file]`;
  }
  const parts = [
    `size=${diag.size}`,
    diag.mtimeIso ? `mtime=${diag.mtimeIso}` : null,
    `loaded=${diag.loadedChars}`,
    `injected=${diag.injectedChars || 0}`,
    diag.truncated ? "truncated" : null,
  ].filter(Boolean);
  return `- ${spec} -> ${resolved} [${parts.join(" ")}]`;
}

function formatElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function formatAgentTimeoutLabel(timeoutMs) {
  const n = Number(timeoutMs || 0);
  if (!Number.isFinite(n) || n <= 0) return "none";
  return formatElapsed(n);
}

function formatWallClock(tsMs) {
  const d = new Date(Number(tsMs || Date.now()));
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const HH = String(d.getHours()).padStart(2, "0");
  const MM = String(d.getMinutes()).padStart(2, "0");
  const SS = String(d.getSeconds()).padStart(2, "0");
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  const offH = String(Math.floor(absOffset / 60)).padStart(2, "0");
  const offM = String(absOffset % 60).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS} ${sign}${offH}:${offM}`;
}

function cleanProgressText(value, maxChars = 160) {
  let text = String(value || "");
  if (!text) return "";
  text = text.replace(/\r?\n+/g, " ");
  text = text.replace(/`+/g, "");
  text = text.replace(/\*\*/g, "");
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

const PERSISTENT_PROGRESS_LOW_SIGNAL_PREFIXES = [
  "queued request",
  "waiting for an earlier request",
  "starting codex run",
  "starting claude run",
  "analyzing request",
  "session started",
  "agent process started",
  "loaded relay runtime context",
  "loaded ",
  "no attachments injected",
  "running shell command",
  "shell command finished",
  "running tool:",
  "tool finished:",
  "tool failed:",
  "working on ",
  "completed ",
  "updating files",
  "finished updating files",
  "preparing final response",
  "claude model selected:",
  "no new agent events for ",
];

function derivePersistentProgressMilestone(cleanedText) {
  const text = String(cleanedText || "").trim();
  if (!text) return "";
  const lower = text.toLowerCase();

  if (lower === "queued request") return "Milestone: request queued";
  if (lower.startsWith("waiting for an earlier request")) return "Milestone: waiting for earlier queued request";
  if (lower.startsWith("starting codex run") || lower.startsWith("starting claude run")) return "Milestone: run started";
  if (lower.startsWith("loaded relay runtime context")) return "Milestone: context loaded";
  if (lower.startsWith("loaded ") && lower.includes("attachment")) return "Milestone: attachments loaded";
  if (lower.startsWith("claude exited during init; retrying once")) return "Milestone: transient init failure detected, retrying";
  if (lower.startsWith("session ") && lower.includes("could not be resumed")) return "Milestone: stale session detected, starting a new session";
  if (lower.startsWith("preparing final response")) return "Milestone: ready to summarize";

  return "";
}

const PERSISTENT_PROGRESS_SYSTEM_MILESTONES = new Set([
  "milestone: request queued",
  "milestone: waiting for earlier queued request",
  "milestone: run started",
  "milestone: context loaded",
  "milestone: attachments loaded",
]);

function isSuppressedPersistentSystemMilestone(cleanedText) {
  if (!CONFIG.progressPersistentSuppressSystemMilestones) return false;
  const key = String(cleanedText || "").trim().toLowerCase();
  return PERSISTENT_PROGRESS_SYSTEM_MILESTONES.has(key);
}

function derivePersistentProgressOrchestrator(cleanedText) {
  const text = String(cleanedText || "").trim();
  if (!text) return "";
  const match = text.match(/^thinking:\s*(.+)$/i);
  if (!match) return "";
  const body = cleanProgressText(match[1], Math.max(80, CONFIG.progressPersistentMaxChars));
  if (!body) return "";
  if (body.length < Math.max(16, Math.floor(CONFIG.progressPersistentMinChars / 2))) return "";
  const capitalizeStart = (value) => {
    const raw = String(value || "");
    if (!raw) return "";
    return `${raw[0].toUpperCase()}${raw.slice(1)}`;
  };
  const lowerStart = (value) => {
    const raw = String(value || "");
    if (!raw) return "";
    return `${raw[0].toLowerCase()}${raw.slice(1)}`;
  };

  // Keep natural first-person commentary untouched.
  if (/^(i|we)(?:\b|['’](?:m|ll|d|ve|re))/i.test(body)) return capitalizeStart(body);
  if (/^let me\b/i.test(body)) return capitalizeStart(body);
  if (/^let's\b/i.test(body)) return capitalizeStart(body);

  // Convert common concise action phrases into natural first-person.
  if (/^[A-Za-z]+ing\b/.test(body)) return `I'm ${lowerStart(body)}`;
  if (
    /^(plan|check|read|review|inspect|analy[sz]e|summari[sz]e|trace|gather|collect|run|test|update|patch|sync|restart|verify|(?:investigate|investigation|investigating)|fix|debug|search|open)\b/i.test(
      body
    )
  ) {
    return `I'll ${lowerStart(body)}`;
  }

  // Fallback: preserve model wording instead of forcing awkward rewrites.
  return capitalizeStart(body);
}

function normalizePersistentProgress(value) {
  const maxChars = Math.max(120, CONFIG.progressPersistentMaxChars);
  const cleaned = cleanProgressText(value, maxChars);
  if (!cleaned) return { text: "", isMilestone: false, isOrchestrator: false };

  const mode = CONFIG.progressPersistentMode;
  if (mode === "off") return { text: "", isMilestone: false, isOrchestrator: false };
  if (mode === "all") return { text: cleaned, isMilestone: false, isOrchestrator: false };

  if (mode === "narrative+milestones" || mode === "narrative+milestones+orchestrator") {
    const milestone = derivePersistentProgressMilestone(cleaned);
    if (milestone) {
      return {
        text: cleanProgressText(milestone, maxChars),
        isMilestone: true,
        isOrchestrator: false,
      };
    }
  }

  if (mode === "narrative+milestones+orchestrator") {
    const orchestrator = derivePersistentProgressOrchestrator(cleaned);
    if (orchestrator) {
      return {
        text: cleanProgressText(orchestrator, maxChars),
        isMilestone: false,
        isOrchestrator: true,
      };
    }
  }

  const lower = cleaned.toLowerCase();
  if (PERSISTENT_PROGRESS_LOW_SIGNAL_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return { text: "", isMilestone: false, isOrchestrator: false };
  }
  if (cleaned.length < CONFIG.progressPersistentMinChars) {
    return { text: "", isMilestone: false, isOrchestrator: false };
  }
  return { text: cleaned, isMilestone: false, isOrchestrator: false };
}

function humanizeStepType(value) {
  const raw = cleanProgressText(value, 80).toLowerCase();
  if (!raw) return "step";
  return raw.replace(/[_-]+/g, " ");
}

function commandPreview(command) {
  const raw = cleanProgressText(command, 140);
  if (!raw) return "";
  if (CONFIG.progressShowCommands) return raw;
  const firstToken = raw.split(/\s+/)[0] || "";
  return path.basename(firstToken) || "";
}

function emitProgress(onProgress, text) {
  if (typeof onProgress !== "function") return;
  const cleaned = cleanProgressText(text, 180);
  if (!cleaned) return;
  try {
    onProgress(cleaned);
  } catch {}
}

function summarizeCodexItemProgress(item, phase) {
  if (!item || typeof item !== "object") return null;
  const kind = String(item.type || "")
    .trim()
    .toLowerCase();
  if (!kind || kind === "agent_message") return null;

  if (kind === "reasoning") {
    if (phase === "completed" && typeof item.text === "string") {
      const thought = cleanProgressText(item.text, 140);
      if (thought) return `Thinking: ${thought}`;
    }
    return phase === "started" ? "Thinking" : null;
  }

  if (kind === "command_execution") {
    const preview = commandPreview(item.command);
    if (phase === "started" || item.status === "in_progress") {
      if (CONFIG.progressShowCommands && preview) return `Running shell command: ${preview}`;
      if (preview) return `Running shell command (${preview})`;
      return "Running shell command";
    }
    const exitCode =
      item.exit_code == null || item.exit_code === "" ? "" : ` (exit ${String(item.exit_code)})`;
    return `Shell command finished${exitCode}`;
  }

  if (kind === "file_change") {
    return phase === "started" ? "Updating files" : "Finished updating files";
  }

  const label = humanizeStepType(kind);
  return phase === "started" ? `Working on ${label}` : `Completed ${label}`;
}

function summarizeCodexProgressEvent(evt) {
  if (!evt || typeof evt !== "object") return null;
  if (evt.type === "thread.started") {
    if (typeof evt.thread_id === "string" && evt.thread_id) {
      return `Session started (${evt.thread_id})`;
    }
    return "Session started";
  }
  if (evt.type === "turn.started") return "Analyzing request";
  if (evt.type === "turn.completed") return "Preparing final response";
  if (evt.type === "item.started") return summarizeCodexItemProgress(evt.item, "started");
  if (evt.type === "item.completed") return summarizeCodexItemProgress(evt.item, "completed");
  return null;
}

function summarizeClaudeProgressEvent(evt, toolMetaById) {
  if (!evt || typeof evt !== "object") return null;
  const type = String(evt.type || "").toLowerCase();

  if (type === "system" && evt.subtype === "init") {
    if (typeof evt.session_id === "string" && evt.session_id) {
      return `Session started (${evt.session_id})`;
    }
    return "Session started";
  }

  if (type === "assistant") {
    const msg = evt.message && typeof evt.message === "object" ? evt.message : null;
    const content = msg && Array.isArray(msg.content) ? msg.content : [];
    let thinkingLine = null;

    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "tool_use") {
        const toolName = cleanProgressText(part.name || "tool", 40) || "tool";
        let toolDetail = "";
        if (
          CONFIG.progressShowCommands &&
          toolName.toLowerCase() === "bash" &&
          part.input &&
          typeof part.input.command === "string"
        ) {
          toolDetail = cleanProgressText(part.input.command, 120);
        }
        if (!toolDetail && part.input && typeof part.input.description === "string") {
          toolDetail = cleanProgressText(part.input.description, 90);
        }
        if (typeof part.id === "string" && part.id) {
          toolMetaById.set(part.id, { name: toolName, detail: toolDetail });
        }
        if (toolDetail) return `Running tool: ${toolName} (${toolDetail})`;
        return `Running tool: ${toolName}`;
      }
      if (part.type === "text" && !thinkingLine && typeof part.text === "string") {
        const text = cleanProgressText(part.text, 140);
        if (text && text.length >= 16 && !/^(ok|done|yes|no)$/i.test(text)) {
          thinkingLine = `Thinking: ${text}`;
        }
      }
    }

    return thinkingLine;
  }

  if (type === "user") {
    const msg = evt.message && typeof evt.message === "object" ? evt.message : null;
    const content = msg && Array.isArray(msg.content) ? msg.content : [];
    for (const part of content) {
      if (!part || typeof part !== "object" || part.type !== "tool_result") continue;
      const toolId = typeof part.tool_use_id === "string" ? part.tool_use_id : "";
      const toolMeta = toolMetaById.get(toolId);
      let toolName = "tool";
      let toolDetail = "";
      if (toolMeta && typeof toolMeta === "object") {
        toolName = cleanProgressText(toolMeta.name || "tool", 40) || "tool";
        toolDetail = cleanProgressText(toolMeta.detail || "", 100);
      } else if (typeof toolMeta === "string") {
        toolName = cleanProgressText(toolMeta, 40) || "tool";
      }
      const suffix = toolDetail ? ` (${toolDetail})` : "";
      return part.is_error ? `Tool failed: ${toolName}${suffix}` : `Tool finished: ${toolName}${suffix}`;
    }
    return null;
  }

  if (type === "result") return "Preparing final response";
  return null;
}

function recordInterruptProgressLine(conversationKey, line, { synthetic = false } = {}) {
  const key = String(conversationKey || "").trim();
  const text = String(line || "").trim();
  if (!key || !text) return;
  const now = nowIso();
  const keepPerConversation = Math.max(20, CONFIG.interruptQuestionsSnapshotProgressLines * 4);
  const keepConversations = 200;

  let row = interruptProgressByConversation.get(key);
  if (!row || typeof row !== "object") {
    row = { entries: [] };
  }
  if (!Array.isArray(row.entries)) row.entries = [];
  if (row.entries.length > 0 && row.entries[row.entries.length - 1].text === text) return;

  row.entries.push({
    at: now,
    text,
    synthetic: Boolean(synthetic),
  });
  if (row.entries.length > keepPerConversation) {
    row.entries.splice(0, row.entries.length - keepPerConversation);
  }
  row.updatedAtMs = Date.now();
  interruptProgressByConversation.set(key, row);

  if (interruptProgressByConversation.size > keepConversations) {
    const oldest = Array.from(interruptProgressByConversation.entries())
      .sort((a, b) => Number(a[1] && a[1].updatedAtMs ? a[1].updatedAtMs : 0) - Number(b[1] && b[1].updatedAtMs ? b[1].updatedAtMs : 0))
      .slice(0, interruptProgressByConversation.size - keepConversations);
    for (const [dropKey] of oldest) interruptProgressByConversation.delete(dropKey);
  }
}

function getInterruptProgressLines(conversationKey) {
  const key = String(conversationKey || "").trim();
  if (!key) return [];
  const row = interruptProgressByConversation.get(key);
  const list = row && Array.isArray(row.entries) ? row.entries : [];
  if (!list.length) return [];
  const limit = Math.max(1, CONFIG.interruptQuestionsSnapshotProgressLines);
  return list.slice(-limit).map((entry) => {
    const at = entry && entry.at ? String(entry.at) : "";
    const text = entry && entry.text ? String(entry.text) : "";
    return at ? `${at} | ${text}` : text;
  });
}

function createProgressReporter(pendingMsg, conversationKey, { runId = null, runReason = "", channel = null } = {}) {
  const traceRunId = runId ? String(runId) : null;
  const traceReason = String(runReason || "").trim() || null;
  const startedAt = Date.now();
  const persistentEnabled = Boolean(
    CONFIG.progressPersistentEnabled && channel && typeof channel.send === "function"
  );
  let persistentSent = 0;
  let lastPersistentAt = 0;
  let lastPersistentOrchestratorAt = 0;
  let lastPersistentText = "";
  let persistentChain = Promise.resolve();

  const persistentIntervalMsFor = (isOrchestrator, nowMs) => {
    const baseMs = isOrchestrator
      ? CONFIG.progressPersistentOrchestratorEveryMs
      : CONFIG.progressPersistentEveryMs;
    if (!CONFIG.progressPersistentAdaptiveEnabled) return baseMs;
    const elapsedMs = Math.max(0, nowMs - startedAt);
    const step = Math.floor(elapsedMs / CONFIG.progressPersistentAdaptiveRampEveryMs);
    const scale = Math.min(CONFIG.progressPersistentAdaptiveMaxScale, Math.max(1, 1 + step));
    return Math.max(baseMs, baseMs * scale);
  };

  const traceProgress = (text, synthetic) => {
    if (!CONFIG.progressTraceEnabled) return;
    if (synthetic && !CONFIG.progressTraceIncludeSynthetic) return;
    logRelayEvent("agent.progress.note", {
      conversationKey: conversationKey || null,
      runId: traceRunId,
      reason: traceReason,
      synthetic: Boolean(synthetic),
      note: cleanProgressText(text, CONFIG.progressTraceMaxChars),
    });
  };

  const maybePostPersistent = (text, { synthetic = false, force = false } = {}) => {
    if (!persistentEnabled || synthetic) return;
    const normalized = normalizePersistentProgress(text);
    const cleaned = normalized && normalized.text ? String(normalized.text) : "";
    const isMilestone = Boolean(normalized && normalized.isMilestone);
    const isOrchestrator = Boolean(normalized && normalized.isOrchestrator);
    if (!cleaned) return;
    if (isMilestone && isSuppressedPersistentSystemMilestone(cleaned)) return;
    const now = Date.now();
    if (!force) {
      if (persistentSent >= CONFIG.progressPersistentMaxPerRun) return;
      if (cleaned === lastPersistentText) return;
      if (isOrchestrator) {
        const intervalMs = persistentIntervalMsFor(true, now);
        if (
          lastPersistentOrchestratorAt > 0 &&
          now - lastPersistentOrchestratorAt < intervalMs
        ) {
          return;
        }
      } else if (!isMilestone) {
        const intervalMs = persistentIntervalMsFor(false, now);
        if (lastPersistentAt > 0 && now - lastPersistentAt < intervalMs) {
          return;
        }
      }
    }

    persistentChain = persistentChain
      .catch(() => {})
      .then(async () => {
        const now2 = Date.now();
        if (!force) {
          if (persistentSent >= CONFIG.progressPersistentMaxPerRun) return;
          if (cleaned === lastPersistentText) return;
          if (isOrchestrator) {
            const intervalMs = persistentIntervalMsFor(true, now2);
            if (
              lastPersistentOrchestratorAt > 0 &&
              now2 - lastPersistentOrchestratorAt < intervalMs
            ) {
              return;
            }
          } else if (!isMilestone) {
            const intervalMs = persistentIntervalMsFor(false, now2);
            if (lastPersistentAt > 0 && now2 - lastPersistentAt < intervalMs) {
              return;
            }
          }
        }
        const elapsed = formatElapsed(now2 - startedAt);
        const message = `Progress update (${elapsed}): ${cleaned}`;
        try {
          await channel.send(message);
          persistentSent += 1;
          lastPersistentAt = Date.now();
          if (isOrchestrator) lastPersistentOrchestratorAt = lastPersistentAt;
          lastPersistentText = cleaned;
        } catch (err) {
          logRelayEvent("progress.persistent.error", {
            conversationKey,
            provider: CONFIG.agentProvider,
            error: String(err && err.message ? err.message : err).slice(0, 240),
          });
        }
      });
  };

  if (!CONFIG.progressEnabled || !pendingMsg || typeof pendingMsg.edit !== "function") {
    return {
      note(text, options = {}) {
        const cleaned = cleanProgressText(text, 180);
        if (!cleaned) return;
        const synthetic = Boolean(options && options.synthetic);
        const forcePersistent = Boolean(options && options.persist);
        recordInterruptProgressLine(conversationKey, cleaned, { synthetic });
        traceProgress(cleaned, synthetic);
        maybePostPersistent(cleaned, { synthetic, force: forcePersistent });
      },
      async stop() {
        try {
          await persistentChain;
        } catch {}
      },
    };
  }

  const maxLines = Math.max(1, CONFIG.progressMaxLines);
  const keepLines = Math.max(maxLines * 3, maxLines);
  const minEditMs = Math.max(500, CONFIG.progressMinEditMs);
  const heartbeatMs = Math.max(minEditMs, CONFIG.progressHeartbeatMs);
  const lines = [];
  const timeoutLabel = formatAgentTimeoutLabel(CONFIG.agentTimeoutMs);

  let dirty = true;
  let stopped = false;
  let lastEditAt = 0;
  let lastRendered = "";
  let delayedFlushTimer = null;
  let editChain = Promise.resolve();
  let lastActivityAt = Date.now();
  let lastStallWarnAt = 0;

  function render() {
    const now = Date.now();
    const elapsed = formatElapsed(now - startedAt);
    const lastEventAgo = formatElapsed(now - lastActivityAt);
    const updatedAt = formatWallClock(now);
    const header = `Running ${AGENT_LABEL}... (elapsed ${elapsed} | timeout ${timeoutLabel} | updated ${updatedAt} | last event ${lastEventAgo} ago)`;
    const visible = lines.slice(-maxLines);
    if (visible.length === 0) return header;
    return `${header}\n${visible.map((line) => `- ${line}`).join("\n")}`;
  }

  function queueFlush(force = false) {
    if (stopped) return;
    editChain = editChain
      .catch(() => {})
      .then(async () => {
        if (stopped) return;
        const now = Date.now();
        const since = now - lastEditAt;
        const dueHeartbeat = since >= heartbeatMs;
        const dueDirty = dirty && since >= minEditMs;
        if (!force && !dueHeartbeat && !dueDirty) return;

        const content = render();
        if (content === lastRendered && !dueHeartbeat && !force) return;

        try {
          const editPromise = Promise.resolve().then(() => pendingMsg.edit(content));
          // Guard against a hanging Discord edit request so progress updates cannot deadlock.
          editPromise.catch(() => {});
          await Promise.race([
            editPromise,
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error(`progress edit timeout after ${CONFIG.progressEditTimeoutMs}ms`)),
                CONFIG.progressEditTimeoutMs
              )
            ),
          ]);
          lastRendered = content;
          lastEditAt = Date.now();
          dirty = false;
        } catch (err) {
          logRelayEvent("progress.edit.error", {
            conversationKey,
            provider: CONFIG.agentProvider,
            error: String(err && err.message ? err.message : err).slice(0, 240),
          });
        }
      });
  }

  function scheduleDelayedFlush() {
    if (stopped || delayedFlushTimer) return;
    const waitMs = Math.max(0, minEditMs - (Date.now() - lastEditAt));
    delayedFlushTimer = setTimeout(() => {
      delayedFlushTimer = null;
      queueFlush(false);
    }, waitMs);
  }

  function note(text, options = {}) {
    if (stopped) return;
    const synthetic = !!(options && options.synthetic);
    const forcePersistent = Boolean(options && options.persist);
    const cleaned = cleanProgressText(text, 180);
    if (!cleaned) return;
    if (lines[lines.length - 1] === cleaned) return;
    lines.push(cleaned);
    if (lines.length > keepLines) lines.splice(0, lines.length - keepLines);
    recordInterruptProgressLine(conversationKey, cleaned, { synthetic });
    traceProgress(cleaned, synthetic);
    maybePostPersistent(cleaned, { synthetic, force: forcePersistent });
    dirty = true;
    if (!synthetic) {
      lastActivityAt = Date.now();
      lastStallWarnAt = 0;
    }

    if (Date.now() - lastEditAt >= minEditMs) queueFlush(false);
    else scheduleDelayedFlush();
  }

  const heartbeatTick = setInterval(() => {
    const now = Date.now();
    if (CONFIG.progressStallWarnMs > 0) {
      const idleMs = now - lastActivityAt;
      const sinceWarn = lastStallWarnAt > 0 ? now - lastStallWarnAt : Number.POSITIVE_INFINITY;
      if (idleMs >= CONFIG.progressStallWarnMs && sinceWarn >= CONFIG.progressStallWarnMs) {
        note(`No new agent events for ${formatElapsed(idleMs)} (possible stall)`, { synthetic: true });
        lastStallWarnAt = now;
      }
    }
    queueFlush(false);
  }, Math.max(1000, Math.min(minEditMs, 5000)));

  note("Queued request");
  queueFlush(true);

  return {
    note,
    stop: async () => {
      stopped = true;
      if (delayedFlushTimer) clearTimeout(delayedFlushTimer);
      clearInterval(heartbeatTick);
      try {
        await editChain;
      } catch {}
      try {
        await persistentChain;
      } catch {}
    },
  };
}

function getConversationKey(message) {
  if (!message.guildId) return `dm:${message.author.id}`;
  if (message.channel && message.channel.isThread && message.channel.isThread()) {
    return `discord:${message.guildId}:thread:${message.channel.id}`;
  }
  return `discord:${message.guildId}:channel:${message.channelId}`;
}

function getSession(key) {
  const existing = state.sessions[key];
  if (existing && typeof existing === "object") {
    ensureTasksShape(existing);
    ensureTaskLoopShape(existing);
    ensurePlansShape(existing);
    ensureJobsShape(existing);
    ensureAutoShape(existing);
    ensureResearchShape(existing);
    ensureAgentRunShape(existing);
    return existing;
  }
  const created = {
    threadId: null,
    workdir: CONFIG.defaultWorkdir,
    contextVersion: 0,
    updatedAt: nowIso(),
    tasks: [],
    taskLoop: { running: false, stopRequested: false, currentTaskId: null },
    plans: [],
    jobs: [],
    auto: { actions: true, research: true },
    research: {
      enabled: false,
      projectRoot: null,
      slug: null,
      managerConvKey: null,
      lastNoteAt: null,
    },
    agentRun: newAgentRunState(),
    lastChannelId: null,
    lastGuildId: null,
  };
  state.sessions[key] = created;
  return created;
}

function isTaskRunnerActive(conversationKey, session) {
  if (!conversationKey) return Boolean(session && session.taskLoop && session.taskLoop.running);
  if (taskRunnerByConversation.has(conversationKey)) return true;
  return Boolean(session && session.taskLoop && session.taskLoop.running);
}

function extractPrompt(message, botUserId) {
  let text = message.content || "";
  if (message.guildId) {
    const mentionRegex = new RegExp(`<@!?${botUserId}>`, "g");
    text = text.replace(mentionRegex, " ");
  }
  return text.trim();
}

function parseCommand(prompt) {
  const match = prompt.match(
    /^\/(help|status|reset|workdir|attach|upload|context|task|worktree|plan|handoff|research|auto|go|overnight|job|exp|ask|inject)\b(?:\s+([\s\S]+))?$/i
  );
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    arg: (match[2] || "").trim(),
  };
}

function commandHead(command) {
  if (!command || typeof command !== "object") return "";
  const { head } = splitFirstToken(String(command.arg || ""));
  return String(head || "").toLowerCase();
}

function shouldBypassConversationQueue(command) {
  if (!command || typeof command !== "object") return false;

  // Always-fast control/status commands.
  if (command.name === "help" || command.name === "status" || command.name === "ask" || command.name === "inject") {
    return true;
  }

  if (command.name === "task") {
    const sub = commandHead(command);
    // Keep task inspection and emergency stop responsive during long runs.
    return !sub || sub === "list" || sub === "stop";
  }

  if (command.name === "context") {
    const sub = String(command.arg || "").trim().toLowerCase();
    // `/context reload` mutates state and should remain ordered in queue.
    return sub !== "reload";
  }

  if (command.name === "auto") {
    // `/auto` without args is read-only status.
    return !commandHead(command);
  }

  if (command.name === "research" || command.name === "overnight") {
    const sub = commandHead(command) || "status";
    return sub === "status";
  }

  if (command.name === "plan") {
    const sub = commandHead(command);
    return !sub || sub === "list" || sub === "show";
  }

  if (command.name === "worktree") {
    const sub = commandHead(command);
    return !sub || sub === "list";
  }

  if (command.name === "job") {
    const sub = commandHead(command);
    // list and logs are read-only; no sub also defaults to list.
    return !sub || sub === "list" || sub === "logs";
  }

  if (command.name === "exp") {
    const sub = commandHead(command);
    return !sub || sub === "best" || sub === "report";
  }

  return false;
}

function getSessionContextVersion(session) {
  if (!session || typeof session !== "object") return 0;
  const n = Number(session.contextVersion || 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function shouldInjectRelayContext(session) {
  if (!CONFIG.contextEnabled) return false;
  if (CONFIG.contextEveryTurn) return true;
  return getSessionContextVersion(session) < CONFIG.contextVersion;
}

function resolveContextSpecPath(specPath, session) {
  const baseWorkdir = session && session.workdir ? session.workdir : CONFIG.defaultWorkdir;
  if (path.isAbsolute(specPath)) return path.resolve(specPath);
  return path.resolve(baseWorkdir, specPath);
}

function truncateContextByMode(rawText, mode, maxChars) {
  const text = String(rawText || "");
  if (!text) return { text: "", truncated: false };
  if (maxChars <= 0) return { text: "", truncated: text.length > 0 };
  if (text.length <= maxChars) return { text, truncated: false };

  const truncSuffix = "\n...[context truncated]";
  const truncPrefix = "...[context truncated]\n";
  const truncMiddleSuffix = "\n...[context truncated middle]";
  const headTailJoiner = "\n...[snip]...\n";

  // Keep oldest content for head mode and append a marker.
  const truncateHead = () => {
    if (truncSuffix.length >= maxChars) return truncSuffix.slice(0, maxChars);
    const keep = Math.max(0, maxChars - truncSuffix.length);
    return `${text.slice(0, keep)}${truncSuffix}`;
  };

  // Keep newest content for tail mode and prefix a marker.
  const truncateTail = () => {
    if (truncPrefix.length >= maxChars) return truncPrefix.slice(0, maxChars);
    const keep = Math.max(0, maxChars - truncPrefix.length);
    return `${truncPrefix}${text.slice(-keep)}`;
  };

  const truncateHeadTail = () => {
    if (truncMiddleSuffix.length >= maxChars) return truncMiddleSuffix.slice(0, maxChars);
    const bodyBudget = Math.max(0, maxChars - truncMiddleSuffix.length);
    if (bodyBudget <= 0) return truncMiddleSuffix.slice(0, maxChars);

    let body = "";
    if (headTailJoiner.length >= bodyBudget) {
      body = text.slice(0, bodyBudget);
    } else {
      const splitBudget = bodyBudget - headTailJoiner.length;
      const headLen = Math.max(1, Math.floor(splitBudget / 2));
      const tailLen = Math.max(1, splitBudget - headLen);
      const head = text.slice(0, headLen);
      const tail = text.slice(-tailLen);
      body = `${head}${headTailJoiner}${tail}`;
    }
    if (body.length > bodyBudget) body = body.slice(0, bodyBudget);
    return `${body}${truncMiddleSuffix}`;
  };

  if (mode === "tail") {
    return {
      text: truncateTail(),
      truncated: true,
    };
  }

  if (mode === "headtail") {
    return {
      text: truncateHeadTail(),
      truncated: true,
    };
  }

  return {
    text: truncateHead(),
    truncated: true,
  };
}

async function buildRelayContextArtifacts(session) {
  const diagnostics = [];
  if (!CONFIG.contextSpecs.length) {
    return { text: "", diagnostics, injectedChars: 0, includedFiles: 0 };
  }

  for (const spec of CONFIG.contextSpecs) {
    const resolvedPath = resolveContextSpecPath(spec.specPath, session);
    const diag = {
      rawSpec: spec.rawSpec,
      mode: spec.mode,
      configuredPath: spec.specPath,
      resolvedPath,
      exists: false,
      isFile: false,
      size: 0,
      mtimeIso: "",
      loadedChars: 0,
      injectedChars: 0,
      truncated: false,
      error: "",
      _text: "",
    };
    try {
      const st = await fsp.stat(resolvedPath);
      diag.exists = true;
      diag.isFile = st.isFile();
      diag.size = Number(st.size || 0);
      diag.mtimeIso = st.mtime ? st.mtime.toISOString() : "";
      if (!diag.isFile) {
        diag.error = "not a file";
        diagnostics.push(diag);
        continue;
      }
      const raw = await fsp.readFile(resolvedPath, "utf8");
      const trimmed = String(raw || "").trim();
      diag.loadedChars = trimmed.length;
      diag._text = trimmed;
    } catch (err) {
      diag.error = String(err && err.code ? err.code : err && err.message ? err.message : "read failed");
    }
    diagnostics.push(diag);
  }

  const withText = diagnostics.filter((diag) => diag._text && diag._text.length > 0);
  const includeLabels = withText.length > 1;
  const pieces = [];
  let remaining = CONFIG.contextMaxChars;
  let includedFiles = 0;

  for (const diag of diagnostics) {
    if (!diag._text) continue;
    if (remaining <= 0) break;

    const separator = pieces.length > 0 ? "\n\n" : "";
    const separatorCost = separator.length;
    if (remaining <= separatorCost) break;

    const perFileBudget = Math.min(CONFIG.contextMaxCharsPerFile, remaining - separatorCost);
    if (perFileBudget <= 0) break;

    const label = includeLabels
      ? `### Context file: ${diag.rawSpec} (resolved: ${diag.resolvedPath})\n`
      : "";
    const textBudget = Math.max(0, perFileBudget - label.length);
    if (textBudget <= 0) continue;

    const truncated = truncateContextByMode(diag._text, diag.mode, textBudget);
    if (!truncated.text) continue;

    const chunk = `${label}${truncated.text}`;
    diag.truncated = truncated.truncated;
    diag.injectedChars = chunk.length;
    pieces.push(`${separator}${chunk}`);
    remaining -= separatorCost + chunk.length;
    includedFiles += 1;
  }

  for (const diag of diagnostics) delete diag._text;
  const text = pieces.join("");
  return {
    text,
    diagnostics,
    injectedChars: text.length,
    includedFiles,
  };
}

function buildRelayRuntimeContext(meta) {
  const scope = meta && meta.isDm ? "dm" : meta && meta.isThread ? "guild-thread" : "guild-channel";
  const uploadDir = meta && meta.uploadDir ? meta.uploadDir : CONFIG.uploadRootDir;
  const workdir = meta && meta.session && meta.session.workdir ? meta.session.workdir : CONFIG.defaultWorkdir;
  const actionsConfigHint = `RELAY_AGENT_ACTIONS_ENABLED=${CONFIG.agentActionsEnabled ? "true" : "false"}, RELAY_AGENT_ACTIONS_DM_ONLY=${
    CONFIG.agentActionsDmOnly ? "true" : "false"
  }`;
  const lines = [
    `You are running through a Discord relay (provider=${CONFIG.agentProvider}, scope=${scope}).`,
    "Your response is posted back to Discord.",
    `Conversation key: ${meta && meta.conversationKey ? meta.conversationKey : "unknown"}`,
    `Current workdir: ${workdir}`,
    "",
    "Relay capabilities:",
    "- Slash commands exist for the user: /status, /reset, /workdir, /attach, /upload, /context, /task, /worktree, /plan, /handoff, /research, /auto, /go, /overnight, /job, /exp.",
    "- Tip: `/plan queue <id|last>` can enqueue a plan's Task breakdown into `/task`, then `/task run` can execute sequentially.",
    "- You cannot execute slash commands directly; ask the user to run them when needed.",
    "- If you need to launch a long-running shell job and watch it, you may request relay actions via a JSON block:",
    `- [[relay-actions]]{"actions":[{"type":"job_start","command":"sleep 3 && echo done","watch":{"everySec":300,"tailLines":30}}]}[[/relay-actions]] (current: ${actionsConfigHint}).`,
    "- Avoid foreground monitor loops (`sleep` + `tail`) inside normal turns; prefer `job_start` + `watch` + `thenTask`.",
  ];
  if (CONFIG.discordAttachmentsEnabled) {
    const attachmentMode = CONFIG.discordAttachmentsZipEnabled
      ? "small text attachments (and .zip archives with text-entry extraction)"
      : "small text attachments";
    lines.push(
      `- Incoming Discord attachments: the relay downloads ${attachmentMode} to ${path.join(
        uploadDir,
        "attachments"
      )} and appends their contents to the prompt.`
    );
  }
  if (CONFIG.uploadEnabled) {
    lines.push(
      "- File attachment bridge is enabled.",
      `- Preferred upload base dir: ${uploadDir}`,
      "- To attach a local file, include markers like [[upload:relative/or/absolute/path]] in your final response.",
      "- Images are shown inline by Discord when supported; non-image files are sent as downloadable attachments.",
      "- Do not claim uploads are unsupported unless an actual error occurred."
    );
  } else {
    lines.push("- File attachment bridge is disabled in this relay instance.");
  }
  lines.push(
    "",
    "Respond to the user normally; this context only describes runtime behavior."
  );
  return lines.join("\n");
}

async function buildAgentPrompt(session, userPrompt, meta) {
  if (!shouldInjectRelayContext(session)) {
    return { prompt: userPrompt, contextInjected: false, contextMeta: null };
  }
  const runtimeContext = buildRelayRuntimeContext({ ...meta, session });
  const contextArtifacts = await buildRelayContextArtifacts(session);
  const extraContext = contextArtifacts.text;
  const contextBlock = extraContext
    ? `${runtimeContext}\n\nInstance-specific context:\n${extraContext}`
    : runtimeContext;
  const prompt = ["[Relay Runtime Context]", contextBlock, "", "[User Message]", userPrompt].join("\n");
  return { prompt, contextInjected: true, contextMeta: contextArtifacts };
}

function buildCodexArgs(session, prompt) {
  const args = ["exec"];

  const appendSharedFlags = () => appendCodexSharedFlags(args);

  if (session.threadId) {
    // For nested `exec resume`, `--sandbox` must be bound to `exec` (before `resume`).
    if (CONFIG.sandbox) args.push("--sandbox", CONFIG.sandbox);
    args.push("resume", session.threadId);
    if (CONFIG.skipGitRepoCheck) args.push("--skip-git-repo-check");
    appendSharedFlags();
    args.push("--json", prompt);
  } else {
    if (CONFIG.skipGitRepoCheck) args.push("--skip-git-repo-check");
    args.push("--cd", session.workdir || CONFIG.defaultWorkdir);
    if (CONFIG.sandbox) args.push("--sandbox", CONFIG.sandbox);
    appendSharedFlags();
    args.push("--json", prompt);
  }
  return args;
}

function appendCodexSharedFlags(args) {
  if (!Array.isArray(args)) return;
  if (CONFIG.approvalPolicy) {
    // Codex CLI doesn't expose an approval flag for exec; set it through config override.
    args.push("-c", `approval_policy=${JSON.stringify(CONFIG.approvalPolicy)}`);
  }
  if (CONFIG.model) args.push("--model", CONFIG.model);
  // Newer codex-cli builds no longer expose `--search` for `exec`.
  // Keep CODEX_ENABLE_SEARCH behavior via config override instead.
  if (CONFIG.enableSearch) args.push("-c", "features.web_search_request=true");
  for (const override of CONFIG.configOverrides) {
    args.push("-c", override);
  }
}

function buildCodexArgsStateless(workdir, prompt, { sandboxMode = "read-only" } = {}) {
  const args = ["exec"];
  if (CONFIG.skipGitRepoCheck) args.push("--skip-git-repo-check");
  args.push("--cd", workdir || CONFIG.defaultWorkdir);
  args.push("--sandbox", sandboxMode);
  appendCodexSharedFlags(args);
  args.push("--ephemeral");
  args.push("--json", prompt);
  return args;
}

async function runCodexWithArgs(args, { cwd, extraEnv, onProgress, conversationKey, label, timeoutMs }) {
  const env = buildChildProcessEnv(extraEnv);
  const child = spawn(CONFIG.codexBin, args, { cwd, env });
  if (conversationKey) activeChildByConversation.set(conversationKey, child);

  let threadId = null;
  let finalText = "";
  const stderrLines = [];
  const rawStdoutLines = [];

  const stdoutRl = readline.createInterface({ input: child.stdout });
  const stderrRl = readline.createInterface({ input: child.stderr });
  try {
    stdoutRl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const evt = JSON.parse(trimmed);
        if (evt.type === "thread.started" && typeof evt.thread_id === "string") {
          threadId = evt.thread_id;
        }
        if (
          evt.type === "item.completed" &&
          evt.item &&
          evt.item.type === "agent_message" &&
          typeof evt.item.text === "string"
        ) {
          finalText = evt.item.text;
        }
        const summary = summarizeCodexProgressEvent(evt);
        if (summary) emitProgress(onProgress, summary);
        return;
      } catch {}
      rawStdoutLines.push(trimmed);
      if (rawStdoutLines.length > 80) rawStdoutLines.shift();
    });

    stderrRl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      stderrLines.push(trimmed);
      if (stderrLines.length > 80) stderrLines.shift();
    });

    const exitCode = await waitForChildExit(child, label || "codex", conversationKey, timeoutMs);
    if (exitCode !== 0) {
      const detail = stderrLines.slice(-20).join("\n") || rawStdoutLines.slice(-20).join("\n");
      throw new Error(`codex exit ${exitCode}\n${detail}`.trim());
    }
    if (!finalText) {
      finalText = rawStdoutLines.join("\n").trim() || "No message returned by Codex.";
    }
    return { threadId, text: finalText };
  } finally {
    try {
      stdoutRl.close();
    } catch {}
    try {
      stderrRl.close();
    } catch {}
    if (conversationKey && activeChildByConversation.get(conversationKey) === child) {
      activeChildByConversation.delete(conversationKey);
    }
  }
}

function waitForChildExit(child, label, conversationKey = null, timeoutMsOverride = null) {
  const timeoutMsRaw = timeoutMsOverride == null ? CONFIG.agentTimeoutMs : timeoutMsOverride;
  const timeoutMs = Math.max(0, Number(timeoutMsRaw) || 0);
  return new Promise((resolve, reject) => {
    let done = false;
    let timeout = null;
    let killTimer = null;
    let onError = null;
    let onClose = null;

    const finish = (fn, value) => {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      try {
        if (onError) child.off("error", onError);
      } catch {}
      try {
        if (onClose) child.off("close", onClose);
      } catch {}
      fn(value);
    };

    onError = (err) => finish(reject, err);
    onClose = (code) => {
      const resolvedCode =
        typeof code === "number" ? code : typeof child.exitCode === "number" ? child.exitCode : 1;
      finish(resolve, resolvedCode);
    };
    child.on("error", onError);
    child.on("close", onClose);

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        logRelayEvent("agent.child.timeout", {
          conversationKey: conversationKey || null,
          provider: CONFIG.agentProvider,
          label,
          timeoutMs,
          pid: child && typeof child.pid === "number" ? child.pid : null,
        });
        try {
          child.kill("SIGTERM");
        } catch {}
        killTimer = setTimeout(() => {
          logRelayEvent("agent.child.sigkill", {
            conversationKey: conversationKey || null,
            provider: CONFIG.agentProvider,
            label,
            pid: child && typeof child.pid === "number" ? child.pid : null,
          });
          try {
            child.kill("SIGKILL");
          } catch {}
        }, 5000);
        finish(reject, new Error(`${label} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    // Race guard: the process may have already exited before listeners were attached.
    if (child.exitCode != null || child.signalCode != null) {
      queueMicrotask(() => onClose(child.exitCode));
    }
  });
}

async function runCodex(session, prompt, extraEnv, onProgress, conversationKey, options = {}) {
  const args = buildCodexArgs(session, prompt);
  const env = buildChildProcessEnv(extraEnv);
  const child = spawn(CONFIG.codexBin, args, {
    cwd: session.workdir || CONFIG.defaultWorkdir,
    env,
  });
  if (conversationKey) activeChildByConversation.set(conversationKey, child);
  emitProgress(
    onProgress,
    `Agent process started (pid ${child && typeof child.pid === "number" ? child.pid : "n/a"}, timeout ${formatAgentTimeoutLabel(
      CONFIG.agentTimeoutMs
    )})`
  );

  let threadId = session.threadId || null;
  let finalText = "";
  const stderrLines = [];
  const rawStdoutLines = [];

  const stdoutRl = readline.createInterface({ input: child.stdout });
  const stderrRl = readline.createInterface({ input: child.stderr });
  try {
    stdoutRl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const evt = JSON.parse(trimmed);
        if (evt.type === "thread.started" && typeof evt.thread_id === "string") {
          threadId = evt.thread_id;
        }
        if (
          evt.type === "item.completed" &&
          evt.item &&
          evt.item.type === "agent_message" &&
          typeof evt.item.text === "string"
        ) {
          finalText = evt.item.text;
        }
        const summary = summarizeCodexProgressEvent(evt);
        if (summary) emitProgress(onProgress, summary);
        return;
      } catch {}
      rawStdoutLines.push(trimmed);
      if (rawStdoutLines.length > 60) rawStdoutLines.shift();
    });

    stderrRl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (trimmed.includes("state db missing rollout path for thread")) return;
      stderrLines.push(trimmed);
      if (stderrLines.length > 80) stderrLines.shift();
    });

    const exitCode = await waitForChildExit(child, "codex", conversationKey, options.timeoutMs);

    if (exitCode !== 0) {
      const detail = stderrLines.slice(-20).join("\n") || rawStdoutLines.slice(-20).join("\n");
      throw new Error(`codex exit ${exitCode}\n${detail}`.trim());
    }

    if (!finalText) {
      finalText = rawStdoutLines.join("\n").trim() || "No message returned by Codex.";
    }
    return { threadId, text: finalText };
  } finally {
    try {
      stdoutRl.close();
    } catch {}
    try {
      stderrRl.close();
    } catch {}
    if (conversationKey && activeChildByConversation.get(conversationKey) === child) {
      activeChildByConversation.delete(conversationKey);
    }
  }
}

function resolveClaudeModel(modelOverride = "") {
  const explicit = String(modelOverride || "").trim();
  if (explicit) return explicit;
  return String(CONFIG.claudeModelLight || CONFIG.claudeModel || "").trim();
}

function shouldPreferClaudeHeavyModel(userPrompt = "", runLabel = "") {
  const text = `${String(userPrompt || "")}\n${String(runLabel || "")}`.toLowerCase();
  if (!text.trim()) return false;
  if (text.length >= 1200) return true;
  return /\b(reason|reasoning|research|analy[sz]e|investigate|investigation|investigating|hypothesis|ablation|compare|architecture|design|strategy|debug|root cause|proof|derive|math|complex|optimi[sz]e|benchmark)\b/.test(
    text
  );
}

function selectClaudeModelForRun(userPrompt = "", runLabel = "") {
  const promptText = `${String(userPrompt || "")}\n${String(runLabel || "")}`.toLowerCase();
  const lightModel = resolveClaudeModel("");
  const heavyModel = String(CONFIG.claudeModelHeavy || "").trim();
  if (!CONFIG.claudeModelRouting || !heavyModel) {
    return {
      selectedModel: lightModel,
      fallbackModel: lightModel,
      usedHeavy: false,
      strategy: "light-default",
    };
  }

  const hasOpusKeyword = /\bopus\b/.test(promptText);
  const hasSonnetKeyword = /\bsonnet\b/.test(promptText);
  if (hasOpusKeyword && hasSonnetKeyword) {
    return {
      selectedModel: heavyModel,
      fallbackModel: lightModel,
      usedHeavy: true,
      strategy: "keyword-opus",
    };
  }
  if (hasOpusKeyword) {
    return {
      selectedModel: heavyModel,
      fallbackModel: lightModel,
      usedHeavy: true,
      strategy: "keyword-opus",
    };
  }
  if (hasSonnetKeyword) {
    return {
      selectedModel: lightModel,
      fallbackModel: lightModel,
      usedHeavy: false,
      strategy: "keyword-sonnet",
    };
  }

  const useHeavy = shouldPreferClaudeHeavyModel(userPrompt, runLabel);
  return {
    selectedModel: useHeavy ? heavyModel : lightModel,
    fallbackModel: lightModel,
    usedHeavy: useHeavy,
    strategy: useHeavy ? "heavy-heuristic" : "light-heuristic",
  };
}

function isClaudeQuotaLimitedError(err) {
  const msg = String((err && err.message) || err || "").toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("quota") ||
    msg.includes("usage limit") ||
    msg.includes("rate limit") ||
    msg.includes("exceeded") ||
    msg.includes("capacity")
  );
}

function buildClaudeArgs(session, prompt, modelOverride = "") {
  // stream-json gives us tool and thinking events so we can relay human-friendly progress updates.
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  const selectedModel = resolveClaudeModel(modelOverride);
  if (selectedModel) args.push("--model", selectedModel);
  if (CONFIG.claudePermissionMode) args.push("--permission-mode", CONFIG.claudePermissionMode);
  // Claude CLI parses `--allowedTools <tools...>` as variadic; pass a single comma-separated
  // argument so the trailing prompt is not swallowed as another tool token.
  if (CONFIG.claudeAllowedTools.length) args.push("--allowedTools", CONFIG.claudeAllowedTools.join(","));
  if (session.threadId) args.push("--resume", session.threadId);
  // Always terminate option parsing explicitly before prompt text.
  // Without `--`, some Claude CLI versions can still swallow the prompt when
  // variadic options are present.
  args.push("--", prompt);
  return args;
}

function extractClaudeTextFromJson(parsed, fallbackText) {
  if (!parsed || typeof parsed !== "object") return fallbackText;
  if (typeof parsed.result === "string" && parsed.result.trim()) return parsed.result;
  if (parsed.message && Array.isArray(parsed.message.content)) {
    const text = parsed.message.content
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return fallbackText;
}

async function runClaude(session, prompt, extraEnv, onProgress, conversationKey, options = {}) {
  const selectedModel = resolveClaudeModel(options && options.modelOverride ? options.modelOverride : "");
  const args = buildClaudeArgs(session, prompt, selectedModel);
  const env = buildChildProcessEnv(extraEnv);
  const child = spawn(CONFIG.claudeBin, args, {
    cwd: session.workdir || CONFIG.defaultWorkdir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (conversationKey) activeChildByConversation.set(conversationKey, child);
  emitProgress(
    onProgress,
    `Agent process started (pid ${child && typeof child.pid === "number" ? child.pid : "n/a"}, model ${
      selectedModel || "default"
    }, timeout ${formatAgentTimeoutLabel(
      CONFIG.agentTimeoutMs
    )})`
  );

  let threadId = session.threadId || null;
  let parsedResult = null;
  let lastAssistantEvent = null;
  let lastAssistantText = "";
  let assistantEventCount = 0;
  let resultEventCount = 0;
  const toolMetaById = new Map();
  const rawStdoutLines = [];
  const nonJsonStdoutLines = [];
  let parsedEventCount = 0;
  const stderrLines = [];

  const stdoutRl = readline.createInterface({ input: child.stdout });
  const stderrRl = readline.createInterface({ input: child.stderr });
  try {
    stdoutRl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      rawStdoutLines.push(trimmed);
      if (rawStdoutLines.length > 400) rawStdoutLines.shift();

      let evt = null;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        nonJsonStdoutLines.push(trimmed);
        if (nonJsonStdoutLines.length > 120) nonJsonStdoutLines.shift();
        return;
      }
      if (!evt || typeof evt !== "object") return;
      parsedEventCount += 1;

      if (typeof evt.session_id === "string" && evt.session_id) {
        threadId = evt.session_id;
      }
      if (evt.type === "assistant") {
        assistantEventCount += 1;
        lastAssistantEvent = evt;
        const assistantText = extractClaudeTextFromJson(evt, "").trim();
        if (assistantText) lastAssistantText = assistantText;
      }
      if (evt.type === "result") {
        resultEventCount += 1;
        parsedResult = evt;
      }

      const summary = summarizeClaudeProgressEvent(evt, toolMetaById);
      if (summary) emitProgress(onProgress, summary);
    });

    stderrRl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      stderrLines.push(trimmed);
      if (stderrLines.length > 80) stderrLines.shift();
    });

    const exitCode = await waitForChildExit(child, "claude", conversationKey, options.timeoutMs);

    const stdoutTrimmed = rawStdoutLines.join("\n").trim();
    if (exitCode !== 0) {
      const detail = stderrLines.slice(-20).join("\n") || rawStdoutLines.slice(-40).join("\n");
      throw new Error(`claude exit ${exitCode}\n${detail}`.trim());
    }

    const parsed = parsedResult || lastAssistantEvent;
    const parsedText = extractClaudeTextFromJson(parsed, "").trim();
    const assistantText = String(lastAssistantText || "").trim();
    const nonJsonStdout = nonJsonStdoutLines.join("\n").trim();

    let resolvedText = "";
    let resolutionSource = "";
    if (parsedText && assistantText && parsedText !== assistantText) {
      if (parsedText.length >= assistantText.length) {
        resolvedText = parsedText;
        resolutionSource = "parsed";
      } else {
        resolvedText = assistantText;
        resolutionSource = "assistant_nonempty";
      }
      if (conversationKey) {
        logRelayEvent("agent.run.claude_text_divergence", {
          conversationKey,
          sessionId: threadId || session.threadId || null,
          parsedChars: parsedText.length,
          assistantChars: assistantText.length,
          selectedSource: resolutionSource,
          model: selectedModel || null,
        });
      }
    } else if (parsedText) {
      resolvedText = parsedText;
      resolutionSource = "parsed";
    } else if (assistantText) {
      resolvedText = assistantText;
      resolutionSource = "assistant_nonempty";
    } else if (nonJsonStdout) {
      resolvedText = nonJsonStdout;
      resolutionSource = "non_json_stdout";
    }

    const fallbackText = resolvedText
      ? resolvedText
      : parsedEventCount > 0
      ? "Claude run finished without a final assistant text response."
      : stdoutTrimmed || "No message returned by Claude.";
    if (!resolvedText && parsedEventCount > 0 && conversationKey) {
      logRelayEvent("agent.run.claude_text_missing", {
        conversationKey,
        sessionId: threadId || session.threadId || null,
        parsedEventCount,
        assistantEventCount,
        resultEventCount,
        nonJsonStdoutChars: nonJsonStdout.length,
        model: selectedModel || null,
      });
    }
    const text = resolvedText || fallbackText;
    if (resolvedText && conversationKey) {
      logRelayEvent("agent.run.claude_text_resolved", {
        conversationKey,
        sessionId: threadId || session.threadId || null,
        source: resolutionSource || "unknown",
        textChars: resolvedText.length,
        parsedEventCount,
        assistantEventCount,
        resultEventCount,
        model: selectedModel || null,
      });
    }
    return { threadId: threadId || session.threadId || null, text, model: selectedModel || null };
  } finally {
    try {
      stdoutRl.close();
    } catch {}
    try {
      stderrRl.close();
    } catch {}
    if (conversationKey && activeChildByConversation.get(conversationKey) === child) {
      activeChildByConversation.delete(conversationKey);
    }
  }
}

async function runAgent(session, prompt, extraEnv, onProgress, conversationKey, options = {}) {
  if (CONFIG.agentProvider === "claude") {
    return runClaude(session, prompt, extraEnv, onProgress, conversationKey, options);
  }
  return runCodex(session, prompt, extraEnv, onProgress, conversationKey, options);
}

function isStaleThreadResumeError(err) {
  const msg = String((err && err.message) || err || "");
  if (!msg) return false;
  return (
    msg.includes("failed to parse thread ID from rollout file") ||
    msg.includes("state db missing rollout path for thread") ||
    msg.includes("No conversation found with session ID")
  );
}

function isTransientClaudeInitError(err) {
  const msg = String((err && err.message) || err || "");
  if (!msg) return false;
  return (
    msg.includes("claude exit") &&
    msg.includes('"type":"system"') &&
    msg.includes('"subtype":"init"')
  );
}

function codexErrorMessage(err) {
  return String((err && err.message) || err || "");
}

function isCodexLikelyPermanentError(err) {
  const msg = codexErrorMessage(err).toLowerCase();
  if (!msg) return false;
  const permanentNeedles = [
    "unexpected argument",
    "invalid value",
    "invalid option",
    "usage:",
    "no such file or directory",
    "permission denied",
    "failed to parse thread id from rollout file",
    "state db missing rollout path for thread",
    "no conversation found with session id",
    "json parse failed",
  ];
  return permanentNeedles.some((needle) => msg.includes(needle));
}

function isTransientCodexRuntimeError(err) {
  const msg = codexErrorMessage(err).toLowerCase();
  if (!msg) return false;
  if (msg.includes("codex timeout after")) return false;
  if (isCodexLikelyPermanentError(err)) return false;
  const networkNeedles = [
    "econnreset",
    "econnrefused",
    "eai_again",
    "enotfound",
    "etimedout",
    "timed out",
    "network",
    "socket hang up",
    "tls",
    "proxy",
    "upstream",
    "service unavailable",
    "bad gateway",
    "gateway timeout",
    "rate limit",
    "429",
    "502",
    "503",
    "504",
  ];
  if (networkNeedles.some((needle) => msg.includes(needle))) return true;
  // Some transient codex failures return only "codex exit 1" with no stderr details.
  return /^codex exit 1\s*$/m.test(msg) || msg.startsWith("codex exit 1\n");
}

function getConversationQueueEpoch(conversationKey) {
  const key = String(conversationKey || "").trim();
  if (!key) return 0;
  const raw = Number(queueEpochByConversation.get(key) || 0);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

function preemptConversationQueue(conversationKey, reason = "manual preempt") {
  const key = String(conversationKey || "").trim();
  if (!key) return { ok: false, reason: "invalid_conversation_key", epoch: null };
  const nextEpoch = getConversationQueueEpoch(key) + 1;
  queueEpochByConversation.set(key, nextEpoch);
  logRelayEvent("conversation.queue.preempted", {
    conversationKey: key,
    epoch: nextEpoch,
    reason: String(reason || "manual preempt").slice(0, 160),
  });
  return { ok: true, epoch: nextEpoch };
}

async function enqueueConversation(key, task, options = {}) {
  const conversationKey = String(key || "").trim();
  const prev = queueByConversation.get(conversationKey) || Promise.resolve();
  const defaultEpoch = getConversationQueueEpoch(conversationKey);
  const requestedEpoch = Number(options && options.epoch != null ? options.epoch : defaultEpoch);
  const queueEpoch = Number.isFinite(requestedEpoch) && requestedEpoch >= 0 ? requestedEpoch : defaultEpoch;
  const skipIfStale = !(options && options.skipIfStale === false);
  const queueLabel = options && options.label ? String(options.label) : "";
  const onSkipped = options && typeof options.onSkipped === "function" ? options.onSkipped : null;

  const runTask = async () => {
    const activeEpoch = getConversationQueueEpoch(conversationKey);
    if (skipIfStale && queueEpoch !== activeEpoch) {
      const skipReason = `stale_queue_epoch (task=${queueEpoch}, active=${activeEpoch})`;
      logRelayEvent("conversation.queue.item.skipped", {
        conversationKey: conversationKey || null,
        label: queueLabel || null,
        reason: skipReason,
      });
      if (onSkipped) {
        return onSkipped({ reason: skipReason, taskEpoch: queueEpoch, activeEpoch });
      }
      return { skipped: true, reason: skipReason };
    }
    return task();
  };

  const next = prev.catch(() => {}).then(runTask);
  queueByConversation.set(conversationKey, next);
  try {
    return await next;
  } finally {
    if (queueByConversation.get(conversationKey) === next) {
      queueByConversation.delete(conversationKey);
      queueEpochByConversation.delete(conversationKey);
    }
  }
}

async function sendLongReply(baseMessage, text) {
  const raw = String(text == null ? "" : text);
  if (!raw.trim()) return;
  const chunks = splitMessage(raw, Math.max(300, CONFIG.maxReplyChars)).filter((chunk) => String(chunk || "").trim().length > 0);
  if (chunks.length === 0) return;
  for (let i = 0; i < chunks.length; i += 1) {
    const content = chunks[i];
    if (i === 0) await baseMessage.reply(content);
    else await baseMessage.channel.send(content);
  }
}

async function sendLongToChannel(channel, text) {
  const raw = String(text == null ? "" : text);
  if (!raw.trim()) return;
  const chunks = splitMessage(raw, Math.max(300, CONFIG.maxReplyChars)).filter((chunk) => String(chunk || "").trim().length > 0);
  if (chunks.length === 0) return;
  for (const content of chunks) {
    await channel.send(content);
  }
}

function splitFirstToken(value) {
  const raw = String(value || "").trim();
  if (!raw) return { head: "", rest: "" };
  const m = raw.match(/^(\S+)(?:\s+([\s\S]+))?$/);
  return { head: (m && m[1] ? m[1] : "").trim(), rest: (m && m[2] ? m[2] : "").trim() };
}

function taskTextPreview(text, maxLen = 60) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  if (raw.length <= maxLen) return raw;
  return `${raw.slice(0, maxLen - 1)}…`;
}

function summarizeTaskCounts(tasks) {
  const counts = { pending: 0, running: 0, done: 0, failed: 0, blocked: 0, canceled: 0 };
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t || typeof t !== "object") continue;
    if (counts[t.status] != null) counts[t.status] += 1;
  }
  return counts;
}

function taskDisplayDescription(task, maxLen = 96) {
  if (!task || typeof task !== "object") return "";
  const explicit = taskTextPreview(task.description || "", maxLen);
  if (explicit) return explicit;
  return taskTextPreview(task.text || "", maxLen);
}

function jobDisplayDescription(job, maxLen = 96) {
  if (!job || typeof job !== "object") return "";
  return taskTextPreview(job.description || "", maxLen);
}

function safeConversationDirName(conversationKey) {
  const raw = String(conversationKey || "").trim() || "unknown";
  const cleaned = raw.replace(/[\\/]/g, "_").replace(/[^a-zA-Z0-9._:-]/g, "_");
  if (cleaned.length <= 80) return cleaned;
  const hash = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 8);
  return `${cleaned.slice(0, 60)}-${hash}`;
}

function sanitizeResearchSlug(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!raw) return "research";
  return raw.slice(0, 48);
}

function stampCompact() {
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const HH = String(d.getHours()).padStart(2, "0");
  const MM = String(d.getMinutes()).padStart(2, "0");
  const SS = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${HH}${MM}${SS}`;
}

function managerConversationKeyFor(conversationKey) {
  return `${String(conversationKey || "").trim()}::research:manager`;
}

function researchPaths(projectRoot) {
  const root = path.resolve(projectRoot);
  const ideaDir = path.join(root, "idea");
  const expDir = path.join(root, "exp");
  const resultsDir = path.join(expDir, "results");
  const reportsDir = path.join(root, "reports");
  const writingDir = path.join(root, "writing");
  const managerDir = path.join(root, "manager");
  const memoryDir = path.join(root, "memory");
  const rollingReportPath = path.join(reportsDir, "rolling_report.md");
  const reportDigestPath = path.join(reportsDir, "report_digest.md");
  const legacyReportPath = path.join(writingDir, "REPORT.md");
  return {
    root,
    ideaDir,
    goalPath: path.join(ideaDir, "goal.md"),
    hypothesesPath: path.join(ideaDir, "hypotheses.yaml"),
    expDir,
    registryPath: path.join(expDir, "registry.jsonl"),
    resultsDir,
    reportsDir,
    rollingReportPath,
    reportDigestPath,
    writingDir,
    reportPath: rollingReportPath,
    legacyReportPath,
    workingMemoryPath: path.join(root, "WORKING_MEMORY.md"),
    handoffLogPath: path.join(root, "HANDOFF_LOG.md"),
    hypothesesMarkdownPath: path.join(root, "HYPOTHESES.md"),
    questionsPath: path.join(root, "QUESTIONS.md"),
    memoryDir,
    handoffPath: path.join(memoryDir, "handoff.md"),
    managerDir,
    managerStatePath: path.join(managerDir, "state.json"),
    eventsPath: path.join(managerDir, "events.jsonl"),
  };
}

async function readJsonFileOr(filePath, fallbackValue) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallbackValue;
  } catch {
    return fallbackValue;
  }
}

async function writeJsonAtomic(filePath, data) {
  const target = path.resolve(filePath);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fsp.rename(tmp, target);
}

async function appendJsonLine(filePath, payload) {
  const target = path.resolve(filePath);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.appendFile(target, `${JSON.stringify(payload)}\n`, "utf8");
}

async function readFileTailText(filePath, maxChars) {
  const budget = Math.max(200, Math.floor(Number(maxChars || 0) || 0));
  if (budget <= 0) return "";
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    if (raw.length <= budget) return raw;
    return raw.slice(-budget);
  } catch {
    return "";
  }
}

async function readFileTailTextFallback(filePaths, maxChars) {
  const list = Array.isArray(filePaths) ? filePaths : [filePaths];
  for (const filePath of list) {
    if (!filePath) continue;
    const tail = await readFileTailText(filePath, maxChars);
    if (tail) return tail;
  }
  return "";
}

async function writeTextFileIfMissing(filePath, content) {
  const target = path.resolve(filePath);
  try {
    await fsp.access(target);
    return false;
  } catch {}
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, String(content || ""), "utf8");
  return true;
}

async function readJsonlTail(filePath, maxLines = 20) {
  const n = Math.max(1, Math.min(200, Math.floor(Number(maxLines || 20) || 20)));
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.slice(-n).join("\n");
  } catch {
    return "";
  }
}

function defaultResearchManagerState({ projectRoot, goal, channelId, guildId }) {
  const started = nowIso();
  return {
    version: 1,
    projectRoot: path.resolve(projectRoot),
    goal: String(goal || "").trim(),
    status: "paused",
    phase: "plan",
    autoRun: false,
    budgets: {
      maxSteps: CONFIG.researchDefaultMaxSteps,
      maxWallClockMinutes: CONFIG.researchDefaultMaxWallclockMin,
      maxRuns: CONFIG.researchDefaultMaxRuns,
    },
    counters: {
      steps: 0,
      runs: 0,
    },
    lease: null,
    inflightStep: {
      stepId: null,
      decisionHash: null,
      status: "idle",
      startedAt: null,
      error: null,
    },
    active: {
      jobId: null,
      runId: null,
    },
    discord: {
      channelId: String(channelId || ""),
      guildId: guildId ? String(guildId) : null,
    },
    startedAt: started,
    lastFeedbackAt: null,
    lastDecisionAt: null,
    reporting: {
      lastDiscordDigestAt: null,
      lastDiscordDigestStep: 0,
    },
    appliedDecisionHashes: [],
    appliedActionKeys: [],
    lastUpdateAt: started,
  };
}

function normalizeResearchManagerState(stateObj, { projectRoot, goal, channelId, guildId } = {}) {
  const fallback = defaultResearchManagerState({
    projectRoot: projectRoot || ".",
    goal: goal || "",
    channelId: channelId || "",
    guildId: guildId || null,
  });
  const state = stateObj && typeof stateObj === "object" ? stateObj : {};
  const out = { ...fallback, ...state };
  out.projectRoot = path.resolve(projectRoot || out.projectRoot || ".");
  out.goal = String(out.goal || goal || "").trim();
  out.status = String(out.status || fallback.status);
  out.phase = String(out.phase || fallback.phase);
  out.autoRun = Boolean(out.autoRun);

  const fallbackBudgets = fallback.budgets || {};
  out.budgets = out.budgets && typeof out.budgets === "object" ? out.budgets : {};
  out.budgets.maxSteps = Math.max(1, Math.floor(Number(out.budgets.maxSteps || fallbackBudgets.maxSteps) || fallbackBudgets.maxSteps));
  out.budgets.maxWallClockMinutes = Math.max(
    1,
    Math.floor(Number(out.budgets.maxWallClockMinutes || fallbackBudgets.maxWallClockMinutes) || fallbackBudgets.maxWallClockMinutes)
  );
  out.budgets.maxRuns = Math.max(1, Math.floor(Number(out.budgets.maxRuns || fallbackBudgets.maxRuns) || fallbackBudgets.maxRuns));

  out.counters = out.counters && typeof out.counters === "object" ? out.counters : {};
  out.counters.steps = Math.max(0, Math.floor(Number(out.counters.steps || 0) || 0));
  out.counters.runs = Math.max(0, Math.floor(Number(out.counters.runs || 0) || 0));

  out.active = out.active && typeof out.active === "object" ? out.active : {};
  out.active.jobId = out.active.jobId ? String(out.active.jobId) : null;
  out.active.runId = out.active.runId ? String(out.active.runId) : null;

  out.inflightStep = out.inflightStep && typeof out.inflightStep === "object" ? out.inflightStep : {};
  out.inflightStep.stepId = out.inflightStep.stepId ? String(out.inflightStep.stepId) : null;
  out.inflightStep.decisionHash = out.inflightStep.decisionHash ? String(out.inflightStep.decisionHash) : null;
  out.inflightStep.status = String(out.inflightStep.status || "idle");
  out.inflightStep.startedAt = out.inflightStep.startedAt ? String(out.inflightStep.startedAt) : null;
  out.inflightStep.error = out.inflightStep.error ? String(out.inflightStep.error) : null;

  out.reporting = out.reporting && typeof out.reporting === "object" ? out.reporting : {};
  out.reporting.lastDiscordDigestAt = out.reporting.lastDiscordDigestAt ? String(out.reporting.lastDiscordDigestAt) : null;
  out.reporting.lastDiscordDigestStep = Math.max(
    0,
    Math.floor(Number(out.reporting.lastDiscordDigestStep || 0) || 0)
  );

  out.discord = out.discord && typeof out.discord === "object" ? out.discord : {};
  out.discord.channelId = out.discord.channelId
    ? String(out.discord.channelId)
    : channelId
    ? String(channelId)
    : "";
  out.discord.guildId =
    out.discord.guildId != null ? String(out.discord.guildId) : guildId != null ? String(guildId) : null;

  if (!Array.isArray(out.appliedDecisionHashes)) out.appliedDecisionHashes = [];
  if (!Array.isArray(out.appliedActionKeys)) out.appliedActionKeys = [];
  out.lastUpdateAt = out.lastUpdateAt || nowIso();
  out.startedAt = out.startedAt || nowIso();
  return out;
}

async function ensureResearchProjectScaffold({
  conversationKey,
  goal,
  channelId,
  guildId,
}) {
  const convSlug = safeConversationDirName(conversationKey);
  const goalSlug = sanitizeResearchSlug(goal);
  const root = path.join(CONFIG.researchProjectsRoot, convSlug, `${stampCompact()}-${goalSlug}`);
  const p = researchPaths(root);

  await fsp.mkdir(p.ideaDir, { recursive: true });
  await fsp.mkdir(p.resultsDir, { recursive: true });
  await fsp.mkdir(p.reportsDir, { recursive: true });
  await fsp.mkdir(p.writingDir, { recursive: true });
  await fsp.mkdir(p.managerDir, { recursive: true });
  await fsp.mkdir(p.memoryDir, { recursive: true });

  await writeTextFileIfMissing(
    p.goalPath,
    [`# Research Goal`, "", String(goal || "").trim(), ""].join("\n")
  );
  await writeTextFileIfMissing(
    p.hypothesesPath,
    ['version: 1', `updated_at: "${nowIso()}"`, "hypotheses: []", ""].join("\n")
  );
  await writeTextFileIfMissing(
    p.hypothesesMarkdownPath,
    ["# Hypotheses", "", "- (add hypothesis here)", ""].join("\n")
  );
  await writeTextFileIfMissing(
    p.questionsPath,
    ["# Questions", "", "- (add open question here)", ""].join("\n")
  );
  await writeTextFileIfMissing(
    p.workingMemoryPath,
    [
      "# WORKING_MEMORY",
      "",
      `Last updated: ${nowIso()}`,
      "",
      "## Objective",
      String(goal || "").trim() || "(fill in objective)",
      "",
      "## Current Status",
      "- Research project initialized.",
      "",
      "## Next Actions",
      "- Define first concrete hypothesis and decision criteria.",
      "",
    ].join("\n")
  );
  await writeTextFileIfMissing(
    p.handoffLogPath,
    ["# HANDOFF_LOG (append-only)", "", `## ${nowIso()}`, "- Research scaffold initialized.", ""].join("\n")
  );
  await writeTextFileIfMissing(p.registryPath, "");
  await writeTextFileIfMissing(
    p.reportPath,
    ["# Rolling Report", "", `Created: ${nowIso()}`, "", `Goal: ${String(goal || "").trim()}`, ""].join("\n")
  );
  await writeTextFileIfMissing(
    p.reportDigestPath,
    ["# Report Digest", "", `Created: ${nowIso()}`, ""].join("\n")
  );
  await writeTextFileIfMissing(
    p.legacyReportPath,
    ["# REPORT (legacy path)", "", `Created: ${nowIso()}`, "", `Goal: ${String(goal || "").trim()}`, ""].join("\n")
  );
  await writeTextFileIfMissing(p.handoffPath, "");

  const stateSeed = defaultResearchManagerState({
    projectRoot: p.root,
    goal,
    channelId,
    guildId,
  });
  const currentState = await readJsonFileOr(p.managerStatePath, stateSeed);
  const stateObj = normalizeResearchManagerState(currentState, {
    projectRoot: p.root,
    goal,
    channelId,
    guildId,
  });
  await writeJsonAtomic(p.managerStatePath, stateObj);
  await appendJsonLine(p.eventsPath, {
    type: "research_started",
    ts: nowIso(),
    conversationKey,
    goal: String(goal || "").trim(),
    projectRoot: p.root,
  });
  return { root: p.root, paths: p, managerState: stateObj };
}

async function loadResearchManagerState(projectRoot) {
  const p = researchPaths(projectRoot);
  const loaded = await readJsonFileOr(
    p.managerStatePath,
    defaultResearchManagerState({ projectRoot: p.root, goal: "", channelId: "", guildId: null })
  );
  return normalizeResearchManagerState(loaded, {
    projectRoot: p.root,
    goal: loaded && loaded.goal ? loaded.goal : "",
    channelId: loaded && loaded.discord && loaded.discord.channelId ? loaded.discord.channelId : "",
    guildId: loaded && loaded.discord && loaded.discord.guildId ? loaded.discord.guildId : null,
  });
}

async function saveResearchManagerState(projectRoot, nextState) {
  const p = researchPaths(projectRoot);
  const out = normalizeResearchManagerState(nextState, {
    projectRoot: p.root,
    goal: nextState && nextState.goal ? nextState.goal : "",
    channelId: nextState && nextState.discord && nextState.discord.channelId ? nextState.discord.channelId : "",
    guildId: nextState && nextState.discord && nextState.discord.guildId ? nextState.discord.guildId : null,
  });
  out.lastUpdateAt = nowIso();
  await writeJsonAtomic(p.managerStatePath, out);
}

async function appendResearchEvent(projectRoot, event) {
  const p = researchPaths(projectRoot);
  await appendJsonLine(p.eventsPath, {
    ...(event && typeof event === "object" ? event : { value: String(event || "") }),
    ts: (event && event.ts) || nowIso(),
  });
}

function newResearchRunId(counter) {
  const n = Math.max(1, Math.floor(Number(counter || 1) || 1));
  return `r${String(n).padStart(4, "0")}`;
}

function safeShellArg(value) {
  return `'${String(value || "").replace(/'/g, `'\"'\"'`)}'`;
}

function resolvePathFromBase(rawPath, baseDir) {
  const raw = String(rawPath || "").trim();
  if (!raw) return "";
  if (path.isAbsolute(raw)) return path.resolve(raw);
  return path.resolve(baseDir, raw);
}

function uniqueStringList(values, { maxItems = 64, maxLen = 1000 } = {}) {
  const list = Array.isArray(values) ? values : values == null ? [] : [values];
  const out = [];
  const seen = new Set();
  for (const rawItem of list) {
    const raw = String(rawItem || "").trim();
    if (!raw) continue;
    const clipped = raw.length > maxLen ? raw.slice(0, maxLen) : raw;
    if (!clipped || seen.has(clipped)) continue;
    seen.add(clipped);
    out.push(clipped);
    if (out.length >= maxItems) break;
  }
  return out;
}

function buildStage0SupervisorLaunchSpec(supervisor, { workdir } = {}) {
  if (!supervisor || typeof supervisor !== "object") {
    return { ok: false, error: "missing supervisor spec", command: "", watchPatch: null };
  }
  const mode = String(supervisor.mode || "").trim().toLowerCase();
  if (mode !== "stage0_smoke_gate") {
    return { ok: false, error: `unsupported supervisor mode: ${mode || "(empty)"}`, command: "", watchPatch: null };
  }

  const baseWorkdir = path.resolve(workdir || CONFIG.defaultWorkdir);
  const projectRoot = resolvePathFromBase(supervisor.projectRoot || baseWorkdir, baseWorkdir) || baseWorkdir;
  const cwd = resolvePathFromBase(supervisor.cwd || projectRoot, baseWorkdir) || projectRoot;
  const configuredScriptRaw = String(
    supervisor.scriptPath || CONFIG.supervisorPhase1DefaultScript || BUNDLED_STAGE0_SUPERVISOR_SCRIPT
  ).trim();
  let scriptPath = resolvePathFromBase(configuredScriptRaw, cwd);
  // Keep relative env defaults portable: if not found under target cwd, try relay-bundled path.
  if (
    !supervisor.scriptPath &&
    configuredScriptRaw &&
    !path.isAbsolute(configuredScriptRaw) &&
    (!scriptPath || !fs.existsSync(scriptPath))
  ) {
    const relayBundledCandidate = resolvePathFromBase(configuredScriptRaw, __dirname);
    if (relayBundledCandidate && fs.existsSync(relayBundledCandidate)) {
      scriptPath = relayBundledCandidate;
    }
  }
  const stateFile = resolvePathFromBase(supervisor.stateFile, cwd);
  if (!scriptPath || !stateFile) {
    return { ok: false, error: "supervisor requires scriptPath and stateFile", command: "", watchPatch: null };
  }
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, error: `supervisor script not found: ${scriptPath}`, command: "", watchPatch: null };
  }

  const runId = String(supervisor.runId || "").trim();
  const smokeCmd = String(supervisor.smokeCmd || "").trim();
  const fullCmd = String(supervisor.fullCmd || "").trim();
  if (!runId || !smokeCmd || !fullCmd) {
    return { ok: false, error: "supervisor requires runId/smokeCmd/fullCmd", command: "", watchPatch: null };
  }

  const stateDir = path.dirname(stateFile);
  const gateOut = resolvePathFromBase(supervisor.gateOut || path.join(stateDir, "gate.out.log"), cwd);
  const gateErr = resolvePathFromBase(supervisor.gateErr || path.join(stateDir, "gate.err.log"), cwd);
  const cleanupSmokePolicy = String(supervisor.cleanupSmokePolicy || "keep_manifest_only").trim() === "keep_all"
    ? "keep_all"
    : "keep_manifest_only";
  const expectStatus = parseSupervisorExpectedStatus(
    supervisor.expectStatus || CONFIG.supervisorPhase1DefaultExpectStatus || "success"
  );
  const onMissing = String(supervisor.onMissing || "block").trim().toLowerCase() === "enqueue" ? "enqueue" : "block";

  const smokeRequiredFiles = uniqueStringList(supervisor.smokeRequiredFiles, { maxItems: 32, maxLen: 1000 }).map((p) =>
    resolvePathFromBase(p, cwd)
  );
  const fullRequiredFiles = uniqueStringList(supervisor.fullRequiredFiles, { maxItems: 32, maxLen: 1000 }).map((p) =>
    resolvePathFromBase(p, cwd)
  );
  const smokeRunDir = supervisor.smokeRunDir ? resolvePathFromBase(supervisor.smokeRunDir, cwd) : "";

  const readyTimeoutSec =
    supervisor.readyTimeoutSec == null || !Number.isFinite(Number(supervisor.readyTimeoutSec))
      ? CONFIG.supervisorPhase1DefaultReadyTimeoutSec
      : Math.max(10, Math.min(86400, Math.floor(Number(supervisor.readyTimeoutSec))));
  const readyPollSec =
    supervisor.readyPollSec == null || !Number.isFinite(Number(supervisor.readyPollSec))
      ? CONFIG.supervisorPhase1DefaultReadyPollSec
      : Math.max(1, Math.min(3600, Math.floor(Number(supervisor.readyPollSec))));

  const args = [
    safeShellArg("python3"),
    safeShellArg(scriptPath),
    "--run-id",
    safeShellArg(runId),
    "--state-file",
    safeShellArg(stateFile),
    "--project-root",
    safeShellArg(projectRoot),
    "--cwd",
    safeShellArg(cwd),
    "--smoke-cmd",
    safeShellArg(smokeCmd),
    "--full-cmd",
    safeShellArg(fullCmd),
  ];
  for (const req of smokeRequiredFiles) {
    args.push("--smoke-required-file", safeShellArg(req));
  }
  for (const req of fullRequiredFiles) {
    args.push("--full-required-file", safeShellArg(req));
  }
  if (smokeRunDir) {
    args.push("--smoke-run-dir", safeShellArg(smokeRunDir));
  }
  args.push("--cleanup-smoke-policy", safeShellArg(cleanupSmokePolicy));

  const mkdirTargets = uniqueStringList([path.dirname(stateFile), path.dirname(gateOut), path.dirname(gateErr)], {
    maxItems: 8,
    maxLen: 1200,
  });
  const mkdirCmd = `mkdir -p ${mkdirTargets.map((p) => safeShellArg(p)).join(" ")}`;
  const command = `${mkdirCmd} && ${args.join(" ")} > ${safeShellArg(gateOut)} 2> ${safeShellArg(gateErr)}`;

  const requireFiles = uniqueStringList(
    [
      stateFile,
      gateOut,
      gateErr,
      cleanupSmokePolicy === "keep_manifest_only" ? path.join(path.dirname(stateFile), "smoke_manifest.json") : "",
    ],
    { maxItems: 32, maxLen: 1200 }
  );

  return {
    ok: true,
    error: "",
    command,
    supervisorSummary: `mode=stage0_smoke_gate runId=${runId}`,
    watchPatch: {
      requireFiles,
      readyTimeoutSec,
      readyPollSec,
      onMissing,
      supervisorMode: "stage0_smoke_gate",
      supervisorStateFile: stateFile,
      supervisorExpectStatus: expectStatus,
      supervisorCleanupSmokePolicy: cleanupSmokePolicy,
    },
  };
}

function mergeWatchConfigWithPatch(baseWatch, patch) {
  const out = baseWatch && typeof baseWatch === "object" && !Array.isArray(baseWatch) ? { ...baseWatch } : {};
  if (!patch || typeof patch !== "object") return out;

  const existingRequire = uniqueStringList(out.requireFiles, { maxItems: 32, maxLen: 1200 });
  const patchRequire = uniqueStringList(patch.requireFiles, { maxItems: 32, maxLen: 1200 });
  out.requireFiles = uniqueStringList([...existingRequire, ...patchRequire], { maxItems: 32, maxLen: 1200 });

  if (out.readyTimeoutSec == null && patch.readyTimeoutSec != null) out.readyTimeoutSec = patch.readyTimeoutSec;
  if (out.readyPollSec == null && patch.readyPollSec != null) out.readyPollSec = patch.readyPollSec;
  if (out.onMissing == null && patch.onMissing != null) out.onMissing = patch.onMissing;
  if (patch.supervisorMode) out.supervisorMode = patch.supervisorMode;
  if (patch.supervisorStateFile) out.supervisorStateFile = patch.supervisorStateFile;
  if (patch.supervisorExpectStatus) out.supervisorExpectStatus = patch.supervisorExpectStatus;
  if (patch.supervisorCleanupSmokePolicy) out.supervisorCleanupSmokePolicy = patch.supervisorCleanupSmokePolicy;
  return out;
}

function leaseIsActive(lease) {
  if (!lease || typeof lease !== "object") return false;
  const expiresAt = Date.parse(String(lease.expiresAt || ""));
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function acquireResearchLease(stateObj, holder) {
  if (leaseIsActive(stateObj && stateObj.lease)) return null;
  const ttlSec = Math.max(15, CONFIG.researchLeaseTtlSec);
  const acquiredAt = nowIso();
  const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString();
  const token = `lease-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  stateObj.lease = {
    holder: String(holder || "research-step-runner"),
    token,
    acquiredAt,
    expiresAt,
  };
  return token;
}

function releaseResearchLease(stateObj, token) {
  if (!stateObj || typeof stateObj !== "object") return;
  if (!stateObj.lease || typeof stateObj.lease !== "object") {
    stateObj.lease = null;
    return;
  }
  if (!token || String(stateObj.lease.token || "") === String(token)) {
    stateObj.lease = null;
  }
}

function parseIsoMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : NaN;
}

function summarizeResearchActionsForDigest(detailLines, maxItems = 6) {
  const list = Array.isArray(detailLines) ? detailLines : [];
  const trimmed = list
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .slice(0, Math.max(1, maxItems));
  if (trimmed.length === 0) return "(none)";
  return trimmed.join("; ");
}

function shouldPostResearchAutoSummary({ outcome, managerState }) {
  if (!managerState || typeof managerState !== "object") return false;
  const status = String(managerState.status || "").toLowerCase();
  if (status === "blocked" || status === "done") return CONFIG.researchPostOnBlocked;
  if (outcome !== "applied") return false;
  if (!CONFIG.researchPostOnApplied) return false;

  const steps = Number((managerState.counters && managerState.counters.steps) || 0);
  const every = Math.max(1, Number(CONFIG.researchPostEverySteps || 1));
  if (every <= 1) return true;
  return steps % every === 0;
}

async function repairResearchStaleState(projectRoot, managerState, trigger = "tick") {
  let changed = false;
  let blockedMessage = "";

  const lease = managerState && managerState.lease && typeof managerState.lease === "object" ? managerState.lease : null;
  if (lease) {
    const leaseExpiryMs = parseIsoMs(lease.expiresAt);
    if (Number.isFinite(leaseExpiryMs) && leaseExpiryMs <= Date.now()) {
      const prior = { ...lease };
      managerState.lease = null;
      changed = true;
      await appendResearchEvent(projectRoot, {
        type: "research_lease_expired",
        trigger,
        holder: String(prior.holder || ""),
        token: String(prior.token || ""),
        expiredAt: String(prior.expiresAt || ""),
      });
    }
  }

  const inflight =
    managerState && managerState.inflightStep && typeof managerState.inflightStep === "object"
      ? managerState.inflightStep
      : null;
  if (inflight && String(inflight.status || "") === "running") {
    const startedMs = parseIsoMs(inflight.startedAt);
    const ttlSec = Math.max(60, Number(CONFIG.researchInflightTtlSec || 900));
    const ageSec = Number.isFinite(startedMs) ? Math.floor((Date.now() - startedMs) / 1000) : 0;
    if (Number.isFinite(startedMs) && ageSec > ttlSec) {
      inflight.status = "failed";
      inflight.error = `inflight step exceeded ttl (${ageSec}s > ${ttlSec}s)`;
      managerState.status = "blocked";
      managerState.autoRun = false;
      managerState.phase = "analyze";
      releaseResearchLease(managerState);
      changed = true;
      blockedMessage = inflight.error;
      await appendResearchEvent(projectRoot, {
        type: "research_inflight_timeout",
        trigger,
        stepId: inflight.stepId || null,
        ageSec,
        ttlSec,
      });
      await appendResearchReportDigest(
        projectRoot,
        `Blocked ${inflight.stepId || "(unknown step)"}`,
        `In-flight manager step timed out after ${ageSec}s (ttl=${ttlSec}s).`
      );
    }
  }

  if (changed) {
    await saveResearchManagerState(projectRoot, managerState);
  }
  return { changed, blockedMessage };
}

function shouldAllowResearchControl({ isDm, session, requireConversationToggle = true }) {
  if (!CONFIG.researchEnabled) {
    return { ok: false, reason: "RELAY_RESEARCH_ENABLED=false" };
  }
  if (CONFIG.researchProjectsRootError) {
    return { ok: false, reason: CONFIG.researchProjectsRootError };
  }
  if (CONFIG.researchDmOnly && !isDm) {
    return { ok: false, reason: "RELAY_RESEARCH_DM_ONLY=true" };
  }
  ensureAutoShape(session);
  if (requireConversationToggle && session && session.auto && session.auto.research === false) {
    return { ok: false, reason: "conversation research automation is OFF (/auto research off)" };
  }
  return { ok: true, reason: "" };
}

function extractResearchDecision(text) {
  const rawText = String(text || "");
  const rawLower = rawText.toLowerCase();
  const startMarker = "[[research-decision]]";
  const endMarker = "[[/research-decision]]";
  const start = rawLower.indexOf(startMarker);
  if (start < 0) {
    return { ok: false, error: "missing [[research-decision]] block", decision: null, cleanedText: rawText };
  }
  const end = rawLower.indexOf(endMarker, start + startMarker.length);
  if (end < 0) {
    return { ok: false, error: "missing [[/research-decision]] terminator", decision: null, cleanedText: rawText };
  }
  const payload = rawText.slice(start + startMarker.length, end).trim();
  const cleanedText = `${rawText.slice(0, start)}${rawText.slice(end + endMarker.length)}`.trim();
  if (!payload) {
    return { ok: false, error: "empty research-decision payload", decision: null, cleanedText };
  }
  if (payload.length > 100000) {
    return { ok: false, error: "research-decision payload too large", decision: null, cleanedText };
  }
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    return {
      ok: false,
      error: `research-decision JSON parse failed: ${String(err && err.message ? err.message : err).slice(0, 200)}`,
      decision: null,
      cleanedText,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "research-decision payload must be an object", decision: null, cleanedText };
  }
  const stepId = String(parsed.stepId || "").trim();
  if (!stepId) {
    return { ok: false, error: "research-decision missing stepId", decision: null, cleanedText };
  }
  const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  return {
    ok: true,
    error: "",
    cleanedText,
    decision: {
      stepId: stepId.length > 120 ? stepId.slice(0, 120) : stepId,
      research_update: parsed.research_update == null ? null : parsed.research_update,
      actions,
      raw: parsed,
    },
  };
}

function normalizeResearchAction(rawAction) {
  if (!rawAction || typeof rawAction !== "object" || Array.isArray(rawAction)) {
    return { ok: false, error: "action is not an object", action: null };
  }
  const type = String(rawAction.type || "").trim().toLowerCase();
  if (!type) return { ok: false, error: "missing action.type", action: null };

  const key = String(rawAction.idempotencyKey || "").trim();
  if (!key) return { ok: false, error: `${type}: missing idempotencyKey`, action: null };
  const idempotencyKey = key.length > 160 ? key.slice(0, 160) : key;

  if (type === "write_report") {
    const markdown = String(rawAction.markdown || "").trim();
    if (!markdown) return { ok: false, error: "write_report: missing markdown", action: null };
    const modeRaw = String(rawAction.mode || "append").trim().toLowerCase();
    const mode = modeRaw === "replace" ? "replace" : "append";
    return {
      ok: true,
      error: "",
      action: {
        type,
        idempotencyKey,
        markdown: markdown.length > 20000 ? markdown.slice(0, 20000) : markdown,
        mode,
      },
    };
  }

  if (type === "research_pause" || type === "research_mark_done") {
    const reasonRaw = rawAction.reason == null ? "" : String(rawAction.reason || "").trim();
    const reason = reasonRaw ? (reasonRaw.length > 500 ? reasonRaw.slice(0, 500) : reasonRaw) : "";
    return { ok: true, error: "", action: { type, idempotencyKey, reason } };
  }

  const baseInput = { ...rawAction };
  delete baseInput.idempotencyKey;
  const base = normalizeRelayAction(baseInput);
  if (!base.ok) return base;
  return {
    ok: true,
    error: "",
    action: {
      ...base.action,
      idempotencyKey,
    },
  };
}

function validateAndNormalizeResearchActions(actions, { session, isDm, origin }) {
  const errs = [];
  const out = [];
  const list = Array.isArray(actions) ? actions : [];
  if (origin !== "research_manager") {
    return { ok: false, error: "origin must be research_manager", actions: [], errors: ["invalid origin"] };
  }

  const gate = shouldAllowResearchControl({ isDm, session });
  if (!gate.ok) {
    return { ok: false, error: gate.reason, actions: [], errors: [gate.reason] };
  }

  const allowed = CONFIG.researchActionsAllowed instanceof Set ? CONFIG.researchActionsAllowed : new Set();
  const budget = Math.max(1, CONFIG.researchMaxActionsPerStep);
  for (const rawAction of list) {
    if (out.length >= budget) {
      errs.push(`max actions per step reached (${budget})`);
      break;
    }
    const normalized = normalizeResearchAction(rawAction);
    if (!normalized.ok) {
      errs.push(normalized.error);
      continue;
    }
    const type = String(normalized.action.type || "").trim().toLowerCase();
    if (allowed.size > 0 && !allowed.has(type)) {
      errs.push(`${type}: blocked (not in RELAY_RESEARCH_ACTIONS_ALLOWED)`);
      continue;
    }
    out.push(normalized.action);
  }
  return { ok: errs.length === 0, error: errs[0] || "", actions: out, errors: errs };
}

async function loadFeedbackEventsSince(projectRoot, sinceIso) {
  const p = researchPaths(projectRoot);
  const threshold = sinceIso ? Date.parse(String(sinceIso || "")) : NaN;
  const out = [];
  try {
    const raw = await fsp.readFile(p.eventsPath, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (!evt || typeof evt !== "object") continue;
      if (String(evt.type || "") !== "user_feedback") continue;
      const ts = Date.parse(String(evt.ts || ""));
      if (Number.isFinite(threshold) && Number.isFinite(ts) && ts <= threshold) continue;
      out.push(evt);
    }
  } catch {}
  return out.slice(-20);
}

function summarizeResearchUpdate(value, maxChars = 1200) {
  const budget = Math.max(200, Math.floor(Number(maxChars || 0) || 1200));
  if (typeof value === "string") {
    const cleaned = value.trim();
    return cleaned.length > budget ? `${cleaned.slice(0, budget)}...` : cleaned;
  }
  if (value == null) return "";
  let text = "";
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  text = text.trim();
  return text.length > budget ? `${text.slice(0, budget)}...` : text;
}

async function buildResearchManagerPrompt({ projectRoot, stateObj }) {
  const p = researchPaths(projectRoot);
  const goal = (await readFileTailText(p.goalPath, 6000)).trim();
  const hypotheses = (await readFileTailText(p.hypothesesPath, 6000)).trim();
  const registryTail = (await readJsonlTail(p.registryPath, 20)).trim();
  const reportTail = (
    await readFileTailTextFallback([p.reportPath, p.reportDigestPath, p.legacyReportPath], 8000)
  ).trim();
  const feedback = await loadFeedbackEventsSince(projectRoot, stateObj.lastFeedbackAt);

  const feedbackLines = feedback.map((evt) => {
    const text = String(evt.text || "").replace(/\s+/g, " ").trim();
    return `- ${evt.ts || ""} ${text}`;
  });

  return [
    "You are the research manager for an unattended experiment loop.",
    "Output exactly one JSON object wrapped in markers:",
    "[[research-decision]]",
    '{"stepId":"s-0001","research_update":{"summary":"..."}, "actions":[...]}',
    "[[/research-decision]]",
    "",
    "Rules:",
    "- Keep research_update concise and concrete.",
    "- Propose only actions that are necessary for the next step.",
    "- Include idempotencyKey on every action.",
    "- If a long run is needed, use job_start and write metrics.json to RUN_DIR.",
    "- Do not keep foreground monitor loops (`sleep` + `tail`) in manager responses.",
    "- Do not emit any markdown outside the decision marker block.",
    "",
    `State status: ${stateObj.status}`,
    `State phase: ${stateObj.phase}`,
    `Budgets: ${JSON.stringify(stateObj.budgets || {})}`,
    `Counters: ${JSON.stringify(stateObj.counters || {})}`,
    `Active: ${JSON.stringify(stateObj.active || {})}`,
    "",
    "[Goal]",
    goal || "(none)",
    "",
    "[Hypotheses]",
    hypotheses || "(none)",
    "",
    "[Recent registry entries]",
    registryTail || "(none)",
    "",
    "[Report tail]",
    reportTail || "(none)",
    "",
    "[New user feedback delta]",
    feedbackLines.length > 0 ? feedbackLines.join("\n") : "(none)",
  ].join("\n");
}

function trimArrayUniquePush(list, value, maxItems) {
  const arr = Array.isArray(list) ? list : [];
  const v = String(value || "").trim();
  if (!v) return arr;
  if (!arr.includes(v)) arr.push(v);
  const keep = Math.max(1, Math.floor(Number(maxItems || 0) || 1000));
  if (arr.length > keep) arr.splice(0, arr.length - keep);
  return arr;
}

async function executeResearchActions({
  actions,
  conversationKey,
  session,
  channel,
  isDm,
  isThread,
  projectRoot,
  managerState,
  stepId,
}) {
  const lines = [];
  let executed = 0;
  const p = researchPaths(projectRoot);
  if (!Array.isArray(managerState.appliedActionKeys)) managerState.appliedActionKeys = [];

  for (const action of actions || []) {
    if (!action || typeof action !== "object") continue;
    const type = String(action.type || "").trim().toLowerCase();
    const idem = String(action.idempotencyKey || "").trim();
    if (!type) continue;
    if (idem && managerState.appliedActionKeys.includes(idem)) {
      lines.push(`- ${type}: skipped duplicate idempotencyKey \`${idem}\``);
      continue;
    }

    if (type === "job_start") {
      const existing = findLatestJob(session, { requireRunning: true });
      if (existing) return { ok: false, executed, lines, error: `job_start refused: ${existing.id} is still running` };

      const nextRunN = Number((managerState.counters && managerState.counters.runs) || 0) + 1;
      const runId = newResearchRunId(nextRunN);
      const runDir = path.join(p.resultsDir, runId);
      const stdoutPath = path.join(runDir, "stdout.log");
      const metricsPath = path.join(runDir, "metrics.json");
      await fsp.mkdir(runDir, { recursive: true });

      if (action.supervisor) {
        return {
          ok: false,
          executed,
          lines,
          error: "job_start supervisor block is not supported in research manager mode (Phase 1 scope)",
        };
      }
      const rawCommand = String(action.command || "").trim();
      if (!rawCommand) return { ok: false, executed, lines, error: "job_start missing command" };
      const guardRes = await evaluateJobLaunchGuards({
        command: rawCommand,
        workdir: session.workdir || CONFIG.defaultWorkdir,
        preflight: action.preflight || null,
      });
      if (guardRes.warnings && guardRes.warnings.length > 0) {
        lines.push(`- job_start guard warnings: ${guardRes.warnings.join(" | ")}`);
      }
      if (!guardRes.ok) {
        const failed = guardRes.preflight && guardRes.preflight.failed ? JSON.stringify(guardRes.preflight.failed) : "";
        return {
          ok: false,
          executed,
          lines,
          error: `job_start blocked by guard (${guardRes.reason})${failed ? `: ${failed}` : ""}`,
        };
      }
      const wrappedCommand = [
        `mkdir -p ${safeShellArg(runDir)}`,
        `export RUN_ID=${safeShellArg(runId)}`,
        `export RUN_DIR=${safeShellArg(runDir)}`,
        `(${rawCommand}) > ${safeShellArg(stdoutPath)} 2>&1`,
      ].join(" && ");

      const started = await startJobProcess({
        conversationKey,
        session,
        command: wrappedCommand,
        workdir: session.workdir || CONFIG.defaultWorkdir,
        description: action.description || `Research run ${runId}`,
      });
      if (!started.ok || !started.job) {
        return { ok: false, executed, lines, error: started.error || "job_start failed" };
      }
      const job = started.job;
      job.research = {
        projectRoot: p.root,
        stepId: String(stepId || ""),
        runId,
        runDir,
        stdoutPath,
        metricsPath,
      };
      session.updatedAt = nowIso();
      await queueSaveState();

      const watchCfg = normalizeJobWatchConfig(action.watch || {}, {
        everySecDefault: CONFIG.jobsAutoWatchEverySec,
        tailLinesDefault: CONFIG.jobsAutoWatchTailLines,
        jobCommand: rawCommand,
        workdir: session.workdir || CONFIG.defaultWorkdir,
      });
      const watchRes = await startJobWatcher({
        conversationKey,
        session,
        job,
        channelId: channel && channel.id ? String(channel.id) : session.lastChannelId,
        watchConfig: watchCfg,
      });
      if (!watchRes || !watchRes.ok) {
        return { ok: false, executed, lines, error: "job_start succeeded but watcher failed to start" };
      }

      managerState.active = { jobId: job.id, runId };
      if (!managerState.counters || typeof managerState.counters !== "object") managerState.counters = { steps: 0, runs: 0 };
      managerState.counters.runs = nextRunN;

      await appendResearchEvent(projectRoot, {
        type: "run_started",
        conversationKey,
        stepId,
        runId,
        jobId: job.id,
        workdir: session.workdir || CONFIG.defaultWorkdir,
        artifacts: { runDir, stdoutPath, metricsPath },
      });

      executed += 1;
      lines.push(`- job_start: \`${job.id}\` run=\`${runId}\`${jobDisplayDescription(job, 80) ? ` desc="${jobDisplayDescription(job, 80)}"` : ""}`);
      managerState.appliedActionKeys = trimArrayUniquePush(managerState.appliedActionKeys, idem, 2000);
      continue;
    }

    if (type === "job_watch") {
      const job = findLatestJob(session, { requireRunning: true }) || findLatestJob(session, { requireRunning: false });
      if (!job) return { ok: false, executed, lines, error: "job_watch failed: no job found" };
      const watchCfg = normalizeJobWatchConfig(action.watch || {}, {
        everySecDefault: CONFIG.jobsAutoWatchEverySec,
        tailLinesDefault: CONFIG.jobsAutoWatchTailLines,
        jobCommand: job.command || "",
        workdir: job.workdir || session.workdir || CONFIG.defaultWorkdir,
      });
      const res = await startJobWatcher({
        conversationKey,
        session,
        job,
        channelId: channel && channel.id ? String(channel.id) : session.lastChannelId,
        watchConfig: watchCfg,
      });
      if (!res || !res.ok) return { ok: false, executed, lines, error: "job_watch failed" };
      executed += 1;
      lines.push(`- job_watch: \`${job.id}\``);
      managerState.appliedActionKeys = trimArrayUniquePush(managerState.appliedActionKeys, idem, 2000);
      continue;
    }

    if (type === "job_stop") {
      const job = findLatestJob(session, { requireRunning: true });
      if (!job) return { ok: false, executed, lines, error: "job_stop failed: no running job" };
      const pid = job.pid;
      killProcessGroup(pid, "SIGTERM");
      job.status = "canceled";
      job.exitedAt = job.exitedAt || nowIso();
      job.finishedAt = job.finishedAt || nowIso();
      appendJobLifecycleTransition(job, "failed", "job_stop_requested", { signal: "SIGTERM", pid: pid || null });
      session.updatedAt = nowIso();
      await queueSaveState();
      await stopJobWatcher(conversationKey, job.id);
      executed += 1;
      lines.push(`- job_stop: \`${job.id}\``);
      managerState.appliedActionKeys = trimArrayUniquePush(managerState.appliedActionKeys, idem, 2000);
      continue;
    }

    if (type === "task_add") {
      if (!CONFIG.tasksEnabled) return { ok: false, executed, lines, error: "task_add blocked: RELAY_TASKS_ENABLED=false" };
      ensureTasksShape(session);
      const pending = session.tasks.filter((t) => t && t.status === "pending").length;
      if (CONFIG.tasksMaxPending > 0 && pending >= CONFIG.tasksMaxPending) {
        return { ok: false, executed, lines, error: `task_add blocked: queue full (pending=${pending}, max=${CONFIG.tasksMaxPending})` };
      }
      const task = createTask(session, String(action.text || ""), {
        description: action.description || null,
      });
      session.tasks.push(task);
      session.updatedAt = nowIso();
      await queueSaveState();
      executed += 1;
      lines.push(`- task_add: \`${task.id}\`${taskDisplayDescription(task, 80) ? ` desc="${taskDisplayDescription(task, 80)}"` : ""}`);
      managerState.appliedActionKeys = trimArrayUniquePush(managerState.appliedActionKeys, idem, 2000);
      continue;
    }

    if (type === "task_run") {
      const res = await maybeStartTaskRunner(conversationKey, channel, session, { isDm, isThread });
      executed += 1;
      lines.push(`- task_run: ${res && res.started ? "started" : "noop"}`);
      managerState.appliedActionKeys = trimArrayUniquePush(managerState.appliedActionKeys, idem, 2000);
      continue;
    }

    if (type === "write_report") {
      const mode = String(action.mode || "append").toLowerCase() === "replace" ? "replace" : "append";
      const markdown = String(action.markdown || "").trim();
      if (!markdown) return { ok: false, executed, lines, error: "write_report missing markdown" };
      if (mode === "replace") {
        await fsp.writeFile(p.reportPath, `${markdown}\n`, "utf8");
        if (p.legacyReportPath && p.legacyReportPath !== p.reportPath) {
          await fsp.writeFile(p.legacyReportPath, `${markdown}\n`, "utf8");
        }
      } else {
        await fsp.appendFile(p.reportPath, `\n\n${markdown}\n`, "utf8");
        if (p.legacyReportPath && p.legacyReportPath !== p.reportPath) {
          await fsp.appendFile(p.legacyReportPath, `\n\n${markdown}\n`, "utf8");
        }
      }
      executed += 1;
      lines.push(`- write_report: ${mode}`);
      managerState.appliedActionKeys = trimArrayUniquePush(managerState.appliedActionKeys, idem, 2000);
      continue;
    }

    if (type === "research_pause") {
      managerState.status = "paused";
      managerState.autoRun = false;
      executed += 1;
      lines.push("- research_pause");
      managerState.appliedActionKeys = trimArrayUniquePush(managerState.appliedActionKeys, idem, 2000);
      continue;
    }

    if (type === "research_mark_done") {
      managerState.status = "done";
      managerState.autoRun = false;
      executed += 1;
      lines.push("- research_mark_done");
      managerState.appliedActionKeys = trimArrayUniquePush(managerState.appliedActionKeys, idem, 2000);
      continue;
    }

    return { ok: false, executed, lines, error: `unsupported research action type: ${type}` };
  }

  return { ok: true, executed, lines, error: "" };
}

async function appendResearchReportDigest(projectRoot, title, body) {
  const p = researchPaths(projectRoot);
  const ts = nowIso();
  const cleanTitle = String(title || "").trim() || "Research update";
  const cleanBody = String(body || "").trim();
  const section = [`## ${ts} — ${cleanTitle}`, cleanBody || "(no details)", ""].join("\n");
  await fsp.appendFile(p.reportPath, `\n${section}\n`, "utf8");
  if (p.legacyReportPath && p.legacyReportPath !== p.reportPath) {
    await fsp.appendFile(p.legacyReportPath, `\n${section}\n`, "utf8");
  }
  if (p.reportDigestPath && p.reportDigestPath !== p.reportPath) {
    await fsp.appendFile(p.reportDigestPath, `\n${section}\n`, "utf8");
  }
}

async function runResearchManagerStep({
  conversationKey,
  session,
  channel,
  isDm,
  isThread,
  trigger = "manual",
}) {
  ensureAutoShape(session);
  ensureResearchShape(session);

  const gate = shouldAllowResearchControl({ isDm, session });
  if (!gate.ok) {
    return { ok: false, blocked: true, outcome: "blocked", message: gate.reason };
  }
  if (!session.research || !session.research.enabled || !session.research.projectRoot) {
    return {
      ok: false,
      blocked: true,
      outcome: "blocked",
      message: "No active research project. Use `/research start <goal...>` first.",
    };
  }

  const projectRoot = path.resolve(session.research.projectRoot);
  const managerState = await loadResearchManagerState(projectRoot);
  const repaired = await repairResearchStaleState(projectRoot, managerState, trigger);
  if (repaired.blockedMessage) {
    return {
      ok: false,
      blocked: true,
      outcome: "blocked",
      message: `blocked: ${repaired.blockedMessage}`,
    };
  }
  const autoTrigger = trigger !== "manual" && trigger !== "run";
  if (autoTrigger && managerState.status !== "running") {
    return { ok: true, skipped: true, outcome: "skipped", message: `research status is ${managerState.status}` };
  }
  if (managerState.status === "done") {
    return { ok: true, skipped: true, outcome: "done", message: "research already marked done" };
  }
  if (managerState.status === "blocked" && trigger !== "manual") {
    return {
      ok: true,
      skipped: true,
      outcome: "blocked",
      message: "research is blocked; manual `/research step` required",
    };
  }

  if (!managerState.counters || typeof managerState.counters !== "object") managerState.counters = { steps: 0, runs: 0 };
  if (!managerState.budgets || typeof managerState.budgets !== "object") {
    managerState.budgets = {
      maxSteps: CONFIG.researchDefaultMaxSteps,
      maxWallClockMinutes: CONFIG.researchDefaultMaxWallclockMin,
      maxRuns: CONFIG.researchDefaultMaxRuns,
    };
  }
  if (managerState.counters.steps >= Number(managerState.budgets.maxSteps || 0)) {
    managerState.status = "blocked";
    managerState.autoRun = false;
    await appendResearchEvent(projectRoot, {
      type: "research_blocked_budget",
      reason: "maxSteps reached",
      steps: managerState.counters.steps,
      budget: managerState.budgets.maxSteps,
      trigger,
    });
    await saveResearchManagerState(projectRoot, managerState);
    return { ok: false, blocked: true, outcome: "blocked", message: "blocked: max steps budget reached" };
  }
  if (managerState.counters.runs >= Number(managerState.budgets.maxRuns || 0)) {
    managerState.status = "blocked";
    managerState.autoRun = false;
    await appendResearchEvent(projectRoot, {
      type: "research_blocked_budget",
      reason: "maxRuns reached",
      runs: managerState.counters.runs,
      budget: managerState.budgets.maxRuns,
      trigger,
    });
    await saveResearchManagerState(projectRoot, managerState);
    return { ok: false, blocked: true, outcome: "blocked", message: "blocked: max runs budget reached" };
  }
  const startedAtMs = Date.parse(String(managerState.startedAt || ""));
  if (Number.isFinite(startedAtMs)) {
    const elapsedMin = Math.floor((Date.now() - startedAtMs) / 60000);
    if (elapsedMin >= Number(managerState.budgets.maxWallClockMinutes || 0)) {
      managerState.status = "blocked";
      managerState.autoRun = false;
      await appendResearchEvent(projectRoot, {
        type: "research_blocked_budget",
        reason: "maxWallClockMinutes reached",
        elapsedMin,
        budget: managerState.budgets.maxWallClockMinutes,
        trigger,
      });
      await saveResearchManagerState(projectRoot, managerState);
      return { ok: false, blocked: true, outcome: "blocked", message: "blocked: wallclock budget reached" };
    }
  }

  const runningJob = findLatestJob(session, { requireRunning: true });
  if (runningJob && managerState.active && managerState.active.jobId === runningJob.id) {
    return { ok: true, skipped: true, outcome: "waiting", message: `waiting for active job ${runningJob.id}` };
  }

  const leaseToken = acquireResearchLease(managerState, `conv:${conversationKey}`);
  if (!leaseToken) {
    return { ok: true, skipped: true, outcome: "skipped", message: "another research step is currently in flight" };
  }

  const managerConvKey = session.research.managerConvKey || managerConversationKeyFor(conversationKey);
  session.research.managerConvKey = managerConvKey;
  session.updatedAt = nowIso();
  await queueSaveState();

  const managerSession = getSession(managerConvKey);
  if (managerSession.workdir !== projectRoot) {
    managerSession.workdir = projectRoot;
    managerSession.threadId = null;
    managerSession.contextVersion = 0;
  }

  managerState.inflightStep = {
    stepId: null,
    decisionHash: null,
    status: "running",
    startedAt: nowIso(),
    error: null,
  };
  managerState.phase = "plan";
  await saveResearchManagerState(projectRoot, managerState);

  try {
    const prompt = await buildResearchManagerPrompt({ projectRoot, stateObj: managerState });
    const result = await runAgent(
      managerSession,
      prompt,
      CONFIG.uploadEnabled ? { RELAY_UPLOAD_DIR: getConversationUploadDir(conversationKey) } : null,
      null,
      managerConvKey
    );
    managerSession.threadId = result.threadId || managerSession.threadId;
    managerSession.updatedAt = nowIso();
    await queueSaveState();

    const extracted = extractResearchDecision(result.text || "");
    if (!extracted.ok || !extracted.decision) {
      managerState.inflightStep = {
        stepId: null,
        decisionHash: null,
        status: "failed",
        startedAt: managerState.inflightStep && managerState.inflightStep.startedAt ? managerState.inflightStep.startedAt : nowIso(),
        error: extracted.error,
      };
      managerState.status = "blocked";
      managerState.autoRun = false;
      releaseResearchLease(managerState, leaseToken);
      await appendResearchEvent(projectRoot, {
        type: "decision_parse_failed",
        trigger,
        error: extracted.error,
      });
      await saveResearchManagerState(projectRoot, managerState);
      return { ok: false, blocked: true, outcome: "blocked", message: `decision parse failed: ${extracted.error}` };
    }

    const decision = extracted.decision;
    const decisionHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(decision.raw || decision))
      .digest("hex");
    managerState.inflightStep = {
      stepId: decision.stepId,
      decisionHash,
      status: "running",
      startedAt: nowIso(),
      error: null,
    };

    if (!Array.isArray(managerState.appliedDecisionHashes)) managerState.appliedDecisionHashes = [];
    if (managerState.appliedDecisionHashes.includes(decisionHash)) {
      managerState.inflightStep = {
        stepId: decision.stepId,
        decisionHash,
        status: "applied",
        startedAt: managerState.inflightStep && managerState.inflightStep.startedAt ? managerState.inflightStep.startedAt : nowIso(),
        error: null,
      };
      managerState.phase = "analyze";
      managerState.lastDecisionAt = nowIso();
      releaseResearchLease(managerState, leaseToken);
      await appendResearchEvent(projectRoot, {
        type: "decision_duplicate_skipped",
        stepId: decision.stepId,
        decisionHash,
      });
      await saveResearchManagerState(projectRoot, managerState);
      return { ok: true, skipped: true, outcome: "skipped", message: `duplicate decision skipped (${decision.stepId})` };
    }

    const validated = validateAndNormalizeResearchActions(decision.actions, {
      session,
      isDm,
      origin: "research_manager",
    });
    if (!validated.ok) {
      managerState.inflightStep = {
        stepId: decision.stepId,
        decisionHash,
        status: "failed",
        startedAt: managerState.inflightStep && managerState.inflightStep.startedAt ? managerState.inflightStep.startedAt : nowIso(),
        error: `action validation failed: ${validated.errors.join("; ")}`,
      };
      managerState.status = "blocked";
      managerState.autoRun = false;
      releaseResearchLease(managerState, leaseToken);
      await appendResearchEvent(projectRoot, {
        type: "action_validation_failed",
        stepId: decision.stepId,
        decisionHash,
        errors: validated.errors,
      });
      await saveResearchManagerState(projectRoot, managerState);
      return {
        ok: false,
        blocked: true,
        outcome: "blocked",
        message: `action validation failed: ${validated.errors.join("; ")}`,
      };
    }
    if (validated.actions.length === 0) {
      managerState.inflightStep = {
        stepId: decision.stepId,
        decisionHash,
        status: "failed",
        startedAt: managerState.inflightStep && managerState.inflightStep.startedAt ? managerState.inflightStep.startedAt : nowIso(),
        error: "manager returned zero actions",
      };
      managerState.status = "blocked";
      managerState.autoRun = false;
      releaseResearchLease(managerState, leaseToken);
      await appendResearchEvent(projectRoot, {
        type: "decision_no_actions",
        stepId: decision.stepId,
        decisionHash,
      });
      await appendResearchReportDigest(projectRoot, `Blocked ${decision.stepId}`, "Manager returned zero actions; awaiting user direction.");
      await saveResearchManagerState(projectRoot, managerState);
      return {
        ok: false,
        blocked: true,
        outcome: "blocked",
        message: "manager returned zero actions; research blocked for safety",
      };
    }

    const execRes = await executeResearchActions({
      actions: validated.actions,
      conversationKey,
      session,
      channel,
      isDm,
      isThread,
      projectRoot,
      managerState,
      stepId: decision.stepId,
    });
    if (!execRes.ok) {
      managerState.inflightStep = {
        stepId: decision.stepId,
        decisionHash,
        status: "failed",
        startedAt: managerState.inflightStep && managerState.inflightStep.startedAt ? managerState.inflightStep.startedAt : nowIso(),
        error: execRes.error || "action execution failed",
      };
      managerState.status = "blocked";
      managerState.autoRun = false;
      releaseResearchLease(managerState, leaseToken);
      await appendResearchEvent(projectRoot, {
        type: "action_failed",
        stepId: decision.stepId,
        decisionHash,
        error: execRes.error,
        detail: execRes.lines,
      });
      await appendResearchReportDigest(projectRoot, `Failure ${decision.stepId}`, execRes.error || "(unknown)");
      await saveResearchManagerState(projectRoot, managerState);
      return { ok: false, blocked: true, outcome: "blocked", message: `action execution failed: ${execRes.error}` };
    }

    managerState.counters.steps = Number(managerState.counters.steps || 0) + 1;
    managerState.appliedDecisionHashes = trimArrayUniquePush(managerState.appliedDecisionHashes, decisionHash, 500);
    managerState.lastDecisionAt = nowIso();
    managerState.lastFeedbackAt = nowIso();
    managerState.phase = managerState.active && managerState.active.jobId ? "wait" : "analyze";
    if (!managerState.status || managerState.status === "paused") {
      managerState.status = trigger === "run" ? "running" : "paused";
    }
    managerState.inflightStep = {
      stepId: decision.stepId,
      decisionHash,
      status: "applied",
      startedAt: managerState.inflightStep && managerState.inflightStep.startedAt ? managerState.inflightStep.startedAt : nowIso(),
      error: null,
    };
    releaseResearchLease(managerState, leaseToken);

    const updateSummary = summarizeResearchUpdate(decision.research_update, 1500);
    await appendResearchEvent(projectRoot, {
      type: "decision_applied",
      stepId: decision.stepId,
      decisionHash,
      actions: validated.actions.map((a) => a.type),
      executed: execRes.executed,
      trigger,
    });
    await appendResearchReportDigest(
      projectRoot,
      `Step ${decision.stepId}`,
      [updateSummary ? `Research update:\n${updateSummary}` : null, execRes.lines.length ? `Actions:\n${execRes.lines.join("\n")}` : null]
        .filter(Boolean)
        .join("\n\n")
    );
    await saveResearchManagerState(projectRoot, managerState);

    return {
      ok: true,
      outcome: "applied",
      message: `step ${decision.stepId} applied (actions=${execRes.executed})`,
      detailLines: execRes.lines,
      researchUpdate: updateSummary,
    };
  } catch (err) {
    managerState.inflightStep = {
      stepId: managerState.inflightStep && managerState.inflightStep.stepId ? managerState.inflightStep.stepId : null,
      decisionHash: managerState.inflightStep && managerState.inflightStep.decisionHash ? managerState.inflightStep.decisionHash : null,
      status: "failed",
      startedAt:
        managerState.inflightStep && managerState.inflightStep.startedAt ? managerState.inflightStep.startedAt : nowIso(),
      error: String(err && err.message ? err.message : err).slice(0, 400),
    };
    managerState.status = "blocked";
    managerState.autoRun = false;
    releaseResearchLease(managerState, leaseToken);
    await appendResearchEvent(projectRoot, {
      type: "research_step_error",
      trigger,
      error: String(err && err.message ? err.message : err).slice(0, 400),
    });
    await saveResearchManagerState(projectRoot, managerState);
    return {
      ok: false,
      blocked: true,
      outcome: "blocked",
      message: `research step failed: ${String(err && err.message ? err.message : err).slice(0, 240)}`,
    };
  }
}

function requestResearchAutoStep(conversationKey, channel, reason) {
  const key = String(conversationKey || "").trim();
  if (!key) return false;
  if (researchStepByConversation.has(key)) return false;
  researchStepByConversation.add(key);
  void enqueueConversation(key, async () => {
    try {
      const session = getSession(key);
      const isDm = !session.lastGuildId;
      const isThread = Boolean(channel && channel.isThread && channel.isThread());
      const res = await runResearchManagerStep({
        conversationKey: key,
        session,
        channel,
        isDm,
        isThread,
        trigger: reason || "auto",
      });
      if (channel && res) {
        const projectRoot = session.research && session.research.projectRoot ? path.resolve(session.research.projectRoot) : "";
        const stateObj = projectRoot ? await loadResearchManagerState(projectRoot) : null;
        const outcome = res && res.outcome ? String(res.outcome) : res && res.ok ? "applied" : "blocked";
        const shouldPost = !res.ok || shouldPostResearchAutoSummary({ outcome, managerState: stateObj });

        if (shouldPost && res.message) {
          const tag = res.ok ? "[research:auto]" : "[research:auto blocked]";
          const steps = Number((stateObj && stateObj.counters && stateObj.counters.steps) || 0);
          const status = stateObj && stateObj.status ? String(stateObj.status) : "unknown";
          const actionSummary = summarizeResearchActionsForDigest(res.detailLines || []);
          const suffix =
            outcome === "applied" && actionSummary !== "(none)"
              ? ` | actions: ${actionSummary}`
              : "";
          await channel.send(`${tag} ${res.message} | steps=${steps} status=${status}${suffix}`);

          if (stateObj && stateObj.reporting && typeof stateObj.reporting === "object") {
            stateObj.reporting.lastDiscordDigestAt = nowIso();
            stateObj.reporting.lastDiscordDigestStep = steps;
            await saveResearchManagerState(projectRoot, stateObj);
          }
        }
      }
    } catch (err) {
      try {
        if (channel) await channel.send(`[research:auto error] ${String(err && err.message ? err.message : err).slice(0, 400)}`);
      } catch {}
    } finally {
      researchStepByConversation.delete(key);
    }
  });
  return true;
}

async function resolveResearchAutoChannel(session, managerState) {
  const client = DISCORD_CLIENT;
  if (!client) return null;
  const fromState =
    managerState && managerState.discord && managerState.discord.channelId
      ? String(managerState.discord.channelId || "").trim()
      : "";
  const fromSession = session && session.lastChannelId ? String(session.lastChannelId || "").trim() : "";
  const channelId = fromState || fromSession;
  if (!channelId) return null;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || typeof channel.send !== "function") return null;
    return channel;
  } catch (err) {
    logRelayEvent("research.tick.channel_fetch_error", {
      channelId,
      error: String(err && err.message ? err.message : err).slice(0, 240),
    });
    return null;
  }
}

async function tickResearchAuto() {
  if (!CONFIG.researchEnabled || CONFIG.researchProjectsRootError) return;
  if (!state || !state.sessions || typeof state.sessions !== "object") return;

  const now = Date.now();
  const maxParallel = Math.max(1, Number(CONFIG.researchTickMaxParallel || 1));
  let dispatched = 0;

  for (const [conversationKey, session] of Object.entries(state.sessions)) {
    if (dispatched >= maxParallel) break;
    if (!session || typeof session !== "object") continue;
    ensureAutoShape(session);
    ensureResearchShape(session);
    if (!session.research || !session.research.enabled || !session.research.projectRoot) continue;
    if (!session.auto || session.auto.research === false) continue;

    const projectRoot = path.resolve(session.research.projectRoot);
    const managerState = await loadResearchManagerState(projectRoot);
    await repairResearchStaleState(projectRoot, managerState, "tick");
    if (managerState.status !== "running" || !managerState.autoRun) continue;
    if (String(managerState.phase || "") === "wait") continue;
    if (managerState.active && managerState.active.jobId) continue;

    const isDm = !session.lastGuildId;
    const gate = shouldAllowResearchControl({ isDm, session, requireConversationToggle: true });
    if (!gate.ok) continue;

    const lastTickMs = Number(researchLastTickByConversation.get(conversationKey) || 0);
    if (now - lastTickMs < CONFIG.researchTickSec * 1000) continue;
    if (researchStepByConversation.has(conversationKey)) continue;

    const channel = await resolveResearchAutoChannel(session, managerState);
    const requested = requestResearchAutoStep(conversationKey, channel, "tick");
    if (!requested) continue;
    researchLastTickByConversation.set(conversationKey, now);
    dispatched += 1;
  }

  if (dispatched > 0) {
    logRelayEvent("research.tick.dispatch", {
      dispatched,
      maxParallel,
      tickSec: CONFIG.researchTickSec,
    });
  }
}

function startResearchTickLoop() {
  if (researchTickTimer) {
    try {
      clearInterval(researchTickTimer);
    } catch {}
    researchTickTimer = null;
  }
  if (!CONFIG.researchEnabled || CONFIG.researchProjectsRootError) return;
  researchTickTimer = setInterval(() => {
    void tickResearchAuto().catch((err) =>
      logRelayEvent("research.tick.error", {
        error: String(err && err.message ? err.message : err).slice(0, 240),
      })
    );
  }, Math.max(5000, CONFIG.researchTickSec * 1000));
  researchTickTimer.unref?.();

  void tickResearchAuto().catch((err) =>
    logRelayEvent("research.tick.error", {
      error: String(err && err.message ? err.message : err).slice(0, 240),
    })
  );
}

async function notifyInterruptedAgentRuns(client) {
  if (!client) return;
  if (!Array.isArray(interruptedAgentRunsAfterRestart) || interruptedAgentRunsAfterRestart.length === 0) return;
  const pending = interruptedAgentRunsAfterRestart.splice(0, interruptedAgentRunsAfterRestart.length);
  for (const item of pending) {
    const conversationKey = item && item.conversationKey ? String(item.conversationKey) : "";
    const session = conversationKey ? state.sessions[conversationKey] : null;
    const channelId = String((item && item.channelId) || (session && session.lastChannelId) || "").trim();
    if (!channelId) {
      logRelayEvent("agent.run.interrupted_notice.skipped", {
        conversationKey,
        reason: "missing_channel_id",
      });
      continue;
    }
    const status = String((item && item.status) || "running");
    const provider = String((item && item.provider) || CONFIG.agentProvider || "agent");
    const runReason = cleanProgressText(String((item && item.reason) || "request"), 120) || "request";
    const startedAt = String((item && item.startedAt) || (item && item.queuedAt) || "unknown");
    const summary = `Run status: interrupted (relay restart while ${provider} run was ${status}, reason ${runReason}, started ${startedAt}). Please resend your last message if needed.`;

    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || typeof channel.send !== "function") {
        logRelayEvent("agent.run.interrupted_notice.skipped", {
          conversationKey,
          channelId,
          reason: "channel_unavailable",
        });
        continue;
      }

      let edited = false;
      const pendingMessageId = String((item && item.pendingMessageId) || "").trim();
      if (pendingMessageId && channel.messages && typeof channel.messages.fetch === "function") {
        try {
          const msg = await channel.messages.fetch(pendingMessageId);
          if (msg && typeof msg.edit === "function") {
            await msg.edit(summary);
            edited = true;
          }
        } catch {}
      }
      if (!edited) {
        await sendLongToChannel(channel, summary);
      }
      logRelayEvent("agent.run.interrupted_notice.sent", {
        conversationKey,
        channelId,
        pendingMessageId: pendingMessageId || null,
        editedPending: edited,
      });
    } catch (err) {
      logRelayEvent("agent.run.interrupted_notice.error", {
        conversationKey,
        channelId,
        error: String(err && err.message ? err.message : err).slice(0, 240),
      });
    }
  }
}

async function handleResearchJobCompletion({ conversationKey, session, job, exitCode, channel }) {
  if (!job || typeof job !== "object") return;
  const meta = job.research;
  if (!meta || typeof meta !== "object") return;
  const projectRoot = String(meta.projectRoot || "").trim();
  if (!projectRoot) return;

  const p = researchPaths(projectRoot);
  const runId = String(meta.runId || "").trim() || null;
  const runDir = String(meta.runDir || "").trim() || (runId ? path.join(p.resultsDir, runId) : "");
  const stdoutPath = String(meta.stdoutPath || "").trim() || (runDir ? path.join(runDir, "stdout.log") : "");
  const metricsPath = String(meta.metricsPath || "").trim() || (runDir ? path.join(runDir, "metrics.json") : "");

  let metricsObj = null;
  let metricsError = "";
  try {
    const raw = await fsp.readFile(metricsPath, "utf8");
    metricsObj = JSON.parse(raw);
    if (!metricsObj || typeof metricsObj !== "object") {
      metricsObj = null;
      metricsError = "metrics.json is not an object";
    }
  } catch (err) {
    metricsObj = null;
    metricsError = String(err && err.message ? err.message : err);
  }
  const metricsValid = Boolean(metricsObj && typeof metricsObj === "object");
  const primaryMetric =
    metricsValid && metricsObj.primary_metric && typeof metricsObj.primary_metric === "object"
      ? metricsObj.primary_metric
      : null;

  await appendJsonLine(p.registryPath, {
    run_id: runId,
    started_at: job.startedAt || null,
    ended_at: job.finishedAt || nowIso(),
    workdir: job.workdir || null,
    job_id: job.id || null,
    artifacts: {
      run_dir: runDir || null,
      metrics: metricsPath || null,
      log: stdoutPath || null,
    },
    metrics: metricsValid
      ? {
          primary: primaryMetric || null,
          all: metricsObj.metrics && typeof metricsObj.metrics === "object" ? metricsObj.metrics : metricsObj,
        }
      : null,
    status: metricsValid ? "ok" : "invalid",
    notes: metricsValid ? "" : `missing_or_invalid_metrics: ${metricsError}`,
  });

  const managerState = await loadResearchManagerState(projectRoot);
  if (managerState.active && managerState.active.jobId && String(managerState.active.jobId) === String(job.id)) {
    managerState.active = { jobId: null, runId: null };
  }

  await appendResearchEvent(projectRoot, {
    type: "run_finished",
    runId,
    jobId: job.id || null,
    exitCode: Number.isFinite(Number(exitCode)) ? Number(exitCode) : null,
    metricsValid,
    metricsPath,
    metricsError: metricsValid ? null : metricsError,
  });

  if (!metricsValid) {
    managerState.status = "blocked";
    managerState.autoRun = false;
    await appendResearchReportDigest(
      projectRoot,
      `Run ${runId || job.id || "unknown"} invalid`,
      `metrics.json missing or invalid at \`${metricsPath}\`.`
    );
  }
  await saveResearchManagerState(projectRoot, managerState);

  if (channel) {
    const line = metricsValid
      ? `[research] run ${runId || job.id} completed; metrics accepted.`
      : `[research] run ${runId || job.id} blocked: metrics.json missing/invalid (${metricsError}).`;
    await channel.send(line);
  }

  if (
    metricsValid &&
    managerState.autoRun &&
    managerState.status === "running" &&
    session &&
    session.research &&
    session.research.enabled &&
    session.auto &&
    session.auto.research !== false
  ) {
    requestResearchAutoStep(conversationKey, channel, "job_completion");
  }
}

function newPlanId() {
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const HH = String(d.getHours()).padStart(2, "0");
  const MM = String(d.getMinutes()).padStart(2, "0");
  const SS = String(d.getSeconds()).padStart(2, "0");
  const rand = crypto.randomBytes(2).toString("hex");
  return `p-${yyyy}${mm}${dd}-${HH}${MM}${SS}-${rand}`;
}

function newRunId(prefix = "r") {
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const HH = String(d.getHours()).padStart(2, "0");
  const MM = String(d.getMinutes()).padStart(2, "0");
  const SS = String(d.getSeconds()).padStart(2, "0");
  const rand = crypto.randomBytes(2).toString("hex");
  const p = String(prefix || "r").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "") || "r";
  return `${p}-${yyyy}${mm}${dd}-${HH}${MM}${SS}-${rand}`;
}

function planTitleFromRequest(request) {
  const t = taskTextPreview(String(request || "").trim(), 72);
  return t || "plan";
}

function planStorageDir(conversationKey) {
  return path.join(CONFIG.stateDir, "plans", safeConversationDirName(conversationKey));
}

function planStoragePath(conversationKey, planId) {
  return path.join(planStorageDir(conversationKey), `${planId}.md`);
}

function newJobId() {
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const HH = String(d.getHours()).padStart(2, "0");
  const MM = String(d.getMinutes()).padStart(2, "0");
  const SS = String(d.getSeconds()).padStart(2, "0");
  const rand = crypto.randomBytes(2).toString("hex");
  return `j-${yyyy}${mm}${dd}-${HH}${MM}${SS}-${rand}`;
}

function jobStorageDir(conversationKey) {
  return path.join(CONFIG.stateDir, "jobs", safeConversationDirName(conversationKey));
}

function jobStorageJobDir(conversationKey, jobId) {
  return path.join(jobStorageDir(conversationKey), String(jobId || "job").trim() || "job");
}

function jobLogPath(conversationKey, jobId) {
  return path.join(jobStorageJobDir(conversationKey, jobId), "job.log");
}

function jobExitCodePath(conversationKey, jobId) {
  return path.join(jobStorageJobDir(conversationKey, jobId), "exit_code");
}

function jobPidPath(conversationKey, jobId) {
  return path.join(jobStorageJobDir(conversationKey, jobId), "pid");
}

async function readJobExitCode(exitCodeFile) {
  const p = String(exitCodeFile || "").trim();
  if (!p) return { ok: false, code: null };
  try {
    const raw = await fsp.readFile(p, "utf8");
    const s = String(raw || "").trim();
    if (!s) return { ok: false, code: null };
    const n = Number(s);
    if (!Number.isFinite(n)) return { ok: false, code: null };
    return { ok: true, code: Math.floor(n) };
  } catch {
    return { ok: false, code: null };
  }
}

function isPidRunning(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessGroup(pid, signal) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(-n, signal);
    return true;
  } catch {}
  try {
    process.kill(n, signal);
    return true;
  } catch {}
  return false;
}

async function readTailLines(filePath, maxLines, maxBytes = 128 * 1024) {
  const p = String(filePath || "").trim();
  if (!p) return "";
  const wantLines = Math.max(1, Math.min(500, Math.floor(Number(maxLines || 50) || 50)));
  const wantBytes = Math.max(1024, Math.min(2 * 1024 * 1024, Math.floor(Number(maxBytes || 0) || 0) || 128 * 1024));

  let fd = null;
  try {
    const st = await fsp.stat(p);
    if (!st.isFile()) return "";
    const size = Number(st.size || 0);
    const start = Math.max(0, size - wantBytes);
    const len = Math.max(0, size - start);
    fd = await fsp.open(p, "r");
    const buf = Buffer.alloc(len);
    await fd.read(buf, 0, len, start);
    const text = buf.toString("utf8");
    const lines = text.split(/\r?\n/);
    const tail = lines.slice(-wantLines).join("\n");
    return tail.trimEnd();
  } catch {
    return "";
  } finally {
    try {
      if (fd) await fd.close();
    } catch {}
  }
}

async function readHeadBytes(filePath, maxBytes = 128 * 1024) {
  const p = String(filePath || "").trim();
  if (!p) return "";
  const wantBytes = Math.max(1024, Math.min(2 * 1024 * 1024, Math.floor(Number(maxBytes || 0) || 0) || 128 * 1024));
  let fd = null;
  try {
    const st = await fsp.stat(p);
    if (!st.isFile()) return "";
    const len = Math.min(Number(st.size || 0), wantBytes);
    if (!Number.isFinite(len) || len <= 0) return "";
    fd = await fsp.open(p, "r");
    const buf = Buffer.alloc(len);
    await fd.read(buf, 0, len, 0);
    return buf.toString("utf8").trimEnd();
  } catch {
    return "";
  } finally {
    try {
      if (fd) await fd.close();
    } catch {}
  }
}

function summarizeTailText(tail) {
  const text = String(tail || "");
  if (!text) return { lineCount: 0, charCount: 0 };
  return {
    lineCount: text.split(/\r?\n/).length,
    charCount: text.length,
  };
}

async function readLogSignature(filePath) {
  const p = String(filePath || "").trim();
  if (!p) return "";
  try {
    const st = await fsp.stat(p);
    if (!st.isFile()) return "";
    const mtimeMs = Number(st.mtimeMs || 0);
    const size = Number(st.size || 0);
    return `${Math.floor(mtimeMs)}:${size}`;
  } catch {
    return "";
  }
}

async function readProcessTreeCpuPercent(rootPid) {
  const root = Number(rootPid);
  if (!Number.isFinite(root) || root <= 0) return null;
  const pids = await collectProcessTreePids(root);
  const uniq = Array.from(
    new Set(
      (Array.isArray(pids) ? pids : [])
        .map((pid) => Number(pid))
        .filter((pid) => Number.isFinite(pid) && pid > 0)
    )
  );
  if (uniq.length === 0) return null;
  const pidArg = uniq.join(",");
  const res = await execFileCapture("ps", ["-o", "pid=,%cpu=", "-p", pidArg], { timeoutMs: 3000 });
  if (res.code !== 0) return null;
  let sum = 0;
  for (const rawLine of String(res.stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const cpu = Number(parts[1]);
    if (!Number.isFinite(cpu)) continue;
    sum += Math.max(0, cpu);
  }
  return Number.isFinite(sum) ? sum : null;
}

async function readMaxGpuUtilPercent() {
  const res = await execFileCapture(
    "nvidia-smi",
    ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
    { timeoutMs: 3000 }
  );
  if (res.code !== 0) return null;
  let max = null;
  for (const rawLine of String(res.stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const value = Number(line.replace(/%/g, "").trim());
    if (!Number.isFinite(value)) continue;
    const clipped = Math.max(0, Math.min(100, value));
    max = max == null ? clipped : Math.max(max, clipped);
  }
  return max;
}

function formatPercent(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "n/a";
  const d = Math.max(0, Math.min(4, Math.floor(Number(digits) || 0)));
  return `${n.toFixed(d)}%`;
}

function compactTailSnippet(tail, maxLines = 3, maxChars = 600) {
  const text = String(tail || "").trimEnd();
  if (!text) return "";
  const wantLines = Math.max(1, Math.min(50, Math.floor(Number(maxLines || 3) || 3)));
  const wantChars = Math.max(80, Math.min(4000, Math.floor(Number(maxChars || 600) || 600)));
  let out = text.split(/\r?\n/).slice(-wantLines).join("\n");
  if (out.length > wantChars) {
    out = `...${out.slice(-(wantChars - 3))}`;
  }
  return out;
}

function sleepMs(ms) {
  const n = Number(ms);
  const waitMs = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  return new Promise((resolve) => setTimeout(resolve, waitMs));
}

function sanitizeLifecycleDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  try {
    const txt = JSON.stringify(details);
    if (!txt) return null;
    if (txt.length <= 4000) return JSON.parse(txt);
    return { note: "details_truncated", preview: txt.slice(0, 1000) };
  } catch {
    return { note: "details_unserializable" };
  }
}

function appendJobLifecycleTransition(job, state, reason, details = null) {
  if (!job || typeof job !== "object") return false;
  const nextState = String(state || "").trim().toLowerCase();
  if (!nextState) return false;
  const nextReason = String(reason || "").trim();
  const at = nowIso();
  const safeDetails = sanitizeLifecycleDetails(details);
  if (!Array.isArray(job.lifecycle)) job.lifecycle = [];
  const prev = job.lifecycle.length > 0 ? job.lifecycle[job.lifecycle.length - 1] : null;
  const sameAsPrev =
    prev &&
    prev.state === nextState &&
    String(prev.reason || "") === nextReason &&
    JSON.stringify(prev.details || null) === JSON.stringify(safeDetails || null);
  if (!sameAsPrev) {
    const row = { state: nextState, at, reason: nextReason };
    if (safeDetails) row.details = safeDetails;
    job.lifecycle.push(row);
    if (job.lifecycle.length > 200) {
      job.lifecycle = job.lifecycle.slice(-200);
    }
  }
  job.lifecycleState = nextState;
  job.lifecycleReason = nextReason || null;
  job.lifecycleUpdatedAt = at;
  return !sameAsPrev;
}

function detectUnsafeWaitPattern(command) {
  const text = String(command || "");
  const lower = text.toLowerCase();
  if (!lower.includes("pgrep") || !lower.includes("-f")) return [];
  const hasLoop = /\bwhile\b|\buntil\b/.test(lower) || lower.includes("sleep ");
  const warnings = [];
  const re = /pgrep\s+-f\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    const pattern = String(match[1] || match[2] || match[3] || "").trim();
    if (!pattern) continue;
    if (pattern.includes("[") && pattern.includes("]")) continue;
    if (!lower.includes(String(pattern).toLowerCase())) continue;
    warnings.push(
      hasLoop
        ? `unsafe wait-loop pattern: pgrep -f "${pattern}" may self-match`
        : `risky pattern: pgrep -f "${pattern}" may self-match`
    );
  }
  return Array.from(new Set(warnings)).slice(0, 10);
}

function resolvePathForCheck(rawPath, workdir) {
  const p = String(rawPath || "").trim();
  if (!p) return "";
  if (path.isAbsolute(p)) return path.resolve(p);
  return path.resolve(workdir || CONFIG.defaultWorkdir, p);
}

async function runCommandExitCheck({ cmd, workdir, timeoutSec = 30 }) {
  const command = String(cmd || "").trim();
  if (!command) return { ok: false, exitCode: 1, timedOut: false, stdout: "", stderr: "empty command" };
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: workdir || CONFIG.defaultWorkdir,
      env: buildChildProcessEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    let timedOut = false;
    const maxCapture = 2000;
    const timeoutMs = Math.max(1, Math.min(600, Math.floor(Number(timeoutSec) || 30))) * 1000;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 2000).unref?.();
    }, timeoutMs);
    const finish = (exitCode, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const code = typeof exitCode === "number" ? exitCode : signal ? 128 : 1;
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        timedOut,
        stdout: stdout.length > maxCapture ? stdout.slice(-maxCapture) : stdout,
        stderr: stderr.length > maxCapture ? stderr.slice(-maxCapture) : stderr,
      });
    };
    child.stdout.on("data", (buf) => {
      stdout += buf.toString("utf8");
      if (stdout.length > maxCapture * 4) stdout = stdout.slice(-maxCapture * 4);
    });
    child.stderr.on("data", (buf) => {
      stderr += buf.toString("utf8");
      if (stderr.length > maxCapture * 4) stderr = stderr.slice(-maxCapture * 4);
    });
    child.on("error", (err) => {
      stderr += String(err && err.message ? err.message : err);
      finish(1, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

async function getFreeDiskGiB(targetPath) {
  const p = String(targetPath || "").trim() || ".";
  const resolved = path.resolve(p);
  if (typeof fsp.statfs === "function") {
    const stats = await fsp.statfs(resolved);
    const bavail = Number(stats && stats.bavail != null ? stats.bavail : 0);
    const bsize = Number(stats && stats.bsize != null ? stats.bsize : 0);
    if (Number.isFinite(bavail) && Number.isFinite(bsize) && bavail >= 0 && bsize > 0) {
      return (bavail * bsize) / (1024 ** 3);
    }
  }
  const probe = await runCommandExitCheck({ cmd: `df -Pk ${safeShellArg(resolved)} | tail -n 1 | awk '{print $4}'`, workdir: "/" });
  if (!probe.ok) throw new Error(probe.stderr || "df probe failed");
  const kb = Number(String(probe.stdout || "").trim().split(/\s+/).pop());
  if (!Number.isFinite(kb)) throw new Error("invalid df output");
  return kb / (1024 ** 2);
}

async function runJobPreflightChecks({ command, workdir, preflight }) {
  const checks = preflight && Array.isArray(preflight.checks) ? preflight.checks : [];
  const results = [];
  for (let i = 0; i < checks.length; i += 1) {
    const check = checks[i];
    const type = String(check && check.type ? check.type : "").trim().toLowerCase();
    if (type === "path_exists") {
      const resolved = resolvePathForCheck(check.path, workdir);
      let exists = false;
      try {
        await fsp.access(resolved);
        exists = true;
      } catch {
        exists = false;
      }
      const row = { index: i, type, ok: exists, path: String(check.path || ""), resolved };
      results.push(row);
      if (!exists && preflight.onFail !== "warn") {
        return { ok: false, failed: row, results };
      }
      continue;
    }
    if (type === "cmd_exit_zero") {
      const cmd = String(check.cmd || "").trim();
      const timeoutSec = check.timeoutSec == null ? 30 : Number(check.timeoutSec);
      const probe = await runCommandExitCheck({ cmd, workdir, timeoutSec });
      const row = {
        index: i,
        type,
        ok: probe.ok,
        cmd,
        exitCode: probe.exitCode,
        timedOut: probe.timedOut,
        stderr: taskTextPreview(probe.stderr, 240),
      };
      results.push(row);
      if (!probe.ok && preflight.onFail !== "warn") {
        return { ok: false, failed: row, results };
      }
      continue;
    }
    if (type === "min_free_disk_gb") {
      const resolved = resolvePathForCheck(check.path || ".", workdir);
      let freeGiB = 0;
      let errText = "";
      try {
        freeGiB = await getFreeDiskGiB(resolved);
      } catch (err) {
        errText = String(err && err.message ? err.message : err);
      }
      const needGiB = Number(check.gb || 0);
      const ok = !errText && Number.isFinite(freeGiB) && freeGiB >= needGiB;
      const row = {
        index: i,
        type,
        ok,
        path: String(check.path || "."),
        resolved,
        requiredGiB: needGiB,
        freeGiB: Number.isFinite(freeGiB) ? Number(freeGiB.toFixed(2)) : null,
        error: errText || null,
      };
      results.push(row);
      if (!ok && preflight.onFail !== "warn") {
        return { ok: false, failed: row, results };
      }
      continue;
    }
    const row = { index: i, type, ok: false, error: `unsupported preflight check type: ${type}` };
    results.push(row);
    if (preflight.onFail !== "warn") return { ok: false, failed: row, results };
  }
  return { ok: true, failed: null, results };
}

async function evaluateJobLaunchGuards({ command, workdir, preflight }) {
  const warnings = [];
  const waitWarnings = detectUnsafeWaitPattern(command);
  if (waitWarnings.length > 0) {
    if (CONFIG.waitPatternGuardMode === "reject") {
      return {
        ok: false,
        reason: "wait_pattern_guard_reject",
        warnings: waitWarnings,
        preflight: null,
      };
    }
    if (CONFIG.waitPatternGuardMode === "warn") {
      warnings.push(...waitWarnings);
    }
  }

  const hasChecks = Boolean(preflight && Array.isArray(preflight.checks) && preflight.checks.length > 0);
  if (!hasChecks || !CONFIG.jobPreflightEnabled) {
    if (hasChecks && !CONFIG.jobPreflightEnabled) {
      warnings.push("preflight checks supplied but RELAY_JOB_PREFLIGHT_ENABLED=false");
    }
    return {
      ok: true,
      reason: hasChecks && !CONFIG.jobPreflightEnabled ? "preflight_disabled" : "",
      warnings,
      preflight: null,
    };
  }

  const preflightRes = await runJobPreflightChecks({ command, workdir, preflight });
  if (!preflightRes.ok) {
    if (preflight && preflight.onFail === "warn") {
      warnings.push(`preflight warning: ${JSON.stringify(preflightRes.failed || {})}`);
      return { ok: true, reason: "preflight_warn", warnings, preflight: preflightRes };
    }
    return { ok: false, reason: "preflight_failed", warnings, preflight: preflightRes };
  }
  return { ok: true, reason: "preflight_passed", warnings, preflight: preflightRes };
}

function isAllowedRequiredFilePath(absPath) {
  if (!absPath) return false;
  return CONFIG.allowedWorkdirRoots.some((root) => isSubPath(root, absPath));
}

function resolveRequiredArtifactSpecs(requireFiles, workdir) {
  const specs = [];
  const files = Array.isArray(requireFiles) ? requireFiles : [];
  for (const rawItem of files) {
    const raw = String(rawItem || "").trim();
    if (!raw) continue;
    const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workdir || CONFIG.defaultWorkdir, raw);
    const allowed = isAllowedRequiredFilePath(resolved);
    specs.push({ raw, resolved, allowed });
  }
  return specs;
}

async function listMissingRequiredFiles(specs) {
  const missing = [];
  for (const spec of specs || []) {
    if (!spec.allowed) {
      missing.push({ raw: spec.raw, resolved: spec.resolved, reason: "outside_allowed_roots" });
      continue;
    }
    try {
      await fsp.access(spec.resolved);
    } catch {
      missing.push({ raw: spec.raw, resolved: spec.resolved, reason: "not_found" });
    }
  }
  return missing;
}

function extractVrRunArg(command, name) {
  const text = String(command || "");
  const re = new RegExp(`--${name}\\s+(?:"([^"]+)"|'([^']+)'|([^\\s"']+))`, "i");
  const m = text.match(re);
  if (!m) return "";
  return String(m[1] || m[2] || m[3] || "").trim();
}

function inferVrRunRequireFiles(command) {
  const cmd = String(command || "");
  if (!/scripts\/vr_run\.sh\b/.test(cmd)) return [];
  const runDirArg = extractVrRunArg(cmd, "run-dir");
  const runIdArg = extractVrRunArg(cmd, "run-id");
  const runDir = runDirArg || (runIdArg ? `exp/results/${runIdArg}` : "");
  if (!runDir) return [];
  return [`${runDir}/metrics.json`, `${runDir}/meta.json`, `${runDir}/train.log`];
}

async function startJobProcess({ conversationKey, session, command, workdir, description }) {
  const cmd = String(command || "").trim();
  if (!cmd) return { ok: false, error: "missing command", job: null };
  if (cmd.length > CONFIG.maxJobCommandChars) {
    return { ok: false, error: `command too long (max ${CONFIG.maxJobCommandChars})`, job: null };
  }
  const desc = taskTextPreview(description, 200) || null;

  const absWorkdir = path.resolve(workdir || session.workdir || CONFIG.defaultWorkdir);
  const jobId = newJobId();
  const dir = jobStorageJobDir(conversationKey, jobId);
  const logPath = jobLogPath(conversationKey, jobId);
  const exitCodeFile = jobExitCodePath(conversationKey, jobId);
  const pidFile = jobPidPath(conversationKey, jobId);

  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `failed creating job dir: ${String(err.message || err)}`, job: null };
  }
  try {
    await fsp.writeFile(path.join(dir, "command.txt"), `${cmd}\n`, "utf8");
  } catch {}

  // Wrapper writes PID + exit_code to files so watches can recover after relay restarts.
  const wrapper = [
    "set -u",
    'JOB_DIR="$1"',
    'WORKDIR="$2"',
    'LOG="$3"',
    'EXIT_CODE_FILE="$4"',
    'PID_FILE="$5"',
    'CMD="$6"',
    'mkdir -p "$JOB_DIR"',
    'echo $$ > "$PID_FILE"',
    'cd "$WORKDIR" || exit 1',
    'exec >>"$LOG" 2>&1',
    'ts="$(date -Is 2>/dev/null || date)"',
    'echo "[job] started_at=$ts"',
    'echo "[job] workdir=$WORKDIR"',
    'echo "[job] command=$CMD"',
    'term_handler() { echo "[job] received SIGTERM"; echo 143 > "$EXIT_CODE_FILE"; exit 143; }',
    'int_handler() { echo "[job] received SIGINT"; echo 130 > "$EXIT_CODE_FILE"; exit 130; }',
    "trap term_handler TERM",
    "trap int_handler INT",
    'bash -lc "$CMD"',
    "code=$?",
    'echo "$code" > "$EXIT_CODE_FILE"',
    'echo "[job] finished exit_code=$code"',
    'exit "$code"',
  ].join("; ");

  let child;
  try {
    child = spawn(
      "bash",
      ["-lc", wrapper, "bash", dir, absWorkdir, logPath, exitCodeFile, pidFile, cmd],
      { detached: true, stdio: "ignore" }
    );
    child.unref();
  } catch (err) {
    return { ok: false, error: `spawn failed: ${String(err.message || err)}`, job: null };
  }

  const job = {
    id: jobId,
    command: cmd,
    description: desc,
    workdir: absWorkdir,
    status: "running",
    startedAt: nowIso(),
    finishedAt: null,
    pid: child && typeof child.pid === "number" ? child.pid : null,
    jobDir: dir,
    logPath,
    exitCodePath: exitCodeFile,
    pidPath: pidFile,
    exitCode: null,
    exitedAt: null,
    lifecycleState: null,
    lifecycleReason: null,
    lifecycleUpdatedAt: null,
    lifecycle: [],
    visibilityStatus: "ok",
    visibilityLastHeartbeatAt: null,
    visibilityDegradedAt: null,
    watch: null,
  };
  appendJobLifecycleTransition(job, "queued", "job_created", { conversationKey, workdir: absWorkdir });
  appendJobLifecycleTransition(job, "running", "process_spawned", { pid: job.pid || null });
  ensureJobsShape(session);
  session.jobs.push(job);
  session.updatedAt = nowIso();
  await queueSaveState();
  logRelayEvent("job.start", { conversationKey, jobId, pid: job.pid || null, workdir: absWorkdir });
  return { ok: true, error: "", job };
}

function jobWatcherKey(conversationKey, jobId) {
  return `${String(conversationKey || "")}::${String(jobId || "")}`;
}

function normalizeJobWatchConfig(rawWatch, { everySecDefault, tailLinesDefault, jobCommand, workdir } = {}) {
  const watch = rawWatch && typeof rawWatch === "object" && !Array.isArray(rawWatch) ? rawWatch : null;
  const everySec =
    watch && watch.everySec != null ? Number(watch.everySec) : Number(everySecDefault != null ? everySecDefault : 300);
  const tailLines =
    watch && watch.tailLines != null ? Number(watch.tailLines) : Number(tailLinesDefault != null ? tailLinesDefault : 30);
  const thenTask = watch && watch.thenTask != null ? String(watch.thenTask || "").trim() : "";
  const thenTaskDescription = watch && watch.thenTaskDescription != null ? String(watch.thenTaskDescription || "").trim() : "";
  const runTasks =
    watch && watch.runTasks != null
      ? Boolean(watch.runTasks)
      : Boolean(thenTask && CONFIG.jobsThenTaskDefaultRunTasks);
  const rawRequireFiles = watch && Array.isArray(watch.requireFiles) ? watch.requireFiles : [];
  const requireFiles = [];
  for (const item of rawRequireFiles) {
    const p = String(item || "").trim();
    if (!p) continue;
    requireFiles.push(p.length > 600 ? p.slice(0, 600) : p);
    if (requireFiles.length >= 32) break;
  }
  if (thenTask && requireFiles.length === 0) {
    const inferred = inferVrRunRequireFiles(jobCommand || "");
    for (const p of inferred) {
      if (!requireFiles.includes(p)) requireFiles.push(p);
    }
  }
  const readyTimeoutSecRaw = watch && watch.readyTimeoutSec != null ? Number(watch.readyTimeoutSec) : null;
  const readyPollSecRaw = watch && watch.readyPollSec != null ? Number(watch.readyPollSec) : null;
  const onMissingRaw = watch && watch.onMissing != null ? String(watch.onMissing || "").trim().toLowerCase() : "";
  const firstPostRegexRaw = watch && watch.firstPostRegex != null ? String(watch.firstPostRegex || "").trim() : "";
  const supervisorModeRaw = watch && watch.supervisorMode != null ? String(watch.supervisorMode || "").trim().toLowerCase() : "";
  const supervisorStateFileRaw = watch && watch.supervisorStateFile != null ? String(watch.supervisorStateFile || "").trim() : "";
  const supervisorExpectStatusRaw =
    watch && watch.supervisorExpectStatus != null ? parseSupervisorExpectedStatus(watch.supervisorExpectStatus) : "";
  const supervisorCleanupSmokePolicyRaw =
    watch && watch.supervisorCleanupSmokePolicy != null
      ? String(watch.supervisorCleanupSmokePolicy || "").trim().toLowerCase()
      : "";
  const hasRequiredFiles = requireFiles.length > 0;
  const supervisorMode = supervisorModeRaw === "stage0_smoke_gate" ? "stage0_smoke_gate" : null;
  const supervisorStateFile = supervisorStateFileRaw ? supervisorStateFileRaw.slice(0, 1200) : null;
  const supervisorExpectStatus = supervisorExpectStatusRaw ? supervisorExpectStatusRaw.slice(0, 120) : null;
  const supervisorCleanupSmokePolicy =
    supervisorCleanupSmokePolicyRaw === "keep_all"
      ? "keep_all"
      : supervisorCleanupSmokePolicyRaw === "keep_manifest_only"
      ? "keep_manifest_only"
      : null;

  return {
    enabled: true,
    everySec: Number.isFinite(everySec) ? Math.max(1, Math.min(86400, Math.floor(everySec))) : 300,
    tailLines: Number.isFinite(tailLines) ? Math.max(1, Math.min(500, Math.floor(tailLines))) : 30,
    thenTask: thenTask ? (thenTask.length > 2000 ? thenTask.slice(0, 2000) : thenTask) : null,
    thenTaskDescription: thenTaskDescription ? taskTextPreview(thenTaskDescription, 200) : null,
    runTasks,
    requireFiles,
    readyTimeoutSec: hasRequiredFiles
      ? Number.isFinite(readyTimeoutSecRaw)
        ? Math.max(10, Math.min(86400, Math.floor(readyTimeoutSecRaw)))
        : CONFIG.watchRequireFilesDefaultTimeoutSec
      : null,
    readyPollSec: hasRequiredFiles
      ? Number.isFinite(readyPollSecRaw)
        ? Math.max(1, Math.min(3600, Math.floor(readyPollSecRaw)))
        : CONFIG.watchRequireFilesDefaultPollSec
      : null,
    onMissing: onMissingRaw === "enqueue" ? "enqueue" : "block",
    long: watch && watch.long != null ? Boolean(watch.long) : null,
    firstPostRegex: firstPostRegexRaw ? firstPostRegexRaw.slice(0, 300) : null,
    supervisorMode,
    supervisorStateFile,
    supervisorExpectStatus,
    supervisorCleanupSmokePolicy,
  };
}

async function resolveChannelForWatch(channelId) {
  const id = String(channelId || "").trim();
  if (!id) return null;
  const client = DISCORD_CLIENT;
  if (!client) return null;
  try {
    const ch = await client.channels.fetch(id);
    if (!ch || typeof ch.send !== "function") return null;
    return ch;
  } catch {
    return null;
  }
}

async function stopJobWatcher(conversationKey, jobId) {
  const key = jobWatcherKey(conversationKey, jobId);
  const watcher = jobWatchersByKey.get(key);
  if (!watcher) return false;
  try {
    if (watcher.timer) clearInterval(watcher.timer);
  } catch {}
  watcher.awaitPromise = null;
  jobWatchersByKey.delete(key);
  return true;
}

async function maybeStartTaskRunner(conversationKey, channel, session, meta) {
  if (taskRunnerByConversation.has(conversationKey)) return { ok: true, started: false };
  const next = findNextPendingTask(session);
  if (!next) return { ok: true, started: false };
  ensureTaskLoopShape(session);
  session.taskLoop.running = true;
  session.taskLoop.stopRequested = false;
  session.taskLoop.currentTaskId = null;
  session.updatedAt = nowIso();
  await queueSaveState();
  taskRunnerByConversation.set(conversationKey, { running: true, stopRequested: false });
  try {
    if (channel) {
      const counts = summarizeTaskCounts(session.tasks);
      await channel.send(
        `Task runner started. pending=${counts.pending} running=${counts.running} done=${counts.done} failed=${counts.failed} blocked=${counts.blocked} canceled=${counts.canceled}`
      );
    }
  } catch {}
  void kickTaskRunner(conversationKey, channel, session, meta);
  return { ok: true, started: true };
}

function shouldTreatWatcherAsLongRun(job, watch) {
  if (watch && watch.long === true) return true;
  const cmd = String(job && job.command ? job.command : "").toLowerCase();
  const hints = /\b(train|training|epoch|sweep|ablation|benchmark|experiment|overnight|eval|evaluation)\b/;
  const watchEvery = Number(watch && watch.everySec != null ? watch.everySec : 0);
  return watchEvery >= 120 && hints.test(cmd);
}

function markWatcherHeartbeat(watcher, job) {
  if (!watcher || !watcher.visibility || !watcher.visibility.enabled) return false;
  watcher.visibility.startupSent = true;
  watcher.visibility.lastHeartbeatAt = Date.now();
  if (!job || typeof job !== "object") return false;
  const at = nowIso();
  let changed = false;
  if (job.visibilityLastHeartbeatAt !== at) {
    job.visibilityLastHeartbeatAt = at;
    changed = true;
  }
  if (!job.visibilityStatus) {
    job.visibilityStatus = "ok";
    changed = true;
  }
  return changed;
}

async function maybeEmitStaleProgressAlert({
  watcher,
  conversationKey,
  session,
  job,
  channel,
  header,
  taskSummary,
  logSignatureChanged,
}) {
  if (!CONFIG.watchStaleGuardEnabled) return;
  if (!watcher || typeof watcher !== "object") return;
  if (!job || typeof job !== "object") return;
  if (!job.pid || !isPidRunning(job.pid)) return;

  if (!watcher.staleProgress || typeof watcher.staleProgress !== "object") {
    watcher.staleProgress = {
      lowSinceMs: 0,
      lastAlertAtMs: 0,
      lastCpuPct: null,
      lastGpuPct: null,
    };
  }
  const stale = watcher.staleProgress;
  const nowMs = Date.now();

  if (logSignatureChanged) {
    stale.lowSinceMs = 0;
    return;
  }

  const cpuPct = await readProcessTreeCpuPercent(job.pid);
  const gpuPct = await readMaxGpuUtilPercent();
  stale.lastCpuPct = cpuPct;
  stale.lastGpuPct = gpuPct;

  const cpuLow = cpuPct != null && cpuPct <= CONFIG.watchStaleCpuLowPct;
  const gpuLow = gpuPct == null ? true : gpuPct <= CONFIG.watchStaleGpuLowPct;
  const lowUtil = cpuLow && gpuLow;
  if (!lowUtil) {
    stale.lowSinceMs = 0;
    return;
  }

  if (!stale.lowSinceMs) stale.lowSinceMs = nowMs;
  const staleForMs = nowMs - stale.lowSinceMs;
  const minMs = Math.max(1, CONFIG.watchStaleMinutes) * 60 * 1000;
  if (staleForMs < minMs) return;

  const repeatMs = Math.max(1, CONFIG.watchStaleAlertEveryMinutes) * 60 * 1000;
  if (stale.lastAlertAtMs && nowMs - stale.lastAlertAtMs < repeatMs) return;
  stale.lastAlertAtMs = nowMs;

  const staleMinutes = Math.max(1, Math.floor(staleForMs / 60000));
  const cpuText = formatPercent(cpuPct, 1);
  const gpuText = formatPercent(gpuPct, 0);
  logRelayEvent("job.watch.stale_progress", {
    conversationKey,
    jobId: job.id,
    staleMinutes,
    cpuPct: cpuPct == null ? null : Number(cpuPct.toFixed(2)),
    gpuPct: gpuPct == null ? null : Number(gpuPct.toFixed(2)),
    cpuLowThreshold: CONFIG.watchStaleCpuLowPct,
    gpuLowThreshold: CONFIG.watchStaleGpuLowPct,
  });

  if (!channel) return;
  await sendLongToChannel(
    channel,
    `${header} | ${taskSummary}\nstale-progress guard: run log unchanged for ${staleMinutes}m and utilization stayed low (cpu ${cpuText}, gpu ${gpuText}).`
  );
  markWatcherHeartbeat(watcher, job);
  session.updatedAt = nowIso();
  await queueSaveState();
}

async function finalizeWatchedJobExit({
  watcher,
  conversationKey,
  session,
  job,
  channel,
  exitCode,
  forceStatus = null,
  allowThenTask = true,
  prefaceLines = [],
  lifecycleReason = "",
  lifecycleDetails = null,
}) {
  const watch = job.watch && typeof job.watch === "object" ? job.watch : null;
  const thenTask = watch && watch.thenTask ? String(watch.thenTask || "").trim() : "";
  const thenTaskDescription = watch && watch.thenTaskDescription ? String(watch.thenTaskDescription || "").trim() : "";
  const runTasks =
    watch && watch.runTasks != null
      ? Boolean(watch.runTasks)
      : Boolean(thenTask && CONFIG.jobsThenTaskDefaultRunTasks);

  if (!job.exitedAt) {
    job.exitedAt = nowIso();
    appendJobLifecycleTransition(job, "exited", "process_exit", { exitCode });
  }
  job.exitCode = exitCode;
  if (forceStatus) {
    job.status = forceStatus;
  } else if (job.status === "running") {
    job.status = exitCode === 0 ? "done" : "failed";
  }
  job.finishedAt = job.finishedAt || nowIso();
  if (watch) watch.enabled = false;

  if (job.status === "blocked") {
    appendJobLifecycleTransition(job, "blocked", lifecycleReason || "blocked", lifecycleDetails || { exitCode });
  } else if (job.status === "failed" || job.status === "canceled") {
    appendJobLifecycleTransition(job, "failed", lifecycleReason || "job_failed", lifecycleDetails || { exitCode });
  } else if (!allowThenTask || !thenTask) {
    appendJobLifecycleTransition(job, "completed", lifecycleReason || "job_completed", lifecycleDetails || { exitCode });
  }
  session.updatedAt = nowIso();
  await queueSaveState();
  await stopJobWatcher(conversationKey, job.id);

  const startedAtMs = Date.parse(job.startedAt || "") || Date.now();
  const elapsed = formatElapsed(Date.now() - startedAtMs);
  const tailLines = watcher && Number.isFinite(Number(watcher.tailLines)) ? Number(watcher.tailLines) : 30;
  const tail = await readTailLines(job.logPath, tailLines, 128 * 1024);
  const tailStats = summarizeTailText(tail);
  const taskCounts = summarizeTaskCounts(session.tasks);
  const taskSummary = `tasks pending=${taskCounts.pending} running=${taskCounts.running} done=${taskCounts.done} failed=${taskCounts.failed} blocked=${taskCounts.blocked} canceled=${taskCounts.canceled}`;
  const jobDescription = jobDisplayDescription(job, 96);
  const visibility = String(job.visibilityStatus || "ok");
  const header = `[JOB ${job.id}] ${job.status || "unknown"} (elapsed ${elapsed}, visibility ${visibility})${
    jobDescription ? ` | ${jobDescription}` : ""
  }`;

  const lines = [];
  lines.push(`${header} -> finished (exit ${exitCode})`);
  lines.push(taskSummary);
  for (const line of prefaceLines || []) {
    if (line) lines.push(String(line));
  }
  if (CONFIG.jobsWatchCompact) {
    lines.push(`log: \`${job.logPath}\``);
    if (tail) {
      lines.push(`final output: ${tailStats.lineCount} lines, ${tailStats.charCount} chars`);
      if (CONFIG.jobsWatchIncludeTailOnFinish) {
        const snippet = compactTailSnippet(tail, CONFIG.jobsWatchCompactTailLines, CONFIG.jobsWatchCompactTailMaxChars);
        if (snippet) lines.push("", "tail excerpt:", snippet);
      }
    } else {
      lines.push("final output: (no captured tail)");
    }
  } else if (tail) {
    lines.push("", "log tail:", tail);
  }
  if (channel) {
    await sendLongToChannel(channel, lines.join("\n"));
    markWatcherHeartbeat(watcher, job);
    session.updatedAt = nowIso();
    await queueSaveState();
  }

  try {
    await handleResearchJobCompletion({
      conversationKey,
      session,
      job,
      exitCode,
      channel,
    });
  } catch (err) {
    logRelayEvent("research.job.finalize.error", {
      conversationKey,
      jobId: job.id,
      error: String(err && err.message ? err.message : err).slice(0, 240),
    });
  }

  if (!allowThenTask || !thenTask) {
    return;
  }
  if (!CONFIG.tasksEnabled) {
    if (channel) await channel.send("Job follow-up task requested, but tasks are disabled (RELAY_TASKS_ENABLED=false).");
    return;
  }
  const pending = (session.tasks || []).filter((t) => t && t.status === "pending").length;
  if (CONFIG.tasksMaxPending > 0 && pending >= CONFIG.tasksMaxPending) {
    if (channel) await channel.send(`Job follow-up task skipped: task queue full (pending=${pending}, max=${CONFIG.tasksMaxPending}).`);
    return;
  }
  const fallbackDescription = thenTaskDescription || `Follow-up for ${job.id}${jobDescription ? `: ${jobDescription}` : ""}`;
  const task = createTask(session, thenTask, {
    description: fallbackDescription,
    sourceJobId: job.id,
  });
  session.tasks.push(task);
  appendJobLifecycleTransition(job, "callback_queued", "then_task_enqueued", { taskId: task.id });
  session.updatedAt = nowIso();
  await queueSaveState();
  logRelayEvent("job.then_task.queued", { conversationKey, jobId: job.id, taskId: task.id });
  if (channel) {
    const taskLabel = taskDisplayDescription(task, 96) || "(no description)";
    await channel.send(`Queued follow-up task \`${task.id}\`${task.sourceJobId ? ` from \`${task.sourceJobId}\`` : ""}: ${taskLabel}`);
    markWatcherHeartbeat(watcher, job);
    session.updatedAt = nowIso();
    await queueSaveState();
  }

  if (runTasks) {
    appendJobLifecycleTransition(job, "callback_running", "task_runner_requested", { taskId: task.id });
    session.updatedAt = nowIso();
    await queueSaveState();
    await maybeStartTaskRunner(conversationKey, channel, session, {
      isDm: !session.lastGuildId,
      isThread: Boolean(channel && channel.isThread && channel.isThread()),
    });
  }
  appendJobLifecycleTransition(job, "completed", runTasks ? "callback_dispatched" : "callback_queued", {
    taskId: task.id,
    runTasks,
  });
  session.updatedAt = nowIso();
  await queueSaveState();
}

async function validateSupervisorStateForFinalize({ watch, conversationKey, jobId }) {
  const mode = String((watch && watch.supervisorMode) || "").trim().toLowerCase();
  if (!mode) return { ok: true, lines: [], reason: "", details: null };
  if (mode !== "stage0_smoke_gate") {
    return {
      ok: false,
      lines: [`unsupported supervisor mode in watch config: ${mode}`],
      reason: "supervisor_mode_unsupported",
      details: { mode },
    };
  }

  const statePathRaw = String((watch && watch.supervisorStateFile) || "").trim();
  if (!statePathRaw) {
    return {
      ok: false,
      lines: ["supervisor validation failed: missing supervisorStateFile"],
      reason: "supervisor_state_missing_path",
      details: null,
    };
  }
  const statePath = path.resolve(statePathRaw);
  if (!isAllowedRequiredFilePath(statePath)) {
    return {
      ok: false,
      lines: [`supervisor validation failed: state path outside allowed roots: ${statePathRaw}`],
      reason: "supervisor_state_path_outside_allowed_roots",
      details: { statePathRaw },
    };
  }

  let payload = null;
  try {
    payload = JSON.parse(await fsp.readFile(statePath, "utf8"));
  } catch (err) {
    return {
      ok: false,
      lines: [`supervisor validation failed: could not parse state file (${statePathRaw})`],
      reason: "supervisor_state_parse_error",
      details: { statePathRaw, error: String(err && err.message ? err.message : err).slice(0, 240) },
    };
  }

  const expectStatus = parseSupervisorExpectedStatus(
    (watch && watch.supervisorExpectStatus) || CONFIG.supervisorPhase1DefaultExpectStatus || "success"
  );
  const actualStatus = String((payload && payload.status) || "").trim().toLowerCase();
  if (expectStatus && actualStatus !== expectStatus) {
    return {
      ok: false,
      lines: [`supervisor state status mismatch: expected=${expectStatus}, got=${actualStatus || "(empty)"}`],
      reason: "supervisor_state_status_mismatch",
      details: { statePathRaw, expected: expectStatus, actual: actualStatus || null },
    };
  }

  const cleanupPolicyRaw = String((watch && watch.supervisorCleanupSmokePolicy) || "").trim().toLowerCase();
  const cleanupPolicy = cleanupPolicyRaw === "keep_all" ? "keep_all" : "keep_manifest_only";
  const cleanupAction = String(payload && payload.smoke_cleanup && payload.smoke_cleanup.action ? payload.smoke_cleanup.action : "").trim();
  if (cleanupPolicy === "keep_manifest_only" && cleanupAction !== "deleted_smoke_run_dir_kept_manifest") {
    return {
      ok: false,
      lines: [
        `supervisor cleanup mismatch: expected deleted_smoke_run_dir_kept_manifest, got ${cleanupAction || "(empty)"}`,
      ],
      reason: "supervisor_cleanup_mismatch",
      details: { statePathRaw, cleanupPolicy, cleanupAction: cleanupAction || null },
    };
  }

  logRelayEvent("job.supervisor.state.validated", {
    conversationKey,
    jobId,
    mode,
    statePath: statePathRaw,
    expectedStatus: expectStatus,
    actualStatus,
    cleanupPolicy,
    cleanupAction: cleanupAction || null,
  });

  return {
    ok: true,
    lines: [
      `supervisor state verified (${mode}): status=${actualStatus || "unknown"} cleanup=${
        cleanupAction || cleanupPolicy
      }`,
    ],
    reason: "",
    details: {
      mode,
      statePath: statePathRaw,
      expectedStatus: expectStatus,
      actualStatus: actualStatus || null,
      cleanupPolicy,
      cleanupAction: cleanupAction || null,
    },
  };
}

async function awaitArtifactsThenFinalize({
  watcher,
  conversationKey,
  session,
  job,
  channel,
  exitCode,
  specs,
  timeoutSec,
  pollSec,
  onMissing,
}) {
  const startedAt = Date.now();
  const deadlineAt = startedAt + Math.max(10, timeoutSec) * 1000;
  const details = {
    timeoutSec: Math.max(10, timeoutSec),
    pollSec: Math.max(1, pollSec),
    required: specs.map((s) => s.raw),
  };
  logRelayEvent("job.await_artifacts.start", { conversationKey, jobId: job.id, ...details });
  appendJobLifecycleTransition(job, "awaiting_artifacts", "waiting_for_required_files", details);
  session.updatedAt = nowIso();
  await queueSaveState();

  const disallowed = (specs || []).filter((s) => !s.allowed);
  if (disallowed.length > 0) {
    const blockedLines = [
      "required artifact paths include entries outside allowed workdir roots:",
      ...disallowed.map((m) => `- ${m.raw}`),
    ];
    await finalizeWatchedJobExit({
      watcher,
      conversationKey,
      session,
      job,
      channel,
      exitCode,
      forceStatus: "blocked",
      allowThenTask: onMissing === "enqueue",
      prefaceLines: blockedLines,
      lifecycleReason: "artifact_path_outside_allowed_roots",
      lifecycleDetails: { disallowed: disallowed.map((s) => s.raw) },
    });
    return;
  }

  while (true) {
    const missing = await listMissingRequiredFiles(specs);
    if (missing.length === 0) {
      const watch = job && job.watch && typeof job.watch === "object" ? job.watch : null;
      const supervisorValidation = await validateSupervisorStateForFinalize({
        watch,
        conversationKey,
        jobId: job.id,
      });
      if (!supervisorValidation.ok) {
        await finalizeWatchedJobExit({
          watcher,
          conversationKey,
          session,
          job,
          channel,
          exitCode,
          forceStatus: "blocked",
          allowThenTask: false,
          prefaceLines: [...(supervisorValidation.lines || []), "supervisor contract validation failed: callback suppressed."],
          lifecycleReason: supervisorValidation.reason || "supervisor_validation_failed",
          lifecycleDetails: supervisorValidation.details || null,
        });
        return;
      }
      logRelayEvent("job.await_artifacts.ready", { conversationKey, jobId: job.id, waitedSec: Math.floor((Date.now() - startedAt) / 1000) });
      await finalizeWatchedJobExit({
        watcher,
        conversationKey,
        session,
        job,
        channel,
        exitCode,
        forceStatus: null,
        allowThenTask: true,
        prefaceLines: [
          `artifacts ready (${specs.length}): callback processing enabled.`,
          ...(supervisorValidation.lines || []),
        ],
        lifecycleReason: "artifacts_ready",
        lifecycleDetails: { waitedSec: Math.floor((Date.now() - startedAt) / 1000), required: specs.map((s) => s.raw) },
      });
      return;
    }
    if (Date.now() >= deadlineAt) {
      logRelayEvent("job.await_artifacts.timeout", {
        conversationKey,
        jobId: job.id,
        waitedSec: Math.floor((Date.now() - startedAt) / 1000),
        missing: missing.map((m) => m.raw).slice(0, 20),
      });
      const missingList = missing.map((m) => `- ${m.raw} (${m.reason})`);
      const timedOutLines = [
        `artifact wait timeout after ${Math.floor((Date.now() - startedAt) / 1000)}s; missing files:`,
        ...missingList,
      ];
      if (onMissing === "enqueue") {
        await finalizeWatchedJobExit({
          watcher,
          conversationKey,
          session,
          job,
          channel,
          exitCode,
          forceStatus: "done",
          allowThenTask: true,
          prefaceLines: [...timedOutLines, "onMissing=enqueue: callback will run anyway."],
          lifecycleReason: "artifact_timeout_enqueue",
          lifecycleDetails: { missing: missing.map((m) => m.raw) },
        });
      } else {
        await finalizeWatchedJobExit({
          watcher,
          conversationKey,
          session,
          job,
          channel,
          exitCode,
          forceStatus: "blocked",
          allowThenTask: false,
          prefaceLines: [...timedOutLines, "onMissing=block: callback suppressed."],
          lifecycleReason: "artifact_timeout_blocked",
          lifecycleDetails: { missing: missing.map((m) => m.raw) },
        });
      }
      return;
    }
    await sleepMs(Math.max(1, pollSec) * 1000);
  }
}

async function tickJobWatcher(watcher) {
  if (!watcher || typeof watcher !== "object") return;
  if (watcher.inFlight) return;
  if (watcher.awaitPromise) return;
  watcher.inFlight = true;
  const { conversationKey, jobId, channelId } = watcher;

  try {
    const session = getSession(conversationKey);
    ensureJobsShape(session);
    ensureTasksShape(session);
    ensureTaskLoopShape(session);

    const job = (session.jobs || []).find((j) => j && typeof j === "object" && String(j.id || "") === String(jobId));
    if (!job) {
      await stopJobWatcher(conversationKey, jobId);
      return;
    }

    const exitRes = await readJobExitCode(job.exitCodePath);
    const startedAtMs = Date.parse(job.startedAt || "") || Date.now();
    const elapsed = formatElapsed(Date.now() - startedAtMs);
    const tail = await readTailLines(job.logPath, watcher.tailLines, 128 * 1024);
    const logSignature = await readLogSignature(job.logPath);
    const logSignatureChanged = watcher.lastLogSignature ? watcher.lastLogSignature !== logSignature : true;
    watcher.lastLogSignature = logSignature;
    const tailStats = summarizeTailText(tail);
    const tailHash = crypto.createHash("sha1").update(tail).digest("hex").slice(0, 12);
    const changed = watcher.lastTailHash !== tailHash;
    watcher.lastTailHash = tailHash;

    const ch = await resolveChannelForWatch(channelId);
    const jobDescription = jobDisplayDescription(job, 96);
    const taskCounts = summarizeTaskCounts(session.tasks);
    const taskSummary = `tasks pending=${taskCounts.pending} running=${taskCounts.running} done=${taskCounts.done} failed=${taskCounts.failed} blocked=${taskCounts.blocked} canceled=${taskCounts.canceled}`;
    const visibility = String(job.visibilityStatus || "ok");
    const header = `[JOB ${job.id}] ${job.status || "unknown"} (elapsed ${elapsed}, visibility ${visibility})${
      jobDescription ? ` | ${jobDescription}` : ""
    }`;

    if (exitRes.ok) {
      const code = exitRes.code;
      const watch = job.watch && typeof job.watch === "object" ? job.watch : null;
      if (!job.exitedAt) {
        job.exitedAt = nowIso();
        appendJobLifecycleTransition(job, "exited", "process_exit", { exitCode: code });
        session.updatedAt = nowIso();
        await queueSaveState();
      }

      const supervisorMode = String((watch && watch.supervisorMode) || "").trim().toLowerCase();
      const requireFilesEnabled =
        code === 0 &&
        watch &&
        Array.isArray(watch.requireFiles) &&
        watch.requireFiles.length > 0 &&
        (CONFIG.watchRequireFilesEnabled || supervisorMode === "stage0_smoke_gate");
      if (requireFilesEnabled) {
        const specs = resolveRequiredArtifactSpecs(watch.requireFiles, job.workdir || session.workdir || CONFIG.defaultWorkdir);
        const timeoutSec = Number.isFinite(Number(watch.readyTimeoutSec))
          ? Number(watch.readyTimeoutSec)
          : CONFIG.watchRequireFilesDefaultTimeoutSec;
        const pollSec = Number.isFinite(Number(watch.readyPollSec))
          ? Number(watch.readyPollSec)
          : CONFIG.watchRequireFilesDefaultPollSec;
        const onMissing = String(watch.onMissing || "block").trim().toLowerCase() === "enqueue" ? "enqueue" : "block";
        if (!watcher.awaitPromise) {
          const line = `required artifacts gate active: waiting for ${specs.length} file(s), timeout=${timeoutSec}s poll=${pollSec}s${
            supervisorMode ? ` mode=${supervisorMode}` : ""
          }`;
          if (ch) {
            await ch.send(`[JOB ${job.id}] ${line}`);
            markWatcherHeartbeat(watcher, job);
            session.updatedAt = nowIso();
            await queueSaveState();
          }
          watcher.awaitPromise = awaitArtifactsThenFinalize({
            watcher,
            conversationKey,
            session,
            job,
            channel: ch,
            exitCode: code,
            specs,
            timeoutSec,
            pollSec,
            onMissing,
          })
            .catch(async (err) => {
              logRelayEvent("job.await_artifacts.error", {
                conversationKey,
                jobId: job.id,
                error: String(err && err.message ? err.message : err).slice(0, 240),
              });
              await finalizeWatchedJobExit({
                watcher,
                conversationKey,
                session,
                job,
                channel: ch,
                exitCode: code,
                forceStatus: "blocked",
                allowThenTask: false,
                prefaceLines: [
                  `artifact wait failed with runtime error: ${String(err && err.message ? err.message : err)}`,
                ],
                lifecycleReason: "artifact_wait_runtime_error",
                lifecycleDetails: { error: String(err && err.message ? err.message : err) },
              });
            })
            .finally(() => {
            watcher.awaitPromise = null;
          });
        }
      } else {
        await finalizeWatchedJobExit({
          watcher,
          conversationKey,
          session,
          job,
          channel: ch,
          exitCode: code,
          forceStatus: null,
          allowThenTask: true,
          prefaceLines: [],
          lifecycleReason: code === 0 ? "process_exit_zero" : "process_exit_nonzero",
          lifecycleDetails: { exitCode: code },
        });
      }
      return;
    }

    // Still running (best-effort).
    if (job.status !== "running") {
      job.status = "running";
      session.updatedAt = nowIso();
      await queueSaveState();
    }

    if (!isPidRunning(job.pid) && !tail) {
      // Wrapper ended but we don't have an exit_code yet; avoid spamming.
      logRelayEvent("job.watch.warn", { conversationKey, jobId: job.id, pid: job.pid || null, note: "pid_not_running_and_no_exit_code" });
      return;
    }

    if (!ch) return;
    if (changed && tail) {
      if (CONFIG.jobsWatchCompact) {
        const lines = [`${header} | ${taskSummary}`, `new output: ${tailStats.lineCount} lines, ${tailStats.charCount} chars`];
        if (CONFIG.jobsWatchIncludeTailOnChange) {
          const snippet = compactTailSnippet(tail, CONFIG.jobsWatchCompactTailLines, CONFIG.jobsWatchCompactTailMaxChars);
          if (snippet) lines.push("", "tail excerpt:", snippet);
        }
        await sendLongToChannel(ch, lines.join("\n"));
        markWatcherHeartbeat(watcher, job);
        session.updatedAt = nowIso();
        await queueSaveState();
      } else {
        await sendLongToChannel(ch, [header, taskSummary, "", "log tail:", tail].join("\n"));
        markWatcherHeartbeat(watcher, job);
        session.updatedAt = nowIso();
        await queueSaveState();
      }
    } else if (CONFIG.jobsWatchPostNoChange) {
      await ch.send(`${header} | ${taskSummary} (no new output)`);
      markWatcherHeartbeat(watcher, job);
      session.updatedAt = nowIso();
      await queueSaveState();
    }

    await maybeEmitStaleProgressAlert({
      watcher,
      conversationKey,
      session,
      job,
      channel: ch,
      header,
      taskSummary,
      logSignatureChanged,
    });

    if (watcher.visibility && watcher.visibility.enabled) {
      const nowMs = Date.now();
      const startupDeadlineMs = Math.max(10, CONFIG.visibilityStartupHeartbeatSec) * 1000;
      if (!watcher.visibility.startupSent && nowMs - watcher.visibility.startedAtMs >= startupDeadlineMs) {
        watcher.visibility.degraded = true;
        if (job.visibilityStatus !== "degraded") {
          job.visibilityStatus = "degraded";
          job.visibilityDegradedAt = nowIso();
          appendJobLifecycleTransition(job, "running", "visibility_degraded_startup_timeout", {
            timeoutSec: CONFIG.visibilityStartupHeartbeatSec,
          });
          session.updatedAt = nowIso();
          await queueSaveState();
        }
        if (ch) {
          await ch.send(
            `[JOB ${job.id}] visibility degraded: no startup heartbeat observed within ${CONFIG.visibilityStartupHeartbeatSec}s.`
          );
          markWatcherHeartbeat(watcher, job);
          session.updatedAt = nowIso();
          await queueSaveState();
        }
      }
      const heartbeatEveryMs = Math.max(30, CONFIG.visibilityHeartbeatEverySec) * 1000;
      if (ch && nowMs - Number(watcher.visibility.lastHeartbeatAt || 0) >= heartbeatEveryMs) {
        await ch.send(`${header} | ${taskSummary} (heartbeat)`);
        markWatcherHeartbeat(watcher, job);
        session.updatedAt = nowIso();
        await queueSaveState();
      }
    }
  } catch (err) {
    logRelayEvent("job.watch.error", {
      conversationKey,
      jobId,
      error: String(err && err.message ? err.message : err).slice(0, 240),
    });
  } finally {
    watcher.inFlight = false;
  }
}

async function startJobWatcher({ conversationKey, session, job, channelId, watchConfig }) {
  if (!job || typeof job !== "object") return { ok: false, error: "missing job" };
  const normalized = normalizeJobWatchConfig(watchConfig, {
    everySecDefault: CONFIG.jobsAutoWatchEverySec,
    tailLinesDefault: CONFIG.jobsAutoWatchTailLines,
    jobCommand: job.command || "",
    workdir: job.workdir || session.workdir || CONFIG.defaultWorkdir,
  });

  job.watch = { ...normalized };
  session.updatedAt = nowIso();
  await queueSaveState();

  const key = jobWatcherKey(conversationKey, job.id);
  const existing = jobWatchersByKey.get(key);
  if (existing && existing.timer) {
    try { clearInterval(existing.timer); } catch {}
  }
  const watcher = {
    conversationKey,
    jobId: job.id,
    channelId: String(channelId || "").trim() || (session.lastChannelId || ""),
    tailLines: normalized.tailLines,
    everySec: normalized.everySec,
    inFlight: false,
    lastTailHash: "",
    lastLogSignature: "",
    awaitPromise: null,
    staleProgress: {
      lowSinceMs: 0,
      lastAlertAtMs: 0,
      lastCpuPct: null,
      lastGpuPct: null,
    },
    visibility: {
      enabled: Boolean(CONFIG.visibilityGateEnabled && shouldTreatWatcherAsLongRun(job, normalized)),
      startedAtMs: Date.now(),
      startupSent: false,
      lastHeartbeatAt: 0,
      degraded: false,
    },
    timer: null,
  };
  watcher.timer = setInterval(() => void tickJobWatcher(watcher), watcher.everySec * 1000);
  watcher.timer.unref?.();
  jobWatchersByKey.set(key, watcher);
  const ch = await resolveChannelForWatch(watcher.channelId);
  if (ch) {
    try {
      const jobDescription = jobDisplayDescription(job, 96);
      const followUpDescription =
        normalized.thenTaskDescription || (normalized.thenTask ? taskTextPreview(normalized.thenTask, 96) : "");
      const mode = CONFIG.jobsWatchCompact ? "compact" : "full-tail";
      const parts = [`[JOB ${job.id}] watcher started (every ${watcher.everySec}s, tail ${watcher.tailLines} lines, mode ${mode})`];
      if (jobDescription) parts.push(`desc: ${jobDescription}`);
      if (followUpDescription) parts.push(`follow-up: ${followUpDescription}`);
      if (normalized.supervisorMode) parts.push(`supervisor=${normalized.supervisorMode}`);
      if (watcher.visibility && watcher.visibility.enabled) {
        parts.push(
          `visibility=startup<=${CONFIG.visibilityStartupHeartbeatSec}s heartbeat<=${CONFIG.visibilityHeartbeatEverySec}s`
        );
      }
      if (CONFIG.watchStaleGuardEnabled) {
        parts.push(
          `stale-guard=${CONFIG.watchStaleMinutes}m cpu<=${CONFIG.watchStaleCpuLowPct}% gpu<=${CONFIG.watchStaleGpuLowPct}%`
        );
      }
      await ch.send(parts.join(" | "));
      markWatcherHeartbeat(watcher, job);
      session.updatedAt = nowIso();
      await queueSaveState();
    } catch {}
  }
  void tickJobWatcher(watcher);
  logRelayEvent("job.watch.start", {
    conversationKey,
    jobId: job.id,
    everySec: watcher.everySec,
    tailLines: watcher.tailLines,
    requireFiles: Array.isArray(normalized.requireFiles) ? normalized.requireFiles.length : 0,
    supervisorMode: normalized.supervisorMode || null,
    visibilityGate: Boolean(watcher.visibility && watcher.visibility.enabled),
    staleGuard: Boolean(CONFIG.watchStaleGuardEnabled),
  });
  return { ok: true, watcher };
}

async function restoreJobWatchers() {
  // Restore watches from persisted session state after relay restart.
  let restored = 0;
  for (const [conversationKey, session] of Object.entries(state.sessions || {})) {
    if (!session || typeof session !== "object") continue;
    ensureJobsShape(session);
    const channelId = String(session.lastChannelId || "").trim();
    if (!channelId) continue;
    for (const job of session.jobs || []) {
      if (!job || typeof job !== "object") continue;
      if (job.status !== "running") continue;
      const watch = job.watch && typeof job.watch === "object" ? job.watch : null;
      if (!watch || !watch.enabled) continue;
      const key = jobWatcherKey(conversationKey, job.id);
      if (jobWatchersByKey.has(key)) continue;
      const res = await startJobWatcher({
        conversationKey,
        session,
        job,
        channelId,
        watchConfig: watch,
      });
      if (res && res.ok) restored += 1;
    }
  }
  if (restored > 0) {
    logRelayEvent("job.watch.restore", { restored });
  }
}

async function writePlanFile(conversationKey, planId, planText) {
  const dir = planStorageDir(conversationKey);
  await fsp.mkdir(dir, { recursive: true });
  const filePath = planStoragePath(conversationKey, planId);
  await fsp.writeFile(filePath, String(planText || ""), "utf8");
  return filePath;
}

async function loadPlanText(plan) {
  if (!plan || typeof plan !== "object") return "";
  if (typeof plan.path === "string" && plan.path.trim()) {
    try {
      return String(await fsp.readFile(plan.path, "utf8"));
    } catch {
      // Fall back to embedded text if present.
    }
  }
  if (typeof plan.text === "string") return plan.text;
  return "";
}

async function createAndSavePlan(session, conversationKey, workdir, request, planText) {
  const id = newPlanId();
  const createdAt = nowIso();
  const absWorkdir = path.resolve(workdir || CONFIG.defaultWorkdir);
  const title = planTitleFromRequest(request);
  const filePath = await writePlanFile(conversationKey, id, planText);
  const plan = {
    id,
    createdAt,
    title,
    workdir: absWorkdir,
    path: filePath,
    request: String(request || "").trim() || null,
  };
  ensurePlansShape(session);
  session.plans.push(plan);
  ensurePlansShape(session);
  return plan;
}

function findPlan(session, idOrLast) {
  if (!session || !Array.isArray(session.plans) || session.plans.length === 0) return null;
  const needle = String(idOrLast || "").trim().toLowerCase();
  if (!needle || needle === "last" || needle === "latest") return session.plans[session.plans.length - 1];
  return session.plans.find((p) => p && typeof p === "object" && String(p.id || "").toLowerCase() === needle) || null;
}

function parsePlanSteps(planText) {
  const raw = String(planText || "");
  const lines = raw.split(/\r?\n/);
  const steps = [];

  // Preferred: markdown task list.
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s*\[\s*[xX ]?\s*\]\s+(.+?)\s*$/);
    if (m) steps.push(m[1]);
  }
  if (steps.length > 0) return steps;

  // Fallback: numbered list.
  for (const line of lines) {
    const m = line.match(/^\s*\d{1,3}[\.)]\s+(.+?)\s*$/);
    if (m) steps.push(m[1]);
  }
  if (steps.length > 0) return steps;

  // Last resort: non-empty bullets.
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (m) steps.push(m[1]);
  }
  return steps;
}

function extractPlanTaskBreakdownText(planText) {
  const raw = String(planText || "");
  if (!raw.trim()) return "";
  const lines = raw.split(/\r?\n/);

  let start = -1;
  let headingLevel = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(/^\s*(#{1,6})\s+Task breakdown\b/i);
    if (!m) continue;
    headingLevel = m[1].length;
    start = i + 1;
    break;
  }
  if (start < 0) return "";

  const out = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(/^\s*(#{1,6})\s+\S/);
    if (m && m[1].length <= headingLevel) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

function parsePlanTaskBreakdownSteps(planText) {
  const breakdown = extractPlanTaskBreakdownText(planText);
  const usedTaskBreakdown = Boolean(breakdown);
  const steps = parsePlanSteps(breakdown || planText)
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  return { steps, usedTaskBreakdown };
}

function nextTaskId(session) {
  const tasks = session && Array.isArray(session.tasks) ? session.tasks : [];
  let max = 0;
  for (const t of tasks) {
    if (!t || typeof t !== "object") continue;
    const m = String(t.id || "").match(/^t-(\d{4})$/);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `t-${String(max + 1).padStart(4, "0")}`;
}

function createTask(session, text, options = {}) {
  const id = nextTaskId(session);
  const createdAt = nowIso();
  const rawText = String(text || "");
  const explicitDescription = options && options.description != null ? String(options.description || "").trim() : "";
  const sourceJobId = options && options.sourceJobId != null ? String(options.sourceJobId || "").trim() : "";
  const description = taskTextPreview(explicitDescription || rawText, 200) || null;
  return {
    id,
    text: rawText,
    description,
    sourceJobId: sourceJobId || null,
    status: "pending",
    createdAt,
    startedAt: null,
    finishedAt: null,
    attempts: 0,
    lastError: null,
    lastResultPreview: null,
  };
}

const GO_LONG_TASK_HINTS = [
  /\btrain(?:ing)?\b/i,
  /\bsweep\b/i,
  /\bablation\b/i,
  /\bbenchmark\b/i,
  /\bexperiment(?:s)?\b/i,
  /\bovernight\b/i,
  /\beval(?:uation)?\b/i,
  /\bepoch(?:s)?\b/i,
  /\bseed(?:s)?\b/i,
  /\bmatrix\b/i,
  /\bkick[\s-]*off\b/i,
  /\blaunch\b/i,
  /\bre-?run\b/i,
  /\bverify hypothesis\b/i,
  /\blong[-\s]*running\b/i,
];

function shouldAutoWrapGoLongTask(taskText) {
  if (!CONFIG.goAutoWrapLongTasks) return false;
  const text = String(taskText || "").trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  if (lower.includes("[[relay-actions]]") || lower.includes("job_start")) return false;
  return GO_LONG_TASK_HINTS.some((pattern) => pattern.test(text));
}

function buildGoLongTaskCallbackTaskText(taskText) {
  const watchEverySec = Math.max(5, Number(CONFIG.goLongTaskWatchEverySec) || 300);
  const tailLines = Math.max(10, Number(CONFIG.goLongTaskTailLines) || 30);
  return [
    "Use skill relay-long-task-callback.",
    "Treat the user request below as a long-running task and launch it in background via one relay action.",
    "",
    "User request:",
    String(taskText || "").trim(),
    "",
    "Output contract (strict):",
    "- Emit exactly one [[relay-actions]] ... [[/relay-actions]] block with one action of type job_start.",
    "- Set job_start.description to a short label.",
    `- Set watch.everySec=${watchEverySec} and watch.tailLines=${tailLines}.`,
    "- Set watch.thenTaskDescription to a short callback label.",
    "- Set watch.thenTask to: analyze final logs/artifacts with exact paths, summarize metrics/trends/failures, propose next steps, and update HANDOFF_LOG.md plus docs/WORKING_MEMORY.md in the active repo.",
    "- Set watch.runTasks=true.",
    "- Do not run foreground polling loops (for example `sleep ...; tail ...`) in this task.",
    "- Ensure command is non-interactive and writes deterministic logs/artifacts.",
    "- After the action block, emit [[task:done]].",
    "",
    "If critical command/path details are missing, emit [[task:blocked]] and list what is missing.",
  ].join("\n");
}

function buildGoHandoffTaskText() {
  return [
    "Use skill experiment-working-memory-handoff.",
    "After completing prior task results, update repo memory artifacts in the current workdir:",
    "- append an evidence-backed entry to HANDOFF_LOG.md (append-only)",
    "- rewrite docs/WORKING_MEMORY.md as a compact current-state snapshot",
    "Include absolute timestamps, commands run, artifact/log paths, and concrete next steps.",
  ].join("\n");
}

function findNextPendingTask(session) {
  if (!session || !Array.isArray(session.tasks)) return null;
  return session.tasks.find((t) => t && typeof t === "object" && t.status === "pending") || null;
}

function parseTaskMarkers(text) {
  const raw = String(text || "");
  const blocked = /\[\[task:blocked\]\]/i.test(raw);
  const done = /\[\[task:done\]\]/i.test(raw);
  const cleaned = raw.replace(/\[\[task:(?:blocked|done)\]\]/gi, "").trim();
  if (blocked) return { status: "blocked", cleaned };
  if (done) return { status: "done", cleaned };
  return { status: "done", cleaned };
}

async function collectProcessTreePids(rootPid) {
  const root = Number(rootPid);
  if (!Number.isFinite(root) || root <= 0) return [];
  const res = await execFileCapture("ps", ["-eo", "pid=,ppid="], { timeoutMs: 2000 });
  if (res.code !== 0) return [root];

  const byParent = new Map();
  const lines = String(res.stdout || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(ppid) || ppid < 0) continue;
    const list = byParent.get(ppid) || [];
    list.push(pid);
    byParent.set(ppid, list);
  }

  const out = [];
  const queue = [root];
  const seen = new Set();
  while (queue.length > 0 && seen.size <= 1024) {
    const pid = queue.shift();
    if (!Number.isFinite(pid) || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    const kids = byParent.get(pid) || [];
    for (const kid of kids) queue.push(kid);
  }
  return out;
}

function signalPidList(pids, signal) {
  const signalName = String(signal || "").trim().toUpperCase();
  if (!signalName) return { signaled: [], failed: [] };
  const seen = new Set();
  const signaled = [];
  const failed = [];
  for (const raw of Array.isArray(pids) ? pids : []) {
    const pid = Number(raw);
    if (!Number.isFinite(pid) || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    try {
      process.kill(pid, signalName);
      signaled.push(pid);
    } catch (err) {
      const code = String((err && err.code) || "");
      // ESRCH is common in rapidly changing trees; treat as non-fatal.
      if (code === "ESRCH") continue;
      failed.push({ pid, code: code || "ERR", error: String(err && err.message ? err.message : err) });
    }
  }
  return { signaled, failed };
}

async function pauseConversationRun(conversationKey, reason = "priority question") {
  const key = String(conversationKey || "").trim();
  if (!key) return { ok: false, reason: "invalid_conversation_key" };
  const already = pausedChildStateByConversation.get(key);
  if (already && typeof already === "object") {
    return {
      ok: true,
      alreadyPaused: true,
      rootPid: Number(already.rootPid) || null,
      pids: Array.isArray(already.pids) ? [...already.pids] : [],
      pausedAt: already.pausedAt || null,
    };
  }

  const child = activeChildByConversation.get(key);
  if (!child || typeof child.pid !== "number" || child.pid <= 0) {
    return { ok: false, reason: "no_active_child" };
  }

  const pids = await collectProcessTreePids(child.pid);
  const pauseOrder = [...pids].reverse();
  const paused = signalPidList(pauseOrder, "SIGSTOP");
  if (paused.signaled.length === 0) {
    return { ok: false, reason: "pause_signal_failed", failed: paused.failed };
  }

  const state = {
    rootPid: child.pid,
    pids: pids.length > 0 ? pids : [child.pid],
    pausedAt: nowIso(),
    reason: String(reason || "").trim() || "priority question",
  };
  pausedChildStateByConversation.set(key, state);
  logRelayEvent("agent.run.paused", {
    conversationKey: key,
    rootPid: state.rootPid,
    processCount: state.pids.length,
    reason: state.reason,
    signalFailures: paused.failed.length,
  });
  return { ok: true, rootPid: state.rootPid, pids: state.pids, failed: paused.failed, pausedAt: state.pausedAt };
}

async function resumeConversationRun(conversationKey, reason = "priority question complete") {
  const key = String(conversationKey || "").trim();
  if (!key) return { ok: false, reason: "invalid_conversation_key" };
  const state = pausedChildStateByConversation.get(key);
  if (!state || typeof state !== "object") {
    return { ok: false, reason: "not_paused" };
  }
  const pids = Array.isArray(state.pids) && state.pids.length > 0 ? state.pids : [state.rootPid];
  const resumed = signalPidList(pids, "SIGCONT");
  pausedChildStateByConversation.delete(key);
  logRelayEvent("agent.run.resumed", {
    conversationKey: key,
    rootPid: Number(state.rootPid) || null,
    processCount: pids.length,
    reason: String(reason || "").trim() || "priority question complete",
    resumedCount: resumed.signaled.length,
    signalFailures: resumed.failed.length,
  });
  if (resumed.signaled.length === 0) {
    return { ok: false, reason: "resume_signal_failed", failed: resumed.failed };
  }
  return { ok: true, resumedCount: resumed.signaled.length, failed: resumed.failed };
}

function collectInterruptSnapshotJobLines(session, maxItems = 4) {
  const jobs = session && Array.isArray(session.jobs) ? session.jobs : [];
  if (!jobs.length) return [];
  const lines = [];
  for (const job of jobs.slice(-Math.max(1, maxItems)).reverse()) {
    if (!job || typeof job !== "object") continue;
    const id = String(job.id || "job").trim() || "job";
    const status = String(job.status || "unknown").trim() || "unknown";
    const started = job.startedAt ? ` started=${job.startedAt}` : "";
    const finished = job.finishedAt ? ` finished=${job.finishedAt}` : "";
    const exitCode = job.exitCode == null ? "" : ` exit=${job.exitCode}`;
    const cmd = taskTextPreview(job.command, 120);
    const logPath = String(job.logPath || "").trim();
    const row = [`- ${id} [${status}]${started}${finished}${exitCode}`];
    if (cmd) row.push(`cmd=${cmd}`);
    if (logPath) row.push(`log=${logPath}`);
    lines.push(row.join(" | "));
  }
  return lines;
}

function extractInterruptSnapshotProgressLogCandidates(progressLines, workdir) {
  const textLines = Array.isArray(progressLines) ? progressLines : [];
  const out = [];
  const seen = new Set();
  for (const rawLine of textLines) {
    const line = String(rawLine || "");
    if (!line) continue;
    const re = /((?:\/|\.{1,2}\/)[^\s"'`]+\.log)\b/gi;
    let m;
    while ((m = re.exec(line)) != null) {
      const found = String(m[1] || "").replace(/[),.;:]+$/g, "").trim();
      if (!found) continue;
      const resolved = path.isAbsolute(found) ? path.resolve(found) : path.resolve(workdir, found);
      if (!isAllowedRequiredFilePath(resolved)) continue;
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      out.push({ path: resolved, source: "progress", priority: 70 });
    }
  }
  return out;
}

function collectInterruptSnapshotLogCandidates(session, workdir, progressLines) {
  const jobs = session && Array.isArray(session.jobs) ? session.jobs : [];
  const candidates = [];
  for (const job of jobs.slice(-8).reverse()) {
    if (!job || typeof job !== "object") continue;
    const runningBoost = String(job.status || "").toLowerCase() === "running" ? 20 : 0;
    const baseDir = job.workdir ? String(job.workdir) : workdir;
    const logPath = String(job.logPath || "").trim();
    if (logPath) {
      const resolved = path.resolve(logPath);
      if (isAllowedRequiredFilePath(resolved)) {
        candidates.push({
          path: resolved,
          source: `job:${job.id || "unknown"}:logPath`,
          priority: 100 + runningBoost,
        });
      }
    }
    for (const requiredRaw of inferVrRunRequireFiles(job.command || "")) {
      if (!/\.log$/i.test(requiredRaw)) continue;
      const resolved = path.isAbsolute(requiredRaw) ? path.resolve(requiredRaw) : path.resolve(baseDir, requiredRaw);
      if (!isAllowedRequiredFilePath(resolved)) continue;
      candidates.push({
        path: resolved,
        source: `job:${job.id || "unknown"}:inferred`,
        priority: 85 + runningBoost,
      });
    }
  }
  candidates.push(...extractInterruptSnapshotProgressLogCandidates(progressLines, workdir));
  return candidates;
}

async function materializeInterruptSnapshotLogCandidates(candidates) {
  const byPath = new Map();
  for (const item of Array.isArray(candidates) ? candidates : []) {
    const resolved = item && item.path ? path.resolve(String(item.path)) : "";
    if (!resolved) continue;
    const prev = byPath.get(resolved);
    if (!prev || Number(item.priority || 0) > Number(prev.priority || 0)) {
      byPath.set(resolved, {
        path: resolved,
        source: item && item.source ? String(item.source) : "unknown",
        priority: Number(item && item.priority != null ? item.priority : 0),
      });
    }
  }

  const out = [];
  for (const item of byPath.values()) {
    try {
      const st = await fsp.stat(item.path);
      if (!st.isFile()) continue;
      out.push({
        ...item,
        sizeBytes: Number(st.size || 0),
        mtimeMs: Number(st.mtimeMs || 0),
        mtimeIso: st.mtime ? st.mtime.toISOString() : "",
      });
    } catch {}
  }
  out.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return b.mtimeMs - a.mtimeMs;
  });
  return out;
}

async function readInterruptSnapshotLog(logPath) {
  const resolved = path.resolve(String(logPath || "").trim());
  if (!resolved) return null;
  try {
    const st = await fsp.stat(resolved);
    if (!st.isFile()) return null;
    const sizeBytes = Number(st.size || 0);
    const maxBytes = Math.max(4096, Number(CONFIG.interruptQuestionsSnapshotLogMaxBytes || 0) || 2 * 1024 * 1024);
    const maxChars = Math.max(1000, Number(CONFIG.interruptQuestionsSnapshotLogMaxChars || 0) || 12000);
    const halfBytes = Math.max(2048, Math.floor(maxBytes / 2));
    let mode = "full";
    let content = "";
    if (sizeBytes <= maxBytes) {
      content = await fsp.readFile(resolved, "utf8");
    } else {
      mode = "headtail";
      const head = await readHeadBytes(resolved, halfBytes);
      const tail = await readTailLines(resolved, 180, halfBytes);
      content = [head, `...[log truncated: ${sizeBytes} bytes total]...`, tail].filter(Boolean).join("\n");
    }
    const cleaned = String(content || "").replace(/\u0000/g, "").trim();
    const clipped = truncateContextByMode(cleaned, "headtail", maxChars);
    return {
      path: resolved,
      mode,
      sizeBytes,
      mtimeIso: st.mtime ? st.mtime.toISOString() : "",
      excerpt: clipped.text,
      excerptChars: String(clipped.text || "").length,
      excerptTruncated: clipped.truncated,
    };
  } catch {
    return null;
  }
}

async function buildInterruptRunSnapshot(session, conversationKey) {
  const workdir = session && session.workdir ? session.workdir : CONFIG.defaultWorkdir;
  const runState = session && session.agentRun && session.agentRun.status ? String(session.agentRun.status) : "unknown";
  const runReason = session && session.agentRun && session.agentRun.reason ? String(session.agentRun.reason) : "request";
  const runStartedAt = session && session.agentRun && session.agentRun.startedAt ? String(session.agentRun.startedAt) : "";
  const progressLines = getInterruptProgressLines(conversationKey);
  const jobLines = collectInterruptSnapshotJobLines(session, 4);
  const candidates = collectInterruptSnapshotLogCandidates(session, workdir, progressLines);
  const existingCandidates = await materializeInterruptSnapshotLogCandidates(candidates);
  const selectedCandidate = existingCandidates.length > 0 ? existingCandidates[0] : null;
  const logSnapshot = selectedCandidate ? await readInterruptSnapshotLog(selectedCandidate.path) : null;

  const lines = [
    `snapshot_generated_at: ${nowIso()}`,
    "snapshot_kind: relay_run_snapshot",
    `workdir: ${workdir}`,
    `active_run_status: ${runState}`,
    `active_run_reason: ${runReason}`,
  ];
  if (runStartedAt) lines.push(`active_run_started_at: ${runStartedAt}`);

  if (progressLines.length > 0) {
    lines.push("", "recent_progress_lines:");
    lines.push(...progressLines.map((line) => `- ${line}`));
  }

  if (jobLines.length > 0) {
    lines.push("", "recent_jobs:");
    lines.push(...jobLines);
  }

  if (logSnapshot) {
    lines.push(
      "",
      `latest_run_log_path: ${logSnapshot.path}`,
      `latest_run_log_mode: ${logSnapshot.mode}`,
      `latest_run_log_size_bytes: ${logSnapshot.sizeBytes}`,
      `latest_run_log_mtime: ${logSnapshot.mtimeIso}`,
      `latest_run_log_excerpt_chars: ${logSnapshot.excerptChars}`,
      "latest_run_log_excerpt:",
      logSnapshot.excerpt || "(empty)"
    );
  } else {
    lines.push("", "latest_run_log_path: unavailable");
  }

  const rendered = lines.join("\n").trim();
  const clipped = truncateContextByMode(
    rendered,
    "headtail",
    Math.max(1000, Number(CONFIG.interruptQuestionsSnapshotMaxChars || 0) || 18000)
  );

  return {
    text: clipped.text,
    truncated: clipped.truncated,
    progressLineCount: progressLines.length,
    jobLineCount: jobLines.length,
    logPath: logSnapshot ? logSnapshot.path : null,
    logMode: logSnapshot ? logSnapshot.mode : null,
    logSizeBytes: logSnapshot ? logSnapshot.sizeBytes : null,
    candidateCount: existingCandidates.length,
  };
}

function buildInterruptQuestionPrompt(session, question, runSnapshotText = "") {
  const workdir = session && session.workdir ? session.workdir : CONFIG.defaultWorkdir;
  const runState = session && session.agentRun && session.agentRun.status ? String(session.agentRun.status) : "unknown";
  const runReason = session && session.agentRun && session.agentRun.reason ? String(session.agentRun.reason) : "request";
  const snapshotText = String(runSnapshotText || "").trim();
  const lines = [
    "You are answering a high-priority user question while an in-progress run is temporarily paused.",
    "Respond directly and concisely.",
    "Use the relay-provided run snapshot as the primary source for latest progress context.",
    "If you can only infer progress from the snapshot, say that explicitly.",
    "Do not launch long-running commands, start background jobs, or modify files unless absolutely required.",
    "If evidence is missing, say what is missing and ask one concise clarification question.",
    "",
    `workdir: ${workdir}`,
    `active_run_status: ${runState}`,
    `active_run_reason: ${runReason}`,
  ];
  if (snapshotText) {
    lines.push("", "[Relay Run Snapshot]", snapshotText);
  } else {
    lines.push("", "[Relay Run Snapshot]", "Unavailable.");
  }
  lines.push("", "User question:", String(question || "").trim());
  return lines.join("\n");
}

async function runPriorityQuestion(session, question, { conversationKey, onProgress, runId = null } = {}) {
  const workdir = session && session.workdir ? session.workdir : CONFIG.defaultWorkdir;
  let snapshot = {
    text: "",
    truncated: false,
    progressLineCount: 0,
    jobLineCount: 0,
    logPath: null,
    logMode: null,
    logSizeBytes: null,
    candidateCount: 0,
  };
  try {
    snapshot = await buildInterruptRunSnapshot(session, conversationKey);
  } catch (err) {
    logRelayEvent("agent.priority_question.snapshot.error", {
      conversationKey,
      runId: runId || null,
      error: String(err && err.message ? err.message : err).slice(0, 240),
    });
  }
  const prompt = buildInterruptQuestionPrompt(session, question, snapshot.text);
  logRelayEvent("agent.priority_question.snapshot", {
    conversationKey,
    runId: runId || null,
    snapshotChars: String(snapshot && snapshot.text ? snapshot.text : "").length,
    snapshotTruncated: Boolean(snapshot && snapshot.truncated),
    progressLineCount: Number(snapshot && snapshot.progressLineCount ? snapshot.progressLineCount : 0),
    jobLineCount: Number(snapshot && snapshot.jobLineCount ? snapshot.jobLineCount : 0),
    logPath: snapshot && snapshot.logPath ? snapshot.logPath : null,
    logMode: snapshot && snapshot.logMode ? snapshot.logMode : null,
    logSizeBytes: snapshot && snapshot.logSizeBytes != null ? snapshot.logSizeBytes : null,
    candidateCount: Number(snapshot && snapshot.candidateCount ? snapshot.candidateCount : 0),
  });
  if (CONFIG.agentProvider === "codex") {
    const args = buildCodexArgsStateless(workdir, prompt, {
      sandboxMode: CONFIG.interruptQuestionsSandbox || "read-only",
    });
    const res = await runCodexWithArgs(args, {
      cwd: workdir,
      extraEnv: null,
      onProgress,
      conversationKey: null,
      label: "codex-priority-question",
      timeoutMs: CONFIG.interruptQuestionsTimeoutMs,
    });
    logRelayEvent("agent.priority_question.done", {
      conversationKey,
      runId: runId || null,
      provider: CONFIG.agentProvider,
      timeoutMs: CONFIG.interruptQuestionsTimeoutMs,
      answerChars: String(res && res.text ? res.text : "").length,
      snapshotChars: String(snapshot && snapshot.text ? snapshot.text : "").length,
      snapshotLogPath: snapshot && snapshot.logPath ? snapshot.logPath : null,
    });
    return { text: res && res.text ? res.text : "No response." };
  }

  const tempSession = { threadId: null, workdir };
  const modelPlan = selectClaudeModelForRun(String(question || ""), "priority question");
  const res = await runClaude(tempSession, prompt, null, onProgress, null, {
    modelOverride: modelPlan.selectedModel,
    timeoutMs: CONFIG.interruptQuestionsTimeoutMs,
  });
  logRelayEvent("agent.priority_question.done", {
    conversationKey,
    runId: runId || null,
    provider: CONFIG.agentProvider,
    timeoutMs: CONFIG.interruptQuestionsTimeoutMs,
    model: res && res.model ? res.model : modelPlan.selectedModel || null,
    answerChars: String(res && res.text ? res.text : "").length,
    snapshotChars: String(snapshot && snapshot.text ? snapshot.text : "").length,
    snapshotLogPath: snapshot && snapshot.logPath ? snapshot.logPath : null,
  });
  return { text: res && res.text ? res.text : "No response." };
}

function buildInjectedRunPrompt(instruction) {
  const text = String(instruction || "").trim();
  return [
    "User issued `/inject` during an in-flight run.",
    "Treat this as the highest-priority directive and re-plan immediately.",
    "Supersede earlier conflicting instructions, but keep any useful completed results.",
    "",
    "Injected instruction:",
    text,
  ].join("\n");
}

async function handleInjectCommand({ message, session, conversationKey, instruction }) {
  const trimmedInstruction = String(instruction || "").trim();
  if (!trimmedInstruction) {
    await message.reply("Usage: `/inject <instruction...>`");
    return true;
  }

  preemptConversationQueue(conversationKey, "inject command");
  const runState = session && session.agentRun && session.agentRun.status ? String(session.agentRun.status) : "";
  const hasInflightRun = queueByConversation.has(conversationKey) || runState === "queued" || runState === "running";
  let stopIssued = false;

  if (hasInflightRun) {
    stopIssued = requestStopConversation(conversationKey, session);
    const stopLine = stopIssued
      ? "Inject requested: sent stop signal, dropped queued pending requests, and queued your replacement instruction."
      : "Inject requested: dropped queued pending requests; active run was not killable yet, so replacement run is queued next.";
    await message.reply(stopLine);
  }

  const injectedPrompt = buildInjectedRunPrompt(trimmedInstruction);
  await runAgentAndPostToDiscord({
    baseMessage: message,
    channel: message.channel,
    session,
    conversationKey,
    prompt: injectedPrompt,
    isDm: !message.guildId,
    isThread: Boolean(message.channel && message.channel.isThread && message.channel.isThread()),
    reasonLabel: hasInflightRun
      ? stopIssued
        ? "inject command (hard preempt + interrupted run)"
        : "inject command (hard preempt + queued behind active run)"
      : "inject command (hard preempt)",
    postFullOutput: true,
  });
  return true;
}

async function handlePriorityQuestionCommand({ message, session, conversationKey, question }) {
  const trimmedQuestion = String(question || "").trim();
  if (!trimmedQuestion) {
    await message.reply("Usage: `/ask <question>`");
    return true;
  }
  if (!CONFIG.interruptQuestionsEnabled) {
    await message.reply("Priority-question interrupts are disabled (`RELAY_INTERRUPT_QUESTIONS_ENABLED=false`).");
    return true;
  }
  if (interruptQuestionInFlightByConversation.has(conversationKey)) {
    await message.reply("A priority question is already in progress for this conversation. Try again in a moment.");
    return true;
  }

  interruptQuestionInFlightByConversation.add(conversationKey);
  const runId = newRunId("pq");
  const hasQueuedWork = queueByConversation.has(conversationKey);
  const statusLine = hasQueuedWork
    ? "Handling priority question (attempting to pause active run first)..."
    : "Handling priority question...";
  const pendingMsg = await message.reply(statusLine);
  const progress = createProgressReporter(pendingMsg, conversationKey, {
    runId,
    runReason: "priority question",
  });
  const startedAt = Date.now();
  logRelayEvent("agent.priority_question.start", {
    conversationKey,
    runId,
    provider: CONFIG.agentProvider,
    hasQueuedWork,
  });
  let paused = false;
  let pauseSummary = "";
  try {
    if (hasQueuedWork) {
      const pauseRes = await pauseConversationRun(conversationKey, "priority question");
      if (pauseRes.ok) {
        paused = true;
        pauseSummary = `Paused active run (pid ${pauseRes.rootPid}, processes ${Array.isArray(pauseRes.pids) ? pauseRes.pids.length : 0}).`;
        progress.note(pauseSummary);
      } else {
        pauseSummary = `Could not pause active run (${pauseRes.reason}); answering anyway.`;
        progress.note(pauseSummary);
      }
    }

    const result = await runPriorityQuestion(session, trimmedQuestion, {
      conversationKey,
      runId,
      onProgress: (line) => progress.note(line),
    });
    const answerText = String(result && result.text ? result.text : "No response.").trim() || "No response.";
    await progress.stop();
    const chunks = splitMessage(answerText, Math.max(300, CONFIG.maxReplyChars));
    await pendingMsg.edit(chunks[0]);
    for (let i = 1; i < chunks.length; i += 1) {
      await message.channel.send(chunks[i]);
    }
    if (CONFIG.statusSummaryEnabled) {
      const elapsed = formatElapsed(Date.now() - startedAt);
      const resumeHint = paused ? "resuming previous run" : "no run pause applied";
      await message.channel
        .send(`Priority question status: completed (${elapsed}, ${resumeHint}).`)
        .catch(() => {});
    }
    return true;
  } catch (err) {
    await progress.stop();
    const detail = String((err && err.message) || err || "").slice(0, 1800);
    await pendingMsg
      .edit(`Priority question error:\n\`\`\`\n${detail}\n\`\`\``)
      .catch(async () => {
        await message.channel.send(`Priority question error:\n\`\`\`\n${detail}\n\`\`\``).catch(() => {});
      });
    return true;
  } finally {
    if (paused) {
      const resumeRes = await resumeConversationRun(conversationKey, "priority question complete");
      if (!resumeRes.ok) {
        await message.channel
          .send(
            `Warning: failed to auto-resume paused run (${resumeRes.reason}). Use \`/status\` and \`/task list\` to inspect.`
          )
          .catch(() => {});
      }
    }
    interruptQuestionInFlightByConversation.delete(conversationKey);
  }
}

function requestStopConversation(conversationKey, session) {
  const runner = taskRunnerByConversation.get(conversationKey);
  if (runner) runner.stopRequested = true;
  const shouldSetTaskStopFlag = Boolean(runner) || Boolean(session && session.taskLoop && session.taskLoop.running);
  if (shouldSetTaskStopFlag && session && typeof session === "object") {
    ensureTaskLoopShape(session);
    session.taskLoop.stopRequested = true;
    session.updatedAt = nowIso();
    void queueSaveState();
  }

  if (pausedChildStateByConversation.has(conversationKey)) {
    void resumeConversationRun(conversationKey, "stop requested");
  }

  const child = activeChildByConversation.get(conversationKey);
  if (!child) {
    logRelayEvent("task.stop_requested", { conversationKey, hasChild: false });
    return false;
  }
  logRelayEvent("task.stop_requested", { conversationKey, hasChild: true });
  try {
    child.kill("SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      if (!child.killed) child.kill("SIGKILL");
    } catch {}
  }, 5000).unref?.();
  return true;
}

function shouldAllowAgentActions({ isDm, session }) {
  if (!CONFIG.agentActionsEnabled) {
    return { ok: false, reason: "RELAY_AGENT_ACTIONS_ENABLED=false" };
  }
  if (CONFIG.agentActionsDmOnly && !isDm) {
    return { ok: false, reason: "RELAY_AGENT_ACTIONS_DM_ONLY=true" };
  }
  ensureAutoShape(session);
  if (session && session.auto && session.auto.actions === false) {
    return { ok: false, reason: "conversation actions toggle is OFF (/auto actions off)" };
  }
  return { ok: true, reason: "" };
}

function findLatestJob(session, { requireRunning = false } = {}) {
  ensureJobsShape(session);
  const jobs = Array.isArray(session.jobs) ? session.jobs : [];
  if (jobs.length === 0) return null;
  if (requireRunning) {
    for (let i = jobs.length - 1; i >= 0; i -= 1) {
      const j = jobs[i];
      if (j && typeof j === "object" && j.status === "running") return j;
    }
    return null;
  }
  return jobs[jobs.length - 1];
}

async function executeRelayActions({ actions, errors, conversationKey, session, channel, isDm, isThread }) {
  const list = Array.isArray(actions) ? actions : [];
  const errs = Array.isArray(errors) ? errors : [];

  if (errs.length > 0) {
    logRelayEvent("agent.actions.extract.warn", { conversationKey, errors: errs.slice(0, 5) });
  }
  if (list.length === 0) return { ok: true, executed: 0 };

  const gate = shouldAllowAgentActions({ isDm, session });
  if (!gate.ok) {
    logRelayEvent("agent.actions.blocked", { conversationKey, reason: gate.reason, count: list.length });
    try {
      if (channel) await channel.send(`Agent requested relay actions, but they are blocked: ${gate.reason}`);
    } catch {}
    return { ok: false, executed: 0, error: gate.reason };
  }

  const allowed = CONFIG.agentActionsAllowed instanceof Set ? CONFIG.agentActionsAllowed : new Set();
  const lines = [];
  let executed = 0;

  for (const action of list) {
    if (!action || typeof action !== "object") continue;
    const type = String(action.type || "").trim().toLowerCase();
    if (!type) continue;
    if (allowed.size > 0 && !allowed.has(type)) {
      lines.push(`- blocked: \`${type}\` (not in RELAY_AGENT_ACTIONS_ALLOWED)`);
      continue;
    }

    try {
      if (type === "job_start") {
        const existing = findLatestJob(session, { requireRunning: true });
        if (existing) {
          lines.push(`- job_start refused: job \`${existing.id}\` is still running`);
          continue;
        }
        let cmd = String(action.command || "").trim();
        let watchInput = action.watch || null;
        if (action.supervisor) {
          const launchSpec = buildStage0SupervisorLaunchSpec(action.supervisor, {
            workdir: session.workdir || CONFIG.defaultWorkdir,
          });
          if (!launchSpec.ok) {
            lines.push(`- job_start supervisor invalid: ${launchSpec.error}`);
            continue;
          }
          cmd = launchSpec.command;
          watchInput = mergeWatchConfigWithPatch(action.watch || null, launchSpec.watchPatch || null);
          lines.push(`- job_start supervisor: ${launchSpec.supervisorSummary}`);
        }
        const guardRes = await evaluateJobLaunchGuards({
          command: cmd,
          workdir: session.workdir || CONFIG.defaultWorkdir,
          preflight: action.preflight || null,
        });
        if (guardRes.warnings && guardRes.warnings.length > 0) {
          lines.push(`- job_start guard warnings: ${guardRes.warnings.join(" | ")}`);
        }
        if (!guardRes.ok) {
          const failed = guardRes.preflight && guardRes.preflight.failed ? JSON.stringify(guardRes.preflight.failed) : "";
          lines.push(`- job_start blocked by guard (${guardRes.reason})${failed ? `: ${failed}` : ""}`);
          continue;
        }
        const started = await startJobProcess({
          conversationKey,
          session,
          command: cmd,
          workdir: session.workdir || CONFIG.defaultWorkdir,
          description: action.description || null,
        });
        if (!started.ok) {
          lines.push(`- job_start failed: ${started.error}`);
          continue;
        }
        executed += 1;
        const job = started.job;
        lines.push(`- job_start: \`${job.id}\` (pid ${job.pid || "?"})${jobDisplayDescription(job, 80) ? ` desc="${jobDisplayDescription(job, 80)}"` : ""}`);

        const wantWatch = watchInput || (CONFIG.jobsAutoWatch ? {} : null);
        if (wantWatch) {
          const watchCfg = normalizeJobWatchConfig(watchInput, {
            everySecDefault: CONFIG.jobsAutoWatchEverySec,
            tailLinesDefault: CONFIG.jobsAutoWatchTailLines,
            jobCommand: cmd,
            workdir: session.workdir || CONFIG.defaultWorkdir,
          });
          const watchRes = await startJobWatcher({
            conversationKey,
            session,
            job,
            channelId: channel && channel.id ? String(channel.id) : session.lastChannelId,
            watchConfig: watchCfg,
          });
          if (watchRes && watchRes.ok) {
            lines.push(`  watching: everySec=${watchCfg.everySec} tailLines=${watchCfg.tailLines}`);
            if (watchCfg.supervisorMode) {
              lines.push(
                `  supervisor-gate: mode=${watchCfg.supervisorMode} expect=${watchCfg.supervisorExpectStatus || "success"}`
              );
            }
          } else {
            lines.push(`  watch failed`);
          }
        }
        continue;
      }

      if (type === "job_watch") {
        const job = findLatestJob(session, { requireRunning: true }) || findLatestJob(session, { requireRunning: false });
        if (!job) {
          lines.push("- job_watch failed: no job found");
          continue;
        }
        const watchCfg = normalizeJobWatchConfig(action.watch || {}, {
          everySecDefault: CONFIG.jobsAutoWatchEverySec,
          tailLinesDefault: CONFIG.jobsAutoWatchTailLines,
          jobCommand: job.command || "",
          workdir: job.workdir || session.workdir || CONFIG.defaultWorkdir,
        });
        const res = await startJobWatcher({
          conversationKey,
          session,
          job,
          channelId: channel && channel.id ? String(channel.id) : session.lastChannelId,
          watchConfig: watchCfg,
        });
        if (res && res.ok) {
          executed += 1;
          lines.push(`- job_watch: \`${job.id}\` everySec=${watchCfg.everySec} tailLines=${watchCfg.tailLines}`);
        } else {
          lines.push(`- job_watch failed: \`${job.id}\``);
        }
        continue;
      }

      if (type === "job_stop") {
        const job = findLatestJob(session, { requireRunning: true });
        if (!job) {
          lines.push("- job_stop failed: no running job found");
          continue;
        }
        const pid = job.pid;
        const killed = pid ? killProcessGroup(pid, "SIGTERM") : false;
        job.status = "canceled";
        job.exitedAt = job.exitedAt || nowIso();
        job.finishedAt = job.finishedAt || nowIso();
        appendJobLifecycleTransition(job, "failed", "job_stop_requested", { signal: "SIGTERM", pid: pid || null, killed });
        session.updatedAt = nowIso();
        await queueSaveState();
        void stopJobWatcher(conversationKey, job.id);
        executed += 1;
        lines.push(`- job_stop: \`${job.id}\` (pid ${pid || "?"}) ${killed ? "SIGTERM sent" : "no pid"}`);
        continue;
      }

      if (type === "task_add") {
        if (!CONFIG.tasksEnabled) {
          lines.push("- task_add blocked: RELAY_TASKS_ENABLED=false");
          continue;
        }
        ensureTasksShape(session);
        const pending = session.tasks.filter((t) => t && t.status === "pending").length;
        if (CONFIG.tasksMaxPending > 0 && pending >= CONFIG.tasksMaxPending) {
          lines.push(`- task_add blocked: queue full (pending=${pending}, max=${CONFIG.tasksMaxPending})`);
          continue;
        }
        const task = createTask(session, String(action.text || ""), {
          description: action.description || null,
        });
        session.tasks.push(task);
        session.updatedAt = nowIso();
        await queueSaveState();
        executed += 1;
        lines.push(`- task_add: \`${task.id}\`${taskDisplayDescription(task, 80) ? ` desc="${taskDisplayDescription(task, 80)}"` : ""}`);
        continue;
      }

      if (type === "task_run") {
        if (!CONFIG.tasksEnabled) {
          lines.push("- task_run blocked: RELAY_TASKS_ENABLED=false");
          continue;
        }
        ensureTasksShape(session);
        ensureTaskLoopShape(session);
        const res = await maybeStartTaskRunner(conversationKey, channel, session, { isDm, isThread });
        executed += 1;
        lines.push(`- task_run: ${res && res.started ? "started" : "noop"}`);
        continue;
      }
    } catch (err) {
      lines.push(`- ${type} error: ${String(err && err.message ? err.message : err).slice(0, 200)}`);
      logRelayEvent("agent.actions.exec.error", {
        conversationKey,
        type,
        error: String(err && err.message ? err.message : err).slice(0, 240),
      });
    }
  }

  logRelayEvent("agent.actions.executed", { conversationKey, executed, requested: list.length });
  if (lines.length > 0) {
    try {
      if (channel) await sendLongToChannel(channel, ["Relay actions:", ...lines].join("\n"));
    } catch {}
  }
  return { ok: true, executed };
}

async function runAgentAndPostToDiscord({
  baseMessage,
  channel,
  session,
  conversationKey,
  prompt,
  isDm,
  isThread,
  reasonLabel,
  postFullOutput = true,
}) {
  const runLabel = reasonLabel ? `${reasonLabel}` : "request";
  const runId = newRunId("run");
  const pendingMsg = baseMessage && typeof baseMessage.reply === "function"
    ? await baseMessage.reply(`Running ${AGENT_LABEL}...`)
    : await channel.send(`Running ${AGENT_LABEL}... (${runLabel})`);
  const pendingMessageId = pendingMsg && pendingMsg.id != null ? String(pendingMsg.id) : "";
  recordAgentRunStatus(session, {
    status: "queued",
    provider: CONFIG.agentProvider,
    reason: runLabel,
    queuedAt: nowIso(),
    startedAt: null,
    pendingMessageId: pendingMessageId || (session.agentRun && session.agentRun.pendingMessageId),
    channelId: channel && channel.id != null ? String(channel.id) : session.lastChannelId,
    guildId: channel && channel.guildId != null ? String(channel.guildId) : session.lastGuildId,
  });
  session.updatedAt = nowIso();
  await queueSaveState();

  const wasAlreadyQueued = queueByConversation.has(conversationKey);
  const progress = createProgressReporter(pendingMsg, conversationKey, {
    runId,
    runReason: runLabel,
    channel,
  });
  if (wasAlreadyQueued) {
    progress.note("Waiting for an earlier request in this conversation");
  }

  logRelayEvent("message.queued", {
    conversationKey,
    runId,
    provider: CONFIG.agentProvider,
    promptChars: String(prompt || "").length,
    sessionId: session.threadId || null,
    reason: runLabel,
  });

  let activeClaudeModel = "";
  let usedClaudeFallback = false;
  let codexTransientRetriesUsed = 0;

  return enqueueConversation(conversationKey, async () => {
    const startedAt = Date.now();
    try {
      recordAgentRunStatus(session, {
        status: "running",
        startedAt: nowIso(),
      });
      session.updatedAt = nowIso();
      await queueSaveState();

      progress.note(`Starting ${AGENT_LABEL} run`);
      void channel
        .sendTyping?.()
        ?.catch((err) =>
          logRelayEvent("discord.sendTyping.error", {
            conversationKey,
            error: String(err && err.message ? err.message : err).slice(0, 240),
          })
        );

      const uploadDir = getConversationUploadDir(conversationKey);
      if (CONFIG.uploadEnabled || CONFIG.discordAttachmentsEnabled) {
        await fsp.mkdir(uploadDir, { recursive: true });
      }

      let userPrompt = prompt;
      let attachmentMeta = null;
      if (CONFIG.discordAttachmentsEnabled && baseMessage) {
        const ingested = await ingestDiscordTextAttachments(
          baseMessage,
          conversationKey,
          uploadDir,
          (line) => progress.note(line)
        );
        attachmentMeta = ingested;
        if (ingested && ingested.injectedText) {
          const block = `[Discord Attachments]\n${ingested.injectedText}`;
          userPrompt = userPrompt ? `${userPrompt}\n\n${block}` : block;
          progress.note(`Loaded ${ingested.includedFiles}/${ingested.totalCandidates} attachment(s)`);
        } else if (ingested && ingested.totalCandidates > 0) {
          progress.note(`No attachments injected (saved=${ingested.savedPaths.length}, errors=${ingested.errors.length})`);
        }
      }

      logRelayEvent("agent.run.start", {
        conversationKey,
        runId,
        provider: CONFIG.agentProvider,
        sessionId: session.threadId || null,
        workdir: session.workdir || CONFIG.defaultWorkdir,
        reason: runLabel,
        discordAttachmentsCandidates: attachmentMeta ? attachmentMeta.totalCandidates : 0,
        discordAttachmentsSaved: attachmentMeta ? attachmentMeta.savedPaths.length : 0,
      });

      let contextInjected = false;
      let firstPrompt = null;
      const runEnv = CONFIG.uploadEnabled ? { RELAY_UPLOAD_DIR: uploadDir } : null;
      let result;
      const claudeModelPlan =
        CONFIG.agentProvider === "claude" ? selectClaudeModelForRun(userPrompt, runLabel) : null;
      activeClaudeModel = claudeModelPlan ? claudeModelPlan.selectedModel : "";
      usedClaudeFallback = false;
      if (claudeModelPlan) {
        progress.note(
          `Claude model selected: ${activeClaudeModel || "default"} (${claudeModelPlan.strategy})`
        );
        logRelayEvent("agent.run.claude_model_selected", {
          conversationKey,
          runId,
          provider: CONFIG.agentProvider,
          selectedModel: activeClaudeModel || null,
          fallbackModel: claudeModelPlan.fallbackModel || null,
          strategy: claudeModelPlan.strategy,
        });
      }
      try {
        firstPrompt = await buildAgentPrompt(session, userPrompt, {
          conversationKey,
          uploadDir,
          isDm,
          isThread,
        });
        contextInjected = firstPrompt.contextInjected;
        if (firstPrompt.contextInjected) {
          const injectedChars =
            firstPrompt.contextMeta && typeof firstPrompt.contextMeta.injectedChars === "number"
              ? firstPrompt.contextMeta.injectedChars
              : 0;
          const includedFiles =
            firstPrompt.contextMeta && typeof firstPrompt.contextMeta.includedFiles === "number"
              ? firstPrompt.contextMeta.includedFiles
              : 0;
          logRelayEvent("agent.run.context_injected", {
            conversationKey,
            runId,
            provider: CONFIG.agentProvider,
            sessionId: session.threadId || null,
            contextVersion: CONFIG.contextVersion,
            contextChars: injectedChars,
            contextFiles: includedFiles,
          });
          progress.note(
            includedFiles > 0
              ? `Loaded relay runtime context (+${includedFiles} context file${includedFiles === 1 ? "" : "s"})`
              : "Loaded relay runtime context"
          );
        }
        result = await runAgent(
          session,
          firstPrompt.prompt,
          runEnv,
          (line) => progress.note(line),
          conversationKey,
          { modelOverride: activeClaudeModel }
        );
      } catch (runErr) {
        if (CONFIG.agentProvider === "claude" && firstPrompt && isTransientClaudeInitError(runErr)) {
          logRelayEvent("agent.run.retry_claude_init", {
            conversationKey,
            runId,
            provider: CONFIG.agentProvider,
            sessionId: session.threadId || null,
          });
          progress.note("Claude exited during init; retrying once");
          try {
            result = await runAgent(
              session,
              firstPrompt.prompt,
              runEnv,
              (line) => progress.note(line),
              conversationKey,
              { modelOverride: activeClaudeModel }
            );
          } catch (retryErr) {
            runErr = retryErr;
          }
        }
        if (
          !result &&
          CONFIG.agentProvider === "claude" &&
          claudeModelPlan &&
          claudeModelPlan.usedHeavy &&
          CONFIG.claudeModelQuotaFallback &&
          claudeModelPlan.fallbackModel &&
          claudeModelPlan.fallbackModel !== activeClaudeModel &&
          isClaudeQuotaLimitedError(runErr)
        ) {
          logRelayEvent("agent.run.retry_claude_quota_fallback", {
            conversationKey,
            runId,
            provider: CONFIG.agentProvider,
            fromModel: activeClaudeModel || null,
            toModel: claudeModelPlan.fallbackModel,
          });
          progress.note(
            `Claude model quota limited for ${activeClaudeModel || "selected model"}; retrying with ${
              claudeModelPlan.fallbackModel
            }`
          );
          activeClaudeModel = claudeModelPlan.fallbackModel;
          usedClaudeFallback = true;
          try {
            result = await runAgent(
              session,
              firstPrompt.prompt,
              runEnv,
              (line) => progress.note(line),
              conversationKey,
              { modelOverride: activeClaudeModel }
            );
          } catch (fallbackErr) {
            runErr = fallbackErr;
          }
        }
        if (
          !result &&
          CONFIG.agentProvider === "codex" &&
          firstPrompt &&
          CONFIG.codexTransientRetryEnabled &&
          CONFIG.codexTransientRetryMax > 0 &&
          isTransientCodexRuntimeError(runErr)
        ) {
          for (let attempt = 1; attempt <= CONFIG.codexTransientRetryMax && !result; attempt += 1) {
            codexTransientRetriesUsed = attempt;
            logRelayEvent("agent.run.retry_codex_transient", {
              conversationKey,
              runId,
              provider: CONFIG.agentProvider,
              sessionId: session.threadId || null,
              attempt,
              maxAttempts: CONFIG.codexTransientRetryMax,
              error: cleanProgressText(codexErrorMessage(runErr), 220),
            });
            progress.note(
              `Codex run failed with a likely transient error; retrying (${attempt}/${CONFIG.codexTransientRetryMax})`
            );
            try {
              result = await runAgent(
                session,
                firstPrompt.prompt,
                runEnv,
                (line) => progress.note(line),
                conversationKey,
                { modelOverride: activeClaudeModel }
              );
            } catch (retryErr) {
              runErr = retryErr;
              if (!isTransientCodexRuntimeError(runErr)) break;
            }
          }
        }
        if (!result) {
          if (CONFIG.agentProvider === "claude" && isClaudeQuotaLimitedError(runErr)) {
            const detail = String((runErr && runErr.message) || runErr || "").slice(0, 300);
            throw new Error(
              `Claude model quota is currently limited (${activeClaudeModel || "default"}). ${detail}`
            );
          }
          if (!session.threadId || !isStaleThreadResumeError(runErr)) throw runErr;
          const staleThreadId = session.threadId;
          session.threadId = null;
          session.updatedAt = nowIso();
          await queueSaveState();
          logRelayEvent("agent.run.retry_stale_session", {
            conversationKey,
            runId,
            provider: CONFIG.agentProvider,
            staleSessionId: staleThreadId,
          });
          progress.note(`Session ${staleThreadId} could not be resumed; retrying in a new session`);
          const retryPrompt = await buildAgentPrompt(session, userPrompt, {
            conversationKey,
            uploadDir,
            isDm,
            isThread,
          });
          contextInjected = contextInjected || retryPrompt.contextInjected;
          result = await runAgent(
            session,
            retryPrompt.prompt,
            runEnv,
            (line) => progress.note(line),
            conversationKey,
            { modelOverride: activeClaudeModel }
          );
          result.text =
            `Note: previous ${AGENT_LABEL} session \`${staleThreadId}\` could not be resumed, so I started a new session.\n\n` +
            (result.text || "");
        }
      }

      if (usedClaudeFallback) {
        result.text =
          `Note: Claude heavy-model quota was limited, so the relay retried with \`${activeClaudeModel}\`.\n\n` +
          (result.text || "");
      }
      if (codexTransientRetriesUsed > 0) {
        result.text =
          `Note: Codex hit a likely transient connectivity/runtime failure and the relay auto-retried ${codexTransientRetriesUsed} time(s).\n\n` +
          (result.text || "");
      }

      session.threadId = result.threadId || session.threadId;
      if (contextInjected) session.contextVersion = CONFIG.contextVersion;
      session.updatedAt = nowIso();
      await queueSaveState();

      logRelayEvent("agent.run.done", {
        conversationKey,
        runId,
        provider: CONFIG.agentProvider,
        durationMs: Date.now() - startedAt,
        sessionId: session.threadId || null,
        model: activeClaudeModel || null,
        quotaFallback: usedClaudeFallback,
        transientRetries: codexTransientRetriesUsed,
        resultChars: (result.text || "").length,
        reason: runLabel,
      });

      let answer = result.text || "No response.";
      let uploadPaths = [];
      let relayActions = [];
      let relayActionErrors = [];
      {
        const extracted = extractRelayActions(answer, { maxActions: CONFIG.agentActionsMaxPerMessage });
        answer = extracted.text;
        relayActions = extracted.actions || [];
        relayActionErrors = extracted.errors || [];
      }
      if (CONFIG.uploadEnabled) {
        const parsed = extractUploadMarkers(answer);
        answer = parsed.text;
        uploadPaths = parsed.rawPaths || [];
      }

      const postedRaw = postFullOutput
        ? answer
        : (() => {
            const max = Math.max(200, Math.min(1800, CONFIG.maxReplyChars));
            if (answer.length <= max) return answer;
            return `${answer.slice(0, Math.max(0, max - 24)).trim()}\n...[output truncated]`;
          })();
      const posted = postedRaw.trim()
        ? postedRaw
        : relayActions.length > 0
          ? "Relay actions were accepted. (No additional text response.)"
          : uploadPaths.length > 0
            ? "Uploads were processed. (No additional text response.)"
            : "No response.";
      if (!postedRaw.trim()) {
        logRelayEvent("agent.response.empty_after_postprocess", {
          conversationKey,
          runId,
          provider: CONFIG.agentProvider,
          answerChars: answer.length,
          relayActions: relayActions.length,
          uploads: uploadPaths.length,
          reason: runLabel,
        });
      }

      await progress.stop();
      const chunks = splitMessage(posted, Math.max(300, CONFIG.maxReplyChars));
      await pendingMsg.edit(chunks[0]);
      for (let i = 1; i < chunks.length; i += 1) {
        await channel.send(chunks[i]);
      }

      if (CONFIG.uploadEnabled && uploadPaths.length > 0) {
        const { files, errors } = await resolveAndValidateUploads(
          conversationKey,
          uploadPaths,
          session.workdir || CONFIG.defaultWorkdir
        );
        if (files.length > 0) {
          for (let i = 0; i < files.length; i += 10) {
            const batch = files.slice(i, i + 10);
            const names = batch.map((f) => `\`${f.name}\``).join(", ");
            await channel.send({ content: `Uploaded: ${names}`, files: batch });
          }
        }
        if (errors.length > 0) {
          await channel.send(`Upload notes:\n${errors.map((e) => `- ${e}`).join("\n")}`);
        }
      }

      if (relayActions.length > 0 || relayActionErrors.length > 0) {
        await executeRelayActions({
          actions: relayActions,
          errors: relayActionErrors,
          conversationKey,
          session,
          channel,
          isDm,
          isThread,
        });
      }

      if (CONFIG.statusSummaryEnabled) {
        const durationLabel = formatElapsed(Date.now() - startedAt);
        const sessionLabel = session.threadId || "n/a";
        const modelLabel =
          CONFIG.agentProvider === "claude" && activeClaudeModel ? `, model ${activeClaudeModel}` : "";
        const actionsLabel = relayActions.length > 0 ? `, actions ${relayActions.length}` : "";
        const uploadsLabel = uploadPaths.length > 0 ? `, uploads ${uploadPaths.length}` : "";
        const retriesLabel =
          codexTransientRetriesUsed > 0 ? `, transient retries ${codexTransientRetriesUsed}` : "";
        try {
          await channel.send(
            `Run status: completed (duration ${durationLabel}, session ${sessionLabel}${modelLabel}, reply ${answer.length} chars${actionsLabel}${uploadsLabel}${retriesLabel})`
          );
        } catch {}
      }

      recordAgentRunStatus(session, {
        status: null,
        provider: null,
        reason: null,
        queuedAt: null,
        startedAt: null,
        pendingMessageId: null,
      });
      session.updatedAt = nowIso();
      await queueSaveState();
      return { ok: true, threadId: session.threadId || null, text: answer };
    } catch (err) {
      await progress.stop();
      const detail = String(err.message || err).slice(0, 1800);
      logRelayEvent("message.failed", {
        conversationKey,
        runId,
        provider: CONFIG.agentProvider,
        durationMs: Date.now() - startedAt,
        sessionId: session.threadId || null,
        error: detail.slice(0, 240),
        reason: runLabel,
      });
      const errorBody = `${AGENT_LABEL} error:\n\`\`\`\n${detail}\n\`\`\``;
      try {
        await pendingMsg.edit(errorBody);
      } catch (editErr) {
        logRelayEvent("message.error_edit_failed", {
          conversationKey,
          error: String(editErr && editErr.message ? editErr.message : editErr).slice(0, 240),
        });
        try {
          if (baseMessage) await sendLongReply(baseMessage, errorBody);
          else await sendLongToChannel(channel, errorBody);
        } catch {}
      }
      if (CONFIG.statusSummaryEnabled) {
        const durationLabel = formatElapsed(Date.now() - startedAt);
        const sessionLabel = session.threadId || "n/a";
        const modelLabel =
          CONFIG.agentProvider === "claude" && activeClaudeModel ? `, model ${activeClaudeModel}` : "";
        const shortErr = cleanProgressText(detail, 120) || "unknown error";
        const transientHint =
          CONFIG.agentProvider === "codex" && isTransientCodexRuntimeError(err)
            ? ", likely transient connectivity/proxy issue"
            : "";
        try {
          await channel.send(
            `Run status: failed (duration ${durationLabel}, session ${sessionLabel}${modelLabel}, error ${shortErr}${transientHint})`
          );
        } catch {}
      }
      recordAgentRunStatus(session, {
        status: null,
        provider: null,
        reason: null,
        queuedAt: null,
        startedAt: null,
        pendingMessageId: null,
      });
      session.updatedAt = nowIso();
      await queueSaveState();
      return { ok: false, error: detail };
    }
  }, {
    label: runLabel,
    onSkipped: async ({ reason } = {}) => {
      await progress.stop();
      const skippedBody = `Run status: canceled before start (${reason || "queue preempted"}).`;
      try {
        await pendingMsg.edit(skippedBody);
      } catch {
        try {
          await channel.send(skippedBody);
        } catch {}
      }
      if (
        session &&
        session.agentRun &&
        String(session.agentRun.pendingMessageId || "") &&
        String(session.agentRun.pendingMessageId || "") === pendingMessageId
      ) {
        recordAgentRunStatus(session, {
          status: null,
          provider: null,
          reason: null,
          queuedAt: null,
          startedAt: null,
          pendingMessageId: null,
        });
        session.updatedAt = nowIso();
        await queueSaveState();
      }
      logRelayEvent("agent.run.preempted_before_start", {
        conversationKey,
        runId,
        provider: CONFIG.agentProvider,
        sessionId: session.threadId || null,
        reason: reason || "queue preempted",
        runReason: runLabel,
      });
      return { ok: false, preempted: true, reason: reason || "queue preempted" };
    },
  });
}

function sanitizeWorktreeName(raw) {
  const name = String(raw || "").trim();
  if (!name) return "";
  if (name === "." || name === "..") return "";
  // Keep it strict: avoid path traversal and surprising unicode. Users can always pick a simpler name.
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) return "";
  return name;
}

function parseWorktreeNewArgs(tokens) {
  const out = { ok: true, fromRef: "HEAD", use: false };
  const args = Array.isArray(tokens) ? tokens : [];
  for (let i = 0; i < args.length; i += 1) {
    const t = args[i];
    if (t === "--use") {
      out.use = true;
      continue;
    }
    if (t === "--from") {
      const ref = args[i + 1];
      if (!ref) return { ok: false, error: "Usage: `/worktree new <name> [--from <ref>] [--use]`" };
      out.fromRef = ref;
      i += 1;
      continue;
    }
    return { ok: false, error: `Unknown flag: ${t}` };
  }
  return out;
}

async function execFileCapture(cmd, args, { cwd, timeoutMs } = {}) {
  const finalCwd = cwd || process.cwd();
  const maxBytes = 200 * 1024;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, { cwd: finalCwd, env: process.env });

    const killTimer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            try {
              child.kill("SIGTERM");
            } catch {}
            setTimeout(() => {
              try {
                child.kill("SIGKILL");
              } catch {}
            }, 5000).unref?.();
          }, timeoutMs)
        : null;

    const collect = (chunk, sink) => {
      if (!chunk) return "";
      const s = chunk.toString("utf8");
      if (sink.length >= maxBytes) return sink;
      return (sink + s).slice(0, maxBytes);
    };

    if (child.stdout) {
      child.stdout.on("data", (d) => {
        stdout = collect(d, stdout);
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (d) => {
        stderr = collect(d, stderr);
      });
    }

    child.on("error", (err) => {
      if (killTimer) clearTimeout(killTimer);
      resolve({ code: 127, stdout, stderr: `${stderr}\n${String(err.message || err)}`.trim() });
    });
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      resolve({ code: typeof code === "number" ? code : 1, stdout, stderr });
    });
  });
}

async function resolveGitRepoRoot(cwd) {
  const res = await execFileCapture("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: 15000 });
  if (res.code !== 0) {
    return {
      ok: false,
      error: "Not a git repo (run `/workdir` into a git repo first).",
    };
  }
  const root = String(res.stdout || "").trim();
  if (!root) return { ok: false, error: "Not a git repo (no repo root returned)." };
  return { ok: true, root: path.resolve(root) };
}

function repoSlug(repoRoot) {
  const repoName = path.basename(repoRoot);
  const repoHash = crypto.createHash("sha1").update(String(repoRoot)).digest("hex").slice(0, 8);
  return `${repoName}-${repoHash}`;
}

async function gitWorktreeList(repoRoot) {
  const res = await execFileCapture("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    timeoutMs: 20000,
  });
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout || "").trim();
    return { ok: false, error: `git worktree list failed:\n\`\`\`\n${detail.slice(0, 1600)}\n\`\`\`` };
  }
  const lines = String(res.stdout || "").split(/\r?\n/);
  const worktrees = [];
  let cur = null;
  const pushCur = () => {
    if (!cur || !cur.path) return;
    const name = path.basename(cur.path);
    let branch = cur.branch || "";
    if (branch.startsWith("refs/heads/")) branch = branch.slice("refs/heads/".length);
    worktrees.push({ name, path: cur.path, branch, head: cur.head || "" });
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith("worktree ")) {
      pushCur();
      cur = { path: line.slice("worktree ".length).trim(), branch: "", head: "" };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("branch ")) cur.branch = line.slice("branch ".length).trim();
    else if (line.startsWith("HEAD ")) cur.head = line.slice("HEAD ".length).trim();
  }
  pushCur();
  return { ok: true, worktrees };
}

async function resolveWorktreePath(repoRoot, nameOrPath) {
  const list = await gitWorktreeList(repoRoot);
  if (!list.ok) return list;
  const needle = String(nameOrPath || "").trim();
  if (!needle) return { ok: false, error: "Missing worktree name." };
  if (path.isAbsolute(needle)) {
    const abs = path.resolve(needle);
    const found = list.worktrees.find((wt) => path.resolve(wt.path) === abs);
    if (found) return { ok: true, path: abs, branch: found.branch || "" };
    return { ok: false, error: "Worktree path not found in `git worktree list`." };
  }
  const name = sanitizeWorktreeName(needle);
  if (!name) return { ok: false, error: "Invalid worktree name." };
  const found = list.worktrees.find((wt) => wt.name === name);
  if (!found) return { ok: false, error: `No worktree named \`${name}\` found.` };
  return { ok: true, path: path.resolve(found.path), branch: found.branch || "" };
}

async function gitWorktreeCreate(repoRoot, name, fromRef) {
  const safeName = sanitizeWorktreeName(name);
  if (!safeName) return { ok: false, error: "Invalid worktree name." };
  const parent = path.join(CONFIG.worktreeRootDir, repoSlug(repoRoot));
  const worktreePath = path.join(parent, safeName);
  const branch = `wt/${safeName}`;

  try {
    await fsp.mkdir(parent, { recursive: true });
  } catch (err) {
    return { ok: false, error: `Failed creating worktree parent dir: ${String(err.message || err)}` };
  }
  try {
    const st = await fsp.stat(worktreePath);
    if (st && st.isDirectory()) {
      return { ok: false, error: `Worktree already exists at: ${worktreePath}` };
    }
  } catch {}

  const ref = String(fromRef || "HEAD").trim() || "HEAD";
  const res = await execFileCapture(
    "git",
    ["-C", repoRoot, "worktree", "add", "-b", branch, worktreePath, ref],
    { cwd: repoRoot, timeoutMs: 60000 }
  );
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout || "").trim();
    return { ok: false, error: `git worktree add failed:\n\`\`\`\n${detail.slice(0, 1600)}\n\`\`\`` };
  }
  logRelayEvent("worktree.created", { repoRoot, path: worktreePath, branch });
  return { ok: true, path: path.resolve(worktreePath), branch };
}

async function gitWorktreeRemove(repoRoot, worktreePath, force) {
  const args = ["-C", repoRoot, "worktree", "remove"];
  if (force) args.push("--force");
  args.push(worktreePath);
  const res = await execFileCapture("git", args, { cwd: repoRoot, timeoutMs: 60000 });
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout || "").trim();
    return { ok: false, error: `git worktree remove failed:\n\`\`\`\n${detail.slice(0, 1600)}\n\`\`\`` };
  }
  await execFileCapture("git", ["-C", repoRoot, "worktree", "prune"], { cwd: repoRoot, timeoutMs: 30000 });
  logRelayEvent("worktree.removed", { repoRoot, path: worktreePath, force: Boolean(force) });
  return { ok: true };
}

function gitAutoCommitScopeAllows(scope) {
  const want = String(scope || "").trim().toLowerCase();
  const cfg = String(CONFIG.gitAutoCommitScope || "both").trim().toLowerCase();
  if (!want) return false;
  if (cfg === "both" || cfg === "all" || !cfg) return true;
  if (cfg === "task" || cfg === "tasks") return want === "task";
  if (cfg === "plan" || cfg === "plans") return want === "plan";
  return true;
}

function buildAutoCommitSubject({ id, title }) {
  const prefix = (CONFIG.gitCommitPrefix || "ai:").trim() || "ai:";
  const baseTitle = taskTextPreview(title || "", 64);
  const pieces = [prefix, id, baseTitle].filter(Boolean);
  const raw = pieces.join(" ").replace(/\s+/g, " ").trim();
  if (!raw) return `${prefix} ${id}`.trim();
  if (raw.length <= 72) return raw;
  return raw.slice(0, 71).trim();
}

async function maybeAutoCommitGit({ workdir, scope, id, title, conversationKey }) {
  if (!CONFIG.gitAutoCommitEnabled) return { ok: false, skipped: "disabled" };
  if (!gitAutoCommitScopeAllows(scope)) return { ok: false, skipped: "scope" };

  const repo = await resolveGitRepoRoot(workdir);
  if (!repo.ok) return { ok: false, skipped: "not a git repo" };

  const stRes = await execFileCapture("git", ["-C", repo.root, "status", "--porcelain=v1"], { cwd: repo.root, timeoutMs: 20000 });
  if (stRes.code !== 0) {
    const detail = (stRes.stderr || stRes.stdout || "").trim();
    return { ok: false, error: `git status failed: ${detail.slice(0, 240)}` };
  }
  const status = String(stRes.stdout || "").trim();
  if (!status) return { ok: false, skipped: "clean" };

  const addRes = await execFileCapture("git", ["-C", repo.root, "add", "-A"], { cwd: repo.root, timeoutMs: 30000 });
  if (addRes.code !== 0) {
    const detail = (addRes.stderr || addRes.stdout || "").trim();
    return { ok: false, error: `git add failed: ${detail.slice(0, 240)}` };
  }

  const diffCached = await execFileCapture("git", ["-C", repo.root, "diff", "--cached", "--quiet"], { cwd: repo.root, timeoutMs: 20000 });
  if (diffCached.code === 0) return { ok: false, skipped: "no staged changes" };

  const filesRes = await execFileCapture("git", ["-C", repo.root, "diff", "--cached", "--name-only"], { cwd: repo.root, timeoutMs: 20000 });
  const files = String(filesRes.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 80);
  const body = files.length ? `Changed files:\n${files.map((f) => `- ${f}`).join("\n")}` : "";

  const subject = buildAutoCommitSubject({ id, title });
  const commitArgs = ["-C", repo.root, "commit", "-m", subject];
  if (body) commitArgs.push("-m", body);
  const commitRes = await execFileCapture("git", commitArgs, { cwd: repo.root, timeoutMs: 90000 });
  if (commitRes.code !== 0) {
    const detail = (commitRes.stderr || commitRes.stdout || "").trim();
    return { ok: false, error: `git commit failed:\n${detail.slice(0, 700)}` };
  }

  const shaRes = await execFileCapture("git", ["-C", repo.root, "rev-parse", "HEAD"], { cwd: repo.root, timeoutMs: 15000 });
  const sha = String(shaRes.stdout || "").trim().slice(0, 12);
  logRelayEvent("git.auto_commit", { conversationKey, scope, id, sha, repoRoot: repo.root });
  return { ok: true, sha, repoRoot: repo.root, subject };
}

async function kickTaskRunner(conversationKey, channel, session, meta) {
  const runner = taskRunnerByConversation.get(conversationKey);
  if (!runner || !channel) return;

  ensureTasksShape(session);
  ensureTaskLoopShape(session);

  try {
    while (true) {
      const r = taskRunnerByConversation.get(conversationKey);
      const stopRequested = (r && r.stopRequested) || (session.taskLoop && session.taskLoop.stopRequested);
      if (stopRequested) break;

      const task = findNextPendingTask(session);
      if (!task) break;

      task.status = "running";
      task.startedAt = nowIso();
      task.finishedAt = null;
      task.attempts = (Number(task.attempts || 0) || 0) + 1;
      task.lastError = null;
      ensureTaskLoopShape(session);
      session.taskLoop.currentTaskId = task.id;
      session.updatedAt = nowIso();
      await queueSaveState();
      logRelayEvent("task.started", { conversationKey, taskId: task.id, attempts: task.attempts });
      try {
        const taskLabel = taskDisplayDescription(task, 100) || "(no description)";
        await channel.send(
          `[TASK ${task.id}] started${task.sourceJobId ? ` from \`${task.sourceJobId}\`` : ""}: ${taskLabel}`
        );
      } catch {}

      const wrapper = [
        `[TASK ${task.id}]`,
        task.text,
        "",
        "When finished:",
        "- briefly summarize outcome",
        "- if blocked, write: [[task:blocked]] and explain what you need",
        "- otherwise end with: [[task:done]]",
      ].join("\n");

      const res = await runAgentAndPostToDiscord({
        baseMessage: null,
        channel,
        session,
        conversationKey,
        prompt: wrapper,
        isDm: Boolean(meta && meta.isDm),
        isThread: Boolean(meta && meta.isThread),
        reasonLabel: `task ${task.id}`,
        postFullOutput: CONFIG.tasksPostFullOutput,
      });

      const finishedAt = nowIso();
      ensureTaskLoopShape(session);
      session.taskLoop.currentTaskId = null;
      let shouldBreakAfterTask = false;

      if (res.ok) {
        const parsed = parseTaskMarkers(res.text);
        task.status = parsed.status;
        task.finishedAt = finishedAt;
        task.lastResultPreview = taskTextPreview(parsed.cleaned, 200) || null;
        task.lastError = null;
        logRelayEvent("task.finished", { conversationKey, taskId: task.id, status: task.status });
        if (task.status === "done") {
          try {
            const commit = await maybeAutoCommitGit({
              workdir: session.workdir || CONFIG.defaultWorkdir,
              scope: "task",
              id: task.id,
              title: task.text || "",
              conversationKey,
            });
            if (commit && commit.ok) {
              await channel.send(`Auto-commit: ${commit.sha} (${commit.subject})`);
            }
          } catch (err) {
            logRelayEvent("git.auto_commit.error", {
              conversationKey,
              scope: "task",
              id: task.id,
              error: String(err && err.message ? err.message : err).slice(0, 240),
            });
          }
        }
        if (task.status === "blocked") shouldBreakAfterTask = true;
      } else {
        const stopNow =
          (taskRunnerByConversation.get(conversationKey) || {}).stopRequested ||
          (session.taskLoop && session.taskLoop.stopRequested);
        task.status = stopNow ? "canceled" : "failed";
        task.finishedAt = finishedAt;
        task.lastError = stopNow ? "stop requested" : res.error || "task failed";
        task.lastResultPreview = null;
        logRelayEvent("task.finished", { conversationKey, taskId: task.id, status: task.status });
        if (CONFIG.tasksStopOnError) shouldBreakAfterTask = true;
      }

      session.updatedAt = nowIso();
      await queueSaveState();
      try {
        const taskLabel = taskDisplayDescription(task, 100) || "(no description)";
        if (res.ok) {
          const detail = task.lastResultPreview ? ` | ${taskTextPreview(task.lastResultPreview, 120)}` : "";
          await channel.send(
            `[TASK ${task.id}] ${task.status}${task.sourceJobId ? ` from \`${task.sourceJobId}\`` : ""}: ${taskLabel}${detail}`
          );
        } else {
          const detail = task.lastError ? ` | error: ${taskTextPreview(task.lastError, 120)}` : "";
          await channel.send(
            `[TASK ${task.id}] ${task.status}${task.sourceJobId ? ` from \`${task.sourceJobId}\`` : ""}: ${taskLabel}${detail}`
          );
        }
      } catch {}

      if (CONFIG.handoffAutoAfterEachTask) {
        await runAutoHandoff({
          session,
          conversationKey,
          workdir: session.workdir || CONFIG.defaultWorkdir,
          channel,
          reason: `task ${task.id} (${task.status})`,
        });
      }

      if (shouldBreakAfterTask) break;

      // Yield so stop commands can take effect between tasks.
      await new Promise((r) => setTimeout(r, 0));
    }
  } catch (err) {
    logRelayEvent("task.runner.error", {
      conversationKey,
      error: String(err && err.message ? err.message : err).slice(0, 240),
    });
  } finally {
    ensureTaskLoopShape(session);
    session.taskLoop.running = false;
    session.taskLoop.stopRequested = false;
    session.taskLoop.currentTaskId = null;
    session.updatedAt = nowIso();
    await queueSaveState();
    taskRunnerByConversation.delete(conversationKey);
    const counts = summarizeTaskCounts(session.tasks);
    try {
      if (CONFIG.tasksSummaryAfterRun) {
        await channel.send(
          `Task runner stopped. pending=${counts.pending} done=${counts.done} failed=${counts.failed} blocked=${counts.blocked} canceled=${counts.canceled}`
        );
      }
    } catch {}

    if (CONFIG.handoffAutoAfterTaskRun) {
      await runAutoHandoff({
        session,
        conversationKey,
        workdir: session.workdir || CONFIG.defaultWorkdir,
        channel,
        reason: "task runner stop",
      });
    }
  }
}

async function writeHandoffEntry({ session, conversationKey, workdir, dryRun, doCommit, doPush }) {
  const repo = await resolveGitRepoRoot(workdir);
  const baseDir = repo.ok ? repo.root : workdir;

  const ensured = [];
  for (const rel of CONFIG.handoffFiles) {
    const resolved = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(baseDir, rel);
    ensured.push(resolved);
    try {
      await fsp.mkdir(path.dirname(resolved), { recursive: true });
    } catch {}
    try {
      await fsp.stat(resolved);
    } catch {
      const header = rel.includes("WORKING_MEMORY")
        ? "# Working Memory (append-only)\n"
        : rel.includes("HANDOFF")
          ? "# Handoff Log (append-only)\n"
          : "# Handoff (append-only)\n";
      if (!dryRun) await fsp.writeFile(resolved, header, "utf8");
    }
  }

  let branch = "";
  let status = "";
  let diffStat = "";
  if (repo.ok) {
    const branchRes = await execFileCapture("git", ["-C", repo.root, "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repo.root,
      timeoutMs: 15000,
    });
    branch = String(branchRes.stdout || "").trim();
    const stRes = await execFileCapture("git", ["-C", repo.root, "status", "--porcelain=v1"], { cwd: repo.root, timeoutMs: 20000 });
    status = String(stRes.stdout || "").trim();
    const diffRes = await execFileCapture("git", ["-C", repo.root, "diff", "--stat"], { cwd: repo.root, timeoutMs: 20000 });
    diffStat = String(diffRes.stdout || "").trim();
  }

  ensureTasksShape(session);
  ensureTaskLoopShape(session);
  ensurePlansShape(session);
  const counts = { pending: 0, running: 0, done: 0, failed: 0, blocked: 0, canceled: 0 };
  for (const t of session.tasks || []) {
    if (t && typeof t === "object" && counts[t.status] != null) counts[t.status] += 1;
  }

  const lastPlan = session.plans && session.plans.length ? session.plans[session.plans.length - 1] : null;
  let planTail = "";
  if (lastPlan) {
    try {
      const lastPlanText = await loadPlanText(lastPlan);
      planTail = lastPlanText ? String(lastPlanText).slice(-1200) : "";
    } catch {}
  }

  const prompt = [
    "Write a handoff entry for future agents. Output MUST be Markdown (no code fences).",
    "",
    "Format:",
    "## <timestamp in ISO 8601>",
    "### Objective",
    "- ...",
    "### Changes",
    "- ...",
    "### Evidence",
    "- paths and commands",
    "### Next steps",
    "- ...",
    "",
    `timestamp: ${nowIso()}`,
    `workdir: ${workdir}`,
    repo.ok ? `repo_root: ${repo.root}` : "repo_root: (not a git repo)",
    branch ? `branch: ${branch}` : null,
    status ? `git status --porcelain=v1:\n${status}` : null,
    diffStat ? `git diff --stat:\n${diffStat}` : null,
    "",
    `task_counts: pending=${counts.pending} running=${counts.running} done=${counts.done} failed=${counts.failed} blocked=${counts.blocked} canceled=${counts.canceled}`,
    planTail ? `last_plan_tail:\n${planTail}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const args = buildCodexArgsStateless(workdir, prompt, { sandboxMode: "read-only" });
  const res = await runCodexWithArgs(args, { cwd: workdir, extraEnv: null, onProgress: null, conversationKey, label: "handoff" });

  const entryText = String(res.text || "").trim();
  const entry = entryText ? `\n\n${entryText}\n` : "\n\n## (empty handoff)\n";
  for (const filePath of ensured) {
    if (!dryRun) await fsp.appendFile(filePath, entry, "utf8");
  }

  let commitSummary = "";
  if (doCommit && repo.ok && !dryRun) {
    const addArgs = ["-C", repo.root, "add", ...ensured.map((p) => path.relative(repo.root, p))];
    await execFileCapture("git", addArgs, { cwd: repo.root, timeoutMs: 30000 });
    const diffCached = await execFileCapture("git", ["-C", repo.root, "diff", "--cached", "--quiet"], { cwd: repo.root, timeoutMs: 20000 });
    if (diffCached.code === 0) {
      commitSummary = "no changes to commit";
    } else {
      const msg = CONFIG.handoffGitCommitMessage || "chore: relay handoff";
      const commitRes = await execFileCapture("git", ["-C", repo.root, "commit", "-m", msg], { cwd: repo.root, timeoutMs: 60000 });
      if (commitRes.code === 0) {
        const shaRes = await execFileCapture("git", ["-C", repo.root, "rev-parse", "HEAD"], { cwd: repo.root, timeoutMs: 15000 });
        const sha = String(shaRes.stdout || "").trim().slice(0, 12);
        commitSummary = `committed ${sha}`;
        if (doPush) {
          const branchNameRes = await execFileCapture("git", ["-C", repo.root, "rev-parse", "--abbrev-ref", "HEAD"], {
            cwd: repo.root,
            timeoutMs: 15000,
          });
          const br = String(branchNameRes.stdout || "").trim() || "main";
          const pushRes = await execFileCapture("git", ["-C", repo.root, "push", "origin", br], { cwd: repo.root, timeoutMs: 120000 });
          if (pushRes.code === 0) commitSummary += " + pushed";
          else commitSummary += " (push failed)";
        }
      } else {
        commitSummary = "git commit failed";
      }
    }
  } else if (doCommit && !repo.ok) {
    commitSummary = "commit skipped (not a git repo)";
  }

  return { ok: true, files: ensured, entryText, commitSummary };
}

async function runAutoHandoff({ session, conversationKey, workdir, channel, reason }) {
  try {
    const res = await enqueueConversation(conversationKey, async () =>
      writeHandoffEntry({
        session,
        conversationKey,
        workdir,
        dryRun: false,
        doCommit: CONFIG.handoffGitAutoCommit,
        doPush: CONFIG.handoffGitAutoPush,
      })
    );
    if (res && res.ok && channel) {
      const note = res.commitSummary ? ` (${res.commitSummary})` : "";
      const reasonSuffix = reason ? ` after ${reason}` : "";
      await channel.send(
        `Auto-handoff written${reasonSuffix} to ${res.files.map((p) => `\`${p}\``).join(", ")}${note}`
      );
    }
    return res;
  } catch (err) {
    logRelayEvent("handoff.auto.error", {
      conversationKey,
      reason: reason || null,
      error: String(err && err.message ? err.message : err).slice(0, 240),
    });
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

async function startPlanApplyFlow({ conversationKey, message, session, plan, planText }) {
  const channel = message && message.channel ? message.channel : null;
  if (!channel) return;

  const isDm = !message.guildId;
  const isThread = Boolean(channel && channel.isThread && channel.isThread());
  const workdir = session.workdir || CONFIG.defaultWorkdir;
  const title = (plan && (plan.title || plan.request)) ? String(plan.title || plan.request) : "";

  const prompt = [
    `[PLAN ${plan && plan.id ? plan.id : "unknown"}]`,
    planText,
    "",
    "Execute this plan now.",
    "",
    "Requirements:",
    "- Make minimal diffs.",
    "- Run the plan's verification steps (commands) and report results.",
    "- Update docs/WORKING_MEMORY.md and HANDOFF_LOG.md as append-only artifacts (create them if missing).",
    "",
    "When finished:",
    "- summarize what changed (file list) and what remains",
    "- if blocked, clearly state what you need from the user",
  ].join("\n");

  let res = null;
  try {
    res = await runAgentAndPostToDiscord({
      baseMessage: message,
      channel,
      session,
      conversationKey,
      prompt,
      isDm,
      isThread,
      reasonLabel: `plan ${plan && plan.id ? plan.id : "unknown"} apply`,
      postFullOutput: true,
    });
  } catch (err) {
    logRelayEvent("plan.apply.error", {
      conversationKey,
      planId: plan && plan.id ? plan.id : null,
      error: String(err && err.message ? err.message : err).slice(0, 240),
    });
    return;
  }

  if (res && res.ok) {
    try {
      const commit = await maybeAutoCommitGit({
        workdir,
        scope: "plan",
        id: plan && plan.id ? plan.id : "plan",
        title,
        conversationKey,
      });
      if (commit && commit.ok) {
        await channel.send(`Auto-commit: ${commit.sha} (${commit.subject})`);
      }
    } catch (err) {
      logRelayEvent("git.auto_commit.error", {
        conversationKey,
        scope: "plan",
        id: plan && plan.id ? plan.id : null,
        error: String(err && err.message ? err.message : err).slice(0, 240),
      });
    }

    if (CONFIG.handoffAutoAfterPlanApply) {
      await runAutoHandoff({
        session,
        conversationKey,
        workdir,
        channel,
        reason: `plan ${plan && plan.id ? plan.id : "unknown"} apply`,
      });
    }
  }
}

function parseExpNamedArgs(raw) {
  const tokens = String(raw || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const named = {};
  const positionals = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.startsWith("--")) {
      const body = token.slice(2);
      if (!body) continue;
      const eq = body.indexOf("=");
      let key = body;
      let value = "";
      if (eq >= 0) {
        key = body.slice(0, eq);
        value = body.slice(eq + 1);
      } else {
        const next = tokens[i + 1];
        if (next && !next.startsWith("--") && !next.includes("=")) {
          value = next;
          i += 1;
        } else {
          value = "true";
        }
      }
      const normalizedKey = String(key || "")
        .trim()
        .toLowerCase()
        .replace(/-/g, "_");
      if (normalizedKey) named[normalizedKey] = value;
      continue;
    }
    if (token.includes("=")) {
      const idx = token.indexOf("=");
      const key = token.slice(0, idx);
      const value = token.slice(idx + 1);
      const normalizedKey = String(key || "")
        .trim()
        .toLowerCase()
        .replace(/-/g, "_");
      if (normalizedKey) named[normalizedKey] = value;
      continue;
    }
    positionals.push(token);
  }
  return { named, positionals };
}

function parseExpRunSpec(raw) {
  const tokens = String(raw || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) {
    return { ok: false, error: "Usage: `/exp run <template_id> [key=value ...] [study_id=...]`", spec: null };
  }
  const templateId = String(tokens.shift() || "").trim();
  if (!templateId) {
    return { ok: false, error: "Usage: `/exp run <template_id> [key=value ...] [study_id=...]`", spec: null };
  }

  const params = [];
  let studyId = "";
  let runId = "";
  let runDir = "";
  let watchEverySec = null;
  let watchTailLines = null;

  const parseIntMaybe = (value, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(min, Math.min(max, Math.floor(n)));
  };

  for (const token of tokens) {
    if (!token.includes("=")) {
      return {
        ok: false,
        error: `Invalid token \`${token}\`. Use key=value pairs (example: seed=0 config=cfg.yaml).`,
        spec: null,
      };
    }
    const idx = token.indexOf("=");
    const rawKey = token.slice(0, idx).trim();
    const value = token.slice(idx + 1).trim();
    if (!rawKey || !value) {
      return { ok: false, error: `Invalid assignment \`${token}\``, spec: null };
    }
    const key = rawKey.toLowerCase().replace(/-/g, "_");
    if (key === "study_id") {
      studyId = value;
      continue;
    }
    if (key === "run_id") {
      runId = value;
      continue;
    }
    if (key === "run_dir") {
      runDir = value;
      continue;
    }
    if (key === "watch_every_sec" || key === "every_sec") {
      const parsed = parseIntMaybe(value, 1, 86400);
      if (parsed == null) return { ok: false, error: `Invalid integer for ${rawKey}: ${value}`, spec: null };
      watchEverySec = parsed;
      continue;
    }
    if (key === "watch_tail_lines" || key === "tail_lines") {
      const parsed = parseIntMaybe(value, 1, 500);
      if (parsed == null) return { ok: false, error: `Invalid integer for ${rawKey}: ${value}`, spec: null };
      watchTailLines = parsed;
      continue;
    }
    params.push(`${rawKey}=${value}`);
  }

  return {
    ok: true,
    error: "",
    spec: { templateId, params, studyId, runId, runDir, watchEverySec, watchTailLines },
  };
}

function shellJoin(parts) {
  return (Array.isArray(parts) ? parts : []).map((p) => safeShellArg(String(p))).join(" ");
}

async function ensureExpToolingAvailable(workdir) {
  const required = [
    "scripts/vr_run.sh",
    "tools/exp/render_template.py",
    "tools/exp/validate_metrics.py",
    "tools/exp/append_registry.py",
    "tools/exp/summarize_run.py",
    "tools/exp/best_run.py",
    "tools/exp/report_registry.py",
    "tools/exp/post_run_pipeline.py",
  ];
  const missing = [];
  for (const rel of required) {
    const abs = path.resolve(workdir, rel);
    try {
      await fsp.access(abs);
    } catch {
      missing.push(rel);
    }
  }
  if (missing.length > 0) {
    return { ok: false, missing };
  }
  return { ok: true, missing: [] };
}

async function handleCommand(message, session, command, conversationKey) {
  if (command.name === "help") {
    await message.reply(
      [
        "Commands:",
        `\`/status\` - show current ${AGENT_LABEL} session + workdir`,
        "`/ask <question...>` - bypass queue with a priority question (pauses active run, answers, resumes)",
        "`/inject <instruction...>` - hard preempt queue, stop current run when possible, then launch replacement run",
        `\`/reset\` - reset ${AGENT_LABEL} conversation for this Discord context`,
        "`/workdir <absolute_path>` - set workdir (resets thread)",
        `\`/attach <session_id>\` - attach this Discord context to an existing ${AGENT_LABEL} session (DM-only by default)`,
        "`/upload <path>` - upload an image from this conversation's upload directory",
        "`/context` - show context bootstrap diagnostics for this conversation",
        "`/context reload` - force context re-bootstrap on next message",
        "`/task <subcmd>` - manage per-conversation task queue (add/list/run/stop/clear)",
        "`/worktree <subcmd>` - manage git worktrees (list/new/use/rm/prune)",
        "`/plan <subcmd>` - manage plans (new/list/show/queue/apply)",
        "`/handoff` - write repo handoff/working-memory update (optional git commit/push)",
        "`/research <subcmd>` - research manager (start/status/run/step/pause/stop/note)",
        "`/auto <subcmd>` - per-conversation automation toggles (actions/research on|off)",
        "`/job <subcmd>` - view background jobs (list/logs [id])",
        "`/exp <run|best|report>` - ML automation helpers backed by exp registry",
        "`/go <task...>` - queue and run immediately (long-run requests auto-wrap into job_start/watch callback mode)",
        "`/overnight <start|status|stop>` - one-command research loop control",
      ].join("\n")
    );
    return true;
  }

  if (command.name === "status") {
    ensureResearchShape(session);
    ensureTasksShape(session);
    ensureTaskLoopShape(session);
    ensureJobsShape(session);
    const key = conversationKey || getConversationKey(message);
    const uploadDir = getConversationUploadDir(key);
    const isRunning = queueByConversation.has(key);
    const sessionContextVersion = getSessionContextVersion(session);
    const researchRoot = session.research && session.research.projectRoot ? String(session.research.projectRoot) : "";
    const taskCounts = summarizeTaskCounts(session.tasks);
    const runningJob = findLatestJob(session, { requireRunning: true });
    const runningJobElapsed = runningJob ? formatElapsed(Date.now() - (Date.parse(runningJob.startedAt || "") || Date.now())) : "";
    const runningJobDesc = runningJob ? jobDisplayDescription(runningJob, 80) : "";
    const runningJobVisibility = runningJob ? String(runningJob.visibilityStatus || "ok") : "";
    const runningJobLifecycle = runningJob ? String(runningJob.lifecycleState || "") : "";
    const pausedRun = pausedChildStateByConversation.get(key);
    const pausedLabel =
      pausedRun && typeof pausedRun === "object"
        ? `paused (pid ${Number(pausedRun.rootPid) || "n/a"}, since ${pausedRun.pausedAt || "unknown"})`
        : "none";
    await message.reply(
      [
        `${AGENT_SESSION_LABEL}: ${session.threadId || "none"}`,
        `workdir: ${session.workdir || CONFIG.defaultWorkdir}`,
        `upload_dir: ${uploadDir}`,
        `context_bootstrap: enabled=${CONFIG.contextEnabled} every_turn=${CONFIG.contextEveryTurn} target_version=${CONFIG.contextVersion} session_version=${sessionContextVersion}`,
        `research: enabled=${Boolean(session.research && session.research.enabled)} auto=${Boolean(session.auto && session.auto.research)} project=${researchRoot || "none"}`,
        `tasks: pending=${taskCounts.pending} running=${taskCounts.running} done=${taskCounts.done} failed=${taskCounts.failed} blocked=${taskCounts.blocked} canceled=${taskCounts.canceled}`,
        runningJob
          ? `job: running \`${runningJob.id}\` elapsed=${runningJobElapsed}${runningJobDesc ? ` desc=${runningJobDesc}` : ""}${runningJobVisibility ? ` visibility=${runningJobVisibility}` : ""}${runningJobLifecycle ? ` state=${runningJobLifecycle}` : ""}`
          : "job: none",
        `interrupt_pause: ${pausedLabel}`,
        `queue: ${isRunning ? "busy (request in progress)" : "idle"}`,
      ].join("\n")
    );
    return true;
  }

  if (command.name === "ask") {
    return handlePriorityQuestionCommand({
      message,
      session,
      conversationKey,
      question: command.arg,
    });
  }

  if (command.name === "inject") {
    return handleInjectCommand({
      message,
      session,
      conversationKey,
      instruction: command.arg,
    });
  }

  if (command.name === "context") {
    const sub = command.arg.toLowerCase();
    if (sub === "reload") {
      session.contextVersion = 0;
      session.updatedAt = new Date().toISOString();
      await queueSaveState();
      await message.reply("Context reload queued. Next message will re-inject context.");
      return true;
    }
    if (sub) {
      await message.reply("Usage: `/context` or `/context reload`");
      return true;
    }

    const artifacts = await buildRelayContextArtifacts(session);
    const specList = CONFIG.contextSpecs.map((spec) => spec.rawSpec).join("; ");
    const lines = [
      `context_bootstrap: enabled=${CONFIG.contextEnabled} every_turn=${CONFIG.contextEveryTurn} target_version=${CONFIG.contextVersion} session_version=${getSessionContextVersion(session)}`,
      `context_limits: total=${CONFIG.contextMaxChars} per_file=${CONFIG.contextMaxCharsPerFile}`,
      `workdir: ${session.workdir || CONFIG.defaultWorkdir}`,
      `configured_specs: ${specList || "(none)"}`,
      `injection_preview: chars=${artifacts.injectedChars} files=${artifacts.includedFiles}`,
    ];
    if (artifacts.diagnostics.length === 0) {
      lines.push("- no context file specs configured");
    } else {
      for (const diag of artifacts.diagnostics) {
        lines.push(summarizeContextDiagnostic(diag));
      }
    }
    await sendLongReply(message, lines.join("\n"));
    return true;
  }

  if (command.name === "auto") {
    ensureAutoShape(session);
    const { head: subRaw, rest } = splitFirstToken(command.arg);
    const sub = subRaw.toLowerCase();
    if (!sub) {
      const lines = [];
      lines.push("Usage:");
      lines.push("- `/auto actions on|off`");
      lines.push("- `/auto research on|off`");
      lines.push("");
      lines.push(
        `agent_actions: enabled=${CONFIG.agentActionsEnabled} dm_only=${CONFIG.agentActionsDmOnly} allowed=${Array.from(
          CONFIG.agentActionsAllowed || []
        )
          .sort()
          .join(",") || "(none)"} max_per_message=${CONFIG.agentActionsMaxPerMessage}`
      );
      lines.push(
        `research_actions: enabled=${CONFIG.researchEnabled} dm_only=${CONFIG.researchDmOnly} allowed=${Array.from(
          CONFIG.researchActionsAllowed || []
        )
          .sort()
          .join(",") || "(none)"} max_per_step=${CONFIG.researchMaxActionsPerStep}`
      );
      lines.push(`conversation_actions: ${session.auto && session.auto.actions ? "on" : "off"}`);
      lines.push(`conversation_research: ${session.auto && session.auto.research ? "on" : "off"}`);
      await sendLongReply(message, lines.join("\n"));
      return true;
    }
    if (sub !== "actions" && sub !== "research") {
      await message.reply("Usage: `/auto actions on|off` or `/auto research on|off`");
      return true;
    }
    const mode = String(rest || "").trim().toLowerCase();
    if (mode !== "on" && mode !== "off") {
      await message.reply("Usage: `/auto actions on|off` or `/auto research on|off`");
      return true;
    }
    if (sub === "actions") {
      session.auto.actions = mode === "on";
    } else {
      session.auto.research = mode === "on";
    }
    session.updatedAt = nowIso();
    await queueSaveState();
    if (sub === "actions") {
      await message.reply(
        `Conversation agent actions are now ${session.auto.actions ? "ON" : "OFF"}.` +
          (CONFIG.agentActionsEnabled ? "" : " (Note: RELAY_AGENT_ACTIONS_ENABLED=false globally.)")
      );
    } else {
      await message.reply(
        `Conversation research automation is now ${session.auto.research ? "ON" : "OFF"}.` +
          (CONFIG.researchEnabled ? "" : " (Note: RELAY_RESEARCH_ENABLED=false globally.)")
      );
    }
    return true;
  }

  if (command.name === "go") {
    if (!CONFIG.tasksEnabled) {
      await message.reply("Tasks are disabled on this relay (RELAY_TASKS_ENABLED=false).");
      return true;
    }
    if (!session.workdir) {
      await message.reply("No workdir is set for this conversation. Use `/workdir /absolute/path` first.");
      return true;
    }
    if (isTaskRunnerActive(conversationKey, session)) {
      await message.reply("Refusing while task runner is active. Run `/task stop` first.");
      return true;
    }
    ensureTasksShape(session);
    ensureTaskLoopShape(session);

    const taskText = String(command.arg || "").trim();
    if (!taskText) {
      await message.reply("Usage: `/go <task...>`");
      return true;
    }

    const autoWrapLongTask = shouldAutoWrapGoLongTask(taskText);
    const pending = (session.tasks || []).filter((t) => t && t.status === "pending").length;
    const requiredSlots = autoWrapLongTask ? 1 : 2;
    if (CONFIG.tasksMaxPending > 0 && pending + requiredSlots > CONFIG.tasksMaxPending) {
      await message.reply(
        `Task queue does not have room for /go (pending=${pending}, needs=${requiredSlots}, max=${CONFIG.tasksMaxPending}).`
      );
      return true;
    }

    const primaryTask = createTask(
      session,
      autoWrapLongTask ? buildGoLongTaskCallbackTaskText(taskText) : taskText,
      {
        description: autoWrapLongTask ? `Launch/watch long run: ${taskText}` : taskText,
      }
    );
    let handoffTask = null;
    session.tasks.push(primaryTask);
    if (!autoWrapLongTask) {
      handoffTask = createTask(session, buildGoHandoffTaskText());
      session.tasks.push(handoffTask);
    }
    session.updatedAt = nowIso();
    await queueSaveState();

    const runRes = await maybeStartTaskRunner(conversationKey, message.channel, session, {
      isDm: !message.guildId,
      isThread: Boolean(message.channel && message.channel.isThread && message.channel.isThread()),
    });

    await sendLongReply(
      message,
      [
        handoffTask
          ? `Queued /go tasks: \`${primaryTask.id}\` then \`${handoffTask.id}\`.`
          : `Queued /go task: \`${primaryTask.id}\` (auto long-run callback mode).`,
        autoWrapLongTask
          ? `Long-run auto-wrap enabled (watch everySec=${CONFIG.goLongTaskWatchEverySec}, tailLines=${CONFIG.goLongTaskTailLines}, runTasks=true).`
          : "Standard /go mode (task + handoff update).",
        runRes && runRes.started ? "Task runner started." : "Task runner was already active.",
        "Monitor with `/task list` and `/status`.",
      ].join("\n")
    );
    return true;
  }

  if (command.name === "overnight") {
    ensureAutoShape(session);
    ensureResearchShape(session);
    const isDm = !message.guildId;
    const isThread = Boolean(message.channel && message.channel.isThread && message.channel.isThread());
    const { head: subRaw, rest } = splitFirstToken(command.arg);
    const sub = (subRaw || "status").toLowerCase();

    if (sub === "status") {
      if (!session.research.enabled || !session.research.projectRoot) {
        await message.reply("Overnight mode is not active. Use `/overnight start <goal...>`.");
        return true;
      }
      const projectRoot = path.resolve(session.research.projectRoot);
      const managerState = await loadResearchManagerState(projectRoot);
      await sendLongReply(
        message,
        [
          `project_root: ${projectRoot}`,
          `status: ${managerState.status}`,
          `phase: ${managerState.phase}`,
          `auto_run: ${Boolean(managerState.autoRun)}`,
          `steps: ${Number((managerState.counters && managerState.counters.steps) || 0)}/${Number(
            (managerState.budgets && managerState.budgets.maxSteps) || 0
          )}`,
          `runs: ${Number((managerState.counters && managerState.counters.runs) || 0)}/${Number(
            (managerState.budgets && managerState.budgets.maxRuns) || 0
          )}`,
          `active_job: ${(managerState.active && managerState.active.jobId) || "none"}`,
        ].join("\n")
      );
      return true;
    }

    const gate = shouldAllowResearchControl({
      isDm,
      session,
      requireConversationToggle: false,
    });
    if (!gate.ok) {
      await message.reply(`Overnight command blocked: ${gate.reason}`);
      return true;
    }

    if (sub === "stop") {
      if (!session.research.enabled || !session.research.projectRoot) {
        await message.reply("No active overnight research project.");
        return true;
      }
      const projectRoot = path.resolve(session.research.projectRoot);
      const managerState = await loadResearchManagerState(projectRoot);
      managerState.status = "paused";
      managerState.autoRun = false;
      await appendResearchEvent(projectRoot, { type: "research_overnight_stop", by: "user" });
      await saveResearchManagerState(projectRoot, managerState);
      await message.reply("Overnight loop paused. Resume with `/overnight start <goal...>` or `/research run`.");
      return true;
    }

    if (sub === "start") {
      const goal = String(rest || "").trim();
      if (!goal) {
        await message.reply("Usage: `/overnight start <goal...>`");
        return true;
      }

      if (!session.research.enabled || !session.research.projectRoot) {
        const created = await ensureResearchProjectScaffold({
          conversationKey,
          goal,
          channelId: message.channel && message.channel.id ? String(message.channel.id) : session.lastChannelId,
          guildId: message.guildId ? String(message.guildId) : null,
        });
        session.research.enabled = true;
        session.research.projectRoot = created.root;
        session.research.slug = path.basename(created.root);
        session.research.managerConvKey = managerConversationKeyFor(conversationKey);
        session.research.lastNoteAt = null;
      }

      session.auto.research = true;
      const projectRoot = path.resolve(session.research.projectRoot);
      const managerState = await loadResearchManagerState(projectRoot);
      managerState.status = "running";
      managerState.autoRun = true;
      managerState.budgets = managerState.budgets && typeof managerState.budgets === "object" ? managerState.budgets : {};
      if (!Number.isFinite(Number(managerState.budgets.maxSteps)) || Number(managerState.budgets.maxSteps) <= 0) {
        managerState.budgets.maxSteps = CONFIG.researchDefaultMaxSteps;
      }
      if (
        !Number.isFinite(Number(managerState.budgets.maxWallClockMinutes)) ||
        Number(managerState.budgets.maxWallClockMinutes) <= 0
      ) {
        managerState.budgets.maxWallClockMinutes = CONFIG.researchDefaultMaxWallclockMin;
      }
      if (!Number.isFinite(Number(managerState.budgets.maxRuns)) || Number(managerState.budgets.maxRuns) <= 0) {
        managerState.budgets.maxRuns = CONFIG.researchDefaultMaxRuns;
      }
      if (!managerState.discord || typeof managerState.discord !== "object") managerState.discord = {};
      if (!managerState.discord.channelId && message.channel && message.channel.id) {
        managerState.discord.channelId = String(message.channel.id);
      }
      if (managerState.discord.guildId == null && message.guildId) {
        managerState.discord.guildId = String(message.guildId);
      }
      await appendResearchEvent(projectRoot, { type: "research_overnight_start", by: "user", goal });
      await saveResearchManagerState(projectRoot, managerState);

      session.updatedAt = nowIso();
      await queueSaveState();

      const res = await runResearchManagerStep({
        conversationKey,
        session,
        channel: message.channel,
        isDm,
        isThread,
        trigger: "run",
      });
      const lines = [
        "Overnight mode enabled.",
        `project_root: ${projectRoot}`,
        `budgets: steps=${managerState.budgets.maxSteps}, runs=${managerState.budgets.maxRuns}, wallclock_min=${managerState.budgets.maxWallClockMinutes}`,
        res.message || "",
      ].filter(Boolean);
      if (res.detailLines && res.detailLines.length) {
        lines.push("", "Actions:", ...res.detailLines);
      }
      await sendLongReply(message, lines.join("\n"));
      return true;
    }

    await message.reply("Usage: `/overnight start <goal...>` | `/overnight status` | `/overnight stop`");
    return true;
  }

  if (command.name === "research") {
    ensureAutoShape(session);
    ensureResearchShape(session);
    const isDm = !message.guildId;
    const isThread = Boolean(message.channel && message.channel.isThread && message.channel.isThread());
    const { head: subRaw, rest } = splitFirstToken(command.arg);
    const sub = (subRaw || "status").toLowerCase();

    if (sub === "status") {
      if (!session.research.enabled || !session.research.projectRoot) {
        await sendLongReply(
          message,
          [
            "Research manager: not started for this conversation.",
            "Use: `/research start <goal...>`",
            `global_enabled=${CONFIG.researchEnabled} dm_only=${CONFIG.researchDmOnly} project_root_error=${
              CONFIG.researchProjectsRootError || "none"
            }`,
          ].join("\n")
        );
        return true;
      }
      const projectRoot = path.resolve(session.research.projectRoot);
      const managerState = await loadResearchManagerState(projectRoot);
      const lines = [
        `project_root: ${projectRoot}`,
        `status: ${managerState.status}`,
        `phase: ${managerState.phase}`,
        `auto_run: ${Boolean(managerState.autoRun)}`,
        `steps: ${Number((managerState.counters && managerState.counters.steps) || 0)}/${Number(
          (managerState.budgets && managerState.budgets.maxSteps) || 0
        )}`,
        `runs: ${Number((managerState.counters && managerState.counters.runs) || 0)}/${Number(
          (managerState.budgets && managerState.budgets.maxRuns) || 0
        )}`,
        `active_job: ${(managerState.active && managerState.active.jobId) || "none"}`,
        `active_run: ${(managerState.active && managerState.active.runId) || "none"}`,
        `conversation_auto_research: ${Boolean(session.auto && session.auto.research)}`,
        `last_decision_at: ${managerState.lastDecisionAt || "none"}`,
      ];
      await sendLongReply(message, lines.join("\n"));
      return true;
    }

    const gate = shouldAllowResearchControl({
      isDm,
      session,
      requireConversationToggle: sub === "run" || sub === "step",
    });
    if (!gate.ok) {
      await message.reply(`Research manager blocked: ${gate.reason}`);
      return true;
    }

    if (sub === "start") {
      const goal = String(rest || "").trim();
      if (!goal) {
        await message.reply("Usage: `/research start <goal...>`");
        return true;
      }
      const created = await ensureResearchProjectScaffold({
        conversationKey,
        goal,
        channelId: message.channel && message.channel.id ? String(message.channel.id) : session.lastChannelId,
        guildId: message.guildId ? String(message.guildId) : null,
      });
      session.research.enabled = true;
      session.research.projectRoot = created.root;
      session.research.slug = path.basename(created.root);
      session.research.managerConvKey = managerConversationKeyFor(conversationKey);
      session.research.lastNoteAt = null;
      session.updatedAt = nowIso();
      await queueSaveState();

      await sendLongReply(
        message,
        [
          `Research project created at: \`${created.root}\``,
          "Next steps:",
          "- `/research run` to start managed loop",
          "- `/research step` to run exactly one manager iteration",
          "- `/research note <text...>` to inject feedback",
        ].join("\n")
      );
      return true;
    }

    if (!session.research.enabled || !session.research.projectRoot) {
      await message.reply("No active research project. Use `/research start <goal...>` first.");
      return true;
    }
    const projectRoot = path.resolve(session.research.projectRoot);
    const managerState = await loadResearchManagerState(projectRoot);

    if (sub === "note") {
      const note = String(rest || "").trim();
      if (!note) {
        await message.reply("Usage: `/research note <text...>`");
        return true;
      }
      if (CONFIG.researchRequireNotePrefix && !/^feedback:/i.test(note)) {
        await message.reply("This relay requires notes prefixed with `feedback:` (RELAY_RESEARCH_REQUIRE_NOTE_PREFIX=true).");
        return true;
      }
      await appendResearchEvent(projectRoot, {
        type: "user_feedback",
        text: note,
        author: message.author && message.author.id ? String(message.author.id) : "unknown",
        messageId: message.id ? String(message.id) : null,
      });
      await appendResearchReportDigest(projectRoot, "Feedback", note);
      session.research.lastNoteAt = nowIso();
      session.updatedAt = nowIso();
      await queueSaveState();
      await message.reply("Research note recorded.");
      return true;
    }

    if (sub === "pause") {
      managerState.status = "paused";
      managerState.autoRun = false;
      await appendResearchEvent(projectRoot, { type: "research_paused", by: "user", reason: String(rest || "").trim() || null });
      await saveResearchManagerState(projectRoot, managerState);
      await message.reply("Research loop paused.");
      return true;
    }

    if (sub === "stop") {
      managerState.status = "done";
      managerState.autoRun = false;
      managerState.active = { jobId: null, runId: null };
      await appendResearchEvent(projectRoot, { type: "research_stopped", by: "user", reason: String(rest || "").trim() || null });
      await saveResearchManagerState(projectRoot, managerState);
      session.research.enabled = false;
      session.updatedAt = nowIso();
      await queueSaveState();
      await message.reply("Research loop stopped and marked done for this conversation.");
      return true;
    }

    if (sub === "run") {
      managerState.status = "running";
      managerState.autoRun = true;
      await appendResearchEvent(projectRoot, { type: "research_run_enabled", by: "user" });
      await saveResearchManagerState(projectRoot, managerState);
      const res = await runResearchManagerStep({
        conversationKey,
        session,
        channel: message.channel,
        isDm,
        isThread,
        trigger: "run",
      });
      const lines = [`Research run mode enabled.`, res.message || ""].filter(Boolean);
      if (res.detailLines && res.detailLines.length) {
        lines.push("", "Actions:", ...res.detailLines);
      }
      await sendLongReply(message, lines.join("\n"));
      return true;
    }

    if (sub === "step") {
      const res = await runResearchManagerStep({
        conversationKey,
        session,
        channel: message.channel,
        isDm,
        isThread,
        trigger: "manual",
      });
      const lines = [res.message || (res.ok ? "Research step finished." : "Research step failed.")];
      if (res.researchUpdate) {
        lines.push("", "Research update:", res.researchUpdate);
      }
      if (res.detailLines && res.detailLines.length) {
        lines.push("", "Actions:", ...res.detailLines);
      }
      await sendLongReply(message, lines.join("\n"));
      return true;
    }

    await message.reply("Usage: `/research start|status|run|step|pause|stop|note`");
    return true;
  }

  if (command.name === "plan") {
    if (!CONFIG.plansEnabled) {
      await message.reply("Plans are disabled on this relay (RELAY_PLANS_ENABLED=false).");
      return true;
    }
    ensurePlansShape(session);

    const { head: subRaw, rest } = splitFirstToken(command.arg);
    const sub = subRaw.toLowerCase();

    if (!sub || sub === "list") {
      if (!session.plans.length) {
        await message.reply("No saved plans for this conversation. Use `/plan <request>`.");
        return true;
      }
      const workdir = path.resolve(session.workdir || CONFIG.defaultWorkdir);
      const matching = session.plans.filter(
        (p) => p && typeof p === "object" && typeof p.workdir === "string" && path.resolve(p.workdir) === workdir
      );
      const pool = matching.length ? matching : session.plans;
      const lines = [];
      lines.push(`plans: total=${session.plans.length} showing=${Math.min(10, pool.length)} (max_history=${CONFIG.plansMaxHistory})`);
      lines.push(`workdir: ${workdir}${matching.length ? " (filtered)" : ""}`);
      const show = pool.slice(-10);
      for (const p of show) {
        const title = p && p.title ? taskTextPreview(p.title, 72) : p && p.request ? taskTextPreview(p.request, 72) : "(no title)";
        const wd = p && p.workdir ? path.basename(String(p.workdir)) : "";
        lines.push(`- ${p.id} ${p.createdAt} ${title}${wd ? ` (wd:${wd})` : ""}`);
      }
      if (pool.length > show.length) {
        lines.push(`- ... (${pool.length - show.length} more)`);
      }
      await sendLongReply(message, lines.join("\n"));
      return true;
    }

    if (sub === "show") {
      const id = (rest || "").split(/\s+/)[0] || "last";
      const plan = findPlan(session, id);
      if (!plan) {
        await message.reply("No such plan. Use `/plan list`.");
        return true;
      }
      const text = (await loadPlanText(plan)).trim();
      await sendLongReply(message, [`Plan \`${plan.id}\` (${plan.createdAt})`, plan.path ? `path: \`${plan.path}\`` : null, "", text || "(empty)"].filter(Boolean).join("\n"));
      return true;
    }

    if (sub === "queue") {
      if (!CONFIG.tasksEnabled) {
        await message.reply("Tasks are disabled on this relay (RELAY_TASKS_ENABLED=false).");
        return true;
      }
      const tokens = (rest || "").split(/\s+/).filter(Boolean);
      const id = tokens[0] || "last";
      const autoRun = tokens.includes("--run");

      const plan = findPlan(session, id);
      if (!plan) {
        await message.reply("No such plan. Use `/plan list`.");
        return true;
      }
      if (isTaskRunnerActive(conversationKey, session)) {
        await message.reply("Refusing while task runner is active. Run `/task stop` first.");
        return true;
      }

      ensureTasksShape(session);
      ensureTaskLoopShape(session);

      const planText = (await loadPlanText(plan)).trim();
      if (!planText) {
        await message.reply("Plan text is empty or missing.");
        return true;
      }

      const parsed = parsePlanTaskBreakdownSteps(planText);
      if (!parsed.steps.length) {
        await message.reply(
          "Couldn't find any steps to queue. Ensure the plan includes a '# Task breakdown …' section with '-' bullets or a numbered list."
        );
        return true;
      }

      const existingPendingOrRunning = new Set(
        (session.tasks || [])
          .filter((t) => t && typeof t === "object" && (t.status === "pending" || t.status === "running"))
          .map((t) => String(t.text || "").trim())
          .filter(Boolean)
      );

      let pendingCount = (session.tasks || []).filter((t) => t && typeof t === "object" && t.status === "pending").length;
      let queued = 0;
      let dupSkipped = 0;
      let limitSkipped = 0;

      for (let i = 0; i < parsed.steps.length; i += 1) {
        const step = parsed.steps[i];
        if (!step) continue;
        if (existingPendingOrRunning.has(step)) {
          dupSkipped += 1;
          continue;
        }
        if (CONFIG.tasksMaxPending > 0 && pendingCount >= CONFIG.tasksMaxPending) {
          limitSkipped = parsed.steps.length - i;
          break;
        }
        const task = createTask(session, step);
        session.tasks.push(task);
        existingPendingOrRunning.add(step);
        pendingCount += 1;
        queued += 1;
      }

      session.updatedAt = nowIso();
      await queueSaveState();
      logRelayEvent("plan.queue", {
        conversationKey,
        planId: plan.id,
        stepsFound: parsed.steps.length,
        queued,
        dupSkipped,
        limitSkipped,
        mode: parsed.usedTaskBreakdown ? "task_breakdown" : "fallback_full_plan",
      });

      const modeNote = parsed.usedTaskBreakdown ? "Task breakdown section" : "fallback parse (whole plan)";
      const lines = [
        `Queued ${queued} task(s) from plan \`${plan.id}\` (${modeNote}).`,
        `steps_found=${parsed.steps.length} dup_skipped=${dupSkipped} limit_skipped=${limitSkipped}`,
        "",
        "Next:",
        "- `/task list`",
        autoRun ? null : "- `/task run`",
      ].filter(Boolean);
      await sendLongReply(message, lines.join("\n"));

      if (autoRun && queued > 0) {
        if (taskRunnerByConversation.has(conversationKey)) return true;
        const next = findNextPendingTask(session);
        if (!next) return true;
        session.taskLoop.running = true;
        session.taskLoop.stopRequested = false;
        session.taskLoop.currentTaskId = null;
        session.updatedAt = nowIso();
        await queueSaveState();
        taskRunnerByConversation.set(conversationKey, { running: true, stopRequested: false });
        await message.channel.send("Task runner started.");
        void kickTaskRunner(conversationKey, message.channel, session, {
          isDm: !message.guildId,
          isThread: Boolean(message.channel && message.channel.isThread && message.channel.isThread()),
        });
      }
      return true;
    }

    if (sub === "apply") {
      const tokens = (rest || "").split(/\s+/).filter(Boolean);
      const id = tokens[0] || "last";
      const confirm = tokens.includes("--confirm");
      const plan = findPlan(session, id);
      if (!plan) {
        await message.reply("No such plan. Use `/plan list`.");
        return true;
      }
      if (isTaskRunnerActive(conversationKey, session)) {
        await message.reply("Refusing while task runner is active. Run `/task stop` first.");
        return true;
      }
      if (message.guildId && CONFIG.planApplyRequireConfirmInGuilds && !confirm) {
        await message.reply(`Refusing to apply plan in a guild channel without \`--confirm\`. Re-run: \`/plan apply ${plan.id} --confirm\``);
        return true;
      }
      const text = (await loadPlanText(plan)).trim();
      if (!text) {
        await message.reply("Plan text is empty or missing.");
        return true;
      }

      void startPlanApplyFlow({
        conversationKey,
        message,
        session,
        plan,
        planText: text,
      });
      return true;
    }

    // Treat anything else as "new plan" for ergonomics: `/plan <request...>`
    const requestText = sub === "new" ? rest : command.arg;
    if (!requestText) {
      await message.reply("Usage: `/plan <request...>` or `/plan new <request...>`");
      return true;
    }
    const workdir = session.workdir || CONFIG.defaultWorkdir;

      let repoRoot = "";
      let branch = "";
      let status = "";
      let diffStat = "";
      const repo = await resolveGitRepoRoot(workdir);
      if (repo.ok) {
        repoRoot = repo.root;
        const branchRes = await execFileCapture("git", ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: repoRoot,
          timeoutMs: 15000,
        });
        branch = String(branchRes.stdout || "").trim();
        const stRes = await execFileCapture("git", ["-C", repoRoot, "status", "--porcelain=v1"], {
          cwd: repoRoot,
          timeoutMs: 20000,
        });
        status = String(stRes.stdout || "").trim();
        const diffRes = await execFileCapture("git", ["-C", repoRoot, "diff", "--stat"], {
          cwd: repoRoot,
          timeoutMs: 20000,
        });
        diffStat = String(diffRes.stdout || "").trim();
      }

      const prompt = [
        "You are in PLAN MODE.",
        "Do not edit files. Do not run commands that modify the repo.",
        "",
        "Return a Markdown plan with these sections (use these exact headings):",
        "# Goal",
        "# Assumptions",
        "# Proposed changes (file-by-file)",
        "# Risks & mitigations",
        "# Verification steps (commands)",
        "# Rollback plan",
        "# Task breakdown (5–20 atomic tasks)",
        "",
        "Notes:",
        "- Keep tasks small, concrete, and ordered.",
        "- If you need clarification, add a final 'Questions:' section with '-' bullets.",
        "- In 'Task breakdown', include items that can be executed sequentially by an agent.",
        "",
        `Workdir: ${workdir}`,
        repoRoot ? `Repo root: ${repoRoot}` : "Repo root: (not a git repo)",
        branch ? `Branch: ${branch}` : null,
        status ? `git status --porcelain=v1:\n${status}` : null,
        diffStat ? `git diff --stat:\n${diffStat}` : null,
        "",
        `User request: ${requestText}`,
      ]
        .filter(Boolean)
        .join("\n");

      // Send a live progress message that updates with elapsed time while the plan generates.
      const planProgressMsg = await message.reply("Generating plan... (elapsed 0s)");
      const planStartedAt = Date.now();
      const planProgressTick = setInterval(async () => {
        const elapsed = formatElapsed(Date.now() - planStartedAt);
        try { await planProgressMsg.edit(`Generating plan... (elapsed ${elapsed})`); } catch (_) { /* ignore */ }
      }, 5000);

      const args = buildCodexArgsStateless(workdir, prompt, { sandboxMode: "read-only" });
      let res;
      try {
        res = await runCodexWithArgs(args, {
          cwd: workdir,
          extraEnv: null,
          onProgress: null,
          conversationKey,
          label: "plan",
        });
      } finally {
        clearInterval(planProgressTick);
        try { await planProgressMsg.delete(); } catch (_) { /* ignore if already gone */ }
      }

      const planText = String(res.text || "").trim();
      const plan = await createAndSavePlan(session, conversationKey, workdir, requestText, planText);
      ensurePlansShape(session);
      session.updatedAt = nowIso();
      await queueSaveState();

      await sendLongReply(
        message,
        [
          `Plan saved: \`${plan.id}\` (generated with codex sandbox=read-only)`,
          plan.path ? `Saved at: \`${plan.path}\`` : null,
          `Apply: \`/plan apply ${plan.id}${message.guildId && CONFIG.planApplyRequireConfirmInGuilds ? " --confirm" : ""}\``,
          "",
          planText || "(empty plan)",
        ].join("\n")
      );
      return true;
  }

  if (command.name === "handoff") {
    if (!CONFIG.handoffEnabled) {
      await message.reply("Handoff is disabled on this relay (RELAY_HANDOFF_ENABLED=false).");
      return true;
    }

    const tokens = (command.arg || "").split(/\s+/).filter(Boolean);
    const dryRun = tokens.includes("--dry-run");
    const commitFlag = tokens.includes("--commit");
    const noCommitFlag = tokens.includes("--no-commit");
    const pushFlag = tokens.includes("--push");
    const noPushFlag = tokens.includes("--no-push");
    if (tokens.includes("-h") || tokens.includes("--help")) {
      await sendLongReply(
        message,
        [
          "Usage: `/handoff [--dry-run] [--commit|--no-commit] [--push|--no-push]`",
          "",
          "Writes a repo-local handoff entry to files from RELAY_HANDOFF_FILES (default: HANDOFF_LOG.md;docs/WORKING_MEMORY.md).",
          "Generation uses `codex exec --sandbox read-only` and the relay appends the result to files.",
        ].join("\n")
      );
      return true;
    }

    const doCommit = noCommitFlag ? false : commitFlag ? true : CONFIG.handoffGitAutoCommit;
    const doPush = noPushFlag ? false : pushFlag ? true : CONFIG.handoffGitAutoPush;

    if (isTaskRunnerActive(conversationKey, session)) {
      await message.reply("Refusing while task runner is active. Run `/task stop` first.");
      return true;
    }

    const workdir = session.workdir || CONFIG.defaultWorkdir;
    const res = await writeHandoffEntry({ session, conversationKey, workdir, dryRun, doCommit, doPush });
    if (!res || !res.ok) {
      await message.reply("Handoff failed.");
      return true;
    }
    const commitNote = res.commitSummary ? ` (${res.commitSummary})` : "";
    if (dryRun) {
      await sendLongReply(
        message,
        [
          `[dry-run] Handoff entry (not written) would append to ${res.files.map((p) => `\`${p}\``).join(", ")}${commitNote}`,
          "",
          (res.entryText || "").trim() || "(empty handoff)",
        ].join("\n")
      );
    } else {
      await message.reply(
        `Handoff written to ${res.files.map((p) => `\`${p}\``).join(", ")}${commitNote}`
      );
    }
    return true;
  }

  if (command.name === "task") {
    if (!CONFIG.tasksEnabled) {
      await message.reply("Tasks are disabled on this relay (RELAY_TASKS_ENABLED=false).");
      return true;
    }
    ensureTasksShape(session);
    ensureTaskLoopShape(session);

    const { head: subRaw, rest } = splitFirstToken(command.arg);
    const sub = subRaw.toLowerCase();

    if (sub === "add") {
      if (!rest) {
        await message.reply("Usage: `/task add <text...>`");
        return true;
      }
      const pending = session.tasks.filter((t) => t && t.status === "pending").length;
      if (CONFIG.tasksMaxPending > 0 && pending >= CONFIG.tasksMaxPending) {
        await message.reply(`Task queue is full (pending=${pending}, max=${CONFIG.tasksMaxPending}).`);
        return true;
      }
      const task = createTask(session, rest);
      session.tasks.push(task);
      session.updatedAt = nowIso();
      await queueSaveState();
      logRelayEvent("task.added", { conversationKey: conversationKey || null, taskId: task.id });
      await message.reply(`Queued task \`${task.id}\`: ${taskDisplayDescription(task, 80) || taskTextPreview(task.text, 80)}`);
      return true;
    }

    if (sub === "list" || !sub) {
      const lines = [];
      lines.push(
        `task_loop: running=${Boolean(session.taskLoop && session.taskLoop.running)} stop_requested=${Boolean(
          session.taskLoop && session.taskLoop.stopRequested
        )} current=${(session.taskLoop && session.taskLoop.currentTaskId) || "none"}`
      );
      if (!session.tasks.length) {
        lines.push("- (no tasks)");
        await sendLongReply(message, lines.join("\n"));
        return true;
      }
      const maxLines = 28;
      const show = session.tasks.slice(0, maxLines);
      for (const t of show) {
        const label = taskDisplayDescription(t, 80) || "(no description)";
        const promptPreview = taskTextPreview(t.text, 80);
        const promptSuffix = promptPreview && label !== promptPreview ? ` | prompt: ${promptPreview}` : "";
        const originSuffix = t.sourceJobId ? ` | source: ${t.sourceJobId}` : "";
        lines.push(`- ${t.id} [${t.status}] ${label}${originSuffix}${promptSuffix}`);
      }
      if (session.tasks.length > show.length) {
        lines.push(`- ... (${session.tasks.length - show.length} more)`);
      }
      await sendLongReply(message, lines.join("\n"));
      return true;
    }

    if (sub === "run") {
      if (taskRunnerByConversation.has(conversationKey)) {
        await message.reply("Task runner is already running for this conversation.");
        return true;
      }
      const next = findNextPendingTask(session);
      if (!next) {
        await message.reply("No pending tasks.");
        return true;
      }
      session.taskLoop.running = true;
      session.taskLoop.stopRequested = false;
      session.taskLoop.currentTaskId = null;
      session.updatedAt = nowIso();
      await queueSaveState();

      taskRunnerByConversation.set(conversationKey, { running: true, stopRequested: false });
      await message.reply("Task runner started.");
      void kickTaskRunner(conversationKey, message.channel, session, {
        isDm: !message.guildId,
        isThread: Boolean(message.channel && message.channel.isThread && message.channel.isThread()),
      });
      return true;
    }

    if (sub === "stop") {
      requestStopConversation(conversationKey, session);
      await message.reply("Stop requested.");
      return true;
    }

    if (sub === "clear") {
      const mode = (rest || "done").toLowerCase();
      if (mode !== "done" && mode !== "all") {
        await message.reply("Usage: `/task clear [done|all]`");
        return true;
      }
      const before = session.tasks.length;
      if (mode === "all") {
        session.tasks = [];
      } else {
        session.tasks = session.tasks.filter((t) => !(t && typeof t === "object" && t.status === "done"));
      }
      session.updatedAt = nowIso();
      await queueSaveState();
      await message.reply(`Cleared ${before - session.tasks.length} task(s).`);
      return true;
    }

    await message.reply("Usage: `/task add|list|run|stop|clear`");
    return true;
  }

  if (command.name === "job") {
    ensureJobsShape(session);
    const { head: subRaw, rest } = splitFirstToken(command.arg);
    const sub = subRaw.toLowerCase();

    if (!sub || sub === "list") {
      const jobs = Array.isArray(session.jobs) ? session.jobs : [];
      if (!jobs.length) {
        await message.reply("job: no jobs recorded.");
        return true;
      }
      const lines = [];
      const now = Date.now();
      const show = jobs.slice(-20); // most recent 20
      for (const j of show) {
        const elapsed =
          j.status === "running"
            ? ` elapsed=${formatElapsed(now - (Date.parse(j.startedAt || "") || now))}`
            : j.finishedAt
            ? ` elapsed=${formatElapsed((Date.parse(j.finishedAt) || now) - (Date.parse(j.startedAt || "") || now))}`
            : "";
        const exitStr = j.exitCode != null ? ` exit=${j.exitCode}` : "";
        const lifecycleStr = j.lifecycleState ? ` state=${j.lifecycleState}` : "";
        const visibilityStr = j.visibilityStatus ? ` visibility=${j.visibilityStatus}` : "";
        const desc = jobDisplayDescription(j, 60);
        lines.push(`- ${j.id} [${j.status}]${elapsed}${exitStr}${lifecycleStr}${visibilityStr}${desc ? ` | ${desc}` : ""}`);
      }
      if (jobs.length > show.length) {
        lines.unshift(`(showing last ${show.length} of ${jobs.length} jobs)`);
      }
      await sendLongReply(message, lines.join("\n"));
      return true;
    }

    if (sub === "logs") {
      const jobId = String(rest || "").trim();
      const jobs = Array.isArray(session.jobs) ? session.jobs : [];
      const job = jobId
        ? jobs.find((j) => j && j.id === jobId)
        : jobs.slice().reverse().find((j) => j && typeof j === "object");
      if (!job) {
        await message.reply(jobId ? `job: no job found with id \`${jobId}\`.` : "job: no jobs recorded.");
        return true;
      }
      const logPath = job.logPath;
      if (!logPath) {
        await message.reply(`job \`${job.id}\`: no log path recorded.`);
        return true;
      }
      const tail = await readTailLines(logPath, 60, 128 * 1024);
      if (!tail) {
        await message.reply(`job \`${job.id}\`: log is empty or not yet written (${logPath}).`);
        return true;
      }
      await sendLongReply(message, `job \`${job.id}\` [${job.status}] log (last 60 lines):\n${tail}`);
      return true;
    }

    await message.reply("Usage: `/job list` | `/job logs [<id>]`");
    return true;
  }

  if (command.name === "exp") {
    if (!CONFIG.expCommandsEnabled) {
      await message.reply("Exp commands are disabled on this relay (RELAY_EXP_COMMANDS_ENABLED=false).");
      return true;
    }
    if (message.guildId && !CONFIG.expAllowGuilds) {
      await message.reply("Exp commands are disabled in guild channels on this relay. Set RELAY_EXP_ALLOW_GUILDS=true to enable.");
      return true;
    }

    const workdir = path.resolve(session.workdir || CONFIG.defaultWorkdir);
    const { head: subRaw, rest } = splitFirstToken(command.arg);
    const sub = (subRaw || "").toLowerCase();

    if (!sub) {
      await sendLongReply(
        message,
        [
          "Usage:",
          "- `/exp run <template_id> [key=value ...] [study_id=S001]`",
          "- `/exp best [metric=loss] [higher=false] [registry=exp/registry.jsonl]`",
          "- `/exp report [last=30] [out=reports/exp_report.md] [registry=exp/registry.jsonl]`",
          "",
          `workdir: ${workdir}`,
          `enabled: ${CONFIG.expCommandsEnabled} guilds_allowed: ${CONFIG.expAllowGuilds}`,
          `defaults: ready_timeout=${CONFIG.expDefaultReadyTimeoutSec}s ready_poll=${CONFIG.expDefaultReadyPollSec}s`,
          `experience_logging: ${CONFIG.expExperienceLoggingEnabled}`,
          `watch_snapshots: ${CONFIG.expWatchSnapshotsEnabled} every_sec=${CONFIG.expWatchSnapshotEverySec} tail_lines=${CONFIG.expWatchSnapshotTailLines}`,
        ].join("\n")
      );
      return true;
    }

    const tooling = await ensureExpToolingAvailable(workdir);
    if (!tooling.ok) {
      await sendLongReply(
        message,
        [
          "Missing required exp tooling in current workdir.",
          `workdir: ${workdir}`,
          ...tooling.missing.map((item) => `- ${item}`),
          "Use `/workdir <repo_root>` that contains tools/exp and scripts/vr_run.sh.",
        ].join("\n")
      );
      return true;
    }

    if (sub === "run") {
      const parsed = parseExpRunSpec(rest);
      if (!parsed.ok || !parsed.spec) {
        await message.reply(parsed.error || "Usage: `/exp run <template_id> [key=value ...]`");
        return true;
      }
      const spec = parsed.spec;

      const existing = findLatestJob(session, { requireRunning: true });
      if (existing) {
        await message.reply(`Refusing /exp run while job \`${existing.id}\` is still running.`);
        return true;
      }

      const renderArgs = ["tools/exp/render_template.py", "--template-id", spec.templateId, "--compact"];
      for (const kv of spec.params) {
        renderArgs.push("--set", kv);
      }
      if (spec.runId) renderArgs.push("--run-id", spec.runId);
      if (spec.runDir) renderArgs.push("--run-dir", spec.runDir);

      const renderRes = await execFileCapture("python3", renderArgs, { cwd: workdir, timeoutMs: 45_000 });
      if (renderRes.code !== 0) {
        await sendLongReply(
          message,
          [
            "Template render failed.",
            `command: python3 ${renderArgs.join(" ")}`,
            "stderr:",
            "```",
            String(renderRes.stderr || renderRes.stdout || "").slice(0, 1500),
            "```",
          ].join("\n")
        );
        return true;
      }

      let rendered = null;
      try {
        rendered = JSON.parse(String(renderRes.stdout || "").trim());
      } catch (err) {
        await sendLongReply(
          message,
          [
            "Template render returned non-JSON output.",
            "stdout:",
            "```",
            String(renderRes.stdout || "").slice(0, 1500),
            "```",
            "stderr:",
            "```",
            String(renderRes.stderr || "").slice(0, 1200),
            "```",
            `parse_error: ${String(err && err.message ? err.message : err)}`,
          ].join("\n")
        );
        return true;
      }

      const commandParts = Array.isArray(rendered && rendered.command) ? rendered.command : null;
      if (!commandParts || commandParts.length === 0) {
        await message.reply("Rendered template is missing a command array.");
        return true;
      }

      const runId = String((rendered && rendered.run_id) || spec.runId || `r${stampCompact()}`).trim();
      const runDir = String((rendered && rendered.run_dir) || spec.runDir || `exp/results/${runId}`).trim();
      if (!runId || !runDir) {
        await message.reply("Rendered template produced empty run_id/run_dir.");
        return true;
      }

      const trainCommand = shellJoin(commandParts);
      const vrCommand = [
        "bash",
        "scripts/vr_run.sh",
        "--run-id",
        runId,
        "--run-dir",
        runDir,
        "--",
        ...commandParts.map((x) => String(x)),
      ];
      const vrCommandText = shellJoin(vrCommand);

      const postArgs = [
        "python3",
        "tools/exp/post_run_pipeline.py",
        "--run-dir",
        runDir,
        "--registry",
        "exp/registry.jsonl",
        "--experience",
        "exp/experience.jsonl",
        "--handoff",
        "HANDOFF_LOG.md",
        "--working-memory",
        "docs/WORKING_MEMORY.md",
        "--rolling-report",
        "reports/rolling_report.md",
        "--template-id",
        String((rendered && rendered.template_id) || spec.templateId || ""),
      ];
      if (spec.studyId) {
        postArgs.push("--study-id", spec.studyId);
      }
      if (!CONFIG.expExperienceLoggingEnabled) {
        postArgs.push("--skip-experience");
      }
      const postCommandText = shellJoin(postArgs);

      const pipelineCommand = [
        `export RELAY_EXP_WATCH_SNAPSHOTS_ENABLED=${CONFIG.expWatchSnapshotsEnabled ? "true" : "false"}`,
        `export RELAY_EXP_WATCH_SNAPSHOT_EVERY_SEC=${Math.max(30, CONFIG.expWatchSnapshotEverySec)}`,
        `export RELAY_EXP_WATCH_SNAPSHOT_TAIL_LINES=${Math.max(10, CONFIG.expWatchSnapshotTailLines)}`,
        vrCommandText,
        "VR_EXIT=$?",
        postCommandText,
        "POST_EXIT=$?",
        'if [ "$VR_EXIT" -ne 0 ]; then exit "$VR_EXIT"; fi',
        'exit "$POST_EXIT"',
      ].join("; ");

      const descriptionParts = [
        `exp:${String((rendered && rendered.template_id) || spec.templateId)}`,
        `run=${runId}`,
      ];
      if (spec.studyId) descriptionParts.push(`study=${spec.studyId}`);

      const started = await startJobProcess({
        conversationKey,
        session,
        command: pipelineCommand,
        workdir,
        description: descriptionParts.join(" "),
      });
      if (!started.ok || !started.job) {
        await message.reply(`Failed to start exp run: ${started.error || "unknown error"}`);
        return true;
      }

      const job = started.job;
      const templateWatch = rendered && rendered.watch && typeof rendered.watch === "object" ? rendered.watch : {};
      const defaultRequireFiles = [`${runDir}/metrics.json`, `${runDir}/meta.json`, `${runDir}/train.log`];
      const mergedRequireFiles = Array.isArray(templateWatch.requireFiles) && templateWatch.requireFiles.length > 0
        ? Array.from(new Set([...templateWatch.requireFiles.map((x) => String(x || "").trim()).filter(Boolean), ...defaultRequireFiles]))
        : defaultRequireFiles;

      const watchRaw = {
        ...templateWatch,
        everySec:
          spec.watchEverySec != null
            ? spec.watchEverySec
            : Number.isFinite(Number(templateWatch.everySec))
            ? Number(templateWatch.everySec)
            : CONFIG.jobsAutoWatchEverySec,
        tailLines:
          spec.watchTailLines != null
            ? spec.watchTailLines
            : Number.isFinite(Number(templateWatch.tailLines))
            ? Number(templateWatch.tailLines)
            : CONFIG.jobsAutoWatchTailLines,
        requireFiles: mergedRequireFiles,
        readyTimeoutSec:
          Number.isFinite(Number(templateWatch.readyTimeoutSec))
            ? Number(templateWatch.readyTimeoutSec)
            : CONFIG.expDefaultReadyTimeoutSec,
        readyPollSec:
          Number.isFinite(Number(templateWatch.readyPollSec))
            ? Number(templateWatch.readyPollSec)
            : CONFIG.expDefaultReadyPollSec,
        onMissing: "block",
        long: true,
      };

      const watchCfg = normalizeJobWatchConfig(watchRaw, {
        everySecDefault: CONFIG.jobsAutoWatchEverySec,
        tailLinesDefault: CONFIG.jobsAutoWatchTailLines,
        jobCommand: trainCommand,
        workdir,
      });

      const watchRes = await startJobWatcher({
        conversationKey,
        session,
        job,
        channelId: message.channel && message.channel.id ? String(message.channel.id) : session.lastChannelId,
        watchConfig: watchCfg,
      });
      if (!watchRes || !watchRes.ok) {
        await message.reply("Run started, but watcher failed to start.");
        return true;
      }

      await sendLongReply(
        message,
        [
          `Started experiment job \`${job.id}\`.`,
          `template: \`${String((rendered && rendered.template_id) || spec.templateId)}\``,
          `run_id: \`${runId}\``,
          `run_dir: \`${runDir}\``,
          `study_id: \`${spec.studyId || ""}\``,
          `watch: everySec=${watchCfg.everySec} tailLines=${watchCfg.tailLines}`,
          "Post-run pipeline is chained automatically (validate -> classify -> registry -> report -> experience/reflection).",
          `Best-run query: \`/exp best metric=${String(
            rendered && rendered.primary_metric && rendered.primary_metric.name ? rendered.primary_metric.name : "objective"
          )}\``,
          "Summary report: `/exp report last=30`",
        ].join("\n")
      );
      return true;
    }

    if (sub === "best") {
      const parsed = parseExpNamedArgs(rest);
      const metric = String(parsed.named.metric || parsed.named.primary || parsed.positionals[0] || "").trim();
      const higher = String(parsed.named.higher || parsed.named.higher_is_better || parsed.named.hib || "auto").trim().toLowerCase();
      const registry = String(parsed.named.registry || "exp/registry.jsonl").trim();
      const topRaw = parsed.named.top;
      const top = Number.isFinite(Number(topRaw)) ? Math.max(1, Math.min(20, Math.floor(Number(topRaw)))) : 5;
      const args = ["tools/exp/best_run.py", "--registry", registry, "--higher-is-better", higher, "--top", String(top), "--json"];
      if (metric) args.push("--metric", metric);

      const res = await execFileCapture("python3", args, { cwd: workdir, timeoutMs: 45_000 });
      if (res.code !== 0) {
        await sendLongReply(
          message,
          [
            "Best-run query failed.",
            "stderr:",
            "```",
            String(res.stderr || res.stdout || "").slice(0, 1500),
            "```",
          ].join("\n")
        );
        return true;
      }

      let payload = null;
      try {
        payload = JSON.parse(String(res.stdout || "").trim());
      } catch (err) {
        await sendLongReply(
          message,
          [
            "Best-run query returned invalid JSON.",
            "stdout:",
            "```",
            String(res.stdout || "").slice(0, 1200),
            "```",
            `parse_error: ${String(err && err.message ? err.message : err)}`,
          ].join("\n")
        );
        return true;
      }

      const best = payload && payload.best && typeof payload.best === "object" ? payload.best : {};
      const paths = best && best.paths && typeof best.paths === "object" ? best.paths : {};
      const runDir = String(paths.run_dir || "").trim();
      await sendLongReply(
        message,
        [
          `Best run: \`${String(best.run_id || "")}\``,
          `metric: \`${String(payload.metric || "")}\``,
          `value: \`${String(best.value || "")}\``,
          `higher_is_better: \`${String(payload.higher_is_better || "")}\``,
          `considered: \`${String(payload.considered || "")}\``,
          `run_dir: \`${runDir}\``,
          runDir
            ? `summarize: \`python3 tools/exp/summarize_run.py --run-dir ${runDir} --registry ${String(payload.registry || registry)}\``
            : "summarize: n/a",
        ].join("\n")
      );
      return true;
    }

    if (sub === "report") {
      const parsed = parseExpNamedArgs(rest);
      const registry = String(parsed.named.registry || "exp/registry.jsonl").trim();
      const outPath = String(parsed.named.out || "reports/exp_report.md").trim();
      const lastRaw = parsed.named.last || parsed.positionals[0] || "30";
      const metric = String(parsed.named.metric || "").trim();
      const higher = String(parsed.named.higher || parsed.named.higher_is_better || parsed.named.hib || "auto").trim().toLowerCase();
      const last = Number.isFinite(Number(lastRaw)) ? Math.max(1, Math.min(500, Math.floor(Number(lastRaw)))) : 30;
      const args = [
        "tools/exp/report_registry.py",
        "--registry",
        registry,
        "--out",
        outPath,
        "--last",
        String(last),
        "--higher-is-better",
        higher,
      ];
      if (metric) args.push("--metric", metric);

      const res = await execFileCapture("python3", args, { cwd: workdir, timeoutMs: 45_000 });
      if (res.code !== 0) {
        await sendLongReply(
          message,
          [
            "Report generation failed.",
            "stderr:",
            "```",
            String(res.stderr || res.stdout || "").slice(0, 1500),
            "```",
          ].join("\n")
        );
        return true;
      }

      const outAbs = path.resolve(workdir, outPath);
      let excerpt = "";
      try {
        const raw = await fsp.readFile(outAbs, "utf8");
        excerpt = raw
          .split(/\r?\n/)
          .slice(0, 10)
          .join("\n")
          .trim();
      } catch {}

      await sendLongReply(
        message,
        [
          `Report updated: \`${outAbs}\``,
          excerpt ? "excerpt:\n```md\n" + excerpt + "\n```" : "(report excerpt unavailable)",
        ].join("\n")
      );
      return true;
    }

    await message.reply("Usage: `/exp run ...` | `/exp best ...` | `/exp report ...`");
    return true;
  }

  if (command.name === "worktree") {
    if (CONFIG.worktreeRootDirError) {
      await message.reply(`Worktrees disabled: ${CONFIG.worktreeRootDirError}`);
      return true;
    }
    if (session.taskLoop && session.taskLoop.running) {
      await message.reply("Refusing while task runner is active. Run `/task stop` first.");
      return true;
    }

    const { head: subRaw, rest } = splitFirstToken(command.arg);
    const sub = subRaw.toLowerCase();
    if (!sub || sub === "list") {
      const repo = await resolveGitRepoRoot(session.workdir || CONFIG.defaultWorkdir);
      if (!repo.ok) {
        await message.reply(repo.error);
        return true;
      }
      const listed = await gitWorktreeList(repo.root);
      if (!listed.ok) {
        await message.reply(listed.error);
        return true;
      }
      const lines = [];
      lines.push(`repo_root: ${repo.root}`);
      if (listed.worktrees.length === 0) {
        lines.push("- (no worktrees?)");
      } else {
        for (const wt of listed.worktrees.slice(0, 30)) {
          lines.push(`- ${wt.name} ${wt.branch ? `[${wt.branch}]` : ""} -> ${wt.path}`);
        }
        if (listed.worktrees.length > 30) lines.push(`- ... (${listed.worktrees.length - 30} more)`);
      }
      await sendLongReply(message, lines.join("\n"));
      return true;
    }

    if (sub === "prune") {
      const repo = await resolveGitRepoRoot(session.workdir || CONFIG.defaultWorkdir);
      if (!repo.ok) {
        await message.reply(repo.error);
        return true;
      }
      const res = await execFileCapture("git", ["-C", repo.root, "worktree", "prune"], { cwd: repo.root });
      if (res.code !== 0) {
        await message.reply(`git worktree prune failed:\n\`\`\`\n${(res.stderr || res.stdout || "").slice(0, 1600)}\n\`\`\``);
        return true;
      }
      await message.reply("Pruned worktrees.");
      return true;
    }

    if (sub === "new") {
      const args = (rest || "").split(/\s+/).filter(Boolean);
      const nameRaw = args[0] || "";
      if (!nameRaw) {
        await message.reply("Usage: `/worktree new <name> [--from <ref>] [--use]`");
        return true;
      }
      const parsed = parseWorktreeNewArgs(args.slice(1));
      if (!parsed.ok) {
        await message.reply(parsed.error);
        return true;
      }
      const name = sanitizeWorktreeName(nameRaw);
      if (!name) {
        await message.reply("Invalid worktree name. Allowed: letters, numbers, '.', '_', '-' (no slashes).");
        return true;
      }
      const repo = await resolveGitRepoRoot(session.workdir || CONFIG.defaultWorkdir);
      if (!repo.ok) {
        await message.reply(repo.error);
        return true;
      }

      const wt = await gitWorktreeCreate(repo.root, name, parsed.fromRef);
      if (!wt.ok) {
        await message.reply(wt.error);
        return true;
      }
      if (parsed.use) {
        if (!isAllowedWorkdir(wt.path)) {
          await message.reply(`Created worktree is outside allowed roots: ${wt.path}`);
          return true;
        }
        session.workdir = wt.path;
        session.threadId = null;
        session.contextVersion = 0;
        session.updatedAt = nowIso();
        await queueSaveState();
      }
      await message.reply(
        parsed.use
          ? `Worktree created and selected: \`${wt.path}\` (branch \`${wt.branch}\`)`
          : `Worktree created: \`${wt.path}\` (branch \`${wt.branch}\`)`
      );
      return true;
    }

    if (sub === "use") {
      const nameRaw = (rest || "").split(/\s+/)[0] || "";
      if (!nameRaw) {
        await message.reply("Usage: `/worktree use <name>`");
        return true;
      }
      const name = sanitizeWorktreeName(nameRaw) || (path.isAbsolute(nameRaw) ? nameRaw : "");
      if (!name) {
        await message.reply("Invalid worktree name/path.");
        return true;
      }
      const repo = await resolveGitRepoRoot(session.workdir || CONFIG.defaultWorkdir);
      if (!repo.ok) {
        await message.reply(repo.error);
        return true;
      }
      const resolved = await resolveWorktreePath(repo.root, nameRaw);
      if (!resolved.ok) {
        await message.reply(resolved.error);
        return true;
      }
      if (!isAllowedWorkdir(resolved.path)) {
        await message.reply(`Workdir not allowed. Allowed roots: ${CONFIG.allowedWorkdirRoots.join(", ")}`);
        return true;
      }
      session.workdir = resolved.path;
      session.threadId = null;
      session.contextVersion = 0;
      session.updatedAt = nowIso();
      await queueSaveState();
      await message.reply(`Workdir set to \`${resolved.path}\`. Session reset.`);
      return true;
    }

    if (sub === "rm") {
      const tokens = (rest || "").split(/\s+/).filter(Boolean);
      const nameRaw = tokens[0] || "";
      const force = tokens.includes("--force");
      if (!nameRaw) {
        await message.reply("Usage: `/worktree rm <name> [--force]`");
        return true;
      }
      const repo = await resolveGitRepoRoot(session.workdir || CONFIG.defaultWorkdir);
      if (!repo.ok) {
        await message.reply(repo.error);
        return true;
      }
      const resolved = await resolveWorktreePath(repo.root, nameRaw);
      if (!resolved.ok) {
        await message.reply(resolved.error);
        return true;
      }
      const listed = await gitWorktreeList(repo.root);
      if (!listed.ok) {
        await message.reply(listed.error);
        return true;
      }
      const sessionWorkdir = session.workdir ? path.resolve(session.workdir) : "";
      const worktreeRoot = path.resolve(resolved.path);
      const containsActiveWorkdir = sessionWorkdir ? isSubPath(worktreeRoot, sessionWorkdir) : false;

      if (!force && containsActiveWorkdir) {
        await message.reply(
          sessionWorkdir && sessionWorkdir !== worktreeRoot
            ? `Refusing to remove a worktree that contains the active workdir: \`${sessionWorkdir}\`. Use \`--force\` if you really want this.`
            : "Refusing to remove the active workdir. Use `--force` if you really want this."
        );
        return true;
      }
      const otherWorktreePath = listed.worktrees
        .map((wt) => path.resolve(wt.path))
        .find((p) => p && p !== worktreeRoot) || "";
      const fallbackWorkdir = otherWorktreePath && isAllowedWorkdir(otherWorktreePath) ? otherWorktreePath : CONFIG.defaultWorkdir;
      const gitCwd = otherWorktreePath || repo.root;

      const removed = await gitWorktreeRemove(gitCwd, resolved.path, force);
      if (!removed.ok) {
        await message.reply(removed.error);
        return true;
      }
      if (containsActiveWorkdir) {
        session.workdir = fallbackWorkdir;
        session.threadId = null;
        session.contextVersion = 0;
        session.updatedAt = nowIso();
        await queueSaveState();
      }
      await message.reply(
        containsActiveWorkdir
          ? `Removed worktree: \`${resolved.path}\` (workdir -> \`${fallbackWorkdir}\`)`
          : `Removed worktree: \`${resolved.path}\``
      );
      return true;
    }

    await message.reply("Usage: `/worktree list|new|use|rm|prune`");
    return true;
  }

  if (command.name === "reset") {
    session.threadId = null;
    session.contextVersion = 0;
    session.updatedAt = new Date().toISOString();
    await queueSaveState();
    await message.reply(`Session reset. Next message starts a new ${AGENT_LABEL} session.`);
    return true;
  }

  if (command.name === "workdir") {
    if (!command.arg) {
      await message.reply("Usage: `/workdir /absolute/path`");
      return true;
    }
    const resolved = path.resolve(command.arg);
    if (!path.isAbsolute(resolved)) {
      await message.reply("Workdir must be an absolute path.");
      return true;
    }
    try {
      const st = await fsp.stat(resolved);
      if (!st.isDirectory()) {
        await message.reply("Workdir is not a directory.");
        return true;
      }
    } catch {
      await message.reply("Workdir does not exist.");
      return true;
    }
    if (!isAllowedWorkdir(resolved)) {
      await message.reply(
        `Workdir not allowed. Allowed roots: ${CONFIG.allowedWorkdirRoots.join(", ")}`
      );
      return true;
    }
    session.workdir = resolved;
    session.threadId = null;
    session.contextVersion = 0;
    session.updatedAt = new Date().toISOString();
    await queueSaveState();
    await message.reply(`Workdir set to \`${resolved}\`. Session reset.`);
    return true;
  }

  if (command.name === "attach") {
    if (!command.arg) {
      await message.reply("Usage: `/attach <session_id>`");
      return true;
    }
    if (message.guildId && !CONFIG.allowAttachInGuilds) {
      await message.reply("For safety, `/attach` is DM-only. DM me with `/attach <session_id>`.");
      return true;
    }
    const id = command.arg.split(/\s+/)[0];
    if (!/^[0-9a-zA-Z_-][0-9a-zA-Z_.:-]{5,127}$/.test(id)) {
      await message.reply(`That doesn't look like a valid ${AGENT_LABEL} session id.`);
      return true;
    }
    session.threadId = id;
    // Force one bootstrap injection after attach so relay capabilities are re-established.
    session.contextVersion = 0;
    session.updatedAt = new Date().toISOString();
    await queueSaveState();
    await message.reply(`Attached. ${AGENT_SESSION_LABEL} is now: \`${id}\``);
    return true;
  }

  if (command.name === "upload") {
    if (!CONFIG.uploadEnabled) {
      await message.reply("Uploads are disabled on this relay.");
      return true;
    }
    if (!command.arg) {
      await message.reply("Usage: `/upload <path>` (relative to this conversation's upload_dir, or absolute within it)");
      return true;
    }
    const key = conversationKey || getConversationKey(message);
    const { conversationDir, files, errors } = await resolveAndValidateUploads(key, [command.arg]);
    if (files.length === 0) {
      const detail = errors.length > 0 ? `\n${errors.map((e) => `- ${e}`).join("\n")}` : "";
      await message.reply(`No valid file to upload.\nupload_dir: \`${conversationDir}\`${detail}`);
      return true;
    }

    const names = files.map((f) => `\`${f.name}\``).join(", ");
    await message.reply({ content: `Uploaded: ${names}`, files });
    if (errors.length > 0) {
      await message.channel.send(`Upload notes:\n${errors.map((e) => `- ${e}`).join("\n")}`);
    }
    return true;
  }

  return false;
}

async function main() {
  await ensureStateLoaded();
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
    ...(DISCORD_REST_AGENT ? { rest: { agent: DISCORD_REST_AGENT } } : {}),
  });
  DISCORD_CLIENT = client;

  client.once("clientReady", () => {
    console.log(`codex-discord-relay (${CONFIG.agentProvider}) connected as ${client.user.tag}`);
    restoreJobWatchers().catch((err) =>
      logRelayEvent("job.watch.restore.error", {
        error: String(err && err.message ? err.message : err).slice(0, 240),
      })
    );
    startResearchTickLoop();
    logRelayEvent("research.tick.started", {
      enabled: CONFIG.researchEnabled,
      tickSec: CONFIG.researchTickSec,
      maxParallel: CONFIG.researchTickMaxParallel,
    });
    notifyInterruptedAgentRuns(client).catch((err) =>
      logRelayEvent("agent.run.interrupted_notice.bootstrap_error", {
        error: String(err && err.message ? err.message : err).slice(0, 240),
      })
    );
  });

  client.on("messageCreate", async (message) => {
    try {
      if (message.author.bot) return;
      const isDm = !message.guildId;
      const isThread = Boolean(message.channel && message.channel.isThread && message.channel.isThread());
      const threadParentId = isThread && message.channel && typeof message.channel.parentId === "string" ? message.channel.parentId : null;

      if (!isDm && CONFIG.allowedGuilds.size > 0 && !CONFIG.allowedGuilds.has(message.guildId)) {
        return;
      }
      // Channel allowlist is intended for guild channels. Threads have their own ids, so
      // allow threads under an allowed parent channel as well.
      if (!isDm && CONFIG.allowedChannels.size > 0) {
        const allowed =
          CONFIG.allowedChannels.has(message.channelId) ||
          (threadParentId && CONFIG.allowedChannels.has(threadParentId));
        if (!allowed) return;
      }

      if (!isDm) {
        const mentioned = message.mentions.has(client.user.id);
        if (!mentioned && !(isThread && CONFIG.threadAutoRespond)) return;
      }

      let prompt = extractPrompt(message, client.user.id);
      const hasIngestibleAttachments = hasIngestibleDiscordAttachments(message);
      if (!prompt && !hasIngestibleAttachments) {
        await message.reply(
          isDm || (isThread && CONFIG.threadAutoRespond)
            ? "Send a prompt, or use `/help`."
            : "Send a prompt after mentioning me, or use `/help`."
        );
        return;
      }
      if (!prompt && hasIngestibleAttachments) {
        prompt = "Please read and follow the attached file(s).";
      }

      // Make sure the bot is joined to threads before trying to type/reply.
      if (!isDm && isThread && message.channel && typeof message.channel.join === "function" && message.channel.joinable) {
        message.channel.join().catch(() => {});
      }

      const key = getConversationKey(message);
      const session = getSession(key);
      // Track last channel so background watchers can post updates after restarts.
      const channelId = message.channel && message.channel.id ? String(message.channel.id) : String(message.channelId || "");
      const guildId = message.guildId ? String(message.guildId) : null;
      if ((channelId && session.lastChannelId !== channelId) || session.lastGuildId !== guildId) {
        session.lastChannelId = channelId || session.lastChannelId || null;
        session.lastGuildId = guildId;
        session.updatedAt = nowIso();
        void queueSaveState();
      }

      const command = parseCommand(prompt);
      if (command) {
        // Step 3 robustness: refuse workdir/session control while task runner is active.
        if (isTaskRunnerActive(key, session)) {
          const { head: researchSubRaw } = command.name === "research" ? splitFirstToken(command.arg) : { head: "" };
          const researchSub = String(researchSubRaw || "").toLowerCase();
          const { head: overnightSubRaw } = command.name === "overnight" ? splitFirstToken(command.arg) : { head: "" };
          const overnightSub = String(overnightSubRaw || "").toLowerCase();
          const isDangerous =
            command.name === "workdir" ||
            command.name === "reset" ||
            command.name === "attach" ||
            command.name === "inject" ||
            command.name === "go" ||
            (command.name === "overnight" && overnightSub !== "status") ||
            (command.name === "research" && researchSub !== "status" && researchSub !== "note") ||
            (command.name === "context" && command.arg.toLowerCase() === "reload");
          if (isDangerous) {
            await message.reply("Refusing while task runner is active. Run `/task stop` first.");
            return;
          }
        }
        // Read-only status/introspection commands bypass the per-conversation queue so they
        // remain responsive while long requests are in progress.
        if (shouldBypassConversationQueue(command)) {
          await handleCommand(message, session, command, key);
          return;
        }
        await enqueueConversation(key, async () => handleCommand(message, session, command, key));
        return;
      }

      if (
        CONFIG.interruptQuestionsEnabled &&
        CONFIG.interruptQuestionsAuto &&
        queueByConversation.has(key) &&
        /[?？]\s*$/.test(String(prompt || "").trim())
      ) {
        await handlePriorityQuestionCommand({
          message,
          session,
          conversationKey: key,
          question: prompt,
        });
        return;
      }

      await runAgentAndPostToDiscord({
        baseMessage: message,
        channel: message.channel,
        session,
        conversationKey: key,
        prompt,
        isDm,
        isThread,
        reasonLabel: "user message",
        postFullOutput: true,
      });
    } catch (err) {
      try {
        await sendLongReply(message, `Relay error: ${String(err.message || err)}`);
      } catch {}
    }
  });

  const shutdown = async () => {
    if (researchTickTimer) {
      try {
        clearInterval(researchTickTimer);
      } catch {}
      researchTickTimer = null;
    }
    try {
      await queueSaveState();
    } catch {}
    try {
      await client.destroy();
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await client.login(CONFIG.token);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
