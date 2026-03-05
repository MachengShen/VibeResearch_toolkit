#!/usr/bin/env python3
"""Create a markdown summary for one experiment run directory."""

from __future__ import annotations

import argparse
import json
import pathlib
import shlex
import sys
from typing import Any


def load_json(path: pathlib.Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError(f"failed to parse {path}: {exc}") from exc


def metric_pairs(metrics: Any, top_n: int) -> list[tuple[str, float]]:
    if not isinstance(metrics, dict):
        return []
    rows: list[tuple[str, float]] = []
    for key, value in metrics.items():
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            rows.append((str(key), float(value)))
    rows.sort(key=lambda item: item[0])
    return rows[:top_n]


def command_to_string(command: Any) -> str:
    if not isinstance(command, list):
        return "(unknown)"
    return " ".join(shlex.quote(str(part)) for part in command)


def build_summary(
    run_dir: pathlib.Path,
    meta: dict[str, Any],
    metrics: dict[str, Any],
    top_n: int,
    registry_path: pathlib.Path | None,
) -> str:
    run_obj = metrics.get("run") if isinstance(metrics.get("run"), dict) else {}
    primary = metrics.get("primary") if isinstance(metrics.get("primary"), dict) else {}
    artifacts = metrics.get("artifacts") if isinstance(metrics.get("artifacts"), dict) else {}

    run_id = run_obj.get("run_id") or meta.get("run_id") or run_dir.name
    status = metrics.get("status", "unknown")
    primary_name = primary.get("name", "objective")
    primary_value = primary.get("value", 0.0)
    hib = primary.get("higher_is_better", False)

    metrics_path = artifacts.get("metrics") or str(run_dir / "metrics.json")
    log_path = artifacts.get("log") or str(run_dir / "train.log")
    meta_path = artifacts.get("meta") or str(run_dir / "meta.json")
    registry_for_cmd = str(registry_path) if registry_path else "<path/to/registry.jsonl>"

    lines: list[str] = []
    lines.append(f"## Run `{run_id}`")
    lines.append("")
    lines.append(f"- Status: `{status}`")
    lines.append(f"- Primary metric: `{primary_name}={primary_value}` (`higher_is_better={hib}`)")
    lines.append(f"- Started: `{run_obj.get('started_at', 'unknown')}`")
    lines.append(f"- Ended: `{run_obj.get('ended_at', 'unknown')}`")
    lines.append(f"- Command: `{command_to_string(meta.get('command'))}`")
    lines.append("")
    lines.append("### Key metrics")
    top_rows = metric_pairs(metrics.get("metrics"), top_n)
    if not top_rows:
        lines.append("- (no numeric metrics captured)")
    else:
        for key, value in top_rows:
            lines.append(f"- `{key}`: `{value}`")
    lines.append("")
    lines.append("### Artifact pointers")
    lines.append(f"- Run dir: `{run_dir}`")
    lines.append(f"- Metrics: `{metrics_path}`")
    lines.append(f"- Log: `{log_path}`")
    lines.append(f"- Meta: `{meta_path}`")
    lines.append("")
    lines.append("### Verification commands")
    lines.append("```bash")
    lines.append(f"python3 tools/exp/validate_metrics.py {shlex.quote(str(metrics_path))}")
    lines.append(
        "python3 tools/exp/append_registry.py "
        f"--registry {shlex.quote(registry_for_cmd)} "
        f"--run-dir {shlex.quote(str(run_dir))}"
    )
    lines.append("```")
    if not registry_path:
        lines.append("")
        lines.append("- Note: provide `--registry` for a concrete append command path.")
    lines.append("")
    if isinstance(metrics.get("error"), str) and metrics.get("error"):
        lines.append("### Error")
        lines.append("")
        lines.append(f"- `{metrics['error']}`")
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True, type=pathlib.Path, help="Path to run directory")
    parser.add_argument("--registry", type=pathlib.Path, help="Optional path to registry.jsonl for append command")
    parser.add_argument("--out-md", type=pathlib.Path, help="Write markdown output to this file")
    parser.add_argument("--append", action="store_true", help="Append to --out-md instead of overwrite")
    parser.add_argument("--top-n", type=int, default=8, help="Maximum numeric metrics to list")
    args = parser.parse_args()

    run_dir = args.run_dir.resolve()
    meta_path = run_dir / "meta.json"
    metrics_path = run_dir / "metrics.json"
    if not meta_path.is_file():
        print(f"[summarize_run][fail] missing meta.json: {meta_path}", file=sys.stderr)
        return 1
    if not metrics_path.is_file():
        print(f"[summarize_run][fail] missing metrics.json: {metrics_path}", file=sys.stderr)
        return 1

    try:
        meta = load_json(meta_path)
        metrics = load_json(metrics_path)
    except ValueError as exc:
        print(f"[summarize_run][fail] {exc}", file=sys.stderr)
        return 1

    if not isinstance(meta, dict):
        print("[summarize_run][fail] meta.json must be an object", file=sys.stderr)
        return 1
    if not isinstance(metrics, dict):
        print("[summarize_run][fail] metrics.json must be an object", file=sys.stderr)
        return 1

    summary_md = build_summary(
        run_dir,
        meta,
        metrics,
        max(args.top_n, 1),
        args.registry.resolve() if args.registry else None,
    )

    if args.out_md:
        args.out_md.parent.mkdir(parents=True, exist_ok=True)
        mode = "a" if args.append else "w"
        with args.out_md.open(mode, encoding="utf-8") as f:
            if args.append and args.out_md.exists() and args.out_md.stat().st_size > 0:
                f.write("\n")
            f.write(summary_md)
            f.write("\n")
        print(f"[summarize_run] wrote {args.out_md}")
    else:
        sys.stdout.write(summary_md)
        if not summary_md.endswith("\n"):
            sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
