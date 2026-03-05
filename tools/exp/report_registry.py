#!/usr/bin/env python3
"""Generate a markdown summary table from exp/registry.jsonl."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import shlex
import sys
from typing import Any


def utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def load_registry(path: pathlib.Path) -> tuple[list[dict[str, Any]], int]:
    rows: list[dict[str, Any]] = []
    bad = 0
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            bad += 1
            continue
        if isinstance(obj, dict):
            rows.append(obj)
        else:
            bad += 1
    return rows, bad


def parse_hib(raw: str) -> str:
    value = (raw or "auto").strip().lower()
    if value in {"auto", "true", "false"}:
        return value
    raise ValueError("--higher-is-better must be one of: auto,true,false")


def metric_value(row: dict[str, Any], metric: str | None, hib_mode: str) -> tuple[str, float, bool] | None:
    primary = row.get("primary") if isinstance(row.get("primary"), dict) else {}
    primary_name = primary.get("name") if isinstance(primary.get("name"), str) else "objective"
    primary_hib = primary.get("higher_is_better") if isinstance(primary.get("higher_is_better"), bool) else False
    target = metric or primary_name

    if target == primary_name and isinstance(primary.get("value"), (int, float)) and not isinstance(primary.get("value"), bool):
        hib = primary_hib if hib_mode == "auto" else hib_mode == "true"
        return (primary_name, float(primary["value"]), hib)

    metrics = row.get("metrics") if isinstance(row.get("metrics"), dict) else {}
    val = metrics.get(target)
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        hib = primary_hib if hib_mode == "auto" else hib_mode == "true"
        return (target, float(val), hib)
    return None


def best_successful(rows: list[dict[str, Any]], metric: str | None, hib_mode: str) -> dict[str, Any] | None:
    scored: list[dict[str, Any]] = []
    for row in rows:
        if row.get("status") != "success":
            continue
        metric_info = metric_value(row, metric, hib_mode)
        if metric_info is None:
            continue
        metric_name, value, hib = metric_info
        scored.append(
            {
                "metric": metric_name,
                "value": value,
                "higher_is_better": hib,
                "ended_at": str(row.get("ended_at") or ""),
                "run_id": str(row.get("run_id") or ""),
                "row": row,
            }
        )
    if not scored:
        return None
    scored.sort(
        key=lambda item: (item["value"], item["ended_at"], item["run_id"]),
        reverse=bool(scored[0]["higher_is_better"]),
    )
    return scored[0]


def row_value(row: dict[str, Any]) -> tuple[str, str, str, str, str, str]:
    run_id = str(row.get("run_id") or "")
    status = str(row.get("status") or "")
    primary = row.get("primary") if isinstance(row.get("primary"), dict) else {}
    metric_name = str(primary.get("name") or "objective")
    metric_value_raw = primary.get("value")
    metric_val = (
        f"{float(metric_value_raw):.6g}"
        if isinstance(metric_value_raw, (int, float)) and not isinstance(metric_value_raw, bool)
        else "-"
    )
    ended_at = str(row.get("ended_at") or "")
    paths = row.get("paths") if isinstance(row.get("paths"), dict) else {}
    run_dir = str(paths.get("run_dir") or "")
    return run_id, status, metric_name, metric_val, ended_at, run_dir


def md_escape(text: str) -> str:
    return str(text).replace("|", "\\|")


def build_report(
    *,
    rows: list[dict[str, Any]],
    parse_errors: int,
    registry_path: pathlib.Path,
    out_path: pathlib.Path,
    last_n: int,
    metric: str | None,
    hib_mode: str,
) -> str:
    chosen = rows[-last_n:] if last_n > 0 else rows
    chosen_rev = list(reversed(chosen))
    best = best_successful(rows, metric, hib_mode)

    lines: list[str] = []
    lines.append("# Experiment Registry Report")
    lines.append("")
    lines.append(f"- generated_at: `{utc_now_iso()}`")
    lines.append(f"- registry: `{registry_path}`")
    lines.append(f"- out: `{out_path}`")
    lines.append(f"- total_rows: `{len(rows)}`")
    lines.append(f"- parse_errors: `{parse_errors}`")
    lines.append(f"- showing_last: `{len(chosen)}`")
    if metric:
        lines.append(f"- metric_filter: `{metric}`")
    lines.append("")

    lines.append("## Best Successful Run")
    lines.append("")
    if not best:
        lines.append("- none (no successful runs with a comparable metric)")
    else:
        row = best["row"]
        paths = row.get("paths") if isinstance(row.get("paths"), dict) else {}
        run_dir = str(paths.get("run_dir") or "")
        lines.append(f"- run_id: `{best['run_id']}`")
        lines.append(f"- metric: `{best['metric']}`")
        lines.append(f"- value: `{best['value']}`")
        lines.append(f"- higher_is_better: `{best['higher_is_better']}`")
        lines.append(f"- run_dir: `{run_dir}`")
        if run_dir:
            lines.append(
                f"- summarize: `python3 tools/exp/summarize_run.py --run-dir {shlex.quote(run_dir)} --registry {shlex.quote(str(registry_path))}`"
            )
    lines.append("")

    lines.append("## Recent Runs")
    lines.append("")
    lines.append("| run_id | status | metric | value | ended_at | run_dir |")
    lines.append("|---|---|---|---:|---|---|")
    if not chosen_rev:
        lines.append("| (none) | - | - | - | - | - |")
    else:
        for row in chosen_rev:
            run_id, status, metric_name, metric_val, ended_at, run_dir = row_value(row)
            lines.append(
                "| "
                + " | ".join(
                    [
                        md_escape(run_id or "-"),
                        md_escape(status or "-"),
                        md_escape(metric_name or "-"),
                        md_escape(metric_val),
                        md_escape(ended_at or "-"),
                        md_escape(run_dir or "-"),
                    ]
                )
                + " |"
            )
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", required=True, type=pathlib.Path, help="Path to exp/registry.jsonl")
    parser.add_argument("--out", required=True, type=pathlib.Path, help="Path to output markdown report")
    parser.add_argument("--last", type=int, default=30, help="Include last N rows in table (default: 30)")
    parser.add_argument("--metric", help="Optional metric name for best-run section")
    parser.add_argument(
        "--higher-is-better",
        default="auto",
        help="auto|true|false (default: auto from row.primary.higher_is_better)",
    )
    args = parser.parse_args()

    registry_path = args.registry.resolve()
    out_path = args.out.resolve()
    if not registry_path.is_file():
        print(f"[report_registry][fail] missing registry: {registry_path}", file=sys.stderr)
        return 1

    try:
        hib_mode = parse_hib(args.higher_is_better)
        rows, parse_errors = load_registry(registry_path)
    except Exception as exc:
        print(f"[report_registry][fail] {exc}", file=sys.stderr)
        return 1

    report = build_report(
        rows=rows,
        parse_errors=parse_errors,
        registry_path=registry_path,
        out_path=out_path,
        last_n=max(1, int(args.last)),
        metric=(args.metric or "").strip() or None,
        hib_mode=hib_mode,
    )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(report + "\n", encoding="utf-8")
    print(f"[report_registry] wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
