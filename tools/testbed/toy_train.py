#!/usr/bin/env python3
"""Tiny training simulator for robustness pipeline checks."""

from __future__ import annotations

import argparse
import json
import pathlib
import random
import time


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--steps", type=int, default=30)
    parser.add_argument("--sleep", type=float, default=1.0)
    parser.add_argument("--fail-at", type=int, default=-1)
    parser.add_argument("--corrupt-metrics", action="store_true")
    parser.add_argument("--delay-metrics-sec", type=float, default=0.0)
    return parser.parse_args()


def write_metrics(run_dir: pathlib.Path, loss: float, corrupt: bool, steps: int) -> None:
    metrics_path = run_dir / "metrics.json"
    if corrupt:
        metrics_path.write_text("{not json", encoding="utf-8")
        return

    doc = {
        "status": "success",
        "primary": {"name": "loss", "value": float(loss), "higher_is_better": False},
        "metrics": {"loss": float(loss), "steps": steps},
        "run": {"run_id": "", "started_at": "", "ended_at": ""},
    }
    metrics_path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    run_dir = pathlib.Path(args.run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)

    loss = 5.0
    for step in range(args.steps):
        print(f"[toy_train] step={step} loss={loss:.4f}", flush=True)
        time.sleep(args.sleep)
        loss *= 0.95 + random.random() * 0.01
        if args.fail_at == step:
            return 2

    if args.delay_metrics_sec > 0:
        time.sleep(args.delay_metrics_sec)

    write_metrics(run_dir, loss, args.corrupt_metrics, args.steps)
    print("[toy_train] done", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
