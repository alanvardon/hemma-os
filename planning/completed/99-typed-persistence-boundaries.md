# Plan 99 — Validate persisted JSON and brand ids/dates

**Status:** completed · **Priority:** Low–Medium · **Effort:** M–L · **Owner
model:** GPT-5.6 Terra — owns the boundary inventory, parsers, branded-type
rollout, and tests; escalate any financial-semantics ambiguity to the user

## Goal

Stop malformed localStorage, imported JSON, or JSONB rows before they reach
financial calculations, and prevent TypeScript from treating every id/date as
the same interchangeable `string`.

## Evidence

- `web/src/lib/storage.ts:89-96` casts database records directly to `Inputs` and
  `Constants`.
- Bespoke stores repeatedly cast `unknown` through `Record<string, unknown>`.
- Scenario ids, loan-part ids, payment ids, ISO dates, and `YYYY-MM` values are
  all plain strings.
- The generic `tool_state.data` column has no database-level shape guarantee.

## Decisions locked

1. Validation happens at every persistence/import boundary, not in JSX or domain
   calculations.
2. Migrations are idempotent and preserve valid legacy data. Invalid values are
   reported or safely rejected; never silently clamped.
3. Prefer small handwritten parsers unless adding a schema dependency is
   separately approved.
4. Introduce brands incrementally at high-risk seams: `ISODate`, `YearMonth`,
   `ScenarioId`, `LoanPartId`, `PaymentId`, then fan out.
5. Do not change database text columns solely for type aesthetics.

## Implementation order

1. Inventory persisted shapes and define parser return contracts.
2. Validate Bostadskalkyl scenario inputs/constants and `tool_state` blobs.
3. Validate mortgage/month-end/salary import and cache envelopes.
4. Add branded ids/dates at store/domain boundaries.
5. Add database checks only where they reject clearly impossible values and
   after a legacy-data preflight.

## Tests

- Golden valid legacy/current payloads.
- Missing fields, wrong scalar types, malformed arrays, NaN/infinity, invalid
  dates/months, duplicate/wrong-kind ids, and permitted extremes.
- Parser idempotence: parsing already-migrated data produces the same value.
- Financial calculations never receive unvalidated imported/persisted records.

## Acceptance criteria

- No `as Inputs`/`as Constants` cast remains at an untrusted boundary.
- Invalid persisted data produces an explicit recoverable result.
- The most commonly mixed ids/dates are compile-time distinct.
- No financial meaning, rounding, or statutory value changes.
