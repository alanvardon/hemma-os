# Plan 125 — Compare proposed mortgage costs with current Bolånkoll costs

**Status:** complete · **Priority:** Medium · **Depends on:** 109c and 118 landed ·
**Effort:** M · **Owner model:** split — GPT-5.6 Sol for domain/read semantics,
GPT-5.6 Terra for the comparison UI · **Source:** owner request 2026-07-20 ·
**Touches:** `web/src/lib/mortgage.ts`, `web/src/lib/mortgage-store.ts`,
`web/src/lib/calc.ts`, `web/src/routes/Bostadskalkyl.tsx`,
`web/src/components/InputsColumn.tsx`, `web/src/styles/components.css`, and
focused tests; no SQL migration or production write.

## Assessment

The existing Bank A/B view calculated a proposed mortgage using the new loan
amount plus shared amortisation, property tax and drift inputs. Plan 118 added
an explicit point-in-time Bolånkoll balance copy into `inputs.currentMortgage`.
That scenario field intentionally does not carry live rate periods and must not
be used to derive the household's current cost.

The completed implementation adds a standard read-only **Nuvarande bolån ·
Bolånkoll** leg. The common comparison is mortgage-only, while proposed-home
property tax and drift remain separate so a complete proposed-home cost is not
mistaken for the current home's cost.

## Comparison contract

The three comparable legs show current/respective balance, rate, monthly
interest, regular monthly amortisation, gross mortgage payment, estimated
monthly ränteavdrag and cost after relief. Gross mortgage payment is the
primary cash-out comparison. Bank A/B deltas compare current-vs-A,
current-vs-B and A-vs-B.

The current value is normalized as active balance × blended current rate ÷ 12
plus regular amortisation. It uses the legacy-compatible active-agreement
scope, excludes archived predecessors, treats accepted predictions as balance
evidence only, prefers an effective declared amortisation plan and otherwise
uses real ordinary evidence. Missing recurring amortisation is shown as 0 with
the explicit `Ingen löpande amortering hittad` provenance, never guessed.

Current-home property tax and drift are not copied or estimated. Proposed
property tax/drift and both proposed full totals remain visible outside the
three mortgage-only legs and continue feeding the existing affordability
calculation.

## Read, freshness and failure behavior

The comparator auto-loads on Bostadskalkyl mount, is ephemeral, and is never
saved into a draft or scenario. It exposes refresh/retry and distinguishes
loading, authoritative empty data, missing rates and unavailable source data.
The route owns request identity and discards superseded/unmounted results. The
four-resource reader captures one household scope and uses a coherent,
tombstone-filtered scoped cache fallback; an unavailable source never renders
as 0 kr.

`inputs.currentMortgage` and Plan 118's explicit **Hämta från Bolånekoll**
control remain unchanged. The live comparator is labelled separately and does
not overwrite the saved scenario snapshot.

## Implementation

1. Reused the purpose-built four-resource snapshot for mortgages, parts, rate
   periods and payments under the Plan 118 failure/scope contract.
2. Added the pure active-agreement monthly-cost selector with balance, blended
   rate, interest, regular amortisation and explicit provenance.
3. Added pure common mortgage comparison legs and gross-payment deltas.
4. Made the route own auto-loading, refresh, stale-request and unmount guards,
   passing typed read-only state to `InputsColumn`.
5. Replaced the Bank A/B block with responsive Current → Bank A → Bank B legs.
6. Kept proposed property tax, drift and full totals outside common rows.
7. Added focused jsdom coverage for loading/empty/missing-rate/unavailable,
   retry, stale requests, no writes, structural hooks and scenario isolation.

## Execution

- [x] **Stage 1 · [GPT-5.6 Sol]** — Lock the active-agreement monthly-cost and
  four-resource read contracts with golden unit/store tests. Gate: focused
  mortgage/calc/store tests and `git diff --check`.
- [x] **Stage 2 · [GPT-5.6 Terra]** — Wire the auto-loaded read-only comparator,
  separate non-mortgage costs and complete component/responsive coverage. Gate:
  focused component tests, `npm run lint`, `npm run test`, `npm run build`,
  static checks and local browser verification.

## Regression coverage

- Multi-part active balance/rate behavior, archived predecessors and legacy
  unscoped rows.
- Declared, observed, missing and predicted-only amortisation behavior.
- Shared current/A/B interest, gross, relief/effective definitions and deltas.
- Proposed tax/drift affecting proposed full totals only.
- Loading, empty, missing-rate, unavailable, retry, stale request and no-write
  route behavior.
- Desktop/intermediate/mobile structural layout hooks.

## Out of scope

- Current-home drift, utilities, insurance, property tax or complete housing
  cost.
- Persisting a historical live-cost snapshot into a scenario.
- Changing the Plan 118 balance-copy behavior, selecting archived agreements,
  or updating Swedish statutory constants.
