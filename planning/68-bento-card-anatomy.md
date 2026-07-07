# Plan 68 — Living-bento card anatomy: label every stat, one consistent card

**Status:** plan · **Owner model:** Opus-suitable (extends plan 30's design;
deciding the card anatomy across breakpoints is layout judgment, and the
wide-slot logic changes behaviour) · **Source:** homepage design review
2026-07-07 · **Touches:** `Home.tsx` (grid + statLineFor/wideStatFor),
`home.css` card rules.

## Finding

Plan 30's living bento works, but its three card variants have drifted into
inconsistent anatomies:

1. **Standard-card stats are unlabeled.** Bostadskalkyl's footer row reads
   "Open → 30 623 kr/mån" (statLineFor, Home.tsx:352-365) — a bare number
   sharing a baseline with the CTA, nearly flush to the card edge. Wide
   cards get "KVAR PÅ LÅNET / value / sub"; standard cards get a naked
   figure you must already understand. 30 623 of *what*?
2. **Mobile anatomy is arbitrary.** At 390 px: Bolånekoll shows stat but NO
   description; Hushållsbudget shows description but no stat;
   Bostadskalkyl shows neither (just the naked footer number);
   Månadsavslut stat-only. Same grid, four different card shapes — reads
   as random, not designed.
3. **Wide slots are hardcoded** to Bolånekoll + Månadsavslut
   (Home.tsx:242-249) regardless of data. An empty Bolånekoll store yields
   a giant mostly-blank hero card (observed pre-seed: wide card with
   3-line description and dead right half).
4. **Hushållsbudget's stat did not render** during review despite the
   household having pot data (42 500 kr) — verify whether `stats.budget`
   hydrates on the hub (timing? cloud fetch? `b.equal` path) and fix or
   explain.

## Fix

- One stat anatomy everywhere: micro-label + value (+ optional sub), the
  wide `card-stat` pattern scaled down for standard cards — sits ABOVE the
  footer row, never inline with "Open →". Labels: "MÅNADSKOSTNAD" for
  Bostadskalkyl's figure, "KVAR VAR" (or similar) for Hushållsbudget.
- Mobile rule: every card = icon-row, name, ONE of (stat | description) —
  stat wins when present, description otherwise — plus footer CTA. Same
  shape for all six.
- Wide slots follow data, not names: the two tools with the richest live
  stats take the wide slots (fall back to the current pinning when fewer
  than two have data). Keep the plan-30 no-reshuffle-under-pointer rule —
  compute once per mount.
- Debug the Hushållsbudget stat path while in there (item 4).

## Acceptance criteria

- Every rendered stat has a visible label at 1440 and 390.
- All six mobile cards share one anatomy (screenshot pass).
- Empty-store household: no wide card renders with a dead half — either a
  different tool takes the slot or the card collapses to standard.
- Hushållsbudget stat renders when pot data exists (seeded household).
