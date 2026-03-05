#!/usr/bin/env python3
"""Append a normalized run record to exp/registry.jsonl."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import sys
from typing import Any

try:
    import fcntl
except Exception:  # pragma: no cover - non-POSIX fallback
    fcntl = None  # type: ignore[assignment]


def utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def load_json(path: pathlib.Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError(f"failed to parse {path}: {exc}") from exc


def read_existing_run_ids(registry_path: pathlib.Path) -> set[str]:
    run_ids: set[str] = set()
    if not registry_path.exists():
        return run_ids

    for idx, raw in enumerate(registry_path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except Exception as exc:
            raise ValueError(
                f"registry contains invalid JSON at line {idx}: {exc}"
            ) from exc
        run_id = row.get("run_id")
        if isinstance(run_id, str) and run_id:
            run_ids.add(run_id)
    return run_ids


def env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def normalize_primary(primary: Any) -> dict[str, Any]:
    if not isinstance(primary, dict):
        return {"name": "objective", "value": 0.0, "higher_is_better": False}
    name = primary.get("name")
    value = primary.get("value")
    higher = primary.get("higher_is_better")
    if not isinstance(name, str) or not name:
        name = "objective"
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        value = 0.0
    if not isinstance(higher, bool):
        higher = False
    return {"name": name, "value": float(value), "higher_is_better": higher}


def append_record(
    *,
    registry_path: pathlib.Path,
    record: dict[str, Any],
    run_id: str,
    allow_duplicate: bool,
) -> int:
    try:
        existing_ids = read_existing_run_ids(registry_path)
    except ValueError as exc:
        print(f"[append_registry][fail] {exc}", file=sys.stderr)
        return 1

    duplicate = run_id in existing_ids
    if duplicate and not allow_duplicate:
        print(
            f"[append_registry][fail] duplicate run_id '{run_id}' in {registry_path}",
            file=sys.stderr,
        )
        return 2

    if duplicate:
        record["duplicate"] = True

    with registry_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, sort_keys=True))
        f.write("\n")

    print(f"[append_registry] appended run_id={run_id} to {registry_path}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", required=True, type=pathlib.Path, help="Path to registry.jsonl")
    parser.add_argument("--run-dir", required=True, type=pathlib.Path, help="Path to run directory")
    parser.add_argument(
        "--allow-duplicate",
        action="store_true",
        help="Allow duplicate run_id entries and mark them as duplicate=true",
    )
    args = parser.parse_args()

    run_dir = args.run_dir.resolve()
    meta_path = run_dir / "meta.json"
    metrics_path = run_dir / "metrics.json"
    log_path = run_dir / "train.log"

    if not meta_path.is_file():
        print(f"[append_registry][fail] missing meta.json: {meta_path}", file=sys.stderr)
        return 1
    if not metrics_path.is_file():
        print(f"[append_registry][fail] missing metrics.json: {metrics_path}", file=sys.stderr)
        return 1

    try:
        meta = load_json(meta_path)
        metrics = load_json(metrics_path)
    except ValueError as exc:
        print(f"[append_registry][fail] {exc}", file=sys.stderr)
        return 1

    if not isinstance(meta, dict):
        print("[append_registry][fail] meta.json must be an object", file=sys.stderr)
        return 1
    if not isinstance(metrics, dict):
        print("[append_registry][fail] metrics.json must be an object", file=sys.stderr)
        return 1

    run_obj = metrics.get("run")
    if not isinstance(run_obj, dict):
        run_obj = {}

    run_id = run_obj.get("run_id") or meta.get("run_id") or run_dir.name
    if not isinstance(run_id, str) or not run_id:
        print("[append_registry][fail] unable to determine run_id", file=sys.stderr)
        return 1

    registry_path = args.registry.resolve()
    registry_path.parent.mkdir(parents=True, exist_ok=True)

    git_info = meta.get("git")
    if not isinstance(git_info, dict):
        git_info = {}
    metrics_obj = metrics.get("metrics") if isinstance(metrics.get("metrics"), dict) else {}
    numeric_metrics = {
        str(k): float(v)
        for k, v in metrics_obj.items()
        if isinstance(v, (int, float)) and not isinstance(v, bool)
    }

    record: dict[str, Any] = {
        "run_id": run_id,
        "status": metrics.get("status"),
        "primary": normalize_primary(metrics.get("primary")),
        "metrics": numeric_metrics,
        "started_at": run_obj.get("started_at") or meta.get("started_at"),
        "ended_at": run_obj.get("ended_at") or meta.get("ended_at"),
        "job_id": run_obj.get("job_id"),
        "task_id": run_obj.get("task_id"),
        "seed": run_obj.get("seed"),
        "params": run_obj.get("params") if isinstance(run_obj.get("params"), dict) else {},
        "command": meta.get("command") if isinstance(meta.get("command"), list) else [],
        "cwd": meta.get("cwd"),
        "git": {
            "commit": git_info.get("commit"),
            "dirty": git_info.get("dirty"),
            "branch": git_info.get("branch"),
        },
        "paths": {
            "run_dir": str(run_dir),
            "meta": str(meta_path),
            "metrics": str(metrics_path),
            "train_log": str(log_path),
        },
        "recorded_at": utc_now_iso(),
    }
    lock_enabled = env_bool("RELAY_REGISTRY_LOCK_ENABLED", True)
    if lock_enabled and fcntl is not None:
        lock_path = registry_path.parent / f"{registry_path.name}.lock"
        with lock_path.open("a+", encoding="utf-8") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            return append_record(
                registry_path=registry_path,
                record=record,
                run_id=run_id,
                allow_duplicate=args.allow_duplicate,
            )

    if lock_enabled and fcntl is None:
        print("[append_registry][warn] fcntl unavailable; continuing without file lock", file=sys.stderr)

    return append_record(
        registry_path=registry_path,
        record=record,
        run_id=run_id,
        allow_duplicate=args.allow_duplicate,
    )


if __name__ == "__main__":
    raise SystemExit(main())
