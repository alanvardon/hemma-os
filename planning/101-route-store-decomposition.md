# Plan 101 — Decompose large routes and row-store repetition

**Status:** proposed · **Priority:** Low · **Effort:** L (incremental) · **Owner
model:** GPT-5.6 Sol — owns seam selection, characterization strategy, dependency
control, and incremental architecture decisions

## Goal

Create smaller ownership boundaries without rewriting working domain logic or
forcing every persistence model through one universal abstraction.

## Evidence

- `routes/Bolanekoll.tsx` is about 1,647 lines.
- `routes/Hushallsbudget.tsx` is about 1,013 lines.
- `lib/mortgage-store.ts` is about 564 lines and repeats list/add/update/delete
  mechanics across five tables.
- Routes combine hydration, mutation orchestration, import workflow, modal
  state, derived view models, and rendering.

## Decisions locked

1. Preserve the architecture flow: route → state coordination → pure domain
   logic/persistence adapter → Supabase/local storage.
2. Do not move financial calculations into hooks/components.
3. Do not create a universal store factory. Extract only stable row-table
   mechanics whose error/cache/revision semantics are genuinely identical.
4. Refactor one cohesive seam per PR; behavior and UI remain unchanged.
5. Plans 93, 97, and 98 define persistence semantics first. Do not abstract the current
   broken silent-write contract.

## Proposed seams

### Bolånekoll

- `useMortgageWorkspace`: hydration and mutation orchestration.
- `useMortgageImport`: file parsing/mapping/commit flow.
- Presentational hero, forecast, ledger, and history sections.
- Typed table adapters for repeated row operations after plan 93.

### Hushållsbudget

- `useBudgetWorkspace`: hydration, save state, salary and mortgage sync.
- Presentational input, summary, and submission-history sections.
- Keep `computeBudget` and migrations pure under `lib/`.

### Stores

- Share cache-envelope parsing, row stamping, mutation-error mapping, and typed
  CRUD scaffolding only where tests prove identical behavior.
- Keep mortgage/month-end transactional operations bespoke.

## Tests

- Characterization tests for each seam before moving code.
- Existing financial golden tests remain unchanged.
- Store tests cover cloud success/error, cache update timing, import retry, and
  conflict/outbox semantics supplied by plans 93, 97, and 98.
- Browser regression of all touched dialogs, empty/loading/error states, import,
  and mobile layout.

## Acceptance criteria

- Main route components primarily compose sections and coordinate hooks.
- No Supabase access moves into components.
- No new circular dependencies.
- Each PR has a narrow rollback boundary and passes full frontend gates.
