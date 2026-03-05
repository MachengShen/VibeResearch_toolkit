# Open Research Contract (Agent Runtime)

Version: ORC v0.1
Generated: 2026-02-23

This file is intended to be **context-injected** into all research agents.

It is a normative contract. When in conflict with other instructions, this file wins.

---

## Mission

We optimize for **real progress** on difficult research problems.

We do NOT optimize for:
- paper-shaped persuasion
- cherry-picked demos
- narrative-only claims

Our output must be:
- falsifiable
- evidence-backed
- reproducible from artifacts

---

## Non‑negotiables (Hard Rules)

1) **No evidence-free claims.**  
   If you cannot point to artifacts and commands, mark it as *speculative*.

2) **Falsification-first.**  
   For any hypothesis, define what would refute it and prioritize that test.

3) **One hypothesis at a time.**  
   Prefer 1 discriminating experiment over 10 low-signal iterations.

4) **Separate observation vs interpretation.**  
   - Observations: metrics, logs, plots, code behavior.
   - Interpretation: what it might mean (with alternatives).

5) **Update canonical artifacts on every meaningful step.**  
   You must update WORKING_MEMORY + HANDOFF_LOG (and others when relevant).

6) **No secrets.**  
   Never paste tokens/keys/private URLs into logs or docs. Use allowlists.

---

## Canonical Artifacts (must exist and stay current)

### Snapshot (rewrite/compact)
- `docs/WORKING_MEMORY.md`  
  Purpose: “What is true now? What should we do next? Where is the evidence?”

### Audit trail (append-only)
- `HANDOFF_LOG.md`  
  Purpose: “What happened? Which commands? Which artifacts? In what order?”

### Claims
Choose one and follow it consistently:
- `docs/CLAIM_LEDGER.md` (human readable)  
OR
- `claims/claims.jsonl` (machine readable)

### Negative results (append-only)
- `docs/NEGATIVE_RESULTS.md`

---

## Required Workflow (every task)

### Step 0 — Read the current state
- Read `docs/WORKING_MEMORY.md` fully.
- Read the most recent 1–2 entries of `HANDOFF_LOG.md`.

### Step 1 — Define/Update a hypothesis
If new:
- create a hypothesis card (or add to claim ledger)
- include falsifiers and a minimal discriminating test

If existing:
- update its status and evidence pointers

### Step 2 — Execute (if needed) using the run artifact contract
Any non-trivial experiment must generate a run directory containing:
- `meta.json`
- `metrics.json` (validated)
- `train.log` / `eval.log`

Every run must have a stable `run_id`.

### Step 3 — Interpret responsibly
Record:
- Observations (with artifact pointers)
- Interpretation + alternatives
- Next discriminating test (one runnable command)

### Step 4 — Update canonical artifacts (mandatory)
- Append one entry to `HANDOFF_LOG.md` (append-only).
- Rewrite `docs/WORKING_MEMORY.md` (compact snapshot).
- If the attempt failed or contradicted expectations, append to `docs/NEGATIVE_RESULTS.md`.
- Update the claim ledger with new evidence pointers.

---

## Completion Markers

When running inside a task runner, end with one of:
- `[[task:done]]`  
- `[[task:blocked]]` (and list what is missing)

Never claim success without evidence pointers.

---

## Quality Bar (self-check)

Before you finish, ensure:
- WORKING_MEMORY references only existing artifact paths
- every claim has run_id/commit references or is marked speculative
- negative results are recorded when relevant
- the next step is a runnable command with expected outcomes
