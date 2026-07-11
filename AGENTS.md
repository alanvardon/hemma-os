# Hemma OS development guide

## Product and priorities

Hemma OS is a production household-management application for the repository owner and their partner. It currently focuses on finance and is fundamentally Swedish in language, rules, formats, housing practices, and household context.

Prioritise, in order:

1. Financial correctness.
2. Ease of use, especially on mobile.
3. Contemporary visual quality and polished interaction.

The product should feel sharp, cohesive, and exceptionally well made. Never trade away security, financial meaning, maintainability, or data safety for visual novelty.

## Authority and scope

- The user's latest explicit instruction has highest authority.
- Treat current behaviour as intentional unless the task changes it. If code and tests disagree, investigate.
- Active plans describe intent but are not immutable specifications. `planning/completed/` is historical context; do not audit it during ordinary work.
- Suggest improvements, but do not implement unrequested ideas or cleanup.
- Ask before changing financial or persisted-data semantics, security boundaries, architecture, dependencies, browser support, material UX, or task scope.
- If one decision is blocked, continue safe independent work.
- Report meaningful deviations, risks, and manual checks at completion.

The product is the React/TypeScript/Vite app in `web/`, with database work in `supabase/` and proposed work in `planning/`.

## Architecture

Preserve this responsibility flow:

```text
React routes/components
  -> state coordination
  -> pure domain logic and persistence adapters
  -> Supabase and local browser storage
```

- Keep financial/domain calculations pure, typed, deterministic, and independent of React, Zustand, Supabase, and browser APIs. Put them in `web/src/lib/`.
- Keep business rules out of JSX, effects, and event handlers. Components may perform trivial display transformations.
- Route ordinary database access through stores or persistence adapters; preserve the existing authentication boundary.
- Decompose by cohesion, not line count. Keep feature-specific code beside its route and promote only stable, genuinely shared primitives.
- Prefer clarity over aggressive DRY. Abstract only concepts with genuinely shared meaning and change patterns.
- Reuse existing UI primitives and design tokens. Do not introduce a new styling system or component library without approval.
- Propose substantial refactors separately. Do not perform opportunistic cleanup.

## Financial correctness and data safety

- Never guess unclear financial meaning. Ask with a concrete interpretation and example calculation.
- Verify changed Swedish tax, mortgage, amortisation, housing, or legal rules against current authoritative sources. Record the source and effective date/year near statutory constants or relevant documentation.
- Never update statutory values during unrelated work.
- Preserve calculation precision and round for display unless a domain rule requires otherwise.
- Use Swedish locale conventions and consistent terminology, formulas, rounding, and time bases.
- Clearly label observed values, estimates, forecasts, hypotheticals, and cross-tool synced values.
- Treat financial wording changes as potential semantic changes.
- Test material calculations with realistic fictional golden values plus relevant thresholds, missing/malformed data, rounding boundaries, and permitted extremes.
- Do not silently clamp or correct invalid financial input without an explicit product decision.
- Every new or changed user-facing financial result requires automated calculation coverage.

The application contains real household data. Production data and administration are off limits without specific approval. Local development and fictional seed data may be used.

- Never expose secrets, tokens, `.env` files, personal financial records, or sensitive logs, and never send household data to third parties without approval.
- Do not weaken authentication, authorisation, CSP, RLS, input safety, or household isolation.
- Every persisted entity must deliberately choose household- or user-level ownership.
- Validate and migrate persisted shapes defensively; make repeatable migrations/merge functions idempotent and test malformed or legacy data where relevant.
- Never edit an applied Supabase migration; create a new one. Schema, RLS, authentication, and security changes require approval and relevant automated tests.
- Local migrations and read-only local database checks are allowed during an authorised task. Production changes are not.
- Do not promise offline synchronisation without a real retry/conflict model. Surface save failures when data loss matters.

## UX quality

- Design mobile-first. Verify user-visible work at 390x844 and 1440x900; add a 320 px stress check when wrapping, tables, charts, or dense controls are at risk.
- Prevent page-level horizontal overflow. Contained data regions may scroll only with a clear affordance.
- Preserve the existing typography, green/copper palette, design tokens, and visual language unless the task changes them.
- Aim for contemporary Scandinavian polish, strong hierarchy, purposeful motion, and responsive interaction. Performance and immediate usability beat spectacle.
- Avoid layout jumps, misleading loading values, and animations that block interaction.
- Keep advanced detail discoverable through progressive disclosure; give empty states one clear primary action.
- Destructive actions need confirmation or reliable undo appropriate to the consequence.
- Write concise Swedish UI copy. Keep code, comments, tests, commits, and technical documentation in English.
- Use semantic, keyboard-operable controls with visible focus, labels, adequate contrast, and no colour-only meaning.

## Development workflow

### Before editing

1. Confirm the base branch and inspect `git status`.
2. If any tracked or untracked changes exist, stop and ask. Never stash, discard, overwrite, or absorb them without direction.
3. Start every change on a new branch from current `main`; never work directly on `main`, which deploys production.
4. Follow repository conventions: `feat/<plan-number>-<slug>` for planned features and concise `fix/`, `refactor/`, or `docs/` branches otherwise.

Scale planning to risk. Approval is required before new features; financial, persistence, security, or schema changes; cross-cutting architecture; material redesigns; dependencies; browser trade-offs; or expanded scope. Obvious small bug fixes may proceed within the authorised task.

### Test-driven implementation

Use red-green-refactor:

1. Write or identify a test that fails for the intended reason.
2. Implement the smallest coherent change that passes.
3. Refactor only within scope while staying green.

- Every behavioural change needs appropriate tests; every bug fix needs a regression test unless genuinely impractical.
- Do not weaken tests to accommodate incorrect behaviour.
- Use focused tests while developing, then run the complete relevant suite.
- If unrelated failures pre-exist, prove and report them, then continue only when the task remains safely verifiable.
- Add a component-test harness only for a concrete need and ask before adding dependencies.

For frontend changes, run from `web/`:

```sh
npm run lint
npm run test
npm run build
```

Add relevant database, migration, security, or browser checks. Documentation-only changes require verified paths, commands, and claims rather than invented tests.

For user-visible work, inspect the changed flow in the running app—not only the landing page. Check mobile/desktop, relevant themes, overflow, touch targets, keyboard/focus behaviour, loading/empty/error/populated states, and animation smoothness using fictional data. Use screenshots when they aid review.

### Completion and Git

A change is complete when requested behaviour is implemented, relevant new and full-suite checks pass, important UI is verified, data/security implications are tested, and deviations and remaining risks are reported.

After verification, commit the scoped change with an English conventional message, push, and open a ready-for-review PR. Keep one feature/plan per branch and PR; tightly related fixes may join without expanding its purpose. Never merge, deploy, access production data, or administer production. Only the repository owner merges.

Provide short updates at investigation, implementation, verification, and decision points.
