# Plan 60 — Replace text-glyph "icons" with a real icon set

**Status:** plan · **Owner model:** Sonnet-suitable (mechanical swap across
many sites; the icon choices are listed below so no design judgment is
needed mid-flight) · **Source:** design review 2026-07-07 · **Touches:** all
five tool routes + `components.css`; adds `lucide-react` (tree-shaken, only
imported icons are bundled).

## Finding

The hub uses proper SVG icons, but inside the tools every action is a text
glyph: ⚙ (settings), ☾ (theme), ✎ ✕ ☆ (row actions), ▸ (expand), ⤢
(chart expand), · and — as decorations. Problems:

- Glyphs render at inconsistent weight/size per font fallback — next to the
  Inter UI they look like placeholder art, the classic "engineer shipped
  it" tell.
- Row-action glyphs (✎ ✕ in Bolånekoll/Månadsavslut tables) are ~11 px
  hits in `--ink-faint` — nearly invisible and far below the 24 px minimum
  touch target.
- ☆ (flag as insats) communicates nothing; a star reads as "favourite".

## Fix

- Add `lucide-react`. Mapping: ⚙→`Settings2`, ☾→`Moon`/`Sun`, ✎→`Pencil`,
  ✕→`X`, ☆→`Flag`, ▸→`ChevronRight` (rotates when expanded), ⤢→`Maximize2`,
  upload arrow→`Upload`. Size 16 px in tables, 18 px in headers,
  `stroke-width: 1.75` to sit well with Inter.
- One tiny wrapper (`components/Icon.tsx` or direct imports — whichever is
  less code) so sizing/stroke stay consistent; NO new abstraction layer
  beyond that.
- Row actions get a ≥28×28 px hit area (padding, not margin), visible
  `:hover` background (`--accent-faint`), and `aria-label`s (several
  currently ship bare "✎" as the accessible name).
- ThemeToggle is shared (`components/` from plan 39a) — swap once, all
  routes get it.

## Acceptance criteria

- `grep -rn "✎\|✕\|☆\|⚙\|⤢\|▸\|☾" web/src/routes web/src/components`
  returns zero UI-glyph hits (typographic · / — / ‹ in copy are fine).
- Every row action ≥28 px hit area with hover state; axe/manual pass shows
  real accessible names.
- Bundle delta < 10 kB gzip (lucide tree-shakes; verify in `vite build`
  output).
