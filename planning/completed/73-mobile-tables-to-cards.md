# Plan 73 — Mobile tables: stop hiding 60% of every row off-screen

**Status:** plan · **Owner model:** Opus-suitable (the card-row layout is a
real design decision per table — which fields earn the visible slots — and
Månadsavslut's triage control is the tool's core interaction; a wrong call
here ships a worse workflow, not just a worse look. Sonnet can fan out the
second and third tables once the Månadsavslut pattern is approved.) ·
**Source:** mobile design review 2026-07-07 (Playwright walkthrough, 390 px)
· **Sequencing:** independent of 57–69; do BEFORE 61 touches the same
section headers if both are in flight, else rebase pain ·
**Touches:** `Manadsavslut.tsx` + `manadsavslut.css`, `Bolanekoll.tsx` +
`bolanekoll.css` (Betalningar + Lånedelar tables), shared pattern maybe in
`components.css`.

## Finding

Every data table in the suite is a desktop `<table>` inside
`.table-wrap { overflow-x: auto }` (manadsavslut.css:117,
bolanekoll.css:223). At 390 px, measured live: the Månadsavslut Poster
table is **771 px wide in a 322 px container** — 58% of every row is
off-screen. What's hidden is not the long tail, it's the point of the tool:

- Månadsavslut: the **Treatment toggle (Split/All)** — the entire triage
  interaction — plus Charge, Owed, Status and the row actions are all in
  the invisible region. Visible: Date, a truncated description, "Sam",
  "Ale". A phone user cannot triage a statement, which is exactly the
  sofa-with-phone use case this tool exists for.
- Bolånekoll Betalningar: Amount/Balance/actions clipped mid-header
  ("AM…"); Lånedelar similar.
- The overflow is technically scrollable but **undiscoverable**: overlay
  scrollbars render nothing, there is no edge fade, no cut-off column
  peeking (the clip lands between columns), no hint at all.

Plan 19 (shipped) already made the Treatment control responsive INSIDE its
cell — wasted work while the cell itself is off-screen.

## Fix

One rule: **≤ 600 px, a data row is a card, not a table row.** No
horizontal scrolling for primary content, ever.

- Add a mobile card-list rendering (CSS-only if the markup allows —
  `display: block` rows with grid areas — else a parallel mobile render
  branch, same data map):
  - **Månadsavslut item card:** line 1 = description (wraps, never
    ellipsis) + charge right-aligned; line 2 = date · paid-by → owes ·
    owed amount; line 3 = Treatment segmented control (the plan-19
    responsive variant finally gets its stage) + status chip + actions.
  - **Bolånekoll payment card:** line 1 = date + type chip + amount;
    line 2 = loan part · balance after; actions right.
  - **Lånedelar:** already only 3 data cols — keep the table but let the
    label column truncate-free and drop the Share column under 480 px
    (it's derivable and shown in the group row).
- Column headers disappear with the table; each value carries its
  micro-label inline where not self-evident (amounts and dates are
  self-evident; "Owed" is not).
- Keep the `<table>` at > 600 px untouched. Breakpoint matches the
  plan-20 mobile-transition threshold (600 px) so "mobile" means one thing
  in this codebase.
- The desktop table keeps `.table-wrap` as a safety net, but if any table
  still overflows at 768 px, add a `mask-image` edge fade so the cut is at
  least visible — fade only, no new UI.

## Acceptance criteria

- 390 px, seeded data: triaging an item (flip Split→Owes all), editing and
  deleting are all possible without any horizontal scrolling, in both
  tools (Playwright walkthrough).
- No `text-overflow: ellipsis` on description/label text inside the mobile
  cards — descriptions wrap.
- `document.scrollingElement.scrollWidth === clientWidth` (no page-level
  horizontal overflow) on both tool pages at 390 px.
- Desktop ≥ 768 px renders pixel-identical tables (visual diff).
- Both themes; suite + `npm run build` green.
