# Plan 74 — Mobile text starvation: row names and CTAs must never clip

**Status:** plan · **Owner model:** Sonnet-suitable (the allocation rule is
stated here; the work is applying it and eyeballing every list at 390 px —
same craft profile as plan 57, which covers *field labels*; this plan
covers *row names and button labels*) · **Source:** mobile design review
2026-07-07 · **Sequencing:** after 57 lands (shared "never truncate what
the user wrote or must read" principle — reference its rule, don't
re-invent) · **Touches:** `hushallsbudget.css`, `Hushallsbudget.tsx` (pot
actions row), spot checks in `bolanekoll.css`/`manadsavslut.css` stat
labels.

## Finding

At 390 px, flex layouts starve the text column to feed fixed-width
controls:

1. **Hushållsbudget cost rows** ellipsize the user's OWN item names at
   ~11 characters: "Bilkostnad / l…", "Bränsle, park…", "Försäkringar …",
   "Förskola, friti…", "Bredband & s…", "Kläder, hälsa …", "Diverse /
   oför…" (hushallsbudget.css:187-189, 221-223, 374-375 — nowrap +
   ellipsis on the name spans) — while each row's number input keeps a
   generous fixed width and the drag-handle/delete columns don't flex.
   Every category list renders as a column of guesses.
2. **The page's primary CTA clips**: "Submit this month's salaries"
   renders in a 156 px box needing 191 px (measured live;
   `.pot-actions .btn { flex: 1; min-width: 0 }` hushallsbudget.css:506
   splits the row 50/50 with "History" and lets the label overflow
   hidden). A clipped primary button is worse than a clipped label — it's
   the one string the tool most wants tapped.
3. Bolånekoll insight-card labels at 390 px: "LATEST MO · NET C…",
   "AMORTERINGSKRA…" (already flagged in plan 57's finding — fix lands
   there; listed for the sweep checklist only).

## Fix

One rule: **user-entered names and button labels get layout priority; 
controls yield.** Concretely:

- Cost rows ≤ 600 px: name wraps to 2 lines max (`white-space: normal`),
  the value input shrinks to fit its content width (~72 px for 5 digits),
  handle/delete stay fixed. Delete the ellipsis declarations on name spans
  — if a name still doesn't fit in 2 lines, it wraps further; never "…".
- Pot actions ≤ 600 px: stack the buttons (`flex-direction: column`),
  primary on top full-width — "Submit this month's salaries" and
  "History" were never equals anyway; 50/50 was the bug, not just the
  clipping.
- Sweep: at 390 px on every route, run the probe from the review —
  elements with `scrollWidth > clientWidth + 4` under `overflow: hidden`
  (include elements WITH children; the review's first probe missed nested
  spans) — and fix each hit by the rule above. Quote surviving intentional
  truncations (if any) in the PR description.

## Acceptance criteria

- Seeded Hushållsbudget at 390 px: every cost/income/individual row name
  fully readable (≤ 2 lines, zero "…"), both themes.
- `Submit this month's salaries` fully visible at 390 px
  (`scrollWidth <= clientWidth` on the button, asserted in the PR via the
  probe).
- The overflow probe returns zero unexplained hits on all seven routes at
  390 px.
- Desktop ≥ 768 px unchanged (visual diff on Hushållsbudget).
- `npm run build` green.
