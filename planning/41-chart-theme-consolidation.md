# Plan 41 — Chart theme consolidation: one theme hook, not three observers

**Status:** plan · **Owner model:** Sonnet-suitable (one hook, three call
sites) · **Req:** 6 (build order 36→…→42; independent of 38-40, just avoid
parallel branches) · **Relationship:** small isolated cleanup inside
`web/src/components/charts/`.

## Goal

Three separate implementations watch the DOM for theme changes and re-read
CSS custom properties via `getComputedStyle` + `MutationObserver`:

- `useChartTheme.ts` — the "official" hook.
- `EquityStackChart.tsx:258-296` — its own observer + token reads.
- `BudgetDonutChart.tsx:151-163` — a third variant (`useThemeTick`-style).

~100 lines of duplicated observer wiring, and three places to update when a
token is added.

## A. One parameterized hook

Extend `components/charts/useChartTheme.ts` to accept:

- `scope?: RefObject<Element>` — element whose computed style is read (the
  donut/stack charts read scoped overrides like `.hb-root` category colors;
  default `document.documentElement`).
- `tokens: string[]` (or a name→CSS-var map) — which custom properties to
  resolve; returns `Record<name, string>`.

Single MutationObserver on `documentElement[data-theme]` (or whatever
attribute the toggle flips — confirm in `useStore.ts`/`global.css`), one
re-read on change, values memoized.

## B. Migrate the two locals

- `EquityStackChart.tsx`: delete the local observer block (258-296), call the
  hook with its token list + scope ref.
- `BudgetDonutChart.tsx`: same for 151-163 (category tokens `--cat-1…8` read
  from the `.hb-root` scope).
- Check the remaining charts (`AmortChart`, `EquityChart`, `LineAreaChart`,
  `StressChart`, `GroceryTrendChart`, `HubSparkline`) for stray
  `getComputedStyle` calls and move them onto the hook where trivial.

## Out of scope

- Chart visual changes, axis/tooltip refactors, memoization tuning.
- CSS token reorganization (plan 42 touches styles; keep these PRs separate).

## Verify

- `npm run test` + `npm run build`.
- `npm run dev`: on Hushållsbudget (donut) and Bolånekoll/Bostadskalkyl
  (equity/stack charts), toggle theme light↔dark — every chart recolors
  immediately, scoped category colors still differ from global chart tokens.
