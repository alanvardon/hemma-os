# Plan 13 — More NumberFlow animations (Hemma `web/`)

**Status:** plan · **Owner model:** Sonnet-suitable (mostly mechanical, one small
shared-component change) · **Relationship:** pairs with the transition work
(plans 08/09 and plan 12, back-transition) — the hero roll-in lands *after* the whoosh.

## Goal

NumberFlow coverage is uneven. **Löneväxling** is fully animated (23 figures);
**Bolånekoll** (~35 raw-formatted numbers vs 2 animated), **Hushållsbudget**
(~25 vs 2), **Månadsavslut** (~11 vs 1) and the **ScenariosDashboard** cards are
mostly static strings. Extend the existing `AnimatedNumber` wrapper to the
**headline/derived figures** that are still raw, and add a small mount roll-in
so the marquee surfaces feel alive on entry — **without** turning every cell of
every table into a slot machine.

> Discipline: one branch `ui/more-numberflow` (or one PR per tool if you prefer
> smaller diffs), base = `main`, no stacking. Visual change only — calc logic
> untouched. `npm run build && npx oxlint src && npx vitest run` green after each
> tool, plus a manual click-through of the touched surfaces.

---

## Decisions locked (source of truth)

1. **What gets animated — class (A) only.** Three classes of figure exist:
   - **(A) headline / derived figures** — summary totals, KPIs, the big result
     numbers that recompute on input change. **→ In scope.**
   - **(B) dense table cells** — Hushållsbudget line-item rows, the Bolånekoll
     amort schedule, Månadsavslut per-transaction rows. **→ Out of scope.** Do
     **not** NumberFlow-ify table bodies; it reads as noisy and is DOM-heavy.
   - **(C) input echoes** — figures that only mirror what was typed. **→ Out.**
2. **Dashboard cards (`ScenarioCard.tsx`) get a mount roll-in.** They are
   snapshots (nothing changes them on-screen), so a plain conversion would show
   no motion. Give them a deliberate **0 → value roll on entry**. **Keep the
   compact notation** (`fmtCompact`, e.g. "3,2 mn") so the small cards don't
   overflow — the roll animates the mantissa.
3. **Each tool page also gets a mount roll-in on 1–3 named hero figures only**
   (hard cap — see inventory). Everything else on a tool page converts to
   NumberFlow with **default reactive** behaviour (rolls only on live input).
   The hero roll-in is an accent that lands as the whoosh settles, *not* a
   cascade of every figure rolling in.
4. **Reduced-motion:** the mount roll-in must be gated. Under
   `prefers-reduced-motion: reduce`, skip the 0→value animation and paint the
   final value immediately. (Default reactive NumberFlow already honours the
   preference via `respectMotionPreference`.)

---

## Mechanism — extend `AnimatedNumber`, don't reinvent

Add one opt-in prop to the existing `Money` / `Percent` / `Num` components
(`components/AnimatedNumber.tsx`):

```tsx
<Money value={equity} rollIn />     // mounts at 0, rolls to `equity` on first paint
```

Implementation sketch (one place, reused everywhere):
- `rollIn` renders the figure at `0` on first commit, then sets the real value in
  a `useEffect`/`useLayoutEffect` so NumberFlow sees a change and animates.
- Guard with the existing reduced-motion check (mirror `prefersReducedMotion()`
  in `Home.tsx`): when reduced, render the real value immediately, no 0 frame.
- Also add a **compact** mode (the dashboard needs `notation: 'compact'`); either
  a `compact` prop on `Num`/`Money` or a thin `MoneyCompact` that mirrors
  `fmtCompact`'s output. The dashboard's already-animated `effectiveMonthly`
  (`ScenarioCard.tsx:166`) shows the NumberFlow call shape to copy.

This keeps the `ScenarioCard.tsx` raw-`NumberFlow` import (plan 10 item #9) from
multiplying — route the card through the wrapper while you're here.

---

## Hero-figure inventory (the capped mount roll-in set)

| Tool | Hero figure(s) (`rollIn` on entry) | Where it lives | Currently |
|------|-----------------------------------|----------------|-----------|
| **Bostadskalkyl** | `totalBalance` (signed top figure) | `SummaryColumn.tsx:57` | already `<Money>` — just add `rollIn` |
| **Bolånekoll** | `equity` (+ `ltv` %) | summary line, `Bolanekoll.tsx:674-675` (`fmtMoney`/`fmtPct`) | raw → convert + `rollIn` |
| **Hushållsbudget** | monthly settle/transfer amount (`pot-transfer-amount`) | `Hushallsbudget.tsx:362` (`fmt`) | raw → convert + `rollIn` |
| **Månadsavslut** | net settlement amount (`pending.amount`) | `Manadsavslut.tsx:178` (`fmtMoney`) | raw → convert + `rollIn` |
| **Konsultkalkyl** | net monthly take-home | route hero block (already 3 animated) | confirm hero is animated; add `rollIn` |
| **Löneväxling** | — | — | already fully animated; add `rollIn` to its single hero only |

## Convert-only inventory (default reactive, NO mount roll-in)

Everything else in class (A) that's still raw:
- **Bolånekoll:** remaining summary/derived figures that recompute (balance owed,
  per-part splits in the *summary*, rate-derived figures) — **not** the amort
  table rows (class B).
- **Hushållsbudget:** the income/balance summary figures (`income-col-sub`,
  even-split share, etc.) — **not** the per-row line items (class B).
- **Månadsavslut:** the settle-preview figures and net grouping totals — **not**
  the per-transaction `<td class="num">` cells (class B).
- **ScenariosDashboard cards:** `newPrice`, `cashBalance`, `reqSalaryMonthly`
  (`ScenarioCard.tsx:163-181`, today `fmtCompact`) → compact NumberFlow + the
  card-level mount roll-in (Decision 2).

> The implementer audits each route for stragglers, but the rule is fixed:
> **summary/headline → animate; table body → leave raw.** When unsure whether a
> figure is (A) or (B), leave it raw and note it.

---

## Out of scope / explicitly excluded
- Table bodies (amort schedule, budget rows, transaction rows) — class (B).
- Home page numbers — the homepage clock is **plan 14 (flip-clock)**, planned
  separately; don't touch it here.
- Chart axis/tooltip numbers — visx formatters, leave as-is.
- Any calc/format logic change — this is presentation only.

## Definition of done
- Every class-(A) headline figure across the 6 tools + dashboard cards renders
  via `AnimatedNumber` (no raw `fmt*`/`toLocaleString` left on a summary figure).
- The named hero figure(s) per tool and the dashboard cards roll in from 0 on
  entry; reduced-motion shows the final value with no roll.
- No table body was animated; `ScenarioCard` no longer imports `NumberFlow`
  directly (uses the wrapper).
- `npm run build` / `oxlint` / `vitest` green; manual click-through of all six
  tools + the dashboard shows headline figures rolling on input and the capped
  hero/dashboard roll-in on entry, with no "slot machine" cascade.
