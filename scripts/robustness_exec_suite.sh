#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DATE_DIR="$(date +%F)"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
REPORT_DIR="${ROBUSTNESS_SUITE_DIR:-reports/robustness_suite/${DATE_DIR}}"
ARTIFACTS_DIR="${REPORT_DIR}/artifacts"
SUITE_LOG="${REPORT_DIR}/suite_log.md"
RESULTS_TSV="${REPORT_DIR}/results.tsv"
SUMMARY_JSON="${REPORT_DIR}/summary.json"
TEST_TMP_DIR="${ROBUSTNESS_SUITE_TMP_DIR:-/tmp/robustness-suite-${TIMESTAMP}}"

mkdir -p "$REPORT_DIR" "$ARTIFACTS_DIR"
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
  append_log "## ${test_id}: ${description}"
  append_log "- started_at: ${started_at}"
  append_log ""
  append_log '```bash'
  append_log "$command"
  append_log '```'
  append_log '```text'

  local start end rc duration
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

mark_manual() {
  local test_id="$1"
  local description="$2"
  local command="$3"
  local at
  at="$(iso_now)"
  append_log ""
  append_log "## ${test_id}: ${description}"
  append_log "- started_at: ${at}"
  append_log "- ended_at: ${at}"
  append_log ""
  append_log "manual-required in Discord runtime; not executed in local suite"
  record_result "$test_id" "false" "warn" "manual-required" "$command"
}

append_log "# Runtime Robustness Execution Suite"
append_log ""
append_log "- timestamp: $(iso_now)"
append_log "- repo: ${ROOT_DIR}"
append_log "- report_dir: ${REPORT_DIR}"
append_log "- artifacts_dir: ${ARTIFACTS_DIR}"
append_log "- tmp_dir: ${TEST_TMP_DIR}"
append_log ""
append_log "## Environment"
append_log ""
append_log "- node: $(node -v 2>/dev/null || echo 'missing')"
append_log "- python: $(python3 --version 2>/dev/null || echo 'missing')"
append_log "- head: $(git rev-parse HEAD 2>/dev/null || echo 'unknown')"
append_log "- git_status_porcelain: $(git status --porcelain | tr '\n' ' ' || true)"
append_log ""
append_log "## Results"

run_check "T0.preflight" "true" "repo lint preflight" "bash scripts/lint_repo.sh"

HAPPY_RUN_DIR="${TEST_TMP_DIR}/exp/results/r_happy"
FAIL_RUN_DIR="${TEST_TMP_DIR}/exp/results/r_fail"
CANCEL_RUN_DIR="${TEST_TMP_DIR}/exp/results/r_cancel"
CORRUPT_RUN_DIR="${TEST_TMP_DIR}/exp/results/r_corrupt"
DELAY_RUN_DIR="${TEST_TMP_DIR}/exp/results/r_delay"
REGISTRY_PATH="${TEST_TMP_DIR}/exp/registry.jsonl"

run_check "T1.happy_path" "true" "happy path run contract" "rm -rf '${HAPPY_RUN_DIR}'; mkdir -p '${HAPPY_RUN_DIR%/*}'; bash scripts/vr_run.sh --run-id r_happy --run-dir '${HAPPY_RUN_DIR}' -- python3 tools/testbed/toy_train.py --run-dir '${HAPPY_RUN_DIR}' --steps 10 --sleep 0.05; python3 tools/exp/validate_metrics.py '${HAPPY_RUN_DIR}/metrics.json'; python3 tools/exp/append_registry.py --registry '${REGISTRY_PATH}' --run-dir '${HAPPY_RUN_DIR}'; python3 tools/exp/summarize_run.py --run-dir '${HAPPY_RUN_DIR}' --out-md '${ARTIFACTS_DIR}/r_happy_summary.md'"

