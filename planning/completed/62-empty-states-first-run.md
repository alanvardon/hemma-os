# Plan 62 — Empty states: guide the first run instead of stacking dead cards

**Status:** plan · **Owner model:** Opus-suitable (product/IA judgment per
tool — deciding what to hide, collapse and lead with is design work, not a
sweep) · **Source:** design review 2026-07-07 · **Touches:** `Bolanekoll.tsx`
(worst offender), `Manadsavslut.tsx`, `ScenariosDashboard.tsx`; CSS per
tool.

## Finding

A brand-new user opening Bolånekoll gets **~2 300 px of nothing**: nine
stacked section cards, each containing one grey sentence ("Add a loan part
and a property value to get started", "Add a property value to chart…",
"Add a loan part to project…"), a ~350 px reserved-but-empty chart void, a
KPI hero full of "0 kr" and "—", and the actual first action ("+ Add loan
part") buried mid-page inside the *Import* card — which itself can't be
used first. Månadsavslut is milder but still shows filter chips
(Open/Ask later/All/Alex/Sam) for zero items and an Insights section with
nothing to analyse. The scenarios dashboard's empty state is one grey
sentence floating over a full-viewport void.

Empty states are the first impression of every tool, and right now they
demo the furniture instead of the product.

## Fix

Per tool, apply the same principle: **until the prerequisite data exists,
show one hero empty-state with a single primary CTA; render downstream
sections collapsed to a compact stub or not at all.**

- Bolånekoll: gate on `loanParts.length`. Zero parts → one card: short
  value pitch + "+ Add loan part" primary + "or import a CSV" secondary;
  hide (not grey-out) hero KPIs, charts, Insikter, Prognos. One part but no
  valuation → the Marknadsvärde/chart sections surface a single inline
  "+ Add value" CTA. Empty chart panels NEVER reserve full height — stub
  height ≤ 120 px.
- Månadsavslut: zero items → hide filter chips + Insights; the import
  drop-zone IS the hero (it already looks right), with "+ Add item
  manually" secondary. Keep Tidigare avslut as a one-line stub.
- Scenarios dashboard: turn the dead void into a real invitation — center
  the "+ New scenario" tile with 2-3 lines about what a scenario captures;
  hide the search/sort row below ~3 scenarios (searching 1 item is
  furniture).
- Reuse the section components — this is conditional rendering + a shared
  `.empty-hero` style, not new architecture. Keep every current section
  intact for the populated path.

## Acceptance criteria

- Playwright, fresh household: each of the three surfaces fits its
  first-run state in ≤ 1.5 viewports at 1440×900 with exactly one primary
  CTA visible.
- Populated path (seeded data) renders all sections exactly as today
  (visual diff).
- No layout jump when the first record is added (sections appear below the
  fold, not shoving the CTA).
