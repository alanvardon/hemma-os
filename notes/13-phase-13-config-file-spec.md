# Handoff — Phase 13 config file spec added to orchestrator PLAN.md

## What happened in this session

The previous session implemented Phase 7 (retry loop) of the LangGraph
orchestrator. This session **did not write any code** — it only extended
[`orchestrator/PLAN.md`](../orchestrator/PLAN.md) with a new Phase 13
specification for a user-facing TOML config file.

The motivation: the user wants the orchestrator to feel plug-and-play
for end users, abstracting away configuration complexity. Specifically
they asked whether granular `human_in_loop` toggles per agent stage were
possible (yes — `interrupt()` is a per-call-site primitive).

## What changed

One file modified: [`orchestrator/PLAN.md`](../orchestrator/PLAN.md).

- New section **Phase 13 — User-facing config file (1 hour)** inserted
  between Phase 12 and "What to skip on the first pass".
- "Open design questions" entry on QA-failure interruptibility updated to
  reference Phase 13.
- "What to skip on the first pass" entry on QA failures as interrupts
  updated similarly.
- Time-estimate table extended with Phase 13 (1h) → new total ~11–16h.

The Phase 13 spec defines an optional `orchestrator.toml` at the project
root with these fields (see PLAN.md for full TOML example and wiring steps):

- `max_retries` — replaces the hardcoded `range(1, 4)` in workflow.py
- `db_path` — checkpointer location
- `[models]` — per-agent overrides (planning / implementation / qa)
- `[human_in_loop]` — 5 toggles: `approve_plan`, `approve_branch`,
  `approve_implementation`, `approve_qa_failure`, `approve_pr`
- `[branch] max_slug_length` — currently magic 50 in `_slugify`
- `[pr]` — `base_branch`, `draft`, `reviewers`, `labels`

Explicitly **not** configurable (documented in the spec):

- System prompts (coupled to structured-output schemas)
- Allowed-tools lists per agent (security-sensitive — QA must stay read-only)
- Per-attempt mode logic (`implement` vs `fix`)

Rejected outright during the discussion (not in spec):

- `pr.auto_merge` — defeats the purpose of opening a PR
- `timeouts` per task — wrong-sized values kill legitimate long runs
- `cost_caps` — needs token-accounting infra; already on the skip list

## State of the codebase

- **No uncommitted code changes** from this session — PLAN.md only.
- Phase 7 (from the prior session) is still **uncommitted** on `main`.
  Check `git status` to confirm.
- Phases 0–7 are implemented. Phases 8–13 are spec only.

## Suggested next steps

1. Commit and PR the Phase 7 retry loop (still pending from prior session).
2. Implement Phase 8 (human-in-loop interrupt for plan approval) — this
   is the baseline that Phase 13's `approve_plan` toggle will gate.
3. Implementation order for the remaining phases is the order in
   PLAN.md: 8 → 9 → 10 → 11 → 12 → 13. Phase 13 should come last because
   it needs real interrupt sites (Phase 8) and real CLI/MCP entry points
   (Phases 10–12) to gate.

## Suggested skills for the next session

- `/loop` or direct implementation work — no planning skill needed since
  PLAN.md is already the authoritative spec.
- For Phase 8 specifically: read PLAN.md's pedagogical landmine #4
  (`interrupt()` re-runs its calling task on resume — side effects must
  come after the interrupt) before touching the workflow.

## References

- Spec: [`orchestrator/PLAN.md`](../orchestrator/PLAN.md) — Phase 13 section
- Workflow code being parameterised:
  [`orchestrator/orchestrator/workflow.py`](../orchestrator/orchestrator/workflow.py),
  [`orchestrator/orchestrator/git_ops.py`](../orchestrator/orchestrator/git_ops.py)
- Prior handoff covering Phases 0–6:
  [`12-langgraph-orchestrator-port.md`](./12-langgraph-orchestrator-port.md)
