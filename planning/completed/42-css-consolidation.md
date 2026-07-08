# Plan 42 — CSS consolidation: shared buttons/inputs/cards instead of per-tool restyles

**Status:** shipped (PR #245) · **Owner model:** Opus-suitable (highest visual-regression
risk of the batch; needs per-tool eyeballing, both themes) · **Req:** 7
(build order 36→…→42, LAST on purpose — plans 39/40 settle which class names
the shared components emit) · **Relationship:** touches `web/src/styles/`
only; markup should already be stable.

> **Shipped focused (PR #245).** Inventory showed the "~half of 3,800 lines
> shareable" premise was over-estimated: konsultkalkyl/lonevaxling are already
> lean, and the real duplication was `.save-state` (4 identical copies from the
> shared PageHeader) + the byte-identical Bolånekoll↔Månadsavslut shell. Those
> were consolidated into `components.css` (the shell comma-hoisted as
> `.bk-root X, .ma-root X` to keep the anti-leak scoping). Pixel-verified both
> tools, both themes. Deferred: the `.field-grid` global-leak fix (not
> pixel-equivalent for Bostadskalkyl) and dead-selector removal (dynamic
> `'kind-'+p.kind` classes defeat grep).

## Goal

Each tool stylesheet re-declares the same primitives instead of sharing
them: button variants (`.btn-suggest`, `.btn-danger`, …), form
inputs/`form-grid`, and card/table shells are re-styled in `bolanekoll.css`,
`konsultkalkyl.css`, `lonevaxling.css`, `hushallsbudget.css`,
`manadsavslut.css` (~3,800 lines across per-tool files, roughly half
estimated shareable). Adding a button variant today means editing five
files. Consolidate into `styles/components.css`; per-tool files keep only
genuinely tool-specific looks.

## A. Inventory before moving

For each candidate primitive, diff the per-tool declarations first:

- Identical → move to `components.css`, delete the copies.
- Nearly identical (one tool tweaks a padding/color) → shared base rule +
  a small per-tool override in that tool's file, with a comment saying it's
  a deliberate deviation.
- Genuinely different → leave alone. Don't unify looks that were designed
  to differ.

Candidates in priority order: button variants → form fields/`form-grid`
(the plan-39 dialogs all emit the same markup now) → dialog/modal chrome →
card/table shells → toast/save-flash styles.

## B. Tokens stay tokens

- Anything hardcoded that duplicates a `tokens.css` value → point at the
  token.
- KEEP the intentional scoped overrides (`.bk-root`, `.hb-root` chart +
  `--cat-1…8` category colors) — that scoping is by design (per-tool
  palettes); just add a comment in each scope block saying so.

## C. Dead-selector sweep

While inventorying, grep each moved/suspicious class name against `src/`
(`grep -rn "class-name" web/src --include="*.tsx"`) and delete selectors with
zero hits — e.g. any leftover `.app-card.soon` styling (plan 29 removed the
cards) and pre-plan-39 modal classes.

## Work in slices, not one diff

One commit per tool stylesheet (konsultkalkyl → lonevaxling → hushallsbudget
→ manadsavslut → bolanekoll, smallest first), verifying visually after each,
so a regression bisects to one tool.

## Out of scope

- Any `.tsx` change (if a class rename is needed, it belongs in a follow-up).
- Redesigning anything; end state must be pixel-equivalent.

## Verify

- `npm run build` + `npm run test`.
- `npm run dev`: EVERY tool page + Home, BOTH themes, desktop + 390px width.
  Compare against the deployed site side by side; screenshot pairs for the
  PR description.
- Grep check: no removed class still referenced in `src/`.
