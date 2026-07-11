# Plan 89 — Hushållsbudget: auto-synced Bolån section fed from Bolånekoll (ränta + amortering)

**Status:** plan · **Owner model:** split — **Opus for the sync semantics** (the
state-identity/save-effect interplay, the `_migrate` guard, and the
offline-vs-gate-failed distinction are all delete-user-data-if-wrong territory,
plus golden figures that certify the math) ; **Sonnet can build the pinned card
UI + CSS** once `applyMortgageSync` and its tests exist. ·
**Source:** idea raised during plan-82 grilled Q&A 2026-07-11 ("raise another
idea: a separate section under cost specifically for mortgage where once
Bolånekoll is populated it automatically starts to populate with Amortering and
Interest"); all 8 design decisions locked via grilled Q&A the same day
(recorded below as **Decisions**). ·
**Sequencing:** standalone; builds on plan 82's conventions (shipped, PR #275).
Nothing else blocks it. ·
**Touches:** `web/src/lib/mortgage.ts` (one new pure fn),
`web/src/lib/hushallsbudget.ts` (Row/BudgetState fields, `applyMortgageSync`,
`computeBudget` bucket), `web/src/lib/hushallsbudget-store.ts` (`_migrate`
guard + export), `web/src/routes/Hushallsbudget.tsx` (hydration effect +
pinned card), `web/src/styles/hushallsbudget.css`,
`web/src/lib/hushallsbudget.test.ts` (extended),
`web/src/lib/hushallsbudget-store.test.ts` (**new**).

## Goal

The budget's biggest joint cost — the mortgage — is today a hand-typed number
(`Bolån (ränta & amortering)`, 12 775 kr in the example) that silently drifts
from reality every time the rate or balance changes. Bolånekoll already knows
the truth. This plan gives Hushållsbudget a dedicated, **read-only "Bolån"
section** that populates itself from Bolånekoll with two rows — **Ränta** and
**Amortering** — and keeps them current. The user's manual mortgage row is
never touched (a dismissible hint points out the double-count once); deleting
it is their move, per the plan-82 Q&A.

## Decisions (locked 2026-07-11, grilled Q&A)

1. **Figure source: computed steady-state** — ränta = `balance × blended/100/12`
   (the exact `/12` convention plan 82 locked, so budget and what-if never
   disagree), amortering = observed
   [`monthlyAmortizationRate`](../web/src/lib/mortgage.ts#L496). Not the last
   ledger month — no day-count noise, no CSV lag.
2. **Persistence: synced rows in the budget blob**, tagged
   `source: 'bolanekoll'` — everything downstream (`computeBudget`, donut,
   Home hub card, plan-82 household chips) keeps working with zero changes.
   Not live-derived: live derivation would force every `costsJoint` consumer
   to also load mortgage data or silently disagree.
3. **Two rows** — `Bolån — ränta` + `Bolån — amortering`. The split (cost of
   money vs forced saving) is the insight the automation adds. Amortering may
   legitimately be 0 kr (interest-only loan); show it anyway — it's honest.
4. **Gross ränta** — budget rows are cash-out figures; the ränteavdrag arrives
   via the tax return, not as monthly cashflow. No netto sub-text (out of scope).
5. **Manual row: one-time dismissible hint**, never auto-delete. Match a joint
   manual (`source` undefined) cost row whose label matches `/bolån|mortgage/i`;
   dismissal persists in the blob.
6. **Read-only rows** — no edit, no drag, no per-row delete; a "från
   Bolånekoll →" link to `#/bolanekoll`. The single control is the section
   off-toggle.
7. **Lifecycle: auto-on when data exists** (`balance > 0 && blended > 0` —
   plan 82's gate) **+ off-toggle** (`mortgageSyncOff`). Off, or gate newly
   failing, removes the rows so totals stay honest.
8. **Sync timing: on Hushållsbudget mount only.** Bolånekoll never writes the
   budget blob — one sync path, one direction. Staleness is bounded by the
   next visit to the budget page.

## Data model

No SQL migration — the budget is one jsonb blob in `tool_state`
(tool = `'hushallsbudget'`). Additive, all-optional fields so old blobs load
unchanged:

| Field | Type | Notes |
|---|---|---|
| `Row.source` | `'bolanekoll'?` | Marks machine-owned rows. Absent on every human row. ([hushallsbudget.ts:10-16](../web/src/lib/hushallsbudget.ts#L10-L16)) |
| `BudgetState.mortgageSyncOff` | `boolean?` | Decision 7's off-toggle. Absent/false = sync active. |
| `BudgetState.bolanHintDismissed` | `boolean?` | Decision 5's dismissal, persisted. |

Auto rows use **fixed ids** `r-bolan-ranta` / `r-bolan-amort` (never the
`seq` counter — they're singletons; fixed ids make the upsert idempotent and
keep `seq` untouched).

Derived-pure-and-tested vs stored: the two amounts are **stored** in the blob
(decision 2) but **produced** by pure, golden-tested functions — nothing
hand-maintained.

### New pure fn in `mortgage.ts` (after `rateWhatIf`, [mortgage.ts:572](../web/src/lib/mortgage.ts#L572))

Lives in `mortgage.ts` to reach module-private `r2` and reuse
[`totalBalance`](../web/src/lib/mortgage.ts#L272) /
[`weightedAvgRate`](../web/src/lib/mortgage.ts#L674) /
[`monthlyAmortizationRate`](../web/src/lib/mortgage.ts#L496):

```ts
// ── Budget sync figures ──────────────────────────────────────────────────────
// The steady-state monthly mortgage figures Hushållsbudget's auto "Bolån"
// section syncs in (plan 89): gross interest at today's blended rate (the same
// balance × rate/100 / 12 convention as rateWhatIf — the two must never
// disagree) plus the observed monthly amortization. null when the plan-82 gate
// fails (no balance or no rate periods) — callers treat null as "no mortgage:
// remove the synced rows".
export function mortgageMonthlyFigures(parts: LoanPart[], periods: RatePeriod[], payments: Payment[]): { ranta: number; amortering: number } | null {
  const balance = totalBalance(parts, payments)
  const blended = weightedAvgRate(parts, periods, payments)
  if (balance <= 0 || blended <= 0) return null
  return { ranta: r2(balance * blended / 100 / 12), amortering: monthlyAmortizationRate(parts, payments) }
}
```

### New pure fn in `hushallsbudget.ts`

```ts
// ── Bolånekoll sync (plan 89) ────────────────────────────────────────────────
// Upsert/remove the two machine-owned mortgage rows. MUST return the SAME
// state reference when nothing changes — Hushallsbudget.tsx's save effect
// treats reference inequality as "user edit, persist it", so a gratuitous new
// object would fire a pointless save on every mount, and a missed change
// would never persist. figures === null (gate failed) or mortgageSyncOff
// removes the rows.
export const BOLAN_ROW_IDS = { ranta: 'r-bolan-ranta', amortering: 'r-bolan-amort' } as const

export function applyMortgageSync(state: BudgetState, figures: { ranta: number; amortering: number } | null): BudgetState {
  const want: Row[] = (figures && !state.mortgageSyncOff) ? [
    { id: BOLAN_ROW_IDS.ranta, label: 'Bolån — ränta', amount: figures.ranta, owner: 'joint', source: 'bolanekoll' },
    { id: BOLAN_ROW_IDS.amortering, label: 'Bolån — amortering', amount: figures.amortering, owner: 'joint', source: 'bolanekoll' },
  ] : []
  const have = state.costs.filter((r) => r.source === 'bolanekoll')
  const same = have.length === want.length && want.every((w) =>
    have.some((h) => h.id === w.id && h.amount === w.amount && h.label === w.label))
  if (same) return state
  return { ...state, costs: [...want, ...state.costs.filter((r) => r.source !== 'bolanekoll')] }
}
```

Auto rows carry **no `category`**. In `computeBudget`'s joint-category
breakdown they must NOT fall into the `'Övrigt'` catch-all
([hushallsbudget.ts:172-183](../web/src/lib/hushallsbudget.ts#L172-L183)) —
give them their own synthetic bucket, prepended:

```ts
// inside the joint-cost category loop: skip synced rows from catTotals/otherTotal
if (cr.source === 'bolanekoll') { bolanTotal += cr.amount || 0; continue }
// after building jointCategories, before the Övrigt push:
if (bolanTotal > 0) jointCategories.unshift({ id: '_bolan', name: 'Bolån', amount: bolanTotal })
```

The donut ([Hushallsbudget.tsx:42](../web/src/routes/Hushallsbudget.tsx#L42))
and the Home hub's budget stat both consume `jointCategories`/`costsJoint` and
need **no change** — the bucket flows through.

### The `_migrate` landmine — the one change in `hushallsbudget-store.ts`

[`_migrate` lines 36-39](../web/src/lib/hushallsbudget-store.ts#L36-L39) force
**every** joint cost with a missing/unknown category into the fallback
category:

```ts
s.costs.forEach((r) => {
  if (r.owner === 'joint' && (!r.category || !valid[r.category])) r.category = fallback
})
```

Unguarded, this stamps a user category onto the category-less auto rows **on
every single load**, teleporting them out of the pinned Bolån card into a
random category card (and double-rendering their total there). Guard it:

```ts
if (r.owner === 'joint' && r.source !== 'bolanekoll' && (!r.category || !valid[r.category])) r.category = fallback
```

Also **export the migrate fn** (rename `_migrate` → exported `migrateBudget`,
store keeps using it) so the guard is directly unit-testable in the new
`hushallsbudget-store.test.ts`. Per the migrations lesson in the web-landmines
memory: this edit must start from the **current** function text, not a stale
copy.

## UI — `Hushallsbudget.tsx` + `hushallsbudget.css`

### Hydration effect (replaces [Hushallsbudget.tsx:491-501](../web/src/routes/Hushallsbudget.tsx#L491-L501))

Load the budget and the mortgage tables together, hydrate, then sync — with
two failure semantics that must not be conflated:

- **Gate failed** (loaded fine; no rate periods / zero balance) → `figures`
  is `null` → rows **removed**. The data says there's no mortgage.
- **Load failed** (offline / Supabase error) → **skip the sync entirely**,
  leaving existing rows as-is. Stale beats wrongly deleted.

```tsx
useEffect(() => {
  let alive = true
  Promise.all([
    loadBudget(),
    Promise.all([mortgageStore.listLoanParts(), mortgageStore.listRatePeriods(), mortgageStore.listPayments()])
      .then(([parts, periods, pays]) => ({ ok: true as const, figs: mortgageMonthlyFigures(parts, periods, pays) }))
      .catch(() => ({ ok: false as const, figs: null })),
  ]).then(([loaded, m]) => {
    if (!alive) return
    setState((prev) => {
      const base = (loadedRef.current = loaded ?? prev)
      return m.ok ? applyMortgageSync(base, m.figs) : base
    })
  })
  return () => { alive = false }
}, [])
```

The identity contract does the persistence for free: `loadedRef.current` is
the **pre-sync** object, so a sync that changes anything produces a different
reference → the existing debounced save effect
([Hushallsbudget.tsx:505-509](../web/src/routes/Hushallsbudget.tsx#L505-L509))
persists it; an unchanged sync returns `base` itself → no save. `loadBudget()`
already never rejects (cache fallback), so the outer `Promise.all` cannot lose
the budget to a mortgage failure — but keep the inner `.catch` anyway; it is
what encodes "load failed ≠ no mortgage".

### Pinned Bolån card

Rendered **above** `.cat-cards`
([Hushallsbudget.tsx:758](../web/src/routes/Hushallsbudget.tsx#L758)) whenever
synced rows exist. Not a `cat-card`: no `EditableName`, no drag handlers, no
`onDrop`, no remove-×, no "+ Add cost". Shape:

```tsx
{state.costs.some((rw) => rw.source === 'bolanekoll') && (
  <div className="cat-card bolan-card">
    <div className="cat-head">
      <span className="cat-name-static">Bolån <span className="bolan-src">· från <a href="#/bolanekoll">Bolånekoll</a> →</span></span>
      <span className="cat-sub">{fmt(r.jointCategories.find((c) => c.id === '_bolan')?.amount ?? 0)}</span>
    </div>
    <div className="b-list">
      {state.costs.filter((rw) => rw.source === 'bolanekoll').map((row) => (
        <div key={row.id} className="b-row bolan-row">
          <span className="b-label-static">{row.label}</span>
          <span className="b-amount-static">{fmt(row.amount)}</span>
        </div>
      ))}
    </div>
    <button type="button" className="link-btn bolan-off" onClick={disableMortgageSync}>Stäng av synk</button>
  </div>
)}
```

`disableMortgageSync` = `mutate((s) => { s.mortgageSyncOff = true; s.costs = s.costs.filter((rw) => rw.source !== 'bolanekoll') })`
— one mutation, so the rows leave the totals in the same save. Re-enabling
(out of scope for a first cut? **No** — trivial): when `mortgageSyncOff` is
true and the mortgage gate passes, render a one-line ghost row in the same
spot: "Bolån-synk är avstängd · Slå på igen" → clears the flag; the next
mount (or an immediate re-apply in the same handler, simpler: call
`applyMortgageSync` inline with the figures kept in a ref from the mount
effect) restores the rows.

### Double-count hint (decision 5)

Below the Bolån card, when
`!state.bolanHintDismissed && state.costs.some((rw) => rw.owner === 'joint' && !rw.source && /bolån|mortgage/i.test(rw.label))`:

> Din manuella bolånerad räknas också med i totalen — ta bort den om den nu
> dubblas. **[Ok, göm]**

Dismiss = `mutate((s) => { s.bolanHintDismissed = true })`. Never deletes the
row (fuzzy label matching must never drive a delete — plan 43's spirit:
destructive actions are explicit, never inferred).

### CSS (`hushallsbudget.css`)

Follow the existing `.cat-card` tokens: `.bolan-card` gets an accent-tinted
border (`var(--accent-light)`) + `var(--accent-faint)` head backdrop so
machine-owned reads visually distinct from editable cards; `.b-label-static` /
`.b-amount-static` mirror the row typography minus input affordances;
`.bolan-src` 11.5px `var(--ink-soft)`; hint styled like the existing
`.triage-hint` pattern. Check both themes — the accent-faint tint has bitten
before in dark mode.

## Interplay with shipped work

- **Plan 82 household chips** read `costsJoint` from the same blob — once the
  auto rows are in and the user deletes their manual row, the chips' "nu" leg
  automatically includes live ränta at today's blended rate, and the caption
  ("Bolåneraden lämnas orörd — endast ränteskillnaden läggs på") stays true:
  the *stored* rows are the baseline; the what-if still layers only the delta.
  No code change; state this in the PR description.
- **Salary submissions / Månadsavslut** don't read `costs` — unaffected.
- **Home hub** `budgetStat` consumes `computeBudget` output — the `_bolan`
  bucket flows through; verify the donut legend just gains a "Bolån" segment.

## Acceptance criteria

- `mortgage.ts`: `mortgageMonthlyFigures` golden tests (in
  `hushallsbudget.test.ts` or `mortgage-whatif.test.ts`, implementer's call —
  name the file in the PR): 3 000 000 kr balance @ 3,42 % blended + 3 000
  kr/mån observed → `{ ranta: 8550, amortering: 3000 }` (arithmetic in a
  comment, plan-82 style); gate cases → `null` for zero balance and for zero
  blended.
- `hushallsbudget.test.ts`: `applyMortgageSync` asserts — inserts both rows
  with the fixed ids; updates amounts in place; **returns the identical
  reference** (`toBe`) when figures are unchanged; removes rows on
  `figures: null`; removes rows when `mortgageSyncOff`; human rows and their
  order untouched throughout. `computeBudget` asserts: synced rows sum into a
  prepended `_bolan` bucket, never into `'Övrigt'`, and `costsJoint` includes
  them.
- **New** `hushallsbudget-store.test.ts`: exported `migrateBudget` leaves
  `source: 'bolanekoll'` rows category-less while still forcing a fallback
  category onto ordinary uncategorised joint rows.
- Behavioral: budget page with Bolånekoll populated (isolated dev env,
  localhost:5174 **only**) shows the pinned Bolån card with two read-only rows
  matching Bolånekoll's balance × blended /12 and observed amortering; totals,
  donut, and "Joint costs ½" all include them; the manual-row hint appears
  once and stays dismissed after reload; "Stäng av synk" removes the rows and
  the totals drop in the same save; with Bolånekoll emptied of rate periods,
  the rows disappear on next budget mount.
- Offline/dev-error path: with the mortgage tables unreachable, the budget
  still hydrates and previously-synced rows survive untouched.
- Verify gates: `npm run build` green (the typecheck — `tsc --noEmit` is a
  no-op in `web/`), full `npm test` green.
- Manual check light + dark, 1280 px and 390 px — pinned card, hint, and
  ghost re-enable row all render without clipping.

## Out of scope

- **Netto sub-text on the ränta row** (decision 4 chose gross; a
  ränteavdrag hint is a natural later extension).
- **Bolånekoll-side push sync** (decision 8 rejected it — no cross-tool
  writes; mount-only pull).
- **One-click removal of the manual row** (decision 5 rejected it — fuzzy
  label matching must never drive a delete).
- **Per-person mortgage attribution** — rows are `joint`, split 50/50 like
  every joint cost; uneven ownership splits live in Bolånekoll's insatser
  model, not the budget.
- **Historical/monthly snapshots** of the synced figures — the budget is a
  baseline, not a ledger; Månadsavslut owns actuals.
