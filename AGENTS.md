# Hemma OS development guide

Shared guide for any coding agent working in this repository. Tool-specific
notes live alongside this file (e.g. `CLAUDE.md` imports it and adds its own).

## Product and scope

Hemma OS is a production household-management application for its owner and partner. It is Swedish in language, financial rules, formats, housing practices, and household context.

Prioritise, in order:

1. Financial correctness and data safety.
2. Ease of use, especially on mobile.
3. Contemporary, cohesive visual quality.

Treat current behaviour as intentional unless the task changes it. Active plans describe intent, not immutable specifications; `planning/completed/` is historical context and should not be audited during ordinary work.

Ask before changes that materially alter financial meaning, persisted data, security, schema, dependencies, architecture, browser support, agreed UX, or task scope. Routine implementation decisions within an authorised task do not require confirmation.

## Repository and stack

```text
web/                  React/TypeScript/Vite app (all frontend work)
  src/routes/         one component per tool/page; feature code lives beside its route
  src/lib/            pure domain logic + per-tool stores (calc.ts, konsult.ts, …) and their *.test.ts
  src/store/          useStore.ts — the Zustand app store and its persistence
  src/components/     stable, genuinely shared UI primitives only
  src/styles/         design tokens and CSS
  e2e/                Playwright cross-page specs (save-sync.spec.ts)
supabase/             migrations/, functions/, seed.sql, config.toml, RLS
planning/             proposed and active work (numbered plan docs)
planning/completed/   shipped plans — historical context, do not audit
```

Stack: React 19, TypeScript, Vite, Zustand, React Router, Radix UI, Motion,
three.js + React Three Fiber (hero scene only), visx (charts). Tests: Vitest
(node env by default; component tests opt in per file with
`// @vitest-environment jsdom`), Playwright (e2e), Oxlint.

## Architecture

Preserve this responsibility flow:

```text
React routes/components
  -> state coordination
  -> pure domain logic and persistence adapters
  -> Supabase and local browser storage
```

- Keep financial and domain calculations pure, typed, deterministic, and independent of React, Zustand, Supabase, and browser APIs. Put them in `web/src/lib/`.
- Keep business rules out of JSX, effects, and event handlers. Components may perform trivial display transformations.
- Route ordinary database access through stores or persistence adapters and preserve the authentication boundary.
- Keep feature-specific code beside its route. Promote only stable, genuinely shared primitives.
- Prefer clarity over aggressive DRY. Reuse existing UI primitives and design tokens; ask before adding a styling system or component library.
- Propose substantial refactors separately. Do not mix unrelated cleanup into a task.

## Financial correctness and data safety

- Never guess unclear financial meaning. Ask with a concrete interpretation and example calculation.
- Verify changed Swedish tax, mortgage, amortisation, housing, or legal rules against current authoritative sources. Record the source and effective year near statutory constants or relevant documentation. Do not update statutory values during unrelated work.
- Preserve calculation precision and round for display unless a domain rule requires otherwise. Use Swedish locale conventions and consistent terminology, formulas, rounding, and time bases.
- Clearly label observed values, estimates, forecasts, hypotheticals, and cross-tool synced values. Treat financial wording as potentially semantic.
- Cover every changed user-facing financial result with automated calculation tests using realistic fictional golden values, relevant thresholds, malformed or missing data, rounding boundaries, and permitted extremes.
- Do not silently clamp or correct invalid financial input without an explicit product decision.

The application contains real household data. Production data and administration are off limits without specific approval; local development and fictional seed data are allowed.

- Never expose secrets, tokens, `.env` files, personal records, or sensitive logs, or send household data to third parties without approval.
- Do not weaken authentication, authorisation, CSP, RLS, input safety, or household isolation.
- Every persisted entity must deliberately choose household- or user-level ownership.
- Validate and migrate persisted shapes defensively. Repeatable migrations and merge functions must be idempotent and tested against malformed or legacy data when relevant.
- Never edit an applied Supabase migration; create a new one. Schema, RLS, authentication, and security changes require approval and relevant automated tests.
- Production changes are prohibited. Local migrations and read-only local database checks are allowed within an authorised task.
- Do not promise offline synchronisation without a retry and conflict model. Surface save failures when data loss matters.

## UX

