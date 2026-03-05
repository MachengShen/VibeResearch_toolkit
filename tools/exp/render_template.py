#!/usr/bin/env python3
"""Render experiment template YAML into a concrete command/watch payload."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import random
import string
import sys
from typing import Any


def utc_now_compact() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S")


def random_suffix(n: int = 4) -> str:
    alphabet = string.ascii_lowercase + string.digits
    return "".join(random.choice(alphabet) for _ in range(n))


def parse_kv(items: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for item in items:
        if "=" not in item:
            raise ValueError(f"expected key=value, got: {item}")
        key, value = item.split("=", 1)
        key = key.strip()
        if not key:
            raise ValueError(f"invalid key in assignment: {item}")
        out[key] = value
    return out


def load_yaml(path: pathlib.Path) -> Any:
    try:
        import yaml  # type: ignore
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("PyYAML is required (pip install pyyaml)") from exc
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def find_template(templates_dir: pathlib.Path, template_id: str) -> tuple[pathlib.Path, dict[str, Any]]:
    if not templates_dir.is_dir():
        raise FileNotFoundError(f"templates dir not found: {templates_dir}")
    for path in sorted(templates_dir.glob("*.yaml")):
        raw = load_yaml(path)
        if not isinstance(raw, dict):
            continue
        candidate = raw.get("id")
        if not isinstance(candidate, str) or not candidate:
            candidate = path.stem
        if candidate == template_id:
            return path, raw
    raise FileNotFoundError(f"template id not found: {template_id}")


def render_str(template: str, values: dict[str, Any]) -> str:
    try:
        return template.format_map(values)
    except KeyError as exc:
        raise ValueError(f"missing placeholder value: {exc}") from exc


def render_value(value: Any, values: dict[str, Any]) -> Any:
    if isinstance(value, str):
        return render_str(value, values)
    if isinstance(value, list):
        return [render_value(v, values) for v in value]
    if isinstance(value, dict):
        return {str(k): render_value(v, values) for k, v in value.items()}
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--template-id",
        "--id",
        dest="template_id",
        required=True,
        help="Template id from templates/experiments/*.yaml",
    )
    parser.add_argument(
        "--templates-dir",
        type=pathlib.Path,
        default=pathlib.Path("templates/experiments"),
        help="Directory containing YAML templates",
    )
    parser.add_argument(
        "--set",
        "--param",
        dest="set_values",
        action="append",
        default=[],
        help="Template value override in key=value form",
    )
    parser.add_argument("--run-id", help="Run id override (default generated)")
    parser.add_argument("--run-dir", help="Run dir override (default exp/results/<run_id>)")
    parser.add_argument("--compact", action="store_true", help="Compact JSON output")
    args = parser.parse_args()

    try:
        template_path, template = find_template(args.templates_dir.resolve(), args.template_id)
    except Exception as exc:
        print(f"[render_template][fail] {exc}", file=sys.stderr)
        return 1

    defaults = template.get("defaults") if isinstance(template.get("defaults"), dict) else {}
    try:
        overrides = parse_kv(list(args.set_values))
    except ValueError as exc:
        print(f"[render_template][fail] {exc}", file=sys.stderr)
        return 1

    run_id = args.run_id.strip() if isinstance(args.run_id, str) and args.run_id.strip() else f"r{utc_now_compact()}-{random_suffix()}"
    run_dir = args.run_dir.strip() if isinstance(args.run_dir, str) and args.run_dir.strip() else f"exp/results/{run_id}"

    values: dict[str, Any] = {}
    values.update(defaults)
    values.update(overrides)
    values.setdefault("run_id", run_id)
    values.setdefault("run_dir", run_dir)
    values.setdefault("out_dir", f"{run_dir}/artifacts")

    command = template.get("command")
    if not isinstance(command, list) or not all(isinstance(part, (str, int, float)) for part in command):
        print("[render_template][fail] template command must be a list", file=sys.stderr)
        return 1

    try:
        rendered_command = [render_str(str(part), values) for part in command]
        rendered_watch = render_value(template.get("watch") if isinstance(template.get("watch"), dict) else {}, values)
        rendered_artifacts = render_value(
            template.get("artifacts") if isinstance(template.get("artifacts"), dict) else {},
            values,
        )
    except ValueError as exc:
        print(f"[render_template][fail] {exc}", file=sys.stderr)
        return 1

    if not isinstance(rendered_watch, dict):
        rendered_watch = {}
    if not isinstance(rendered_artifacts, dict):
        rendered_artifacts = {}

    rendered_artifacts.setdefault("metrics", f"{run_dir}/metrics.json")
    rendered_artifacts.setdefault("meta", f"{run_dir}/meta.json")
    rendered_artifacts.setdefault("log", f"{run_dir}/train.log")

    rendered_watch.setdefault(
        "requireFiles",
        [rendered_artifacts["metrics"], rendered_artifacts["meta"], rendered_artifacts["log"]],
    )

    primary_metric = template.get("primary_metric") if isinstance(template.get("primary_metric"), dict) else {}
    if not isinstance(primary_metric, dict):
        primary_metric = {}

    payload = {
        "template_id": template.get("id") or template_path.stem,
        "template_path": str(template_path),
        "description": template.get("description") if isinstance(template.get("description"), str) else "",
        "run_id": run_id,
        "run_dir": run_dir,
        "values": values,
        "command": rendered_command,
        "watch": rendered_watch,
        "primary_metric": {
            "name": primary_metric.get("name") if isinstance(primary_metric.get("name"), str) else "objective",
            "higher_is_better": bool(primary_metric.get("higher_is_better", False)),
        },
        "artifacts": rendered_artifacts,
    }

    if args.compact:
        print(json.dumps(payload, sort_keys=True))
    else:
        print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
