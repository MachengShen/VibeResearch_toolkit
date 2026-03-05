# Runtime Robustness Execution Suite Runbook

## Purpose
Run a reproducible stress suite for pipeline robustness and capture evidence for review.

## Quick Start

```bash
bash scripts/robustness_exec_suite.sh
```

Outputs:
- `reports/robustness_suite/YYYY-MM-DD/suite_log.md`
- `reports/robustness_suite/YYYY-MM-DD/summary.json`

Validate summary schema:

```bash
python3 tools/verification/check_summary.py \
  --summary reports/robustness_suite/YYYY-MM-DD/summary.json \
  --suite-log reports/robustness_suite/YYYY-MM-DD/suite_log.md
```

## What the Script Executes

Required checks:
1. `T0.preflight` - repository lint
2. `T1.happy_path` - wrapper success contract
3. `T2.failure_path` - non-zero exit contract
4. `T3.cancel_path` - signal cancellation contract
5. `T4.corrupt_salvage` - invalid metrics recovery
6. `T6.registry_concurrency` - concurrent append JSONL integrity

Advisory checks:
- `T5.artifact_readiness.offline` - delayed artifact simulation
- `T7.wait_loop_guard` - manual runtime guard validation
- `T8.visibility_slo` - manual runtime visibility validation
- `T9.restart_recovery` - manual runtime recovery validation

## Manual Runtime Steps (Discord / Relay)

### Wait-loop guard
- Start a risky self-matching wait-loop command as a watched job.
- Confirm relay warns/rejects according to configured mode.

### Visibility SLO
- Start a long silent job (`sleep 600`) with watch enabled.
- Confirm startup/periodic heartbeat behavior and degraded visibility signaling if configured.

### Restart recovery
1. Start a watched wrapper run (2-5 min).
2. Restart relay while run is active.
3. Verify job completion is detected and callback behavior is explicit (queued or blocked with reason).

## Recommended Final Summary Format
At end of `suite_log.md`, record:
- Overall PASS/FAIL
- Failed test IDs with exact evidence paths
- Top 3 fixes with rationale
- Report-vs-reality mismatches (if any)

`scripts/robustness_exec_suite.sh` now auto-appends this section using execution results and evidence paths.
