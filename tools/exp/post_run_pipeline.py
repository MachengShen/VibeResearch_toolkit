#!/usr/bin/env python3
"""Run deterministic post-run automation for one experiment directory."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import subprocess
import sys
from typing import Any


def utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except Exception:
        return default


def load_json(path: pathlib.Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def run_tool(label: str, cmd: list[str], cwd: pathlib.Path) -> int:
    print(f"[post_run_pipeline] {label}: {' '.join(cmd)}")
    proc = subprocess.run(cmd, cwd=str(cwd), text=True, capture_output=True)
    if proc.stdout.strip():
        print(proc.stdout.rstrip())
    if proc.stderr.strip():
        print(proc.stderr.rstrip(), file=sys.stderr)
    if proc.returncode != 0:
        print(f"[post_run_pipeline][fail] {label} failed (exit={proc.returncode})", file=sys.stderr)
    return int(proc.returncode)


def read_tail(path: pathlib.Path, lines: int) -> str:
    if not path.is_file():
        return ""
    raw = path.read_text(encoding="utf-8", errors="replace")
    row_list = raw.splitlines()
    return "\n".join(row_list[-max(1, lines) :])


def append_jsonl(path: pathlib.Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload, sort_keys=True))
        f.write("\n")


def ensure_reflection_stub(path: pathlib.Path, *, run_id: str, run_dir: pathlib.Path, status: str, error_type: str | None) -> None:
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    body = [
        f"# Reflection Stub: {run_id}",
        "",
        f"- generated_at: `{utc_now_iso()}`",
        f"- run_id: `{run_id}`",
        f"- run_dir: `{run_dir}`",
        f"- status: `{status}`",
        f"- error_type: `{error_type or ''}`",
        "",
        "## What happened?",
        "-",
        "",
        "## What worked?",
        "-",
        "",
        "## What failed?",
        "-",
        "",
        "## Next experiment",
        "- hypothesis:",
        "- one exact command:",
        "",
    ]
    path.write_text("\n".join(body), encoding="utf-8")


def append_markdown_update(path: pathlib.Path, section: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text("", encoding="utf-8")
    with path.open("a", encoding="utf-8") as f:
        if path.stat().st_size > 0:
            f.write("\n")
        f.write(section)
        if not section.endswith("\n"):
            f.write("\n")


def build_handoff_entry(
    *,
    run_id: str,
    run_dir: pathlib.Path,
    status: str,
    primary_name: str,
    primary_value: float | None,
    error_type: str | None,
    registry: pathlib.Path,
    report: pathlib.Path,
    experience: pathlib.Path,
    reflection: pathlib.Path,
) -> str:
    ts = utc_now_iso()
    value_str = f"{primary_value}" if primary_value is not None else "n/a"
    lines = [
        f"## {ts}",
        "### Objective",
        f"- Post-run pipeline update for `{run_id}`.",
        "",
        "### Result",
        f"- status: `{status}`",
        f"- primary: `{primary_name}={value_str}`",
        f"- error_type: `{error_type or ''}`",
        "",
        "### Evidence",
        f"- `{run_dir}/metrics.json`",
        f"- `{run_dir}/meta.json`",
        f"- `{run_dir}/train.log`",
        f"- `{registry}`",
        f"- `{report}`",
        f"- `{experience}`",
        f"- `{reflection}`",
        "",
    ]
    return "\n".join(lines)


def build_working_memory_entry(
    *,
    run_id: str,
    run_dir: pathlib.Path,
    status: str,
    primary_name: str,
    primary_value: float | None,
    template_id: str | None,
    study_id: str | None,
    error_type: str | None,
) -> str:
    ts = utc_now_iso()
    value_str = f"{primary_value}" if primary_value is not None else "n/a"
    lines = [
        f"## {ts}",
        "### Latest experiment snapshot",
        f"- run_id: `{run_id}`",
        f"- run_dir: `{run_dir}`",
        f"- template_id: `{template_id or ''}`",
        f"- study_id: `{study_id or ''}`",
        f"- status: `{status}`",
        f"- primary: `{primary_name}={value_str}`",
        f"- error_type: `{error_type or ''}`",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True, type=pathlib.Path, help="Run directory")
    parser.add_argument("--registry", default=pathlib.Path("exp/registry.jsonl"), type=pathlib.Path)
    parser.add_argument("--experience", default=pathlib.Path("exp/experience.jsonl"), type=pathlib.Path)
    parser.add_argument("--handoff", default=pathlib.Path("HANDOFF_LOG.md"), type=pathlib.Path)
    parser.add_argument("--working-memory", default=pathlib.Path("docs/WORKING_MEMORY.md"), type=pathlib.Path)
    parser.add_argument("--rolling-report", default=pathlib.Path("reports/rolling_report.md"), type=pathlib.Path)
    parser.add_argument("--template-id", default="", help="Template id for experience records")
    parser.add_argument("--study-id", default="", help="Optional study id")
    parser.add_argument("--reflection-dir", default=pathlib.Path("exp/reflections"), type=pathlib.Path)
    parser.add_argument("--classify-tail-lines", type=int, default=200)
    parser.add_argument("--allow-registry-duplicate", action="store_true")
    parser.add_argument("--skip-experience", action="store_true", help="Skip appending exp/experience.jsonl")
    args = parser.parse_args()

    repo_root = pathlib.Path.cwd().resolve()
    tools_dir = pathlib.Path(__file__).resolve().parent
    py = sys.executable or "python3"

    run_dir = args.run_dir.resolve()
    metrics_path = run_dir / "metrics.json"
    meta_path = run_dir / "meta.json"
    log_path = run_dir / "train.log"

    if not run_dir.is_dir():
        print(f"[post_run_pipeline][fail] missing run dir: {run_dir}", file=sys.stderr)
        return 1
    if not metrics_path.is_file():
        print(f"[post_run_pipeline][fail] missing metrics.json: {metrics_path}", file=sys.stderr)
        return 1

    # Fail-closed: metrics must validate before any downstream registry/report updates.
    rc = run_tool("validate_metrics(pre)", [py, str(tools_dir / "validate_metrics.py"), str(metrics_path)], repo_root)
    if rc != 0:
        return rc

    rc = run_tool(
        "classify_failure",
        [py, str(tools_dir / "classify_failure.py"), "--run-dir", str(run_dir), "--tail-lines", str(max(1, args.classify_tail_lines))],
        repo_root,
    )
    if rc != 0:
        return rc

    rc = run_tool("validate_metrics(post)", [py, str(tools_dir / "validate_metrics.py"), str(metrics_path)], repo_root)
    if rc != 0:
        return rc

    registry_path = args.registry.resolve()
    append_cmd = [py, str(tools_dir / "append_registry.py"), "--registry", str(registry_path), "--run-dir", str(run_dir)]
    if args.allow_registry_duplicate:
        append_cmd.append("--allow-duplicate")
    rc = run_tool("append_registry", append_cmd, repo_root)
    if rc != 0:
        return rc

    rolling_report_path = args.rolling_report.resolve()
    rc = run_tool(
        "summarize_run",
        [
            py,
            str(tools_dir / "summarize_run.py"),
            "--run-dir",
            str(run_dir),
            "--registry",
            str(registry_path),
            "--out-md",
            str(rolling_report_path),
            "--append",
        ],
        repo_root,
    )
    if rc != 0:
        return rc

    try:
        metrics = load_json(metrics_path)
        meta = load_json(meta_path) if meta_path.is_file() else {}
    except Exception as exc:
        print(f"[post_run_pipeline][fail] failed loading run artifacts: {exc}", file=sys.stderr)
        return 1
    if not isinstance(metrics, dict):
        print("[post_run_pipeline][fail] metrics.json must be an object", file=sys.stderr)
        return 1
    if not isinstance(meta, dict):
        meta = {}

    run_obj = metrics.get("run") if isinstance(metrics.get("run"), dict) else {}
    run_id = str(run_obj.get("run_id") or meta.get("run_id") or run_dir.name)
    status = str(metrics.get("status") or "unknown")
    primary = metrics.get("primary") if isinstance(metrics.get("primary"), dict) else {}
    primary_name = str(primary.get("name") or "objective")
    raw_primary_value = primary.get("value")
    primary_value = (
        float(raw_primary_value)
        if isinstance(raw_primary_value, (int, float)) and not isinstance(raw_primary_value, bool)
        else None
    )
    error_type = str(metrics.get("error_type") or "") or None
    error_hint = str(metrics.get("error_hint") or "") or None
    error_signature = str(metrics.get("error_signature") or "") or None

    reflection_dir = args.reflection_dir.resolve()
    reflection_path = reflection_dir / f"{run_id}.md"
    ensure_reflection_stub(
        reflection_path,
        run_id=run_id,
        run_dir=run_dir,
        status=status,
        error_type=error_type,
    )

    watch_snapshot_path: str | None = None
    if env_bool("RELAY_EXP_WATCH_SNAPSHOTS_ENABLED", False):
        tail_lines = max(1, env_int("RELAY_EXP_WATCH_SNAPSHOT_TAIL_LINES", 80))
        snapshot = read_tail(log_path, tail_lines)
        if snapshot:
            snap_path = run_dir / "watch_snapshot.final.log"
            snap_path.write_text(
                "\n".join(
                    [
                        f"# final watch snapshot ({utc_now_iso()})",
                        f"# run_id={run_id}",
                        "",
                        snapshot,
                        "",
                    ]
                ),
                encoding="utf-8",
            )
            watch_snapshot_path = str(snap_path)

    experience_path = args.experience.resolve()
    if not args.skip_experience:
        experience_row: dict[str, Any] = {
            "recorded_at": utc_now_iso(),
            "run_id": run_id,
            "status": status,
            "template_id": args.template_id.strip() or None,
            "study_id": args.study_id.strip() or None,
            "primary": {
                "name": primary_name,
                "value": primary_value,
                "higher_is_better": primary.get("higher_is_better")
                if isinstance(primary.get("higher_is_better"), bool)
                else None,
            },
            "error_type": error_type,
            "error_hint": error_hint,
            "error_signature": error_signature,
            "job_id": run_obj.get("job_id"),
            "task_id": run_obj.get("task_id"),
            "paths": {
                "run_dir": str(run_dir),
                "metrics": str(metrics_path),
                "meta": str(meta_path),
                "train_log": str(log_path),
                "registry": str(registry_path),
                "rolling_report": str(rolling_report_path),
                "experience": str(experience_path),
                "reflection": str(reflection_path),
                "watch_snapshot": watch_snapshot_path,
            },
        }
        append_jsonl(experience_path, experience_row)
        print(f"[post_run_pipeline] appended experience: {experience_path}")
    else:
        print("[post_run_pipeline] experience logging skipped (--skip-experience)")

    handoff_path = args.handoff.resolve()
    wm_path = args.working_memory.resolve()
    handoff_entry = build_handoff_entry(
        run_id=run_id,
        run_dir=run_dir,
        status=status,
        primary_name=primary_name,
        primary_value=primary_value,
        error_type=error_type,
        registry=registry_path,
        report=rolling_report_path,
        experience=experience_path,
        reflection=reflection_path,
    )
    wm_entry = build_working_memory_entry(
        run_id=run_id,
        run_dir=run_dir,
        status=status,
        primary_name=primary_name,
        primary_value=primary_value,
        template_id=args.template_id.strip() or None,
        study_id=args.study_id.strip() or None,
        error_type=error_type,
    )
    try:
        append_markdown_update(handoff_path, handoff_entry)
        print(f"[post_run_pipeline] updated handoff: {handoff_path}")
    except Exception as exc:
        print(f"[post_run_pipeline][warn] failed to update handoff: {exc}", file=sys.stderr)
    try:
        append_markdown_update(wm_path, wm_entry)
        print(f"[post_run_pipeline] updated working memory: {wm_path}")
    except Exception as exc:
        print(f"[post_run_pipeline][warn] failed to update working memory: {exc}", file=sys.stderr)

    print(f"[post_run_pipeline] done run_id={run_id} status={status} run_dir={run_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
