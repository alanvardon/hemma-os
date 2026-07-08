# Plan 37 — lib dedupe: one genId, one money formatter, one Swedish tax module

**Status:** shipped (PR #230) · **Owner model:** Sonnet-suitable (mechanical extraction +
characterization tests) · **Req:** 2 (build order 36→…→42, needs 36's CI gate
merged) · **Relationship:** foundation for plans 38–40 — the shared helpers
land here so the store factory and route refactors can import them. Touches
`web/src/lib/` plus small import swaps in 5 routes and 4 stores.

## Goal

Three families of helpers are re-implemented per file instead of shared:
ID generation (4 copies), money formatting (5+ local variants, two of which
re-implement `formatWithSpaces` that already exists in `lib/format.ts`), and
Swedish tax constants/functions (duplicated across `konsult.ts` and
`lonevaxling.ts`, 99%-identical function bodies). Consolidate each into one
module; zero behavior change.

## A. `lib/id.ts`

One `genId(prefix?: string): string` with the
`crypto.randomUUID → Date.now+Math.random` fallback. Replace the 4 copies:

- `mortgage-store.ts:59` (`genId`)
- `manadsavslut-store.ts:32` (`genId`)
- `salary-store.ts:86` (`_id`)
- `storage.ts:87` (`_scenId`)

## B. `lib/format.ts` additions + route cleanup

- Add `money(n: number, suffix = ' kr'): string` =
  `formatWithSpaces(Math.round(n)) + suffix`.
- Add a currency-aware factory for the mutable module-var pattern
  (`let CURRENT_CURRENCY` + `CURRENCY_SUFFIX` lookup) used by
  `Bolanekoll.tsx:514` and `Manadsavslut.tsx:24-35` — e.g.
  `makeMoneyFormatter(currency)` returning `fmtMoney`/`fmtPct`; routes hold
  the current formatter instead of mutating a module global.
- Delete the local `formatWithSpaces` re-implementations at
  `routes/Lonevaxling.tsx:20` and `routes/Konsultkalkyl.tsx:15` — import from
  `lib/format` (they are byte-identical in behavior).
- Point route-local wrappers at the shared `money`:
  `Hushallsbudget.tsx:20` (`fmt`), `Lonevaxling.tsx:25`,
  `Konsultkalkyl.tsx:26` (keep its `rollIn` variant local — it's specific).

## C. `lib/swedish-tax.ts`

- `export const TAX_2026 = { PBB: 59200, IBB: 83400, STATE_TAX_SKIKTGRANS:
  643000, STATE_TAX_RATE: 0.2, EMPLOYER_FEE: 0.3142, ... }` — pulled from
  `konsult.ts:48-50` and `lonevaxling.ts:1-5` (currently duplicated).
- One `grundavdrag(income, pbb)` and one `jobbskatteavdrag(...)` — the bodies
  in `konsult.ts:71-105` and `lonevaxling.ts:62-91` are the same math with
  slightly different signatures; parameterize and have both callers use it.
- **Characterization test first** (`lib/swedish-tax.test.ts`): before moving
  anything, snapshot current outputs of both files' functions for a spread of
  incomes (0, 100k, 300k, 643k, 1M) and assert the shared module reproduces
  them exactly. Neither konsult nor lonevaxling has unit tests today — this
  is the safety net.

## Out of scope

- The `*-store.ts` persistence boilerplate — that's plan 38.
- Any UI/JSX change beyond import swaps — plans 39–40.

## Verify

- `cd web && npm run test` (new tax parity test green, suite green) and
  `npm run build` (real typecheck).
- Konsultkalkyl + Löneväxling in `npm run dev`: same numbers as main for the
  default inputs (compare side by side against the deployed site).
- `grep -rn "function formatWithSpaces" web/src/routes` → zero hits.
