---
name: pr-acceptance-tests-writer
description: Use when preparing or reviewing a PR; produce runtime-first acceptance tests with copy/paste commands, expected outcomes, and log locations.
version: 1.0
---

# PR Acceptance Tests Writer

## Purpose

Create fast, executable PR validation checklists that prove behavior, not just syntax.

## When to use

Use for every non-trivial PR, especially relay/runtime/automation changes.

## Required output

Provide a test checklist with:

1. Setup/preconditions
2. Runtime smoke tests per modified entrypoint
3. Negative-path test (expected failure)
4. Rollback/disable check (feature flag or config off)
5. Expected outputs + log paths

## Runtime > syntax rule

Syntax checks are necessary but not sufficient. Include at least one runtime command for each changed surface.

Examples:

- `node codex-discord-relay/relay.js --help` (or safe dry invocation)
- `bash scripts/vr_run.sh --help`
- `python3 tools/exp/<tool>.py --help`

## Output template

```markdown
## Acceptance Checklist

1. <test name>
```bash
<command>
```
Expected:
- <stdout/stderr fragment>
- <exit code>
- <artifact/log path>

2. <test name>
...

## Test Result Summary
- PASS:
- FAIL:
- SKIPPED:
```

## Quality rules

- Keep commands copy/paste ready.
- Prefer under-5-minute tests for user re-runs.
- Include exact evidence paths for failures.
