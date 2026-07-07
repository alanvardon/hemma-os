# Plan 63 — Data-viz color discipline + legible legends

**Status:** plan · **Owner model:** Opus-suitable (palette design across two
themes + a legend layout rework; visual-regression heavy like plan 42) ·
**Source:** design review 2026-07-07 · **Relationship:** builds on plan 41
(one theme hook) — do 41 first so colors are read from one place; 42's
`--cat-1…8` scoping note applies. · **Touches:** `tokens.css`,
`hushallsbudget.css`, chart components, Månadsavslut insights,
Bolånekoll insights bar.

## Finding

The suite's core palette is disciplined (forest green + copper on warm
paper — tokens.css) but the charts freelance:

- **Hushållsbudget donut**: ~10 category hues including blue, purple and
  pink that exist nowhere else in the product; the donut is ~90 px with an
  illegible label inside ("In the pot 85 000 kr"); the legend is a
  centre-aligned wrapped text blob of 10 `swatch name value` runs — you
  cannot scan it, and the row order doesn't match the arc order.
- **Bolånekoll Insikter**: the equity-change bar introduces teal
  (Värdeökning) — a fourth hue family for one bar.
- **Månadsavslut Spending by category**: green for the top category, plain
  grey for the rest — grey reads "disabled", not "smaller".

Charts are where this app should shine (it's a numbers product); instead
they're where the visual language falls apart.

## Fix

- Define a tokenized categorical ramp in `tokens.css`, derived from the two
  existing hue families: 4 greens + 3 coppers/ambers stepped in OKLCH
  lightness/chroma, plus one warm neutral for "other/left over" — 8 slots
  (`--cat-1…8`), tuned per theme. No blue/purple/pink anywhere.
- Donut: min 160 px at desktop; move the center label out (it's the "THE
  POT" card's job anyway); legend becomes a left-aligned two-column table
  (swatch · name · right-aligned kr, `tabular-nums`), sorted to match arc
  order (largest first). On mobile the legend IS the chart — the donut can
  drop entirely below 480 px.
- Bolånekoll bar: Värdeökning uses a ramp copper; Amortering stays green.
- Månadsavslut bars: all bars from the ramp (largest = strongest green),
  never plain grey for real data.
- Verify against both themes and against color-blind simulation (the ramp
  is essentially a two-hue scheme, so deuteranopia needs the lightness
  steps to carry the difference — check in DevTools rendering emulation).

## Acceptance criteria

- No chart color outside the tokenized ramp (`grep` for hex/oklch literals
  in chart components — everything reads tokens via the plan-41 hook).
- Donut legend scannable: aligned columns, sorted, matches arc order;
  values right-aligned with tabular numerals.
- Both themes + deuteranopia emulation pass a manual distinguishability
  check on the 8-slot ramp.
