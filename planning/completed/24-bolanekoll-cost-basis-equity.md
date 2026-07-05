# Plan 24 — Bolånekoll cost-basis equity hero + per-owner insatser (Hemma `web/`)

**Status:** feature — designing (grilled) · **Owner model:** Sonnet-suitable but
touches the math layer + dashboard + two dialogs · **Relationship:**
`routes/Bolanekoll.tsx` (dashboard, ValuationDialog, ContribDialog, payment
ledger), `lib/mortgage.ts` (new pure fns), `lib/mortgage-store.ts` (schema +
flags). **Req:** user — "we need a hero on the right that calculates equity from
the loan amounts / original purchase price, not just the valuation… insatser
should adjust Remaining debt & Total amortised… attribute deposit + extra
insatser to a person."

## The need (from grilling)

Today the dashboard has **one** equity hero: `equity(value, balance)` =
**latest valuation − outstanding debt** ([Bolanekoll.tsx:757-790](../web/src/routes/Bolanekoll.tsx#L757-L790)).
That's *market* equity — it bakes in paper gains from appreciation and tells you
nothing about **how much of the home you've actually funded** vs the original
purchase price.

There is **no concept of purchase price (köpeskilling) or deposit (kontantinsats)**
anywhere in the model. `partOriginal`/`totalAmortized` only know the *loan*, not
the cash you put down. So the app literally cannot answer "how much of the home
have we paid for."

## The model (decisions locked)

A second, **valuation-independent** hero on the right:

> **Cost-basis equity = köpeskilling − current debt**  (≡ deposit + total amortised)

Algebraically: at purchase, `debt = price − deposit`, so cost-basis equity =
`price − (price − deposit) = deposit`; after amortising X, it's `deposit + X`.
Extra payments need **no special equity handling** — they reduce debt, so
cost-basis equity rises automatically.

1. **Headline = kronor** (`köpeskilling − debt`); **ownership % underneath**
   (`(price − debt) / price` = "how much of the home is funded").

2. **Anchor = a flagged valuation, not a new field.** Add `is_purchase: boolean`
   to `Valuation`; one valuation in "Bostadens värde" is flagged as the
   köpeskilling. Robust regardless of when tracking started (the hero is
   `price − Saldo-driven debt`, both hard numbers), and it doubles as the
   earliest point on the equity chart. **Single flag enforced** (flagging one
   clears the others).

3. **Deposit is derived/cross-checked, not a debt-reducer.** The initial
   kontantinsats is an *anchor*, never reduces Remaining debt (that money was
   never borrowed). Derived sanity figure = `köpeskilling − Σ original loans`.

4. **Extra payments are ordinary ledger payments, flagged — never separate
   records.** Add `is_insats: boolean` to `Payment`. Debt & Total amortised
   already move via the payment's Saldo (`balance_after`), so there is **zero
   double-count risk** (one record, not two). The flag is a *label* that lists
   the payment in the Insatser card as read-only info. "Insatser affect Remaining
   debt & amortised" is satisfied by the payment existing in the ledger, not by
   any new debt math.

5. **Per-owner attribution reuses existing machinery.** `contributionSplit()`
   ([mortgage.ts:618](../web/src/lib/mortgage.ts#L618)) already sums
   `Σ(contributions by owner) + Σ(amortization payments by paid_by)` →
   `{a, b, a_pct, b_pct}`. So:
   - **Extra payments & scheduled amortisation** → already attributed via
     `paid_by`. Nothing new.
   - **Deposit** → the only new data: enter as per-owner `Contribution` rows
     ("Alex 600 000 down payment", "Sam 400 000"). The `Contribution` dialog
     already names this exact use case.
   - **Cost-basis hero's per-person split** = apply `contributionSplit`'s funded
     **percentages** to the hero total (`price − debt`), so the two halves always
     sum to the headline even if Σcontributions ≠ price−debt exactly.
   - Lights up only when `track_contributions` is on (single-owner / fixed-%
     users see just the household total).

6. **Keep a dedicated "Insatser" card** (not badge-only): deposit contributions
   (editable) + flagged extra payments (info) + "Totalt insatt" with a reconcile
   hint vs `köpeskilling − Σ lån`. It narrates the cost-basis hero's story in one
   place.

7. **Per-payment co-funding split (user, 3rd pass).** A single extra-payment line
   is often funded by both people in unequal amounts. New optional
   `Payment.paid_split: {a,b}` overrides `paid_by` in `contributionSplit` when set.
   The ledger ★ (with `track_contributions` on) opens an **Allocate insats** modal:
   two amount fields that auto-balance to the payment total, a "Remove insats"
   action, and Save writes `is_insats + paid_split` (and a derived `paid_by`). The
   Insatser info list shows the per-person allocation. With tracking off, ★ stays a
   plain flag toggle.

8. **Expandable ledger rows (user, 4th pass).** Each insats row in the Betalningar
   ledger gets a ▸ chevron; expanding reveals an "Insats funded by" detail row with
   the per-owner allocation as chips (or an `allocate…` link when not yet split) +
   the payment description. `expandedPays: Set<id>` state; `Fragment`-wrapped rows.

## Layout

Current dashboard — one full-width card:

```
┌─ dashboard-card ───────────────────────────────────────────────┐
│ Eget kapital · Total equity                                     │
│ 3 200 000 kr                                                    │
│ 56.2% loan-to-value · 4 100 000 kr still owed to the bank.      │
│ ┌ Alex · 50% ──────┐  ┌ Sam · 50% ───────┐                     │
│ │ 1 600 000        │  │ 1 600 000        │                     │
│ └──────────────────┘  └──────────────────┘                     │
│ [Remaining debt][Property value][LTV][Total amortised][Interest]│
└─────────────────────────────────────────────────────────────────┘
```

Proposed — two heroes side by side (stack on mobile), chips full-width below:

```
┌─ dashboard-card ───────────────────────────────────────────────┐
│ MARKNADSVÄRDE · Market equity   │ INSATT · Cost-basis equity     │
│ 3 200 000 kr                    │ 1 550 000 kr                   │
│ value − debt · worth today      │ 31% of köpeskilling funded     │
│ ────────────────────────────────┼──────────────────────────────  │
│ Alex 50%  1 600 000             │ Alex  930 000 · 60% funded     │
│ Sam  50%  1 600 000             │ Sam   620 000 · 40% funded     │
│ (split: agreed ownership %)     │ (split: who actually paid)     │
├─────────────────────────────────────────────────────────────────┤
│ [Remaining debt][Köpeskilling][Property value][LTV][Amortised]  │
└─────────────────────────────────────────────────────────────────┘
```

New Insatser card:

```
┌─ Insatser · Eget insatt kapital ───────────────────────────────┐
│ Kontantinsats (deposit)                       [+ Lägg till]     │
│   Alex  600 000  2021-09-01  Down payment           ✎ ✕         │
│   Sam   400 000  2021-09-01  Down payment           ✎ ✕         │
│ Extra amorteringar · flagged payments (info only)               │
│   Alex  200 000  2023-05-01                         ⮕ ledger    │
│   Sam   150 000  2024-11-01                         ⮕ ledger    │
│ ──────────────────────────────────────                          │
│ Totalt insatt 1 350 000  ·  deposit ✓ vs köpeskilling − lån     │
└─────────────────────────────────────────────────────────────────┘
```

## Open decisions

- **OD1 — layout & splits — REVISED (user, 2nd pass).** Cost-basis equity is now
  the **primary** hero (top of the dashboard card, green headline + chips);
  **market equity is its own secondary card *beneath*** (ink headline, smaller).
  *Both* splits use the **funded percentages** (`contributionSplit`) — market
  equity must **not** default to 50/50, because the owners paid in unequally.
  When `track_contributions` is off (no funding data) neither card shows a split,
  so 50/50 never appears. `ownerSplit`/`ownerPercents` (fixed-% split) dropped
  from the dashboard.
- **OD2 — equity-over-time chart — LOCKED: untouched for v1.** No köpeskilling
  reference line or cost-basis band yet; revisit later (a köpeskilling line that
  separates funded equity from market appreciation is the natural follow-up).
- **OD3 — empty state — LOCKED.** No valuation flagged as köpeskilling → the
  cost-basis hero shows a prompt ("Flag your köpeskilling in Bostadens värde"),
  not a wrong number.
- **OD4 — `track_contributions` — LOCKED.** Adding a deposit contribution or
  flagging a payment as insats *prompts* to enable contribution tracking; never
  flips it silently.

## Scope / data model

- `Valuation.is_purchase: boolean`, `Payment.is_insats: boolean`; store schema
  bump + migration (default both false; pick earliest valuation as purchase?
  No — leave unflagged, prompt). New pure fns in `mortgage.ts`:
  `purchasePrice(valuations)`, `costBasisEquity(price, debt)`,
  `costBasisSplit(...)` (wraps `contributionSplit` → applies % to hero total).
- Unit tests for the new fns (purchase-flag selection, single-flag enforcement,
  cost-basis = deposit + amortised invariant, funded-split sums to headline).

## Out of scope (v1)
- Fees in cost basis (stämpelskatt, lagfart, pantbrev, renovations) — köpeskilling
  only; note it.
- Changing how Remaining debt / Total amortised are computed (unchanged — they
  already move via the ledger).

## Definition of done
- Right-hand cost-basis hero (kronor + funded %) driven by a flagged köpeskilling
  valuation; per-owner funded split via `contributionSplit`; deposit entered as
  contributions with a reconcile hint; extra payments flagged in the ledger and
  mirrored read-only in an Insatser card; no double-counting; checks + new tests
  green.
