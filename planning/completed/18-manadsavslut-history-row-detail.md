# Plan 18 — Richer Tidigare avslut rows (who paid what, what amount) (Hemma `web/`)

**Status:** feature — display-only · **Owner model:** Sonnet-suitable (JSX + CSS,
no math/store change) · **Relationship:** `routes/Manadsavslut.tsx` (history
section) + `styles/manadsavslut.css`. **Plan 22 extends this same expanded-row
format** with a `(personal: …)` breakdown — build **18 first**, 22 layers on top.
**Req:** _More Plans_ — "In the Månadsavslut for Tidigare avslut I would like the
rows to have a little more information as it's not clear who paid what or what the
amount is."

## The problem

The settlement history ([Manadsavslut.tsx:688-705](../web/src/routes/Manadsavslut.tsx#L688-L705))
under-informs:

- **Collapsed `<summary>`:** `period/date` · `A → B · amount` · `N items` — no
  close date, and the only money shown is the **net transfer**, not what was
  actually spent.
- **Expanded item rows:** `date` · `description` · `amount` — and that `amount`
  is `it.amount`, the **owed share** (often half), with **no payer** and **not
  the real transaction amount**. So reopening a closed month shows a half-figure
  with no idea who fronted it or what the purchase cost.

All the data is already on each `Item` (`fronted_by`, `enter_amount`, `split`,
`owed_by`, `amount`) and the linked items are already gathered via
`itemsByPayment` ([Manadsavslut.tsx:389](../web/src/routes/Manadsavslut.tsx#L389)).
This is purely a rendering change.

## The fix

### Collapsed summary — add close date + gross total spent
```
2026-06-29 · Juni 2026    Alex → Sam · 1 240 kr    3 items · 4 980 kr
^close date  ^period        ^net transfer          ^count  ^gross spent
```
- **Close date** = `p.created_at.slice(0,10)` (already computed as `when`), shown
  alongside `period_label` instead of only as a fallback for it.
- **Gross total** = `sum(linked.map(it => it.enter_amount))` — the real money
  that moved, distinct from the net transfer. Add to the `history-meta`.

### Expanded item rows — payer, full amount, owed_by, split type
```
2026-06-12   ICA Maxi     Alex paid 480 kr → Sam owes 240 kr · Split
2026-06-14   SL biljett   Sam  paid 360 kr → Alex owes 360 kr · All
```
Each `<li>` becomes: `date` · `description` · **`{nameOf(it.fronted_by)} paid
{fmtMoney(it.enter_amount)}`** → **`{nameOf(it.owed_by)} owes
{fmtMoney(it.amount)}`** · **`{it.split ? 'Split' : 'All'}`**.

(Keep the existing `hl-date`/`hl-desc` classes; add `hl-payer`, `hl-arrow`,
`hl-type` and restyle `hl-amt`. Mobile: let the payer→owes clause wrap under the
description rather than truncate.)

## Decisions locked
1. **Enrich both states** — collapsed gets settlement-level facts (close date +
   gross), expanded gets per-item detail. (Per-item payer→owes can't all fit one
   collapsed line for 3+ items, so it lives in the expanded view.)
2. **Collapsed additions = close date *and* gross total spent** (both, not one).
   Gross = Σ `enter_amount` of linked items — answers "what the amount is" at a
   glance, separate from the net transfer.
3. **Expanded format = `{payer} paid {enter_amount} → {owed_by} owes {amount} ·
   Split/All`** — names `owed_by` explicitly, shows the full transaction amount
   *and* the owed share.
4. **Display-only** — no change to `manadsavslut.ts`, the store, or any math.

## Verify
- A past settlement's collapsed row shows close date + period + net transfer +
  item count + **gross spent**; the gross ≠ the transfer when items split.
- Expanding shows, per item, **who paid**, the **full amount**, the **arrow to
  owed_by**, the **owed share**, and **Split/All**.
- "Even — no transfer" settlements still render (no payer arrow), with gross +
  count intact.
- Reopen-settlement action unchanged. `npm run build` / `oxlint` / `vitest` green.

## Out of scope
- Any change to how settlements are created or to the open-items table.
- Editing items from within history (still reopen-then-edit).
- The personal-offset breakdown in history — that's **Plan 22**, which extends
  the expanded format defined here.

## Definition of done
- Tidigare avslut answers "who paid what / what amount" without leaving the
  history card; collapsed + expanded both enriched; no logic touched; checks green.
