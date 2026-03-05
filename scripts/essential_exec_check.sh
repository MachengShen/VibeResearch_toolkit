#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
REPORT_DIR="${ESSENTIAL_EXEC_REPORT_DIR:-reports/essential_exec/${TIMESTAMP}}"
SUITE_LOG="${REPORT_DIR}/suite_log.md"
RESULTS_TSV="${REPORT_DIR}/results.tsv"
SUMMARY_JSON="${REPORT_DIR}/summary.json"
TEST_TMP_DIR="${ESSENTIAL_EXEC_TMP_DIR:-/tmp/essential-exec-${TIMESTAMP}}"

mkdir -p "$REPORT_DIR"
: >"$RESULTS_TSV"

required_failures=0
warning_count=0

iso_now() {
  date --iso-8601=seconds
}

sanitize() {
  printf '%s' "$1" | tr '\n\t' '  '
}

append_log() {
  printf '%s\n' "$*" >>"$SUITE_LOG"
}

record_result() {
  local test_id="$1"
  local required="$2"
  local status="$3"
  local message="$4"
  local command="$5"
  local evidence_path="${6:-$SUITE_LOG}"

  local msg_s cmd_s evidence_s
  msg_s="$(sanitize "$message")"
  cmd_s="$(sanitize "$command")"
  evidence_s="$(sanitize "$evidence_path")"

  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$test_id" "$required" "$status" "$msg_s" "$cmd_s" "$evidence_s" >>"$RESULTS_TSV"

  if [[ "$required" == "true" && "$status" == "fail" ]]; then
    required_failures=$((required_failures + 1))
  fi
  if [[ "$status" == "warn" ]]; then
    warning_count=$((warning_count + 1))
  fi

  append_log "- [${status}] ${test_id}: ${msg_s} (evidence: ${evidence_s})"
}

run_check() {
  local test_id="$1"
  local required="$2"
  local description="$3"
  local command="$4"
  local started_at ended_at

  started_at="$(iso_now)"
  append_log ""
  append_log "### ${test_id}: ${description}"
  append_log "- started_at: ${started_at}"
  append_log ""
  append_log '```bash'
  append_log "$command"
  append_log '```'
  append_log '```text'

  local start rc end duration
  start="$(date +%s)"
  set +e
  bash -lc "$command" >>"$SUITE_LOG" 2>&1
  rc=$?
  set -e
  end="$(date +%s)"
  duration=$((end - start))
  ended_at="$(iso_now)"

  append_log '```'
  append_log "- ended_at: ${ended_at}"

  if [[ "$rc" -eq 0 ]]; then
    record_result "$test_id" "$required" "pass" "ok (${duration}s)" "$command"
  else
    record_result "$test_id" "$required" "fail" "exit=${rc} (${duration}s)" "$command"
  fi
}

run_warn_or_fail() {
  local test_id="$1"
  local should_fail="$2"
  local description="$3"
  local command="$4"
  local started_at ended_at

  started_at="$(iso_now)"
  append_log ""
  append_log "### ${test_id}: ${description}"
  append_log "- started_at: ${started_at}"
  append_log ""
  append_log '```bash'
  append_log "$command"
  append_log '```'
  append_log '```text'

  local rc
  set +e
  bash -lc "$command" >>"$SUITE_LOG" 2>&1
  rc=$?
  set -e
  ended_at="$(iso_now)"

  append_log '```'
  append_log "- ended_at: ${ended_at}"

  if [[ "$rc" -eq 0 ]]; then
    record_result "$test_id" "false" "pass" "ok" "$command"
    return
  fi

  if [[ "$should_fail" == "true" ]]; then
    record_result "$test_id" "true" "fail" "exit=${rc}" "$command"
  else
    record_result "$test_id" "false" "warn" "exit=${rc}" "$command"
  fi
}

command -v bash >/dev/null 2>&1 || {
  echo "[essential_exec][fail] bash not found" >&2
  exit 1
}
command -v git >/dev/null 2>&1 || {
  echo "[essential_exec][fail] git not found" >&2
  exit 1
}

HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
BRANCH_NAME="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
STATUS_BEFORE="$(git status --porcelain)"

append_log "# Essential Execution Check"
append_log ""
append_log "- timestamp: $(iso_now)"
append_log "- repo: ${ROOT_DIR}"
append_log "- branch: ${BRANCH_NAME}"
append_log "- head: ${HEAD_SHA}"
append_log "- report_dir: ${REPORT_DIR}"
append_log "- tmp_dir: ${TEST_TMP_DIR}"
append_log ""
append_log "## Results"

REQUIRE_CLEAN="${ESSENTIAL_EXEC_REQUIRE_CLEAN_GIT:-auto}"
if [[ "$REQUIRE_CLEAN" == "auto" ]]; then
  REQUIRE_CLEAN="false"
