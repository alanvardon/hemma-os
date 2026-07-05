# Plan 33 — Smooth expand + category transitions

**Status:** plan (grilled) · **Owner model:** Sonnet-suitable (view-layer only:
Motion animations + CSS + route wire-ins; no logic/store/shader work) ·
**Scope:** one PR · **Branch:** `ui/smooth-expand-and-category-transitions`
off `main`.

## Goal

Kill the hard-cuts across the app. Two classes of interaction currently
"just appear": inline **expand/disclosure** sections and **category/segment
selection** (and the content those selections drive). Make both feel
considered — animated on enter *and* exit, with restraint (this is polish,
not a light show).

Motion (`motion/react`) is already the house animation library
([AnimatedDialog](../web/src/components/AnimatedDialog.tsx),
[ExpandableChartCard](../web/src/components/charts/ExpandableChartCard.tsx),
ScenarioCard all use it). No new dependencies.

## Scope decision (grilled)

**Exemplary, not exhaustive** — build the two reusable primitives and apply
them to the highest-value surfaces, *plus* migrate the two hand-rolled
segmented controls so the most-used filters aren't left inconsistent.

**Deferred to a documented round two:** the 4 native `<details>/<summary>`
disclosures (Konsultkalkyl rates, Löneväxling rates, Månadsavslut
payment-history, Månadsavslut highlight rows). These are a genuinely
different technical track — height-animating native `<details>` needs either
JS control or the newer `interpolate-size`/`::details-content` CSS, whose
browser support is worth evaluating on its own. Also out of round one: the
niche Bolånekoll expands (loan-group row expand :1160, insats allocation
:1294) and Hushållsbudget history-toggle :464 — they inherit the `Collapse`
primitive later for free.

Already smooth, left untouched: all modals/overlays (`AnimatedDialog`), the
chart expand morph (`ExpandableChartCard`), ScenarioCard.

## A. `Collapse` primitive (inline expands)

- New `components/Collapse.tsx`: Motion `AnimatePresence` + animate
  `height: auto` / opacity, `overflow: hidden` during the tween. Content
  **unmounts** on close (so collapsed rows leave the tab order — the a11y win
  over a `0fr`-grid clip that keeps content focusable).
- First consumer: **Bolånekoll "Avslutade"**
  ([Bolanekoll.tsx:1200](../web/src/routes/Bolanekoll.tsx#L1200)), currently
  `{avslutadeOpen && <table>}` hard-popping in/out.
- Chevron: replace the `▸`/`▾` **glyph swap** with a single chevron that
  **rotates 90°** in sync with the collapse.
- Note: animating `height: auto` around a `<table>` needs Motion to measure;
  fine for the short Avslutade list (1-frame settle only bites on very tall
  content).
- Reduced-motion → instant show/hide, no height tween.

## B. Sliding pill in the shared `Segmented`

- [Segmented.tsx](../web/src/components/Segmented.tsx): add an absolutely
  positioned pill behind the active segment, animated with Motion
  shared-layout. **Per-instance `layoutId` via `useId()`** — critical, so the
  pill slides only *within* its own control and never flies across the page
  between two different segmented controls on the same view.
- Hand the active background from CSS to the pill: neutralize
  `.seg.is-active { background: var(--accent) }` in **bolanekoll.css**,
  **manadsavslut.css**, and the two `.*-dialog .segmented` variants, so the
  pill provides the fill instead of double-painting. Keep `.is-active` for
  the text/`color` swap.
- Keep the `<select>` responsive fallback and `role="radiogroup"` /
  `aria-checked` a11y intact.
- **Migrate the two hand-rolled controls** onto `Segmented`:
  - Månadsavslut filter tabs
    ([:669](../web/src/routes/Manadsavslut.tsx#L669)) — static 5 options
    (`open/pending/all/a/b`).
  - Bolånekoll payment filter
    ([:1273](../web/src/routes/Bolanekoll.tsx#L1273)) — **dynamic** options
    (`all` + one per loan part). Pill must tolerate the option count
    changing; if the active part is deleted the existing code resets the
    filter.
- Layout animations don't run on initial mount, so the pill appears in place
  on first paint (no unwanted intro slide). Reduced-motion → pill appears
  without sliding.

## C. Content-swap smoothing

The content a category/period drives splits into two shapes needing two
different treatments.

### C1 — aggregate panels: morph in place (no fade)

Månadsavslut insights + Bolånekoll bridge. These half-morph today: insight
`.bar-fill` already has `transition: width 0.4s`, but the figures hard-swap.

- **Roll headline figures only** — Månadsavslut groceries total and
  Bolånekoll `total_gain` — via the existing `AnimatedNumber`/`Money`
  component. **Leave secondary numbers instant** (per-bar values, legend
  gains, metric chips): rolling 8-14 numbers on one click reads as frantic,
  and the bars already carry the change. Restraint = considered, not busy.
- Add `transition: width` to the bridge segments (`.bridge-seg`) to match the
  insight bars.
- When converting `M()` → `<Money>`, map each call's args to props
  (`M(x, true)` signed → `signed`, etc.).

### C2 — filtered tables: fast keyed re-entrance

Månadsavslut items, Bolånekoll payments — genuine row-set swaps.

- The list container does a **fast (~130ms) fade + 4px rise** on filter
  change, replayed via `key={filter}`. **Not** a true overlap cross-fade —
  two tables of different heights overlapping = layout jank.
- Deliberately subtle/fast so it never annoys on a frequently-clicked filter.
- Reduced-motion → instant swap.

## Cross-cutting

- Every animation degrades via `useReducedMotion()` (house convention):
  instant/fade only — no height tween, pill slide, number roll, or container
  fade under reduced motion.
- No new packages (Motion already present).

## Verification

- Playwright visual pass at desktop **and** ≤640px (Segmented + the filters
  have responsive variants; Månadsavslut filter uses the `<select>` fallback
  under 640px).
- A `prefers-reduced-motion` pass confirming everything falls back to instant.
- Run existing vitest suites — view-layer changes only, expect green.

## Rollout

One branch/PR (`ui/smooth-expand-and-category-transitions`): single coherent
polish theme, all in `web/`, shared reduced-motion plumbing. Suggested build
order **B → A → C** (B is one file touching the most surfaces). Split C into
its own PR only if the branch grows unexpectedly.
