# Hemma OS development guide

## Product and scope

Hemma OS is a production household-management application for its owner and partner. It is Swedish in language, financial rules, formats, housing practices, and household context.

Prioritise, in order:

1. Financial correctness and data safety.
2. Ease of use, especially on mobile.
3. Contemporary, cohesive visual quality.

The React/TypeScript/Vite app lives in `web/`, database work in `supabase/`, and proposed work in `planning/`. Treat current behaviour as intentional unless the task changes it. Active plans describe intent, not immutable specifications; `planning/completed/` is historical context and should not be audited during ordinary work.

Ask before changes that materially alter financial meaning, persisted data, security, schema, dependencies, architecture, browser support, agreed UX, or task scope. Routine implementation decisions within an authorised task do not require confirmation.

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
- For material UI work, verify the changed flow at 390x844 and desktop, plus relevant themes and states. Add 320 px, keyboard, loading/error, touch, and animation checks when the change affects them. Use fictional data.

## Workflow

- Inspect the current branch and `git status` before editing. Preserve unrelated changes; ask only when the task overlaps them or risks overwriting them.
- Continue on the active task branch for follow-ups. For a new task, start a branch from an up-to-date `main`. Never implement directly on `main`, which deploys production.
- Use `feat/<plan-number>-<slug>` for planned features and concise `fix/`, `refactor/`, or `docs/` names otherwise.
- Add automated coverage for behavioural, financial, persistence, and bug-fix changes when practical. Develop calculation and persistence changes test-first. Purely visual fixes may use targeted browser regression evidence when no suitable component harness exists.
- Use focused tests while developing, then run the complete relevant suite. Do not weaken tests to accommodate incorrect behaviour. Prove and report unrelated pre-existing failures.
- Ask before adding a test dependency or component-test harness.

For frontend implementation changes, run from `web/`:

```sh
npm run lint
npm run test
npm run build
```

Add relevant database, migration, security, or browser checks. Documentation-only work requires verified paths, commands, and claims rather than invented tests.

## Completion and Git

A change is complete when the requested behaviour is implemented, relevant checks pass, important UI is verified, data and security implications are covered, and remaining risks or manual checks are reported.

For implementation tasks, commit and push verified changes. Open a ready-for-review PR if one does not already exist. Keep one feature or plan per branch and PR. Never merge, deploy, access production data, or administer production; only the repository owner merges.