fi
if [[ "$REQUIRE_CLEAN" == "1" || "$REQUIRE_CLEAN" == "true" ]]; then
  CLEAN_FAILS="true"
else
  CLEAN_FAILS="false"
fi

if [[ -z "$STATUS_BEFORE" ]]; then
  record_result "A1.git.clean.before" "false" "pass" "git status clean before checks" "git status --porcelain"
else
  run_warn_or_fail "A1.git.clean.before" "$CLEAN_FAILS" "git status cleanliness before checks" "git status --porcelain"
fi

run_check "A1.shebang.bash" "true" "no trailing code on bash shebang lines" "if grep -RIn --include='*.sh' '^#!/usr/bin/env bash .\\+' .; then exit 1; fi"
run_check "A1.shebang.node" "true" "no trailing code on node shebang lines" "if grep -RIn --include='*.js' '^#!/usr/bin/env node .\\+' codex-discord-relay; then exit 1; fi"
run_check "A1.shebang.python" "true" "no trailing code on python shebang lines" "if grep -RIn --include='*.py' '^#!/usr/bin/env python3 .\\+' tools; then exit 1; fi"
run_check "A1.lint" "true" "repository lint" "bash scripts/lint_repo.sh"

if [[ -d "codex-discord-relay/node_modules" ]]; then
  run_check "A2.relay.help" "true" "relay parse smoke" "tmp=\"\$(mktemp)\"; set +e; timeout 8s node codex-discord-relay/relay.js --help >\"\$tmp\" 2>&1; rc=\$?; set -e; cat \"\$tmp\"; if grep -Eqi 'Cannot find module|SyntaxError|ReferenceError' \"\$tmp\"; then rm -f \"\$tmp\"; exit 1; fi; rm -f \"\$tmp\"; if [[ \"\$rc\" -ne 0 && \"\$rc\" -ne 1 && \"\$rc\" -ne 124 ]]; then exit \"\$rc\"; fi"
else
  run_check "A2.relay.syntax" "true" "relay syntax check (fallback without node_modules)" "node --check codex-discord-relay/relay.js"
  record_result "A2.relay.help" "false" "warn" "skipped: codex-discord-relay/node_modules not installed" "node codex-discord-relay/relay.js --help"
fi
run_check "A2.vr_run.help" "true" "vr_run help" "bash scripts/vr_run.sh --help"
run_check "A2.validate_metrics.help" "true" "validate_metrics help" "python3 tools/exp/validate_metrics.py --help"
run_check "A2.append_registry.help" "true" "append_registry help" "python3 tools/exp/append_registry.py --help"
run_check "A2.summarize_run.help" "true" "summarize_run help" "python3 tools/exp/summarize_run.py --help"
run_check "A2.render_template.help" "true" "render_template help" "python3 tools/exp/render_template.py --help"
run_check "A2.best_run.help" "true" "best_run help" "python3 tools/exp/best_run.py --help"

SMOKE_RUN_DIR="${TEST_TMP_DIR}/r_smoke"
FAIL_RUN_DIR="${TEST_TMP_DIR}/r_fail"
CANCEL_RUN_DIR="${TEST_TMP_DIR}/r_cancel"
REGISTRY_PATH="${TEST_TMP_DIR}/registry.jsonl"

run_check "A3.success.run" "true" "wrapper success contract" "rm -rf '${SMOKE_RUN_DIR}'; mkdir -p '${SMOKE_RUN_DIR%/*}'; bash scripts/vr_run.sh --run-id r_smoke --run-dir '${SMOKE_RUN_DIR}' -- bash -lc 'echo hello; exit 0'"
run_check "A3.success.files" "true" "success run artifacts exist" "test -f '${SMOKE_RUN_DIR}/meta.json' && test -f '${SMOKE_RUN_DIR}/train.log' && test -f '${SMOKE_RUN_DIR}/metrics.json'"
run_check "A3.success.validate" "true" "success metrics validate" "python3 tools/exp/validate_metrics.py '${SMOKE_RUN_DIR}/metrics.json'"

run_check "A3.failure.run" "true" "wrapper failure contract" "rm -rf '${FAIL_RUN_DIR}'; mkdir -p '${FAIL_RUN_DIR%/*}'; bash scripts/vr_run.sh --run-id r_fail --run-dir '${FAIL_RUN_DIR}' -- bash -lc 'echo forced-fail; exit 2' || true"
run_check "A3.failure.validate" "true" "failure metrics validate" "python3 tools/exp/validate_metrics.py '${FAIL_RUN_DIR}/metrics.json'"
run_check "A3.failure.status" "true" "failure status is failed" "python3 - <<'PY'
import json
from pathlib import Path
p = Path('${FAIL_RUN_DIR}/metrics.json')
d = json.loads(p.read_text(encoding='utf-8'))
status = d.get('status')
if status != 'failed':
    raise SystemExit(f'expected failed, got {status!r}')