run_check "T2.failure_path" "true" "non-zero exit produces valid failed metrics" "rm -rf '${FAIL_RUN_DIR}'; mkdir -p '${FAIL_RUN_DIR%/*}'; bash scripts/vr_run.sh --run-id r_fail --run-dir '${FAIL_RUN_DIR}' -- python3 tools/testbed/toy_train.py --run-dir '${FAIL_RUN_DIR}' --steps 10 --sleep 0.05 --fail-at 3 || true; python3 tools/exp/validate_metrics.py '${FAIL_RUN_DIR}/metrics.json'; python3 - <<'PY'
import json
from pathlib import Path
p = Path('${FAIL_RUN_DIR}/metrics.json')
d = json.loads(p.read_text(encoding='utf-8'))
if d.get('status') != 'failed':
    raise SystemExit('expected failed, got %r' % (d.get('status'),))
print('status=failed')
PY"

run_check "T3.cancel_path" "true" "SIGTERM cancellation still yields valid metrics" "rm -rf '${CANCEL_RUN_DIR}'; mkdir -p '${CANCEL_RUN_DIR%/*}'; ( bash scripts/vr_run.sh --run-id r_cancel --run-dir '${CANCEL_RUN_DIR}' -- python3 tools/testbed/toy_train.py --run-dir '${CANCEL_RUN_DIR}' --steps 200 --sleep 0.05 ) & pid=\$!; sleep 1; kill -TERM \"\$pid\"; wait \"\$pid\" || true; python3 tools/exp/validate_metrics.py '${CANCEL_RUN_DIR}/metrics.json'"

run_check "T4.corrupt_salvage" "true" "corrupt metrics are repaired to valid schema" "rm -rf '${CORRUPT_RUN_DIR}'; mkdir -p '${CORRUPT_RUN_DIR%/*}'; bash scripts/vr_run.sh --run-id r_corrupt --run-dir '${CORRUPT_RUN_DIR}' -- python3 tools/testbed/toy_train.py --run-dir '${CORRUPT_RUN_DIR}' --steps 5 --sleep 0.05 --corrupt-metrics; python3 tools/exp/validate_metrics.py '${CORRUPT_RUN_DIR}/metrics.json'"

run_check "T5.artifact_readiness.offline" "false" "offline delayed artifact readiness simulation" "rm -rf '${DELAY_RUN_DIR}'; mkdir -p '${DELAY_RUN_DIR}'; ( sleep 2; python3 - <<'PY'
import json
from pathlib import Path
run_dir = Path('${DELAY_RUN_DIR}')
(run_dir / 'metrics.json').write_text(json.dumps({'status':'success','primary':{'name':'loss','value':1.23,'higher_is_better':False},'metrics':{'loss':1.23},'run':{'run_id':'r_delay','started_at':'x','ended_at':'y'}}, indent=2) + '\n', encoding='utf-8')
(run_dir / 'meta.json').write_text(json.dumps({'run_id':'r_delay'}) + '\n', encoding='utf-8')
(run_dir / 'train.log').write_text('late artifacts\n', encoding='utf-8')
PY
) & python3 - <<'PY'
import time
from pathlib import Path
run_dir = Path('${DELAY_RUN_DIR}')
required = [run_dir / 'metrics.json', run_dir / 'meta.json', run_dir / 'train.log']
deadline = time.time() + 20
while time.time() < deadline:
    missing = [str(p) for p in required if not p.exists()]
    if not missing:
        print('all required artifacts present')
        raise SystemExit(0)
    time.sleep(0.5)
print('missing artifacts after timeout:', missing)
raise SystemExit(1)
PY"

run_check "T6.registry_concurrency" "true" "parallel appends keep registry JSONL valid" "rm -f '${REGISTRY_PATH}'; for i in 1 2; do run_id=\"r_conc\${i}_${TIMESTAMP}\"; run_dir='${TEST_TMP_DIR}/exp/results/'\"\$run_id\"; ( bash scripts/vr_run.sh --run-id \"\$run_id\" --run-dir \"\$run_dir\" -- python3 tools/testbed/toy_train.py --run-dir \"\$run_dir\" --steps 20 --sleep 0.02 && python3 tools/exp/append_registry.py --registry '${REGISTRY_PATH}' --run-dir \"\$run_dir\" ) & done; wait; python3 - <<'PY'
import json
from pathlib import Path
p = Path('${REGISTRY_PATH}')
lines = [line for line in p.read_text(encoding='utf-8').splitlines() if line.strip()]
if len(lines) < 2:
    raise SystemExit(f'expected >=2 lines, got {len(lines)}')
