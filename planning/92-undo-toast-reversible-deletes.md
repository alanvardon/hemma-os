# Plan 92 — Delete-then-undo toast for reversible single-row deletes

**Status:** plan · **Owner model:** Split — **Opus** for the store `restore*`
functions + the shared `useUndo()` hook (data re-insertion semantics, `id`/
`created_at` preservation, and the delete-now-vs-defer trade-off must be
reasoned — a wrong call silently loses a row or resurrects it with a new
identity); **Sonnet** can wire the toast into each route once the hook + the
first converted delete exist · **Source:** follow-up deferred out of
[plan 91](91-confirm-dialog-native-dialog-replacement.md) ("Undo-toast for
single-item deletes … needs per-store restore support") · **Sequencing:**
**build AFTER plan 91 lands.** 91 gives every delete a `ConfirmDialog`; this
plan then *removes* the confirmation for the reversible leaf subset and replaces
it with one-tap-delete + a 6-second undo toast. Both plans edit the same call
sites for that subset, so they must not be in flight at once — land 91, then
rebase this. (If 91 has not landed, this plan still works: it replaces the
native `confirm()` directly.) · **Touches:** `web/src/components/useUndo.tsx`
(**new**), `web/src/lib/mortgage-store.ts` (`restorePayment`,
`restoreValuation`, `restoreContribution`, `restoreRatePeriod`),
`web/src/lib/manadsavslut-store.ts` (`restoreItem`),
`web/src/lib/salary-store.ts` (`restoreSubmission`),
`web/src/routes/Bolanekoll.tsx`, `web/src/routes/Manadsavslut.tsx`,
`web/src/routes/Hushallsbudget.tsx`,
`web/src/routes/bolanekoll/{PaymentDialog,ValuationDialog,ContribDialog,PeriodDialog,PartDialog}.tsx`,
and a new store test + hook test.

## Goal

For **reversible single-row deletes**, the confirm-then-delete dance is the
wrong pattern. The modern, lower-friction UX is: **delete immediately, then show
a "Deleted · Ångra" toast for a few seconds** — one tap to remove, one tap to
recover, no modal interrupting the flow. You already ship exactly this once, in
[ScenariosDashboard.tsx:76-86](../web/src/routes/ScenariosDashboard.tsx#L76-L86)
(`deleteScenario` → `DeletedInfo` → `restoreScenario`), backed by
[UndoToast.tsx](../web/src/components/UndoToast.tsx) and its CSS in
[modals.css:120](../web/src/styles/modals.css#L120). This plan extends that
proven pattern to the six leaf-row deletes across Bolånekoll, Månadsavslut and
Hushållsbudget, and DRYs the hand-rolled undo state into a shared hook.

**Scope is deliberately the reversible leaf deletes only.** Cascade deletes
(loan part → its payments + rate periods), bulk deletes ("delete all N"), and
non-delete confirmations keep plan 91's `ConfirmDialog` — see *Out of scope* for
why each is excluded.

## The enabling finding — restore is free, `id` is preserved

The one thing that makes undo safe is that **re-inserting keeps the original
identity**. The shared `stamp()` helper
([store-helpers.ts:31-34](../web/src/lib/store-helpers.ts#L31-L34)) is:

```ts
export function stamp<T extends object>(record: T, prefix: string) {
  const r = record as Record<string, unknown>
  return { ...record, id: (r.id as string) || genId(prefix),
           created_at: (r.created_at as string) || new Date().toISOString() }
}
```

`id: (r.id) || genId(...)` — if the record already carries an `id`, it is kept.
Every store's `add*` funnels its insert through `stamp`, so **feeding a captured
full row back through the insert path restores it with the same `id` and
`created_at`** — no dangling foreign keys (payments keyed on `loan_part_id`),
no jump-to-top from a fresh timestamp, no duplicate. The only obstacle is the
type: `add*` is typed `Omit<T, 'id' | 'created_at'>`, so passing a full row is a
type error even though it works at runtime. The fix is a set of explicit
`restore*(row: T)` functions (below) — cleaner than loosening `add*`, and it
keeps the intent legible: **`add` = new row, `restore` = re-insert this exact
row.**

## Data model — the six reversible deletes in scope

| Tool | Row | Delete API today | Capture source (in component) | New restore API |
|------|-----|------------------|-------------------------------|-----------------|
| Bolånekoll | payment | `removePayment(id)` | `payments.find(p => p.id === id)` | `restorePayment(row)` |
| Bolånekoll | valuation | `removeValuation(id)` | `valuations.find(...)` | `restoreValuation(row)` |
| Bolånekoll | contribution | `removeContribution(id)` | `contributions.find(...)` | `restoreContribution(row)` |
| Bolånekoll | rate period | `removeRatePeriod(id)` | the part's `rate_periods` | `restoreRatePeriod(row)` |
| Månadsavslut | item | `removeItem(id)` | `items.find(...)` | `restoreItem(row)` |
| Hushållsbudget | salary submission | `salaryStore.remove(id)` | `rows.find(...)` | `salaryStore.restore(row)` |

Each `restore*` is a three-line twin of its `add*` that accepts the full row
(id included). Example for [mortgage-store.ts](../web/src/lib/mortgage-store.ts),
alongside `addPayment` (line 342):

```ts
// Re-insert a previously-removed row verbatim — id + created_at preserved by
// stamp(), so undo restores identity, not a lookalike. Powers useUndo (plan 92).
export async function restorePayment(row: Payment): Promise<Payment> {
  const saved = stamp(row, 'pay') as Payment           // id kept → same row
  const { error } = await supabase.from(T.payments).insert(_row(saved, COLS.payments))
  if (error) throw error
  _patchCache(e => { e.payments = [saved, ...e.payments.filter(p => p?.id !== saved.id)] })
  return saved
}
```

`restoreValuation` / `restoreContribution` / `restoreRatePeriod` /
`restoreItem` / `salaryStore.restore` follow the same shape against their tables
(`COLS`/`_row`/`_itemRow` already exist per store). **Verify each store's insert
still passes the row through `stamp` before its DB call** — if any bypasses it,
stamp the captured row explicitly so `id` is preserved.

## Delete semantics — delete now, re-insert on undo (NOT deferred)

**Decision: the delete commits to the cloud immediately; undo re-inserts.** This
matches ScenariosDashboard and the stores' optimistic write-through cache, which
already assumes writes land immediately. The rejected alternative — *deferred
delete* (hold the row for 6s, commit only if not undone) — is strictly worse
here: it forces the row to read as gone in the UI while still present in the
cloud, races the save-on-change effects, and a tab-close mid-window leaves a
"deleted" row alive. Delete-now is simpler and consistent.

**Accepted trade-off:** during the ~6s window the row is genuinely absent from
the cloud, so closing the tab before tapping Ångra makes the deletion permanent.
That is the same contract ScenariosDashboard already ships and is acceptable for
single-row deletes. Document this in a comment in `useUndo.tsx`.

## UI — shared `useUndo()` hook

Replace ScenariosDashboard's hand-rolled undo state with one reusable hook, so
every route gets identical behavior (6s window, timer reset on repeat, cleanup
on unmount). New `web/src/components/useUndo.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'

interface UndoState { open: boolean; message: string; restore: (() => void | Promise<void>) | null }

// Delete-then-undo: run `remove` now; show a toast for `duration` ms with an
// Ångra button that runs `restore`. If the toast times out (or the tab closes),
// the deletion is permanent — see plan 92's accepted trade-off. `remove` may
// throw (offline); it is NOT caught here so the caller's try/catch surfaces it.
export function useUndo(duration = 6000) {
  const [undo, setUndo] = useState<UndoState>({ open: false, message: '', restore: null })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const runWithUndo = useCallback(async (opts: {
    message: string
    remove: () => Promise<void>
    restore: () => void | Promise<void>
  }) => {
    await opts.remove()                                  // throws → caller handles
    if (timer.current) clearTimeout(timer.current)
    setUndo({ open: true, message: opts.message, restore: opts.restore })
    timer.current = setTimeout(() => setUndo(u => ({ ...u, open: false })), duration)
  }, [duration])

  const handleUndo = useCallback(() => {
    void undo.restore?.()
    if (timer.current) clearTimeout(timer.current)
    setUndo(u => ({ ...u, open: false }))
  }, [undo])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  return { undoProps: { open: undo.open, message: undo.message, onUndo: handleUndo }, runWithUndo }
}
```

Each route: `const { undoProps, runWithUndo } = useUndo()`, render
`<UndoToast {...undoProps} />` once, and rewrite the delete handler. The undo
toast **replaces** the existing "…deleted" `showToast` for these actions (the
toast now carries the Ångra affordance). Example —
[Bolanekoll.tsx:587-590](../web/src/routes/Bolanekoll.tsx#L587-L590):

```tsx
// before: confirm() guard removed by plan 91; delete + showToast
async function handleDeletePay(id: string) {
  const row = payments.find(p => p.id === id)          // capture BEFORE delete
  if (!row) return
  try {
    await runWithUndo({
      message: 'Payment deleted',
      remove: async () => { await Store.removePayment(id); await refresh(); flashSaved() },
      restore: async () => { await Store.restorePayment(row); await refresh() },
    })
    setPayDlg({ open: false, id: null })
  } catch (err) { saveErr(err) }
}
```

**Delete buttons inside editing dialogs** (PaymentDialog, ValuationDialog,
ContribDialog, PeriodDialog) already delegate deletion to the parent route via
their `onDelete` prop — drop their inner `confirm()` (plan 91 removed native
`confirm`; this plan removes the modal entirely for these) and let the parent
handler drive delete + undo. The dialog closes, the toast appears over the page.

**Migrate ScenariosDashboard onto the hook too** — delete its local `undo`
state/timer ([lines 65-86](../web/src/routes/ScenariosDashboard.tsx#L65-L86)) and
express it through `useUndo`, so there is exactly one undo implementation. Its
`deleteScenario`/`restoreScenario` already exist; only the wiring changes.

No new CSS — `.undo-toast` and its mobile offsets already exist in
[modals.css:120-150](../web/src/styles/modals.css#L120-L150).

## Acceptance criteria

- Deleting a payment / valuation / contribution / rate period (Bolånekoll), an
  item (Månadsavslut), or a salary submission (Hushållsbudget) removes it with
  **no confirmation modal**, shows the undo toast, and **tapping Ångra restores
  the exact row** — same `id`, same position, same `created_at` (verify the
  restored row does not jump to the top of its list).
- Restore survives reload: delete → Ångra → reload the page → the row is still
  present (proves the re-insert hit the cloud, not just the cache).
- Store-layer test (new, e.g. `mortgage-store.test.ts` or extend an existing
  one) with the mocked Supabase client
  ([testSupabaseMock.ts](../web/src/lib/testSupabaseMock.ts) per web/CLAUDE.md):
  assert `restorePayment(row)` inserts a row whose `id` **equals** the captured
  `row.id` (not a fresh `genId`), and that `remove` then `restore` round-trips
  to the original state. This is the golden guarantee — an Opus-owned assertion,
  because a wrong expectation here certifies identity loss as correct.
- Hook test for `useUndo` (`// @vitest-environment jsdom`, plan-78 harness):
  `runWithUndo` calls `remove`; the toast opens; `onUndo` calls `restore`; after
  `duration` the toast auto-closes and `restore` is **not** called.
- Offline path: with `remove` rejecting, the delete surfaces the existing
  `saveErr`/toast error and **no** undo toast appears (nothing was deleted).
- ScenariosDashboard still deletes + restores scenarios correctly after being
  migrated onto `useUndo` (its existing behavior is unchanged).
- Verify gates (web/CLAUDE.md): `npm run build`, `npm test`, `npm run lint` green.
- Manually check the toast in **both themes** and at **mobile width** (the
  `.undo-toast` bottom offset clears the mobile nav — modals.css:150).

## Out of scope

- **Loan-part cascade delete** ([Bolanekoll.tsx:272](../web/src/routes/Bolanekoll.tsx#L272),
  [PartDialog.tsx:72](../web/src/routes/bolanekoll/PartDialog.tsx#L72)). Keeps
  plan 91's `ConfirmDialog`. `removeLoanPart`
  ([mortgage-store.ts:317-331](../web/src/lib/mortgage-store.ts#L317-L331))
  deletes across **three tables** (parts, payments, periods); a correct undo
  must capture and re-insert all three as a bundle. That is a real multi-table
  restore with its own failure modes — a deliberate destructive action deserves
  the confirm anyway. Could become a phase-2 `restoreLoanPart(bundle)` later.
- **Bulk deletes** — Månadsavslut "delete all N open"
  ([:199](../web/src/routes/Manadsavslut.tsx#L199)) and Bolånekoll "delete N
  payments" ([:639](../web/src/routes/Bolanekoll.tsx#L639)). Undo is *possible*
  (capture the array, `restore*` each) but bulk restore + a "Restored N items"
  toast is a distinct chunk of work and these already read as intentional
  batch operations; keep the confirm for now.
- **Non-delete confirmations and destructive resets** — reset budget, remove
  category, rate-drift import, duplicate-month, reopen settlement. Not reversible
  single-row deletes; they stay as plan 91 `ConfirmDialog`s.
- **Changing the 6s window or adding a keyboard shortcut for undo.** Match the
  existing 6000ms; Cmd/Ctrl-Z undo is a later idea.
