---
name: release-hardening-checklist
description: Use before public release; verify CI/lint/license/docs/safe defaults and identify release blockers with concrete fixes.
version: 1.0
---

# Release Hardening Checklist

## Purpose

Prevent avoidable release regressions by enforcing a minimal public-readiness gate.

## When to use

Use before tagging, publishing, or handing a branch to external users.

## Required checklist

1. Scripts hygiene
- valid shebang and newline discipline
- shell strict mode where expected
- executable bits for runnable scripts

2. CI + lint
- CI workflow present and green for core checks
- lint/format/static checks documented and runnable

3. Legal/docs
- `LICENSE` present
- `README.md` accurate
- `CONTRIBUTING.md` or equivalent onboarding note

4. Safe defaults
- no dangerous default paths (for example unrestricted `/root` writes)
- feature flags default to safe/off for powerful operations
- secrets are never logged in sample configs

5. Rollback readiness
- clear disable flag(s)
- quick revert instructions

## Required output

Produce:

- release status: `ready` or `blocked`
- blocker list with file paths
- exact remediation steps
- final verify command list
