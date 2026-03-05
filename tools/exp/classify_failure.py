#!/usr/bin/env python3
"""Classify failed experiment runs into deterministic error categories."""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
from typing import Any


ERROR_HINTS: dict[str, str] = {
    "oom": "Reduce batch size/model size, enable grad accumulation, or use a larger GPU.",
    "nan": "Lower learning rate, add gradient clipping, and validate input normalization.",
    "data_missing": "Check dataset/config paths and ensure required input files are present.",
    "dependency_missing": "Install missing packages/binaries and verify runtime environment setup.",
    "disk_full": "Free disk space or redirect outputs/checkpoints to a larger volume.",
    "permission": "Fix file permissions/ownership or write outputs to an allowed directory.",
    "timeout": "Increase timeout budget or reduce per-run workload/checkpoint cadence.",
    "interrupted": "Run was interrupted; inspect scheduler/operator events and relaunch if needed.",
    "config_error": "Fix invalid config/CLI arguments and rerun with validated parameters.",
    "unknown": "Inspect train.log tail and full traceback, then add a targeted remediation step.",
}


RULES: list[tuple[str, str, re.Pattern[str]]] = [
    ("oom", "oom.cuda", re.compile(r"cuda out of memory", re.IGNORECASE)),
    ("oom", "oom.generic", re.compile(r"\bout of memory\b|\boom-kill(ed)?\b", re.IGNORECASE)),
    ("nan", "nan.loss", re.compile(r"\bnan\b|\binf(inity)?\b|floating point exception", re.IGNORECASE)),
    ("data_missing", "data.file_not_found", re.compile(r"filenotfounderror|no such file or directory", re.IGNORECASE)),
    ("data_missing", "data.dataset_missing", re.compile(r"dataset.*(not found|missing)", re.IGNORECASE)),
    (
        "dependency_missing",
        "dep.python_module",
        re.compile(r"modulenotfounderror|importerror:.*no module named", re.IGNORECASE),
    ),
    ("dependency_missing", "dep.command_missing", re.compile(r"command not found", re.IGNORECASE)),
    ("disk_full", "disk.no_space", re.compile(r"no space left on device|disk quota exceeded", re.IGNORECASE)),
    (
        "permission",
        "perm.denied",
        re.compile(r"permission denied|operation not permitted|\beacces\b", re.IGNORECASE),
    ),
    ("timeout", "timeout.keyword", re.compile(r"\btimeout\b|timed out|deadline exceeded", re.IGNORECASE)),
    ("config_error", "cfg.argparse", re.compile(r"unrecognized arguments|invalid choice", re.IGNORECASE)),
    (
        "config_error",
        "cfg.config_file",
        re.compile(r"keyerror|valueerror|assertionerror|config(uration)?.*(error|invalid)", re.IGNORECASE),
    ),
]


def load_json(path: pathlib.Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError(f"failed to parse {path}: {exc}") from exc


def write_json(path: pathlib.Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def read_log_tail(log_path: pathlib.Path, tail_lines: int) -> str:
    if not log_path.is_file():
        return ""
    try:
        raw = log_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""
    lines = raw.splitlines()
    return "\n".join(lines[-max(1, tail_lines) :])


def classify(metrics: dict[str, Any], log_tail: str) -> tuple[str, str, str]:
    status = str(metrics.get("status") or "").strip().lower()
    run_obj = metrics.get("run") if isinstance(metrics.get("run"), dict) else {}
    signal = str(run_obj.get("signal") or "").strip().upper()
    exit_code = run_obj.get("exit_code")

    if status == "canceled" or signal in {"INT", "TERM"} or str(exit_code) in {"130", "143"}:
        return ("interrupted", ERROR_HINTS["interrupted"], f"run.signal:{signal or exit_code or 'canceled'}")

    text_parts = []
    err_msg = metrics.get("error")
    if isinstance(err_msg, str) and err_msg.strip():
        text_parts.append(err_msg.strip())
    if log_tail.strip():
        text_parts.append(log_tail.strip())
    haystack = "\n".join(text_parts)

    for error_type, signature, pattern in RULES:
        if pattern.search(haystack):
            return (error_type, ERROR_HINTS[error_type], signature)

    return ("unknown", ERROR_HINTS["unknown"], "no_match")


def clear_failure_fields(metrics: dict[str, Any]) -> bool:
    changed = False
    for key in ("error_type", "error_hint", "error_signature"):
        if key in metrics:
            del metrics[key]
            changed = True
    return changed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True, type=pathlib.Path, help="Run directory path")
    parser.add_argument("--tail-lines", type=int, default=200, help="Number of train.log tail lines to scan")
    args = parser.parse_args()

    run_dir = args.run_dir.resolve()
    metrics_path = run_dir / "metrics.json"
    log_path = run_dir / "train.log"

    if not metrics_path.is_file():
        print(f"[classify_failure][fail] missing metrics.json: {metrics_path}", file=sys.stderr)
        return 1

    try:
        metrics = load_json(metrics_path)
    except ValueError as exc:
        print(f"[classify_failure][fail] {exc}", file=sys.stderr)
        return 1

    if not isinstance(metrics, dict):
        print("[classify_failure][fail] metrics.json must be an object", file=sys.stderr)
        return 1

    status = str(metrics.get("status") or "").strip().lower()
    if status == "success":
        if clear_failure_fields(metrics):
            write_json(metrics_path, metrics)
        print(f"[classify_failure] status=success run_dir={run_dir} (no classification needed)")
        return 0

    log_tail = read_log_tail(log_path, max(1, int(args.tail_lines)))
    error_type, error_hint, error_signature = classify(metrics, log_tail)
    metrics["error_type"] = error_type
    metrics["error_hint"] = error_hint
    metrics["error_signature"] = error_signature
    write_json(metrics_path, metrics)

    print(
        f"[classify_failure] run_dir={run_dir} status={status or 'unknown'} "
        f"error_type={error_type} signature={error_signature}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
