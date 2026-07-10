# Plan 65 — Scenario cards + suite-wide language/number polish

**Status:** plan · **Owner model:** Sonnet-suitable (the copy/format rules
are fixed in this plan; execution is a sweep with per-viewport eyeballing) ·
**Source:** design review 2026-07-07 · **Touches:**
`ScenariosDashboard.tsx`/`dashboard.css`, small copy touches in
`Manadsavslut.tsx`, `lib/format.ts` (careful: NBSP landmine — Lönevaxling/
Konsultkalkyl use U+202F/U+00A0 variants; hexdump before assuming
formatters are shared).

## Finding

1. **Scenario card stats**: the 5-stat row mixes languages and formats —
   "PRICE" (EN) next to "REQ. LÖN" (mixed abbrev), "6,5 mnkr" next to
   "30 623 kr / mån" next to "102 tkr / mån" that wraps onto two ragged
   lines at desktop AND mobile. LTV renders orange at 90% with no
   threshold explanation anywhere. On mobile the 5 stats in a 2-col grid
   leave a dangling odd cell.
2. **Hero precision**: Månadsavslut leads with "407,5 kr" — öre in a
   display-serif hero. Settlement math can keep öre; the hero should read
   "408 kr" (or "407,50 kr" if exactness is the point — pick one, apply
   everywhere).
3. **Mixed-language labels** repeat across tools (headers already use the
   deliberate "Lånedelar · Loan parts" pattern — fine, that's the house
   style; the problem is single labels that are *neither* one thing nor the
   bilingual pattern, like "REQ. LÖN").

## Fix

- Scenario card: label set becomes Swedish-first matching the tools (PRIS,
  MÅNADSKOSTNAD, KONTANT, LTV, LÖN KRÄVS — or the bilingual dot pattern if
  it fits); one format family: mnkr for prices ≥ 1 M, "kr/mån" for
  monthlies, "tkr/mån" only if it fits on ONE line (else drop to card
  width-based hiding). Fix the mobile dangling cell (2-col grid → the 5th
  stat spans or the grid becomes 3+2).
- LTV color coding gets a threshold legend in a tooltip/title ("orange ≥
  85% — amorteringskrav trigger") or loses the color.
- Hero rounding rule: heroes show whole kr; tables/settlement lines keep
  the exact value. Implement as one `formatHeroKr()` next to the existing
  helpers in `lib/format.ts` (mind the NBSP variants).
- Grep-sweep for other one-off mixed labels in stat chips
  (`REQ\.\|LATEST MO` etc.) and normalize to the chosen set.

## Acceptance criteria

- No stat label wraps or dangles at 1440/768/390 (screenshot pass).
- Every hero across the suite shows whole-kr values; item/settlement rows
  unchanged.
- Stat labels are either Swedish or the bilingual "Svenska · English"
  pattern — zero lone-English or hybrid abbreviations (grep + eyeball).
- Suite tests + `npm run build` green.
