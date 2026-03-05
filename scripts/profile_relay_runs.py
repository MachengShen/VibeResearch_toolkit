#!/usr/bin/env python3
"""Profile relay run behavior from /root/.codex-discord-relay/relay.log.

Focus:
- run duration and queue delay
- progress-note mix (thinking vs action vs stall vs polling)
- repeated polling patterns
- actionable optimization hints
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
from collections import Counter, defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


def parse_iso(value: str) -> Optional[datetime]:
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def fmt_seconds(seconds: Optional[float]) -> str:
    if seconds is None:
        return "n/a"
    s = max(0.0, float(seconds))
    if s < 60:
        return f"{s:.1f}s"
    m, rs = divmod(int(round(s)), 60)
    if m < 60:
        return f"{m}m{rs:02d}s"
    h, rm = divmod(m, 60)
    return f"{h}h{rm:02d}m"


def short_conversation_key(key: str) -> str:
    text = str(key or "")
    if "thread:" in text:
        return text.split("thread:", 1)[1]
    if "channel:" in text:
        return text.split("channel:", 1)[1]
    return text[-36:] if len(text) > 36 else text


def classify_progress_note(note: str, synthetic: bool) -> str:
    text = str(note or "").strip()
    lower = text.lower()
    if lower.startswith("thinking:"):
        return "thinking"
    if lower.startswith("running shell command:") or lower.startswith("running tool:"):
        if "tail -n" in lower or "sleep " in lower or "poll" in lower:
            return "polling"
        return "action"
    if lower.startswith("shell command finished") or lower.startswith("tool finished"):
        return "action_result"
    if "no new agent events" in lower or "possible stall" in lower:
        return "stall"
    if "waiting for an earlier request" in lower:
        return "queue_wait"
    if lower.startswith("queued request") or lower.startswith("starting "):
        return "overhead"
    if synthetic:
        return "synthetic"
    return "other"


def normalize_note_for_repeat(note: str) -> str:
    text = str(note or "").strip()
    text = re.sub(r"\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+\-]\d{2}:\d{2})", "<iso>", text, flags=re.I)
    text = re.sub(r"\b\d+\b", "<n>", text)
    return text


@dataclass
class ProgressNote:
    at: datetime
    text: str
    synthetic: bool


@dataclass
class RunRecord:
    run_id: str
    conversation_key: str
    reason: str
    provider: str
    started_at: datetime
    queued_at: Optional[datetime] = None
    ended_at: Optional[datetime] = None
    status: str = "running"
    duration_ms: Optional[int] = None
    result_chars: Optional[int] = None
    transient_retries: int = 0
    notes: List[ProgressNote] = field(default_factory=list)
    stale_alerts: int = 0

    def duration_seconds(self) -> Optional[float]:
        if self.duration_ms is not None:
            return max(0.0, self.duration_ms / 1000.0)
        if self.ended_at is not None and self.started_at is not None:
            return max(0.0, (self.ended_at - self.started_at).total_seconds())
        return None

    def queue_delay_seconds(self) -> Optional[float]:
        if self.queued_at is None:
            return None
        return max(0.0, (self.started_at - self.queued_at).total_seconds())

    def end_timestamp_for_notes(self) -> datetime:
        if self.ended_at is not None:
            return self.ended_at
        guess = self.duration_seconds()
        if guess is not None:
            return self.started_at + timedelta(seconds=guess)
        return self.started_at


def parse_relay_events(log_path: Path) -> Iterable[Dict[str, Any]]:
    with log_path.open("r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            raw = line.strip()
            if not raw.startswith("{"):
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if obj.get("subsystem") != "relay-runtime":
                continue
            at = parse_iso(str(obj.get("at", "")))
            if at is None:
                continue
            obj["_at"] = at
            yield obj


def build_run_records(events: Iterable[Dict[str, Any]], since: Optional[datetime], conversation_key: Optional[str]) -> List[RunRecord]:
    runs: List[RunRecord] = []
    active_by_conv: Dict[str, RunRecord] = {}
    by_run_id: Dict[str, RunRecord] = {}
    queued_by_conv: Dict[str, deque] = defaultdict(deque)
    queued_by_run_id: Dict[str, datetime] = {}
    legacy_counter = 0

    for evt in events:
        at: datetime = evt["_at"]
        if since and at < since:
            continue
        conv = str(evt.get("conversationKey") or "").strip()
        if not conv:
            continue
        if conversation_key and conv != conversation_key:
            continue
        event = str(evt.get("event") or "").strip()
        run_id = str(evt.get("runId") or "").strip()

        if event == "message.queued":
            if run_id:
                queued_by_run_id[run_id] = at
            else:
                queued_by_conv[conv].append(at)
            continue

        if event == "agent.run.start":
            if not run_id:
                legacy_counter += 1
                run_id = f"legacy-run-{legacy_counter:05d}"
            queued_at = queued_by_run_id.pop(run_id, None)
            if queued_at is None:
                # Drop stale queue markers first.
                while queued_by_conv[conv] and (at - queued_by_conv[conv][0]).total_seconds() > 6 * 3600:
                    queued_by_conv[conv].popleft()
            if queued_at is None and queued_by_conv[conv]:
                queued_at = queued_by_conv[conv].popleft()
            run = RunRecord(
                run_id=run_id,
                conversation_key=conv,
                reason=str(evt.get("reason") or "").strip() or "request",
                provider=str(evt.get("provider") or "").strip() or "unknown",
                started_at=at,
                queued_at=queued_at,
            )
            runs.append(run)
            active_by_conv[conv] = run
            by_run_id[run_id] = run
            continue

        if event == "agent.progress.note":
            note_text = str(evt.get("note") or "").strip()
            if not note_text:
                continue
            target: Optional[RunRecord] = None
            if run_id and run_id in by_run_id:
                target = by_run_id[run_id]
            if target is None:
                target = active_by_conv.get(conv)
            if target is None:
                continue
            target.notes.append(
                ProgressNote(
                    at=at,
                    text=note_text,
                    synthetic=bool(evt.get("synthetic", False)),
                )
            )
            continue

        if event == "job.watch.stale_progress":
            target = active_by_conv.get(conv)
            if target is not None:
                target.stale_alerts += 1
            continue

        if event in {"agent.run.done", "message.failed"}:
            target = None
            if run_id and run_id in by_run_id:
                target = by_run_id[run_id]
            if target is None:
                target = active_by_conv.get(conv)
            if target is None:
                continue
            target.ended_at = at
            target.duration_ms = int(evt.get("durationMs")) if evt.get("durationMs") is not None else target.duration_ms
            target.result_chars = int(evt.get("resultChars")) if evt.get("resultChars") is not None else target.result_chars
            target.transient_retries = int(evt.get("transientRetries") or 0)
            target.status = "failed" if event == "message.failed" else "completed"
            if active_by_conv.get(conv) is target:
                del active_by_conv[conv]
            continue

    return runs


def summarize_run(run: RunRecord) -> Dict[str, Any]:
    duration_sec = run.duration_seconds()
    queue_delay_sec = run.queue_delay_seconds()
    notes = sorted(run.notes, key=lambda n: n.at)

    cat_counts: Counter = Counter()
    cat_seconds: Dict[str, float] = defaultdict(float)
    repeat_counter: Counter = Counter()

    for n in notes:
        cat = classify_progress_note(n.text, n.synthetic)
        cat_counts[cat] += 1
        repeat_counter[normalize_note_for_repeat(n.text)] += 1

    if notes and duration_sec is not None:
        end_at = run.end_timestamp_for_notes()
        for idx, n in enumerate(notes):
            start = n.at
            nxt = notes[idx + 1].at if idx + 1 < len(notes) else end_at
            if nxt <= start:
                continue
            cat = classify_progress_note(n.text, n.synthetic)
            cat_seconds[cat] += (nxt - start).total_seconds()

    repeated = [(k, v) for k, v in repeat_counter.items() if v >= 2]
    repeated.sort(key=lambda kv: (-kv[1], kv[0]))

    hints: List[str] = []
    think_share = (cat_seconds.get("thinking", 0.0) / duration_sec) if duration_sec and duration_sec > 0 else 0.0
    polling_share = (cat_seconds.get("polling", 0.0) / duration_sec) if duration_sec and duration_sec > 0 else 0.0
    action_share = (cat_seconds.get("action", 0.0) / duration_sec) if duration_sec and duration_sec > 0 else 0.0
    stall_count = cat_counts.get("stall", 0)
    polling_repeats = sum(v for k, v in repeated if "tail -n" in k.lower() or "sleep " in k.lower() or "poll" in k.lower())

    if duration_sec and duration_sec >= 20 * 60 and think_share >= 0.35 and action_share <= 0.25:
        hints.append("High thinking-time share on a long run; prefer callback/watch mode and analyze on artifact checkpoints.")
    if polling_share >= 0.20 or polling_repeats >= 3:
        hints.append("Polling-heavy pattern detected; switch to `job_start + watch + thenTask` and reduce foreground babysitting.")
    if stall_count >= 2 or run.stale_alerts >= 1:
        hints.append("Stall signals observed; add artifact gates or low-frequency watcher heartbeat to avoid noisy loops.")
    if queue_delay_sec is not None and queue_delay_sec >= 30:
        hints.append("Queue delay is significant; thread had an active in-flight run.")
    if not notes:
        hints.append("No fine-grained progress notes in log. Enable `RELAY_PROGRESS_TRACE_ENABLED=true` for detailed profiling.")

    return {
        "run_id": run.run_id,
        "conversation_key": run.conversation_key,
        "reason": run.reason,
        "provider": run.provider,
        "status": run.status,
        "started_at": run.started_at.isoformat(),
        "ended_at": run.ended_at.isoformat() if run.ended_at else None,
        "duration_sec": duration_sec,
        "queue_delay_sec": queue_delay_sec,
        "result_chars": run.result_chars,
        "transient_retries": run.transient_retries,
        "stale_alerts": run.stale_alerts,
        "note_count": len(notes),
        "category_counts": dict(cat_counts),
        "category_seconds": dict(cat_seconds),
        "repeated_notes": repeated[:5],
        "hints": hints,
    }


def render_text_report(log_path: Path, run_summaries: List[Dict[str, Any]]) -> str:
    lines: List[str] = []
    lines.append(f"Relay Run Profile")
    lines.append(f"log: {log_path}")
    lines.append(f"runs_analyzed: {len(run_summaries)}")

    durations = [r["duration_sec"] for r in run_summaries if isinstance(r.get("duration_sec"), (int, float))]
    queue_delays = [r["queue_delay_sec"] for r in run_summaries if isinstance(r.get("queue_delay_sec"), (int, float))]
    traced_runs = [r for r in run_summaries if int(r.get("note_count") or 0) > 0]
    if durations:
        p50 = statistics.median(durations)
        p90 = statistics.quantiles(durations, n=10)[8] if len(durations) >= 10 else max(durations)
        lines.append(f"duration: p50={fmt_seconds(p50)} p90={fmt_seconds(p90)} max={fmt_seconds(max(durations))}")
    if queue_delays:
        lines.append(f"queue_delay: avg={fmt_seconds(sum(queue_delays) / len(queue_delays))} max={fmt_seconds(max(queue_delays))}")
    lines.append(f"trace_coverage: {len(traced_runs)}/{len(run_summaries)} runs with progress-note telemetry")
    lines.append("")

    for idx, run in enumerate(run_summaries, start=1):
        conv_short = short_conversation_key(run["conversation_key"])
        lines.append(
            f"{idx}. {run['run_id']} [{run['status']}] conv={conv_short} reason={run['reason']} "
            f"duration={fmt_seconds(run.get('duration_sec'))} queue_delay={fmt_seconds(run.get('queue_delay_sec'))}"
        )
        lines.append(
            f"   notes={run['note_count']} retries={run['transient_retries']} stale_alerts={run['stale_alerts']} result_chars={run.get('result_chars')}"
        )
        cat_counts = run.get("category_counts") or {}
        if cat_counts:
            cat_bits = ", ".join(f"{k}:{v}" for k, v in sorted(cat_counts.items(), key=lambda kv: (-kv[1], kv[0])))
            lines.append(f"   categories: {cat_bits}")
        repeats = run.get("repeated_notes") or []
        if repeats:
            top = "; ".join(f"{n}x {t}" for t, n in [(k, v) for k, v in repeats[:3]])
            lines.append(f"   repeated: {top}")
        for hint in run.get("hints") or []:
            lines.append(f"   hint: {hint}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Profile codex-discord-relay run behavior from relay.log.")
    parser.add_argument("--log", default="/root/.codex-discord-relay/relay.log", help="Path to relay.log")
    parser.add_argument("--conversation-key", default="", help="Filter to one conversation key")
    parser.add_argument("--since-minutes", type=int, default=24 * 60, help="Only include events from last N minutes")
    parser.add_argument("--limit-runs", type=int, default=25, help="Show up to N most recent runs")
    parser.add_argument("--include-open", action="store_true", help="Include runs without terminal done/failed events")
    parser.add_argument("--json", action="store_true", help="Emit JSON report")
    args = parser.parse_args()

    log_path = Path(args.log).expanduser().resolve()
    if not log_path.exists():
        raise SystemExit(f"log file not found: {log_path}")

    since = None
    if args.since_minutes and args.since_minutes > 0:
        since = datetime.now(timezone.utc) - timedelta(minutes=args.since_minutes)

    runs = build_run_records(
        events=parse_relay_events(log_path),
        since=since,
        conversation_key=args.conversation_key.strip() or None,
    )
    if not args.include_open:
        runs = [r for r in runs if r.status in {"completed", "failed"}]
    runs.sort(key=lambda r: r.started_at, reverse=True)
    runs = runs[: max(1, args.limit_runs)]
    summaries = [summarize_run(r) for r in runs]

    if args.json:
        print(
            json.dumps(
                {
                    "log": str(log_path),
                    "since_minutes": args.since_minutes,
                    "conversation_key": args.conversation_key.strip() or None,
                    "runs": summaries,
                },
                indent=2,
                ensure_ascii=False,
            )
        )
    else:
        print(render_text_report(log_path, summaries))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
