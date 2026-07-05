# Plan 21 — Bolånekoll "Copy payment to parts" (duplicate across loan parts) (Hemma `web/`)

**Status:** feature — designed · **Owner model:** Sonnet-suitable (one new dialog
+ a store-backed batch insert) · **Relationship:** `routes/Bolanekoll.tsx`
(payment ledger + a new dialog) + `lib/mortgage-store.ts` (`makePayment`,
add/save). Standalone. **Req:** _More Plans_ — "For bolanekoll a duplicate
transaction feature."

## The need (from grilling)

The mortgage is in **4 parts**, and most months the payment for **3 of the parts
is identical** (same date, amount, type) — only the **loan part** differs. Today
that means typing the same transaction three times. Critically, the user **will
not** split one bank line into several rows elsewhere, because a row must stay
equal to one bank-statement transaction for reconciliation — but here it's the
*opposite*: these genuinely are separate per-part payments that happen to be
identical, so creating real copies is exactly right.

The ledger ([Bolanekoll.tsx:1031-1043](../web/src/routes/Bolanekoll.tsx#L1031-L1043))
currently offers only per-row **Edit (✎)** and **Delete (✕)**.

## The fix — a batch "Copy to parts…" action

Add a third per-row icon **⧉** in `.col-act`. Clicking it opens a small
**Copy-to-parts modal**:

- Lists the **other loan parts** as checkboxes (exclude the source row's own
  part), **all pre-checked**. If the source payment is **unassigned**
  (`loan_part_id == null`), list **all** parts.
- **Confirm** creates **one copy per checked part in a single action** — same
  `date`, `amount`, `kind`, `note`; `loan_part_id` = each target; **`balance_after`
  cleared**; fresh `id` / `created_at` (via `makePayment` →
  [mortgage-store.ts](../web/src/lib/mortgage-store.ts)).
- The **⧉ button is hidden entirely when there is only one loan part**
  (`parts.length <= 1`) — nothing to copy to.

```tsx
// per-row, alongside Edit/Delete:
{parts.length > 1 && (
  <button type="button" className="icon-btn" title="Copy to parts"
    onClick={() => setCopyDlg({ open: true, source: p })}>⧉</button>
)}

// CopyToPartsDialog: targets default = parts.filter(pt =>
//   p.loan_part_id == null ? true : pt.id !== p.loan_part_id), all checked.
// onConfirm: for each checked target →
//   makePayment({ date: p.date, amount: p.amount, kind: p.kind, note: p.note,
//                 loan_part_id: target.id, balance_after: null })
//   then persist + refresh once.
```

Typical flow: log part 1's payment once → ⧉ → confirm → parts 2-4 populated.

## Decisions locked
1. **Batch "Copy to parts…"** (Option B), not a plain row-duplicate — it kills the
   stated pain (entering 3 identical rows/month) in one action.
2. **Same date** (these are sibling parts in the *same* month — no +1-month bump).
3. **`balance_after` cleared** on every copy — each part has its own running
   balance, so the source figure would be wrong for the others.
4. **Checkbox list = other parts, all pre-checked**; **all parts** if the source
   is unassigned; **⧉ hidden when only one part** exists.
5. **Pure copy** — no per-part amount editing in the dialog. The rare month one
   part differs is a one-row Edit afterward; per-part inputs would turn a quick
   "stamp across parts" into a data-entry form.
6. Copies carry everything except `id` / `created_at` (regenerated) and
   `balance_after` (cleared).

## Verify
- With ≥2 parts, a payment row shows **⧉**; with 1 part it does **not**.
- ⧉ → modal lists the other parts pre-checked (all parts if source unassigned);
  unchecking one excludes it; Confirm inserts exactly one copy per checked part.
- Copies match the source's date/amount/type/note, are assigned to the right
  parts, and have **blank** balance; the source row is unchanged.
- Copies appear in the ledger, respect the part filter
  ([Bolanekoll.tsx:1016-1018](../web/src/routes/Bolanekoll.tsx#L1016-L1018)), and
  feed downstream calcs (per-part balances, amorteringskrav) like any payment.
- `npm run build` / `oxlint` / `vitest` green (add a unit test for the batch
  insert: N checked parts → N payments with cleared balance + new ids).

## Out of scope
- Recurring/scheduled payments or templates (this is an explicit per-month copy).
- Copying across *valuations* or *contributions* — payments only.
- Editing amounts per target part in the copy dialog (Decision 5).

## Definition of done
- One ⧉ click + confirm stamps an identical payment across the chosen sibling
  loan parts (cleared balances, new ids); hidden when only one part; pure copy;
  checks + a new test green.
