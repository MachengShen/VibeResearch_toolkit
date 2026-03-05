#!/usr/bin/env python3
"""Validate execution-suite summary schema and print failing checks."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


VALID_OVERALL = {"pass", "fail"}
VALID_STATUS = {"pass", "fail", "warn", "skip"}


def _load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("summary root must be a JSON object")
    return data


def _is_non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _ensure_path_exists(path_like: str, report_dir: str) -> bool:
    candidate = Path(path_like)
    if candidate.exists():
        return True
    if candidate.is_absolute():
        return False
    return (Path(report_dir) / candidate).exists()


def validate_summary(summary: dict[str, Any], suite_log: Path | None) -> list[str]:
    errors: list[str] = []

    if not _is_non_empty_string(summary.get("suite")):
        errors.append("missing or invalid 'suite'")
    if summary.get("overall") not in VALID_OVERALL:
        errors.append("missing or invalid 'overall' (expected pass|fail)")
    if not isinstance(summary.get("required_failed"), int) or summary["required_failed"] < 0:
        errors.append("missing or invalid 'required_failed' (expected non-negative int)")
    if not isinstance(summary.get("warnings"), int) or summary["warnings"] < 0:
        errors.append("missing or invalid 'warnings' (expected non-negative int)")
    if not _is_non_empty_string(summary.get("report_dir")):
        errors.append("missing or invalid 'report_dir'")

    results = summary.get("results")
    if not isinstance(results, list) or not results:
        errors.append("missing or invalid 'results' (expected non-empty list)")
        return errors

    for index, result in enumerate(results, start=1):
        prefix = f"results[{index}]"
        if not isinstance(result, dict):
            errors.append(f"{prefix} must be object")
            continue
        if not _is_non_empty_string(result.get("id")):
            errors.append(f"{prefix}.id missing/invalid")
        if not isinstance(result.get("required"), bool):
            errors.append(f"{prefix}.required missing/invalid (bool expected)")
        if result.get("status") not in VALID_STATUS:
            errors.append(f"{prefix}.status missing/invalid (expected one of {sorted(VALID_STATUS)})")
        if not _is_non_empty_string(result.get("message")):
            errors.append(f"{prefix}.message missing/invalid")
        if not _is_non_empty_string(result.get("command")):
            errors.append(f"{prefix}.command missing/invalid")
        evidence = result.get("evidence_path")
        if not _is_non_empty_string(evidence):
            errors.append(f"{prefix}.evidence_path missing/invalid")
        elif _is_non_empty_string(summary.get("report_dir")) and not _ensure_path_exists(
            evidence, str(summary["report_dir"])
        ):
            errors.append(f"{prefix}.evidence_path does not exist: {evidence}")

    required_failed_count = sum(
        1 for result in results if result.get("required") is True and result.get("status") == "fail"
    )
    expected_overall = "fail" if required_failed_count > 0 else "pass"

    if isinstance(summary.get("required_failed"), int) and summary["required_failed"] != required_failed_count:
        errors.append(
            f"required_failed mismatch: summary={summary['required_failed']} computed={required_failed_count}"
        )
    if summary.get("overall") in VALID_OVERALL and summary["overall"] != expected_overall:
        errors.append(f"overall mismatch: summary={summary['overall']} expected={expected_overall}")

    if suite_log is not None and not suite_log.exists():
        errors.append(f"suite log not found: {suite_log}")

    return errors


def print_top_failures(summary: dict[str, Any], limit: int) -> None:
    results = summary.get("results", [])
    actionable = [
        result
        for result in results
        if isinstance(result, dict) and result.get("status") in {"fail", "warn"}
    ]
    actionable.sort(
        key=lambda item: (
            0 if item.get("status") == "fail" else 1,
            0 if item.get("required") else 1,
            str(item.get("id", "")),
        )
    )

    if not actionable:
        print("[check_summary] no failing/warning checks")
        return

    print(f"[check_summary] top failing/warning checks (limit={limit}):")
    for item in actionable[:limit]:
        print(
            "  - {id} status={status} required={required} evidence={evidence}".format(
                id=item.get("id", "unknown"),
                status=item.get("status", "unknown"),
                required=item.get("required", "unknown"),
                evidence=item.get("evidence_path", "n/a"),
            )
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--summary", required=True, help="Path to summary.json")
    parser.add_argument("--suite-log", help="Path to suite_log.md")
    parser.add_argument("--print-top-failures", type=int, default=5)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    summary_path = Path(args.summary)
    suite_log = Path(args.suite_log) if args.suite_log else None

    if not summary_path.exists():
        print(f"[check_summary][fail] summary file not found: {summary_path}")
        return 1

    try:
        summary = _load_json(summary_path)
    except Exception as exc:  # pragma: no cover - defensive path
        print(f"[check_summary][fail] could not parse summary: {exc}")
        return 1

    errors = validate_summary(summary, suite_log)

    print(
        "[check_summary] suite={suite} overall={overall} required_failed={required_failed} warnings={warnings}".format(
            suite=summary.get("suite", "unknown"),
            overall=summary.get("overall", "unknown"),
            required_failed=summary.get("required_failed", "unknown"),
            warnings=summary.get("warnings", "unknown"),
        )
    )
    print_top_failures(summary, max(1, args.print_top_failures))

    if errors:
        print("[check_summary][fail] schema/consistency errors:")
        for error in errors:
            print(f"  - {error}")
        return 1

    print("[check_summary] summary schema OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
