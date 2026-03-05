---
name: incident-triage-playbook
description: Use when overnight automation fails; perform minimal high-signal triage and produce recovery steps with mandatory handoff/working-memory updates.
version: 1.0
---

# Incident Triage Playbook

## Purpose

Shorten recovery time after unattended failures while preserving auditability.

## When to use

Use when jobs fail, stall, disappear, or produce incomplete artifacts overnight.

## Minimum triage sequence

1. Identify affected run/job/task IDs.
2. Capture latest logs and process state.
3. Check required artifacts and list what is missing.
4. Classify failure mode with evidence.
5. Propose immediate recovery command.
6. Record prevention candidate.

## Required outputs

1. Triage summary
- symptom
- probable trigger (evidence-based)
- immediate next step

2. Evidence block
- exact log paths
- key command output
- relevant pid/session/task references

3. Memory updates
- append incident summary to `HANDOFF_LOG.md`
- refresh `docs/WORKING_MEMORY.md` with current state and recovery plan

## Classification hints

- callback timing mismatch
- wait-loop/self-match bug
- missing preflight invariant
- watcher/visibility regression
- external dependency outage

## Guardrail rule

Never end triage with "monitor more" only. Provide at least one concrete command or config change to execute next.
