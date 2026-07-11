# Plan 82 — Bolånekoll rate what-if: "what would I pay per month at X % instead of today's rate"

**Status:** plan · **Owner model:** split — **Opus for the golden test values + the
ränteavdrag-per-month semantics** (a wrong expected number certifies a bug, and the
monthly bracket quirk below is easy to get subtly wrong); **Sonnet can wire the UI**
once `rateWhatIf` + its tests exist (chips/input follow existing patterns verbatim). ·
**Source:** chat request 2026-07-08 — all design decisions locked via grilled Q&A the
same day (10 questions; recorded below as **Decisions**). ·
**Touches:** `web/src/lib/mortgage.ts` (one new pure fn + interface),
`web/src/lib/mortgage-whatif.test.ts` (new), `web/src/routes/Bolanekoll.tsx`
(Prognos card only), `web/src/styles/bolanekoll.css`. **No store/schema change,
no new state persisted.**

## Goal

Rates move and the user wants to feel the impact before it happens: *"if my rate
were 4 % instead of today's 3.42 %, what would I pay per month?"* This plan adds a
rate input to the existing **Prognos** card. Type (or step) a hypothetical rate and
three chips answer instantly: what the computed payment is **now**, what it would be
**at the hypothetical rate**, and the **delta** in kr/mån and kr/år. It is a
*hypothetical*, not a forecast — one rate applied to the whole balance, deliberately
ignoring that bunden parts can't reprice until their villkorsändringsdag (plan 70,
Räntebesked, is the forecasting thread; this is not it).

## Decisions (locked 2026-07-08, grilled Q&A)

1. **Rate scope:** one hypothetical rate applied to the **whole current balance**.
   Not a rörlig-only delta, not per-part overrides.
2. **Payment definition:** hypothetical interest **plus current observed monthly
   amortization** — reads as "total to the bank per month". Net-after-ränteavdrag
   shown as a sub-figure when `settings.ranteavdrag` is on.
