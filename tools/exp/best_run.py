#!/usr/bin/env python3
"""Select the best successful run from exp/registry.jsonl."""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from typing import Any


def load_rows(path: pathlib.Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for idx, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except Exception as exc:
            raise ValueError(f"invalid JSON on line {idx}: {exc}") from exc
        if isinstance(row, dict):
            rows.append(row)
    return rows


def parse_higher_is_better(raw: str) -> str:
    value = (raw or "auto").strip().lower()
    if value in {"auto", "true", "false"}:
        return value
    raise ValueError("--higher-is-better must be one of: auto, true, false")


def metric_from_row(row: dict[str, Any], metric: str | None, hib_mode: str) -> tuple[float, bool, str] | None:
    primary = row.get("primary") if isinstance(row.get("primary"), dict) else {}
    primary_name = primary.get("name") if isinstance(primary.get("name"), str) else "objective"
    primary_value = primary.get("value")
    primary_hib = primary.get("higher_is_better")
    if not isinstance(primary_hib, bool):
        primary_hib = False

    target = metric or primary_name

    if metric is None or metric == primary_name:
        if isinstance(primary_value, (int, float)) and not isinstance(primary_value, bool):
            hib = primary_hib if hib_mode == "auto" else hib_mode == "true"
            return float(primary_value), hib, primary_name

    metrics = row.get("metrics") if isinstance(row.get("metrics"), dict) else {}
    mval = metrics.get(target)
    if isinstance(mval, (int, float)) and not isinstance(mval, bool):
        hib = primary_hib if hib_mode == "auto" else hib_mode == "true"
        return float(mval), hib, target

    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", required=True, type=pathlib.Path, help="Path to registry.jsonl")
    parser.add_argument("--metric", help="Metric name to optimize (default: row.primary.name)")
    parser.add_argument(
        "--higher-is-better",
        default="auto",
        help="auto|true|false (default: auto from row.primary.higher_is_better)",
    )
    parser.add_argument("--top", type=int, default=5, help="Number of top rows to include")
    parser.add_argument("--json", action="store_true", help="Output JSON only")
    args = parser.parse_args()

    registry_path = args.registry.resolve()
    if not registry_path.is_file():
        print(f"[best_run][fail] missing registry: {registry_path}", file=sys.stderr)
        return 1

    try:
        hib_mode = parse_higher_is_better(args.higher_is_better)
        rows = load_rows(registry_path)
    except Exception as exc:
        print(f"[best_run][fail] {exc}", file=sys.stderr)
        return 1

    scored: list[dict[str, Any]] = []
    for row in rows:
        if row.get("status") != "success":
            continue
        metric = metric_from_row(row, args.metric, hib_mode)
        if metric is None:
            continue
        value, hib, metric_name = metric
        scored.append(
            {
                "run_id": row.get("run_id"),
                "value": value,
                "higher_is_better": hib,
                "metric": metric_name,
                "ended_at": row.get("ended_at"),
                "row": row,
            }
        )

    if not scored:
        print("[best_run][fail] no successful runs with the requested metric", file=sys.stderr)
        return 2

    # Deterministic tie-breaks: metric score, then ended_at, then run_id.
    scored.sort(
        key=lambda item: (
            item["value"],
            str(item.get("ended_at") or ""),
            str(item.get("run_id") or ""),
        ),
        reverse=bool(scored[0]["higher_is_better"]),
    )

    top_n = max(1, int(args.top))
    top_rows = scored[:top_n]
    best = top_rows[0]

    payload = {
        "registry": str(registry_path),
        "metric": best["metric"],
        "higher_is_better": best["higher_is_better"],
        "considered": len(scored),
        "best": {
            "run_id": best["run_id"],
            "value": best["value"],
            "ended_at": best.get("ended_at"),
            "status": best["row"].get("status"),
            "paths": best["row"].get("paths") if isinstance(best["row"].get("paths"), dict) else {},
        },
        "top": [
            {
                "run_id": item["run_id"],
                "value": item["value"],
                "ended_at": item.get("ended_at"),
            }
            for item in top_rows
        ],
    }

    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 0

    print(f"[best_run] metric={payload['metric']} higher_is_better={payload['higher_is_better']}")
    print(f"[best_run] best run_id={payload['best']['run_id']} value={payload['best']['value']}")
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