print(f'status={status}')
PY"

run_check "A3.cancel.run" "true" "wrapper cancellation contract" "rm -rf '${CANCEL_RUN_DIR}'; mkdir -p '${CANCEL_RUN_DIR%/*}'; ( bash scripts/vr_run.sh --run-id r_cancel --run-dir '${CANCEL_RUN_DIR}' -- bash -lc 'sleep 30' ) & pid=\$!; sleep 2; kill -TERM \"\$pid\"; wait \"\$pid\" || true"
run_check "A3.cancel.validate" "true" "cancel metrics validate" "python3 tools/exp/validate_metrics.py '${CANCEL_RUN_DIR}/metrics.json'"
run_check "A3.cancel.status" "true" "cancel status is canceled or failed" "python3 - <<'PY'
import json
from pathlib import Path
p = Path('${CANCEL_RUN_DIR}/metrics.json')
d = json.loads(p.read_text(encoding='utf-8'))
status = d.get('status')
if status not in {'canceled', 'failed'}:
    raise SystemExit(f'unexpected status: {status!r}')
print(f'status={status}')
PY"

run_check "A3.registry.append" "true" "registry append first run" "rm -f '${REGISTRY_PATH}'; python3 tools/exp/append_registry.py --registry '${REGISTRY_PATH}' --run-dir '${SMOKE_RUN_DIR}'"
run_check "A3.registry.count" "true" "registry line count is 1" "test \"\$(wc -l < '${REGISTRY_PATH}')\" = '1'"
run_check "A3.registry.duplicate" "true" "duplicate registry append is rejected" "set +e; python3 tools/exp/append_registry.py --registry '${REGISTRY_PATH}' --run-dir '${SMOKE_RUN_DIR}'; rc=\$?; set -e; if [[ \"\$rc\" -eq 0 ]]; then echo 'UNEXPECTED duplicate allowed'; exit 1; fi; echo 'OK duplicate rejected with rc='\"\$rc\""

STATUS_AFTER="$(git status --porcelain)"
if [[ -z "$STATUS_AFTER" ]]; then
  record_result "A1.git.clean.after" "false" "pass" "git status clean after checks" "git status --porcelain"
else
  run_warn_or_fail "A1.git.clean.after" "$CLEAN_FAILS" "git status cleanliness after checks" "git status --porcelain"
fi

overall="pass"
if [[ "$required_failures" -gt 0 ]]; then
  overall="fail"
fi

python3 - "$RESULTS_TSV" "$SUMMARY_JSON" "$overall" "$required_failures" "$warning_count" "$REPORT_DIR" <<'PY'
import csv
import json
import pathlib
import sys

rows_path = pathlib.Path(sys.argv[1])
out_path = pathlib.Path(sys.argv[2])
overall = sys.argv[3]
required_failed = int(sys.argv[4])
warning_count = int(sys.argv[5])
report_dir = sys.argv[6]

results = []
if rows_path.exists():
    with rows_path.open("r", encoding="utf-8") as f:
        reader = csv.reader(f, delimiter="\t")
        for row in reader:
            if len(row) < 5:
                continue
            test_id, required, status, message, command = row[:5]
            evidence_path = row[5] if len(row) >= 6 else str(rows_path.with_name("suite_log.md"))
            results.append(
                {
                    "id": test_id,
                    "required": required == "true",
                    "status": status,
                    "message": message,
                    "command": command,
                    "evidence_path": evidence_path,
                }
            )

doc = {
    "suite": "essential_exec_check",
    "overall": overall,
    "required_failed": required_failed,
    "warnings": warning_count,
    "report_dir": report_dir,
    "results": results,
}
out_path.write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

python3 tools/verification/check_summary.py \
  --summary "$SUMMARY_JSON" \
  --suite-log "$SUITE_LOG" \
  --print-top-failures 8

append_log ""
append_log "## Final Summary"
append_log ""
append_log "- overall: ${overall}"
append_log "- required_failed: ${required_failures}"
append_log "- warnings: ${warning_count}"
append_log "- summary_json: ${SUMMARY_JSON}"

if [[ "$overall" != "pass" ]]; then
  printf '[essential_exec][fail] required checks failed: %s\n' "$required_failures" >&2
  printf '[essential_exec][info] report: %s\n' "$REPORT_DIR" >&2
  exit 1
fi

printf '[essential_exec] PASS\n'
printf '[essential_exec] report: %s\n' "$REPORT_DIR"