3. **Baseline:** **computed, not observed** — both sides use the same formula
   (`balance × rate/100 / 12 + amortization`) with the baseline rate = today's
   blended rate from [`weightedAvgRate`](../web/src/lib/mortgage.ts#L628). The delta
   is then a pure rate effect; no day-count/timing noise from the real ledger.
4. **Placement:** inside the **Prognos** card
   ([Bolanekoll.tsx:578-602](../web/src/routes/Bolanekoll.tsx#L578-L602)), which is
   already the what-if card with the same interaction pattern (ephemeral input →
   chips).
5. **Input UX:** text field **prefilled with the blended rate** plus **−/+ 0.25 pp
   stepper buttons** (Riksbank moves in 25 bp steps).
6. **Output:** three metric chips — *Nu (Ø 3,42 %)*, *Vid 4,00 %*, and a signed
   colored delta chip.
7. **Independence:** the rate comparison **ignores the extra-amortering input**, and
   the rate input does **not** touch the payoff milestones. Each input answers
   exactly one question.
8. **Persistence:** **ephemeral** — plain component state, resets on reload,
   nothing written to Supabase.
9. **Gating:** the whole block **hides until `blended > 0 && balance > 0`** —
   no rate periods anywhere or a paid-off loan means nothing to compare.
10. **Delta detail:** delta chip shows **both kr/mån and kr/år**.

## The math — one pure helper in `lib/mortgage.ts`

It must live in `mortgage.ts` (not a new module) to reach the module-private `r2`
rounding helper and reuse the exported
[`ranteavdrag`](../web/src/lib/mortgage.ts#L287). Place it after `monthlyCost`
(after [mortgage.ts:545](../web/src/lib/mortgage.ts#L545)).

```ts
// ── Rate what-if ─────────────────────────────────────────────────────────────
// "What would I pay per month at rate X instead of today's blended rate?"
// Both legs are COMPUTED with the same formula (balance × rate/100 / 12 + the
// observed monthly amortization) so the delta is a pure rate effect — this is a
// hypothetical applied to the whole balance, not a forecast (bunden lock-ins
// are deliberately ignored; see plan 82).
export interface RateWhatIf {
  balance: number
  amortization: number   // observed monthly amortization (rate-independent)
  base_rate: number      // today's blended rate, %
  rate: number           // the hypothetical rate, %
  now: { interest: number; gross: number; deduction: number; net: number }
  hyp: { interest: number; gross: number; deduction: number; net: number }
  delta_month: number    // hyp.gross − now.gross (signed)
  delta_year: number     // delta_month × 12
}

export function rateWhatIf(balance: number, baseRate: number, rate: number, amortization: number): RateWhatIf | null {
  const b = Number(balance) || 0, br = Number(baseRate) || 0
  const r = Number(rate) || 0, am = Math.max(0, Number(amortization) || 0)
  if (b <= 0 || br <= 0 || r < 0) return null
  // Deduction applies the annual-bracket ranteavdrag() to a MONTHLY interest
  // figure — same convention as monthlyCost() so the two never disagree.
  const leg = (pct: number) => {
    const interest = r2(b * pct / 100 / 12)
    const deduction = ranteavdrag(interest)
    return { interest, gross: r2(interest + am), deduction, net: r2(interest + am - deduction) }
  }
  const now = leg(br), hyp = leg(r)
  return {
    balance: b, amortization: am, base_rate: br, rate: r, now, hyp,
    delta_month: r2(hyp.gross - now.gross), delta_year: r2((hyp.gross - now.gross) * 12),
  }
}
```

Two semantics that must be preserved exactly:

- **Monthly convention is `/12`**, not `days/365` (plan 23 uses day-counts because
  it predicts a *specific* charge; this compares steady-state months, and since both
  legs share the formula the convention cancels out of the delta anyway).
- **`ranteavdrag()` applied to the monthly interest** mirrors
  [`monthlyCost`](../web/src/lib/mortgage.ts#L531)'s existing convention (line 542:
  `ded = ranteavdrag(interest)` per month). The 100 000 kr / 30→21 % bracket
  therefore operates on monthly figures — effectively a flat 30 % for any realistic
  household loan. Keep the convention consistent; do not "fix" it to annualized
  brackets here.

### Golden values (hand-verified — these go in the tests as-is)

`rateWhatIf(3_000_000, 3.42, 4.00, 3000)`:

| leg | interest | gross | deduction | net |
|---|---|---|---|---|
| now (3.42 %) | 8 550.00 | 11 550.00 | 2 565.00 | 8 985.00 |
| hyp (4.00 %) | 10 000.00 | 13 000.00 | 3 000.00 | 10 000.00 |

`delta_month = 1450`, `delta_year = 17400`.

`rateWhatIf(3_000_000, 3.42, 2.92, 3000)` (rate cut): hyp.interest `7300`,
hyp.gross `10300`, `delta_month = -1250`, `delta_year = -15000`.

Bracket-quirk documentation case — `rateWhatIf(50_000_000, 3.00, 3.00, 0)`:
monthly interest `125000`, deduction `100000×0.30 + 25000×0.21 = 35250`, net
`89750`. (Documents that the bracket runs on monthly figures, per the
`monthlyCost` convention.)

Null gating: `rateWhatIf(0, 3.42, 4, 3000)`, `rateWhatIf(3_000_000, 0, 4, 3000)`,
and `rateWhatIf(3_000_000, 3.42, -1, 3000)` all return `null`.
`rate = 0` is **valid** (hyp.interest `0`) — "what if it were free" is a legal
question. Negative amortization input clamps to `0`.

## UI — Prognos card only

All pieces already exist on the page; this is assembly.

**State** (next to `extraAmort`, [Bolanekoll.tsx:61](../web/src/routes/Bolanekoll.tsx#L61)):

```tsx
const [whatIfRate, setWhatIfRate] = useState<string | null>(null)
```

`null` means "untouched". **Do not seed via effect** — `blended` loads async
(starts 0); derive the displayed value instead so the prefill is always live:

```tsx
const hypRate = (() => {
  if (whatIfRate == null) return blended
  const n = parseAmount(whatIfRate)          // handles both "4.25" and "4,25"
  return isFinite(n) && n >= 0 ? n : 0
})()
const whatIf = useMemo(() => rateWhatIf(balance, blended, hypRate, base), [balance, blended, hypRate, base])
```

Note it takes `base` ([line 182](../web/src/routes/Bolanekoll.tsx#L182), the
observed `monthlyAmortizationRate`) and **not** `extra` — decision 7.

**Input row** in the Prognos card actions area, beside the extra-amortering field
(reuse `.proj-field` / `.proj-input` styles at
[bolanekoll.css:258-264](../web/src/styles/bolanekoll.css#L258-L264)):

```tsx
<label className="proj-field" htmlFor="whatIfRate">Ränta i scenariot / %</label>
<div className="rate-stepper">
  <button type="button" className="rate-step" aria-label="−0,25 procentenheter"
    onClick={() => setWhatIfRate(Math.max(0, hypRate - 0.25).toFixed(2))}>−</button>
  <input type="text" id="whatIfRate" className="proj-input rate-input" inputMode="decimal" autoComplete="off"
    value={whatIfRate ?? blended.toFixed(2)} onChange={e => setWhatIfRate(e.target.value)} />
  <button type="button" className="rate-step" aria-label="+0,25 procentenheter"
    onClick={() => setWhatIfRate((hypRate + 0.25).toFixed(2))}>+</button>
</div>
```

**Chips row**, rendered below the existing milestones `metric-row`
([Bolanekoll.tsx:595-599](../web/src/routes/Bolanekoll.tsx#L595-L599)), gated per
decision 9 (`whatIf` is already `null` unless `blended > 0 && balance > 0`):

```tsx
{whatIf && (
  <div className="metric-row whatif-row">
    <div className="metric-chip"><span className="metric-label">Nu (Ø {fmtPct(blended)})</span>
      <span className="metric-val">{M(whatIf.now.gross)}</span>
      {settings.ranteavdrag && <span className="metric-sub">{fmtMoney(whatIf.now.net)} netto</span>}</div>
    <div className="metric-chip is-accent"><span className="metric-label">Vid {fmtPct(hypRate)}</span>
      <span className="metric-val">{M(whatIf.hyp.gross)}</span>
      {settings.ranteavdrag && <span className="metric-sub">{fmtMoney(whatIf.hyp.net)} netto</span>}</div>
    <div className={'metric-chip' + (whatIf.delta_month > 0 ? ' is-warn' : whatIf.delta_month < 0 ? ' is-good' : '')}>
      <span className="metric-label">Skillnad</span>
      <span className="metric-val">{M(whatIf.delta_month, true)}/mån</span>
      <span className="metric-sub">{fmtMoney(whatIf.delta_year)} /år</span></div>
  </div>
)}
```

`M(…, true)` is the signed animated money formatter from
[shared.tsx](../web/src/routes/bolanekoll/shared.tsx); `.is-warn` chip styling
already exists ([bolanekoll.css:60-61](../web/src/styles/bolanekoll.css#L60-L61)).

**New CSS** in `bolanekoll.css` (three small additions, follow the vars already in
use): `.metric-chip .metric-sub` (11px, `var(--ink-soft)`), `.metric-chip.is-good`
(mirror `.is-warn` with the success/`--ok`-family tokens used elsewhere on the
page), and `.rate-stepper` / `.rate-step` (inline-flex group; steppers are compact
square buttons matching `.icon-btn` sizing).

## Acceptance criteria

- New tests in **`web/src/lib/mortgage-whatif.test.ts`** assert every golden value
  in the table above (all four legs' interest/gross/deduction/net, both deltas,
  the rate-cut case, the 50 M bracket case, the three `null` gates, `rate = 0`
  valid, negative amortization clamped) — expected numbers hand-computed and
  written as literals with a comment showing the arithmetic.
- Prognos card: typing `4` (or `4,00`) with a 3 000 000 kr balance at Ø 3,42 %
  and 3 000 kr/mån observed amortization shows *Nu 11 550 kr* · *Vid 13 000 kr* ·
  *Skillnad +1 450 kr/mån · 17 400 kr/år*, delta chip warn-colored; stepping −
  four times from 4,00 lands on 3,00 exactly (no float drift in the field).
- Changing the extra-amortering input does **not** move any what-if chip;
  changing the rate input does **not** move the payoff/LTV chips.
- With no rate periods (blended = 0) or zero balance, the rate input and the
  what-if chips are absent entirely — the rest of the Prognos card unchanged.
- With `settings.ranteavdrag` off, no `netto` sub-labels render.
- Reload resets the field to the blended-rate prefill (comma-formatted to 2
  decimals is acceptable; `parseAmount` round-trips it).
- Verify gates: `npm run build` green (this is the typecheck — `tsc --noEmit` is
  a no-op in `web/`), full `npm test` green.
- Manual check on the isolated dev env (localhost:5174 **only**, per the
  dev-server rule): light + dark theme, 1280 px and 390 px widths — chips wrap,
  nothing clips.

## Out of scope

- **Per-part or rörlig-only scenarios** — decision 1 rejected them; plan 70
  (Räntebesked) owns real repricing forecasts.
- **Persisting the scenario** — decision 8; no settings field.
- **Feeding the hypothetical rate into payoff milestones** — the projection is
  amortization-driven; rate doesn't change the balance path shown there.
- **Interaction with plan 23's predicted charges** — plan 23 predicts *actual*
  next charges with day-counts; deliberately different convention, shared only
  via `ranteavdrag`/`r2`.
- **Slider input** — rejected in decision 5 (imprecise on mobile, new component
  style).