for idx, line in enumerate(lines, 1):
    json.loads(line)
print(f'lines={len(lines)} parse_ok=true')
PY"

mark_manual "T7.wait_loop_guard" "self-matching pgrep wait-loop guard" "bash -lc 'while pgrep -f \"pgrep -f\" >/dev/null; do sleep 1; done; echo done'"
mark_manual "T8.visibility_slo" "silent long-job visibility heartbeat/degraded behavior" "bash -lc 'sleep 600'"
mark_manual "T9.restart_recovery" "restart relay mid-job and verify callback recovery" "restart relay service while watched job is active"

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
    "suite": "robustness_exec_suite",
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

python3 - "$SUMMARY_JSON" "$SUITE_LOG" <<'PY'
import json
from pathlib import Path
import sys

summary = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
suite_log = Path(sys.argv[2])
results = summary.get("results", [])
failed = [r for r in results if r.get("status") == "fail"]
warned = [r for r in results if r.get("status") == "warn"]

def fix_for_test(test_id: str) -> str:
    if test_id.startswith("T0"):
        return "Fix lint/shebang failures before rerunning the suite."
    if test_id.startswith(("T1", "T2", "T3", "T4")):
        return "Repair wrapper contract behavior in scripts/vr_run.sh and metrics generation paths."
    if test_id.startswith("T5"):
        return "Validate artifact gate configuration (requireFiles/readyTimeoutSec/onMissing) in live relay runs."
    if test_id.startswith("T6"):
        return "Investigate append_registry lock/atomic write behavior for concurrent writes."
    if test_id.startswith("T7"):
        return "Tune wait-loop guard mode/pattern rules and verify warn/reject behavior in Discord job_start."
    if test_id.startswith("T8"):
        return "Tune visibility heartbeat/degradation settings and verify startup heartbeat coverage."
    if test_id.startswith("T9"):
        return "Run restart-recovery canary and patch watcher reattach/callback recovery gaps."
    return "Investigate failure and patch test-specific execution path."

recommended = []
for item in failed + warned:
    candidate = fix_for_test(str(item.get("id", "")))
    if candidate not in recommended:
        recommended.append(candidate)
    if len(recommended) == 3:
        break
while len(recommended) < 3:
    recommended.append("No additional automated failures; keep canary manual checks in the release checklist.")

with suite_log.open("a", encoding="utf-8") as f:
    f.write("\n## D. Final Summary Requirements\n\n")
    f.write(f"- Overall PASS/FAIL: {summary.get('overall', 'unknown').upper()}\n")
    if failed:
        f.write("- Failed tests:\n")
        for item in failed:
            f.write(
                "  - {id}: {msg} (evidence: {evidence})\n".format(
                    id=item.get("id", "unknown"),
                    msg=item.get("message", ""),
                    evidence=item.get("evidence_path", "n/a"),
                )
            )
    else:
        f.write("- Failed tests: none\n")
    f.write("- Recommended fixes (top 3):\n")
    for idx, rec in enumerate(recommended, 1):
        f.write(f"  - {idx}. {rec}\n")

    unresolved_manual = [r for r in warned if str(r.get("id", "")).startswith(("T7", "T8", "T9"))]
    if unresolved_manual:
        ids = ", ".join(str(r.get("id", "")) for r in unresolved_manual)
        f.write(
            "- Report-vs-reality discrepancies: offline suite passed but manual runtime checks remain unexecuted ({ids}).\n".format(
                ids=ids
            )
        )
    else:
        f.write("- Report-vs-reality discrepancies: none detected in this run.\n")
PY

if [[ "$overall" != "pass" ]]; then
  printf '[robustness_suite][fail] required checks failed: %s\n' "$required_failures" >&2
  printf '[robustness_suite][info] report: %s\n' "$REPORT_DIR" >&2
  exit 1
fi

printf '[robustness_suite] PASS\n'
printf '[robustness_suite] report: %s\n' "$REPORT_DIR"
