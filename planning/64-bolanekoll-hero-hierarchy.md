# Plan 64 — Bolånekoll: one hero, one story (equity hierarchy rework)

**Status:** plan · **Owner model:** Opus-suitable (information design — the
work is deciding what the page leads with, then a moderate Bolanekoll.tsx
restructure) · **Source:** design review 2026-07-07 · **Touches:**
`Bolanekoll.tsx` top-of-page sections, `bolanekoll.css`.

## Finding

The page opens with two stacked hero cards that show THE SAME NUMBER:
"Insatt kapital · Cost-basis equity — **2 503 500 kr**" followed
immediately by "Marknadsvärde · Market equity — **2 503 500 kr**". Same
serif display size, same weight, adjacent. Unless you already know the
domain distinction (cost-basis vs market equity — and here they happen to
be equal, making it look like a straight duplicate), the page seems to
stutter. Below that, EIGHT KPI chips share one grid with near-equal visual
weight — Remaining debt gets a green outline that reads as a *selected
state*, not emphasis; "Interest paid 0 kr" and "Ränteavdrag (est.) 0 kr"
get the same billing as Loan-to-value. Nothing tells the eye what matters.

## Fix

Design pass first, then implement:

- ONE hero: "How much of the home is yours" — market equity as the lead
  number with LTV + remaining debt as its two supporting stats. Cost-basis
  equity ("what you've actually paid in") becomes a secondary row inside
  the same card (label + number + the existing explainer sentence), not a
  competing hero. When the two equities differ they read as a pair
  (market vs paid-in); when equal the page no longer repeats itself.
- Demote the chip grid: keep 4 primary chips max (Remaining debt, Property
  value, LTV, Total amortised); fold Interest paid / Ränteavdrag /
  Kontantinsats into the relevant sections (interest → Insikter,
  kontantinsats → the cost-basis row). Kill the green outline on chip #1 —
  emphasis comes from position and size, not a border that mimics focus.
- Keep all numbers available — this is re-ranking, not deletion.
- Do a quick before/after screenshot pair at 1440 and 390 for the PR.

## Acceptance criteria

- Exactly one display-size number above the fold; no number rendered twice
  at hero size.
- ≤ 4 KPI chips; every removed chip's value still reachable on the page
  (state where in the PR description).
- The green "selected-looking" outline is gone; both themes checked.
