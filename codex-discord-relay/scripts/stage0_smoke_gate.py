#!/usr/bin/env python3
"""Two-stage launcher: run smoke stage first, then full stage."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Sequence


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def within_path(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except Exception:
        return False


def resolve_under(base: Path, raw: str) -> Path:
    candidate = Path(raw)
    if candidate.is_absolute():
        return candidate.resolve()
    return (base / candidate).resolve()


def write_json(path: Path, payload: Dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


@dataclass
class StageResult:
    name: str
    command: str
    started_at: str
    finished_at: str
    exit_code: int
    stdout_path: str
    stderr_path: str
    required_files: List[str]
    missing_files: List[str]
    status: str


def run_stage(
    *,
    name: str,
    command: str,
    cwd: Path,
    env: Dict[str, str],
    logs_dir: Path,
    required_files: Sequence[Path],
) -> StageResult:
    logs_dir.mkdir(parents=True, exist_ok=True)
    stdout_path = logs_dir / f"{name}.stdout.log"
    stderr_path = logs_dir / f"{name}.stderr.log"
    started_at = utc_now()
    with stdout_path.open("w", encoding="utf-8") as out_fh, stderr_path.open("w", encoding="utf-8") as err_fh:
        proc = subprocess.run(
            ["bash", "-lc", command],
            cwd=str(cwd),
            env=env,
            stdout=out_fh,
            stderr=err_fh,
            text=True,
            check=False,
        )
    finished_at = utc_now()
    missing = [str(p) for p in required_files if not p.exists()]
    if proc.returncode != 0:
        status = "failed_exit"
    elif missing:
        status = "failed_missing_artifacts"
    else:
        status = "passed"
    return StageResult(
        name=name,
        command=command,
        started_at=started_at,
        finished_at=finished_at,
        exit_code=int(proc.returncode),
        stdout_path=str(stdout_path),
        stderr_path=str(stderr_path),
        required_files=[str(p) for p in required_files],
        missing_files=missing,
        status=status,
    )


def maybe_cleanup_smoke(
    *,
    project_root: Path,
    smoke_run_dir: Path | None,
    cleanup_policy: str,
    state_dir: Path,
) -> Dict[str, str]:
    summary: Dict[str, str] = {"policy": cleanup_policy, "action": "none"}
    if cleanup_policy != "keep_manifest_only":
        return summary
    if smoke_run_dir is None:
        summary["action"] = "skipped_missing_smoke_run_dir"
        return summary
    if not smoke_run_dir.exists():
        summary["action"] = "skipped_smoke_run_dir_not_found"
        return summary
    if not smoke_run_dir.is_dir():
        summary["action"] = "skipped_smoke_run_dir_not_directory"
        return summary
    if not within_path(smoke_run_dir, project_root):
        summary["action"] = "skipped_outside_project_root"
        return summary

    manifest = {
        "captured_at": utc_now(),
        "smoke_run_dir": str(smoke_run_dir),
        "entries": [],
    }
    for path in sorted(smoke_run_dir.rglob("*")):
        if path.is_file():
            manifest["entries"].append(
                {
                    "path": str(path),
                    "size_bytes": int(path.stat().st_size),
                }
            )
    manifest_path = state_dir / "smoke_manifest.json"
    write_json(manifest_path, manifest)
    shutil.rmtree(smoke_run_dir)
    summary["action"] = "deleted_smoke_run_dir_kept_manifest"
    summary["manifest_path"] = str(manifest_path)
    return summary


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description=(
            "Run smoke stage first and gate full stage on smoke success. "
            "Writes a machine-readable state file."
        )
    )
    ap.add_argument("--run-id", required=True, help="Logical run identifier.")
    ap.add_argument("--state-file", required=True, help="Output JSON state file path.")
    ap.add_argument("--project-root", default=".", help="Project root for safety checks.")
    ap.add_argument("--cwd", default=None, help="Working directory for both commands (default: project root).")
    ap.add_argument("--smoke-cmd", required=True, help="Shell command for smoke stage.")
    ap.add_argument("--full-cmd", required=True, help="Shell command for full stage.")
    ap.add_argument("--smoke-required-file", action="append", default=[], help="Required artifact path after smoke.")
    ap.add_argument("--full-required-file", action="append", default=[], help="Required artifact path after full run.")
    ap.add_argument("--smoke-run-dir", default=None, help="Smoke run directory to optionally clean up.")
    ap.add_argument(
        "--cleanup-smoke-policy",
        choices=("keep_all", "keep_manifest_only"),
        default="keep_manifest_only",
        help="Whether to keep full smoke artifacts or keep only a manifest and delete the run dir.",
    )
    ap.add_argument("--print-state", action="store_true", help="Print final state JSON to stdout.")
    return ap.parse_args()


def main() -> int:
    args = parse_args()
    project_root = Path(args.project_root).resolve()
    cwd = Path(args.cwd).resolve() if args.cwd else project_root
    state_file = Path(args.state_file).resolve()
    state_dir = state_file.parent
    logs_dir = state_dir / "logs"
    env = dict(os.environ)

    smoke_required = [resolve_under(cwd, p) for p in args.smoke_required_file]
    full_required = [resolve_under(cwd, p) for p in args.full_required_file]
    smoke_run_dir = resolve_under(cwd, args.smoke_run_dir) if args.smoke_run_dir else None

    state: Dict[str, object] = {
        "run_id": args.run_id,
        "status": "running",
        "created_at": utc_now(),
        "updated_at": utc_now(),
        "project_root": str(project_root),
        "cwd": str(cwd),
        "cleanup_smoke_policy": args.cleanup_smoke_policy,
        "phases": [],
    }
    write_json(state_file, state)

    print(f"[stage0-smoke-gate] run_id={args.run_id} phase=smoke start")
    smoke_result = run_stage(
        name="smoke",
        command=args.smoke_cmd,
        cwd=cwd,
        env=env,
        logs_dir=logs_dir,
        required_files=smoke_required,
    )
    state["phases"].append(smoke_result.__dict__)
    state["updated_at"] = utc_now()
    write_json(state_file, state)
    print(
        f"[stage0-smoke-gate] run_id={args.run_id} phase=smoke "
        f"status={smoke_result.status} exit={smoke_result.exit_code}"
    )

    if smoke_result.status != "passed":
        if smoke_result.status == "failed_exit":
            state["status"] = "blocked_smoke_failed_exit"
            rc = 20
        else:
            state["status"] = "blocked_smoke_missing_artifacts"
            rc = 21
        state["updated_at"] = utc_now()
        write_json(state_file, state)
        if args.print_state:
            print(json.dumps(state, indent=2, sort_keys=True))
        return rc

    cleanup_result = maybe_cleanup_smoke(
        project_root=project_root,
        smoke_run_dir=smoke_run_dir,
        cleanup_policy=args.cleanup_smoke_policy,
        state_dir=state_dir,
    )
    state["smoke_cleanup"] = cleanup_result
    state["updated_at"] = utc_now()
    write_json(state_file, state)

    print(f"[stage0-smoke-gate] run_id={args.run_id} phase=full start")
    full_result = run_stage(
        name="full",
        command=args.full_cmd,
        cwd=cwd,
        env=env,
        logs_dir=logs_dir,
        required_files=full_required,
    )
    state["phases"].append(full_result.__dict__)
    if full_result.status == "passed":
        state["status"] = "success"
        rc = 0
    elif full_result.status == "failed_exit":
        state["status"] = "blocked_full_failed_exit"
        rc = 30
    else:
        state["status"] = "blocked_full_missing_artifacts"
        rc = 31
    state["updated_at"] = utc_now()
    write_json(state_file, state)
    print(
        f"[stage0-smoke-gate] run_id={args.run_id} phase=full "
        f"status={full_result.status} exit={full_result.exit_code}"
    )

    if args.print_state:
        print(json.dumps(state, indent=2, sort_keys=True))
    return rc


if __name__ == "__main__":
    sys.exit(main())
