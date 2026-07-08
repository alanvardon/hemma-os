# Plan 49 — Tests for the tax calculators and the Supabase store layer

**Status:** plan · **Owner model:** Opus for the tax golden values + the
supabase mock harness design (wrong expected kronor = a test that certifies a
bug; the fluent-chain mock is the one reusable design decision). Sonnet can
fan out the per-store test files once the harness + first example exist ·
**Severity: MEDIUM (M3)** · **Source:** repo audit 2026-07-06 ·
**Req:** 7 of the audit batch · **Sequencing:** ideally BEFORE plans 47/48 land
(they refactor the very code this covers); at minimum land the store-mock
harness together with 47 ·
Touches `web/src/lib/*.test.ts` (new files) only.

## Finding

237 tests pass, and the pure calculation libs (calc, mortgage groupings,
hushallsbudget, manadsavslut parsing, swedish-tax, hub-stats…) are well
covered. Two critical gaps:

1. **The two tax calculators have ZERO tests.** `konsult.ts` (AB-contractor:
   hourly rate → salary + 3:12 dividend → net; encodes verified 2026 constants
   incl. the unified 322 400 kr grundbelopp) and `lonevaxling.ts` (salary
   exchange). A regression produces confidently wrong kronor — these numbers
   drive real decisions.
2. **No Supabase store module has tests.** `mortgage-store.ts` (530 lines,
   incl. the v<4 rate-period migration, `_row` NOT-NULL fallbacks, JSON
   import/merge dedupe), `salary-store.ts`, `manadsavslut-store.ts`
   (`normalizeItem` personal-items migration), `household.ts`. This is the
   layer where the audit's C1/H2/M1 bugs lived — it is exactly the code that
   most needs a net.

## Approach

**Tax calcs (pure, easy):** `konsult.test.ts` + `lonevaxling.test.ts`. Golden
tests pinned to the 2026 constants — a known input → exact expected breakdown
(document the hand-calculation in a comment), plus edge cases: zero hours,
below/above the statslåneränta thresholds, dividend cap boundary. Copy the
style of `swedish-tax.test.ts`.

**Stores (need a supabase mock):** one shared test helper
(`lib/__mocks__` or a plain factory in the test file) that fakes the
supabase-js fluent chain (`from().select().eq().maybeSingle()`,
`insert/upsert/update/delete`, `rpc`) returning scripted `{ data, error }`.
vitest `vi.mock('./supabase', ...)`. Then per store, cover:

- read path: cloud ok → cache written; cloud error → cache served.
- write path: error → throws AND cache untouched (locks in plan 47).
- one-time import: legacy key present + no cloud row → seeded once; error →
  flag NOT set (retries); flag set → no requests.
- store-specific logic: mortgage `migrateToPeriods` + `_row` defaults;
  manadsavslut `normalizeItem` (already exported); salary `_migrate` v1→v2.
- `household.ts`: error → fail-closed defaults ([], false, null).

Keep tests node-environment (matches vite.config `test.environment: 'node'`;
localStorage may need a tiny in-memory shim in a setup file).

## Acceptance criteria

- New test files: `konsult.test.ts`, `lonevaxling.test.ts`,
  `mortgage-store.test.ts`, `manadsavslut-store.test.ts`,
  `salary-store.test.ts`, `household.test.ts`.
- Tax tests assert exact kronor against hand-verified 2026 figures.
- Full suite green in CI; no live network calls from any test.
