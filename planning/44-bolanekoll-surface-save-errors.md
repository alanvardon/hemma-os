# Plan 44 — Bolånekoll: stop swallowing save failures

**Status:** plan · **Owner model:** Sonnet-suitable (mechanical try/catch sweep;
the target pattern already exists verbatim in Manadsavslut.tsx — the only skill
needed is not missing a handler) ·
**Severity: HIGH (H2)** · **Source:** repo audit 2026-07-06 ·
**Req:** 2 of the audit batch ·
Touches `web/src/routes/Bolanekoll.tsx` only (store-side half lives in plan 47).

## Finding

`mortgage-store.ts` deliberately **throws** on write errors so the UI can
react — but every Bolånekoll mutation handler calls the store bare, with no
try/catch (Bolanekoll.tsx:758–829; only `handleImportJSON` at ~845 catches):

- `handleSavePart`, `handleDeletePart`
- `handleSavePeriod`, `handleDeletePeriod`
- `handleSavePay`, `handleDeletePay`, `handleSaveImport` (addPayments)
- `handleSaveValuation`, insats togglers (updatePayment ×3), `handleCopyPayment`
- `handleSaveSettings`, `maybeEnableContributions`, bulk remove loop (~829)

On a failed write (expired session, offline, 5xx) the user gets: no toast, no
dialog close, an unhandled promise rejection in the console — and a row that
LOOKS saved (the store patches the optimistic localStorage cache before
throwing) but was never persisted. The next successful cloud read overwrites
the cache and the row silently evaporates. Real mortgage history disappears
with no trace.

Månadsavslut already does this right — Manadsavslut.tsx:511–530 wraps every
mutation in `try { … } catch (err) { saveErr(err) }`.

## Fix

Copy Månadsavslut's pattern into Bolånekoll. One helper:

```tsx
function saveErr(err: unknown) {
  showToast('Kunde inte spara — ' + ((err as Error)?.message ?? String(err)))
}
```

Then wrap EVERY handler listed above, e.g.:

```tsx
async function handleSavePart(data: Omit<LoanPart, 'id' | 'created_at'>) {
  try {
    if (partDlg.id) await Store.updateLoanPart(partDlg.id, data)
    else await Store.addLoanPart(data)
    await refresh(); flashSaved(); setPartDlg({ open: false, id: null })
    showToast(partDlg.id ? 'Loan part updated.' : 'Loan part added.')
  } catch (err) { saveErr(err) }
}
```

Rules: the success tail (`refresh/flashSaved/close dialog/toast`) stays INSIDE
the try so a failure leaves the dialog open with the user's input intact; the
catch only toasts. Do not change store semantics here — the
patch-cache-after-error ordering fix is plan 47 (M1), kept separate so this PR
stays a mechanical, low-risk sweep.

## Acceptance criteria

- Every `await Store.*` mutation in Bolanekoll.tsx is inside a try/catch that
  surfaces the error via toast.
- Manual check (dev server + Playwright auth session): kill network in
  devtools, attempt a payment save → toast appears, dialog stays open, no
  unhandled rejection in console.
- `npm run build` + suite green.
