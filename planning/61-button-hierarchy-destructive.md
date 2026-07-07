# Plan 61 — Button hierarchy: demote destructive, disable impossible

**Status:** plan · **Owner model:** Sonnet-suitable (pattern is prescribed
below; per-site sweep like plan 44) · **Source:** design review 2026-07-07 ·
**Touches:** `Bolanekoll.tsx`, `Manadsavslut.tsx`, `components.css` +
per-tool css for the button variants.

## Finding

Three related hierarchy sins:

1. **Destructive lives next to primary.** "Delete all" (Bolånekoll
   Betalningar) and "Delete all open" (Månadsavslut Poster) sit permanently
   in the section header, directly beside "+ Add payment" / "+ Add item".
   A wipe-everything control should never be one slip away from the most
   used button on the page — especially in THIS app, where plan 43 exists
   because bulk data loss already happened once.
2. **Inconsistent destructive styling.** Bolånekoll's is red-ghost,
   Månadsavslut's is amber-ghost. Same severity, two colors.
3. **Enabled-looking buttons for impossible actions.** Månadsavslut shows a
   filled-green "Settle up" beside "ALL SETTLED — Nothing outstanding."
   The hero contradicts its own CTA. (Bolånekoll's "Delete all" does
   disable correctly at 0 — use that as the reference.)

## Fix

- Move "Delete all" / "Delete all open" out of the section headers into a
  small overflow menu (`…`) at the section's right edge — or bottom-of-list
  text-link styling; either way, not adjacent to the add-CTA. Keep the
  existing confirm dialogs.
- One destructive variant: `.btn-danger-ghost` (red family, both themes) in
  `components.css`; delete the per-tool variants. (Coordinate with plan 42,
  which consolidates button CSS — if 42 lands first this is just the
  placement/menu work.)
- "Settle up": `disabled` + muted when there are 0 open items; the hero
  copy already explains why.
- While sweeping, note (don't fix) any other primary-vs-destructive
  adjacency for the record.

## Acceptance criteria

- No destructive control is a direct sibling of an add/save CTA in any
  section header.
- Settle up is disabled at 0 open items; enabled with ≥1 (Playwright: seed
  one item, check both states).
- Exactly one destructive button style rendered across the suite (visual
  diff of both tools, both themes).