- Design mobile-first and prevent page-level horizontal overflow. Preserve the existing typography, green/copper palette, tokens, and visual language unless the task changes them.
- Use concise Swedish UI copy. Keep code, comments, tests, commits, and technical documentation in English.
- Use semantic, keyboard-operable controls with visible focus, labels, adequate contrast, and no colour-only meaning.
- Avoid layout jumps, misleading loading values, and interaction-blocking animation. Use progressive disclosure and give empty states one clear primary action.
- Destructive actions require confirmation or reliable undo appropriate to the consequence.
- For material UI work, verify the changed flow at 390x844 and desktop, plus relevant themes and states. Add 320 px, keyboard, loading/error, touch, and animation checks when the change affects them.
- Run UI verification against the local dev server only (`npm run dev`, http://localhost:5174), which uses local Supabase with dev auth. Never verify against production or live household data; use fictional data.
- If the server is unreachable because a stale instance is already holding the port, stop that instance and start a fresh one before testing.
- Drive interactive verification with Playwright against that dev server (agents with a Playwright MCP server should use it); this is separate from the scripted `e2e/` suite, which runs against a preview build.
- Leave the dev server running after verification so the owner can review the change before confirming the merge.

## Testing and verify gates

Add automated coverage for behavioural, financial, persistence, and bug-fix changes when practical. Develop calculation and persistence changes test-first. Purely visual fixes may use targeted browser regression evidence when no suitable component harness exists. Ask before adding a test dependency or component-test harness.

Use focused tests while developing, then run the complete relevant suite. Do not weaken tests to accommodate incorrect behaviour. Prove and report unrelated pre-existing failures.

Run before opening a PR, from `web/`:

```sh
npm run lint    # Oxlint
npm run test    # Vitest (vitest run)
npm run build   # tsc -b + vite build — the ONLY real typecheck here
```

`npm run build` is the only command that actually typechecks; plain
`tsc --noEmit` is a no-op in this project. Add relevant database, migration,
security, or browser checks. Documentation-only work requires verified paths,
commands, and claims rather than invented tests.

### Writes, failures, and cache/cloud disagreement

If a change touches `src/store/useStore.ts`, `src/lib/storage.ts`, or any
component's data-mutation handlers (save/delete/import), answer this before
writing the PR: **does it change what happens when a write succeeds, fails, or
the cache and cloud disagree?** If yes, a pure-function/state-transition unit
test is not enough — add or extend one of:

- a store-layer test with a mocked Supabase client (see
  `src/store/useStore.test.ts` and the shared `createSupabaseMock()` in
  `src/lib/testSupabaseMock.ts`) asserting the success **and** failure path.
- a component test (`// @vitest-environment jsdom`) asserting the user actually
  sees the failure — a toast, a dialog staying open, a retry affordance. "The
  store throws" is not the same as "the user finds out."
- for a cross-page flow (save → reload → still there), extend
  `web/e2e/save-sync.spec.ts` rather than a one-off manual Playwright script.

This rule exists because two incidents (a scenario-wipe and a swallowed
save-error) both passed CI clean and were caught only by later manual audit; in
both cases the missing test was exactly this kind, not a missing pure-function
test.

## Workflow

- Inspect the current branch and `git status` before editing. Preserve unrelated changes; ask only when the task overlaps them or risks overwriting them.
- Continue on the active task branch for follow-ups. For a new task, start a branch from an up-to-date `main`. Never implement directly on `main`, which deploys production. Re-check the branch immediately before each commit — merges move `HEAD`.
- Use `feat/<plan-number>-<slug>` for planned features and concise `fix/`, `refactor/`, or `docs/` names otherwise.
- Keep commits small and focused with imperative English messages. One feature or plan per branch and PR; every PR bases off `main` (no stacked PRs).
- Attribute agent-authored commits to the agent, not the owner: stage with `git add .`, set the author with `--author`, and do not add a `Co-Authored-By` footer. Use the identity for whichever agent is committing, for example:
  - Claude: `git commit --author="Claude <claude@anthropic.com>" -m "…"`
  - ChatGPT / Codex: `git commit --author="ChatGPT <chatgpt@users.noreply.github.com>" -m "…"`

### Plan lifecycle

Plans live as numbered markdown files in `planning/` with a short metadata
header (Status, Owner, Source, Touches). When a plan's PR is opened, move its
file into `planning/completed/`. When planning a batch, keep the
`planning/README.md` index in sync.

### Executing plans

When the owner asks to start or implement a plan (or several):

- **One plan at a time, in order.** If several plans are named, action them
  sequentially in the given order (or the batch's build order when unspecified),
  each on its own branch and PR, base `main`, landed before the next starts — no
  stacked PRs. Finish and report a plan before beginning the next.
- **Delegate every stage to a subagent — even within one plan.** A plan's
  `## Execution` section lists its stages; run **each** stage in its own subagent
  of the tagged model, not the whole plan in one pass, and not only when stages
  span different tiers. Same-tier consecutive stages still get separate
  subagents. Run the stage's own gate before moving to the next, and preserve the
  stated stage order and dependencies. When a plan has no `## Execution` section
  (a genuinely single-stage plan), one subagent of the `Owner model` tier is
  enough.
- **The orchestrating agent keeps the clarify gate.** Do not hand a subagent a
  stage that still needs an undecided call on financial meaning, persisted-data
  semantics, schema, or security. Resolve it with the owner first (concrete
  interpretation + example), then dispatch. A stage marked `[escalate]`
  must never be guessed by a cold subagent. Verification, financial-correctness
  gates, and the final report stay the orchestrator's responsibility.

## Completion and Git

A change is complete when the requested behaviour is implemented, relevant checks pass, important UI is verified, data and security implications are covered, and remaining risks or manual checks are reported.

For implementation tasks, commit and push verified changes. Open a ready-for-review PR if one does not already exist. Keep one feature or plan per branch and PR. Never merge, deploy, access production data, or administer production; only the repository owner merges.
