# Plan 24 — Bolånekoll "Lånedelar" grouped & expandable by villkorsändringsdag + rate (Hemma `web/`)

**Status:** feature — designed (grilled) · **Owner model:** **Sonnet 5-suitable**
(see assessment at end) · **Relationship:** `web/src/routes/Bolanekoll.tsx` (the
Lånedelar table render + dashboard chip + rate-period dialog) and
`web/src/lib/mortgage.ts` (new pure `groupLoanParts()` + widen `bindingStatus`)
+ `web/src/styles` CSS for the nested rows. Standalone; no store/schema change.
**Req:** user — "the loan parts should be grouped under the period it's bound by
and the rate … some sort of expand functionality."

## The need (from grilling)

Today the Lånedelar card is a **flat table**, one row per part
([Bolanekoll.tsx:1120-1149](../web/src/routes/Bolanekoll.tsx#L1120-L1149)):
`Loan part | Balance | Share | Rate | ✎ ✕`. The user thinks about the mortgage
by **when each chunk reprices** (villkorsändringsdag) — that's the decision axis,
because a lapsing binding is when money is at stake and a renegotiation happens.
Parts that reprice on the same date should sit together, broken out by rate.

Swedish context that shapes the model: **rörlig is a rolling 3-month bindning**,
so it *also* has a villkorsändringsdag — it's just a shorter binding than bunden.
Every part therefore has a repricing date.

## Grouping model (locked)

- **Group key = villkorsändringsdag (`end_date`) only** (`effectiveRatePeriod(part,
  periods)` → [mortgage.ts:558](../web/src/lib/mortgage.ts#L558)). All parts that
  reprice on the same day sit together **even at different rates** (e.g. 3 fixed
  tranches + 1 floating lapsing the same date). The folder header shows a
  **balance-weighted blended rate** (prefixed `Ø`) when the members' rate types
  differ, or the **shared rate + type** when uniform; **each member row shows its
  own rate badge**. (Reversed the original `(end_date + rate)` two-level key —
  user chose date-only grouping for a cleaner by-date view.)
- **Rörlig date is user-entered** — the same `end_date` field bunden already uses;
  no auto-computed 3-month roll (fragile, invents dates the statement contradicts).
- **`bindingStatus()` widened** so a **dated rörlig** period counts as `bound`
  (currently it early-returns unless `rate_type === 'bunden'` —
  [mortgage.ts:575](../web/src/lib/mortgage.ts#L575)). A rörlig period with a
  `null` end_date stays unbound.
- **Catch-all group** (single, muted, bottom): any live part whose effective
  period has **no end_date** or **no rate** (incl. legacy ongoing rörlig). Reads
  as a gentle "needs a date" nudge, not an error.
- **Archived parts excluded** from groups entirely (they'd skew balance/share
  sums); shown under a separate **collapsed "Avslutade" section** at the very
  bottom.

## Layout (locked)

**Collapsed group header** — parts in a group share only the reprice date, so
the header carries the aggregates + a rate summary:

```
2027-09-01 · in 14 mo   |   Ø 3.18%  (or  3.45% bunden if uniform)   |   3 parts   |   4 250 000 kr   |   38% of loan
```

villkorsändringsdag (+ countdown, the visual anchor) · rate summary (shared
rate+type when uniform, else balance-weighted blend prefixed `Ø`) · part count ·
summed balance · share of total loan. Countdown from `bindingStatus().days_left`.

**Expanded body** — the individual parts, each with **its own rate badge** (rate
now varies within a group):

```
Lånedel name  #loan-no   [3.45% · bunden]   |   Balance   |   Share   |   ✎ ✕
```

Per-part ✎ edit / ✕ delete stay at row level. Editing a part's date moves it to
another group on save — expected ("row jumps").

**One-part groups** — every reprice-date group renders identically as a
collapsible folder (disclosure triangle + aggregate header), even a one-part
group, so the list reads consistently. (Superseded the earlier "smart singleton"
idea of a rich non-expandable row — user chose uniformity over the shortcut.)

## Ordering & interaction (locked)

- **Order:** expired first → then soonest villkorsändringsdag ascending → ties by
  balance desc → catch-all last → "Avslutade" section below everything.
- **Urgency is uniform:** all expired (bunden *and* rörlig) sort to top / get
  warn styling / auto-expand. (User accepted that rörlig will re-expire each
  quarter and can revisit if it reads as noise.)
- **Independent toggles**, not accordion (compare two groups side by side).
- **Default collapsed**, auto-expanding: the catch-all group + any expired group.
- **No persistence** — reset to default each load.

## Data-entry change (locked)

Rate-period dialog ([Bolanekoll.tsx:82-105](../web/src/routes/Bolanekoll.tsx#L82-L105)):
- Relabel the `end_date` field → **"Villkorsändringsdag"**, show for both types,
  update the hint (e.g. "nästa ränteändring — bankens datum; blank = ongoing").
- **Keep optional** — blank still allowed; the catch-all is the safety net + nudge.

## Dashboard change (locked, scoped)

The soonest-expiry chip ([Bolanekoll.tsx:601-608](../web/src/routes/Bolanekoll.tsx#L601-L608),
rendered [line 901](../web/src/routes/Bolanekoll.tsx#L901)) uses `bindingStatus`.
Once that counts dated rörlig, `soon` **automatically becomes the soonest of ALL
parts** — which is exactly what the user asked for ("always the soonest part
expiring"). Only change needed: **relabel** the chip from "Bound rate ends" →
**"Nästa villkorsändring"** (it's no longer bunden-only). Everything else on the
dashboard (blended rate, amorteringskrav, bridge) is untouched.

## Build shape

1. **`groupLoanParts(parts, periods, payments)` in `mortgage.ts`** — pure,
   returns an ordered array of groups:
   `{ key, end_date|null, rate|null, rate_type, parts: [...], total_balance,
      share_pct, days_left, expired, is_singleton, is_catchall }`, already sorted
   per the ordering rule, archived excluded. This is the testable core.
2. **Widen `bindingStatus`** to accept dated rörlig (drop the `!== 'bunden'`
   guard; keep the `end_date != null` guard). Verify no existing test/behaviour
   regresses (weightedAvgRate/blended is rate-based, unaffected; the `soon` chip
   is the intended consumer).
3. **Render** the grouped/nested table in Bolanekoll.tsx with local expand state
   (`Set<groupKey>`), singleton special-case, auto-expand seeding, "Avslutade"
   section.
4. **CSS** for group headers, nested rows, disclosure affordance, warn/expired +
   muted catch-all styling.
5. **Dialog + chip relabels** (trivial).

## Tests (test-first for step 1)

New `web/src/lib/mortgage-grouping.test.ts` mirroring the existing
`mortgage-copy.test.ts` / `mortgage-costbasis.test.ts` convention. Cover:
- two parts, same date+rate → one 2-part group; same date diff rate → two groups.
- singleton flagged `is_singleton`.
- undated / rate-less part → catch-all; archived excluded.
- ordering: expired before upcoming; upcoming ascending; ties by balance desc;
  catch-all last.
- dated rörlig now `bound` via `bindingStatus`; null-end rörlig still unbound.
- group aggregates: `total_balance`, `share_pct` sum correctly.

## Decisions locked (grilling)
1. ~~Group key = (villkorsändringsdag + rate)~~ → **group key = villkorsändringsdag
   (end_date) ONLY**; a group may hold mixed rates. Header shows a balance-weighted
   blended rate (`Ø`) when types differ, else the shared rate+type; members each
   show their own rate badge. (User reversed to date-only during build.)
2. **Rörlig user-enters** its 3-month date; `bindingStatus` widened to count it.
3. Incomplete parts → **single muted catch-all** at bottom.
4. Archived → **separate collapsed "Avslutade"** section, excluded from groups.
5. Header = date+countdown · rate/type · count · Σbalance · share.
6. Expanded rows drop the rate column; per-part ✎/✕ stay.
7. ~~Singletons render as rich non-expandable rows~~ → **all date+rate groups
   render uniformly as collapsible folders, even one-part groups** (user reversed
   this for consistency during build).
8. Order: **expired → soonest → balance desc → catch-all last**; urgency uniform.
9. **Independent** toggles, default collapsed, auto-expand catch-all + expired,
   no persistence.
10. Dialog field relabel → **"Villkorsändringsdag"**, optional.
11. Dashboard soonest chip = **soonest of all parts** (free from #2), relabelled.

---

## Model assessment — Opus vs Sonnet 5

**Recommendation: Sonnet 5.**

Why Sonnet is sufficient:
- **The judgment is already spent.** Grilling removed every design fork — model,
  ordering, edge cases, and the data model are all locked above. What remains is
  faithful execution of a fully specified spec, which is Sonnet's strong suit.
- **Bounded blast radius.** Two files of substance (`Bolanekoll.tsx`,
  `mortgage.ts`) + CSS + one test file. No cross-system/architecture design.
- **The one non-trivial algorithm is pure and test-guarded.** `groupLoanParts`
  is a bucket-sort-aggregate with a clear contract; writing it test-first
  (step 1) catches ordering/edge-case mistakes mechanically rather than needing
  deep reasoning.
- **Precedent:** the directly comparable plan 21 (Copy-to-parts) was tagged
  "Sonnet-suitable" and shipped clean; this is the same category, slightly larger.

The only real risk is **widening `bindingStatus` without regressing** its other
callers — but that's a small, well-understood change with test coverage around it,
not a reason to reach for Opus.

**Use Opus only if** during build the `bindingStatus` change turns out to ripple
further than expected (e.g. blended-rate or amorteringskrav logic depends on the
bunden-only assumption in a way tests don't catch) — escalate then, not upfront.
