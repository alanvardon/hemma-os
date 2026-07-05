# #4 — Chart jank on minimize

## Decision locked

**Keep the morph, defer the chart.** Keep the card→fullscreen "grows from the
card" effect, but only mount the heavy chart **after** the open animation settles,
and unmount it **before** the close animation starts. During the size tween only
the lightweight preview is shown; the real chart cross-fades in/out.

## Root cause (the "why")

Every chart wraps its SVG in visx's **`<ParentSize>`**, which uses a
`ResizeObserver` to read its container's width/height and **re-render the chart at
that exact size**:

- [AmortChart.tsx:27](../web/src/components/charts/AmortChart.tsx#L27),
  [StressChart](../web/src/components/charts/StressChart.tsx),
  [EquityChart](../web/src/components/charts/EquityChart.tsx),
  [BudgetDonutChart](../web/src/components/charts/BudgetDonutChart.tsx),
  [EquityStackChart](../web/src/components/charts/EquityStackChart.tsx),
  [GroceryTrendChart](../web/src/components/charts/GroceryTrendChart.tsx) — all `<ParentSize>`.

When the container's width/height is **tweened frame-by-frame** during a morph,
`ParentSize` fires on **every frame** and forces a full visx re-render (recompute
scales, regenerate SVG paths) at each intermediate size. That layout/paint thrash
is the jank. It's worst on **minimize** because the chart shrinks through dozens of
re-renders while React is simultaneously unmounting the overlay.

## Two expand mechanisms (one root cause)

1. **Bostadskalkyl** — [`ExpandableChartCard.tsx`](../web/src/components/charts/ExpandableChartCard.tsx):
   Motion `layoutId` morph between the card and the fullscreen panel. Used by
   InputsColumn (StressChart), SummaryColumn (EquityChart), AmortChartCard. This
   is the real "grows from card" + ParentSize-during-tween case.
2. **Hushållsbudget** — a **separate hand-rolled** fullscreen overlay
   `.chart-overlay` ([Hushallsbudget.tsx:466-486](../web/src/routes/Hushallsbudget.tsx#L466)),
   opened via the ⤢ button ([:930](../web/src/routes/Hushallsbudget.tsx#L930)) for
   BudgetDonutChart. Not a layoutId morph, but the same ParentSize re-measure on
   open/close.
3. **Bolånekoll** (EquityStackChart, inline) and **Månadsavslut**
   (GroceryTrendChart, inline) have **no expand** — only affected by
   window-resize, not the minimize complaint. Secondary, optional.

## Fix

### `ExpandableChartCard`

- Add a `settled` state. Mount `children` (the heavy chart) **only when
  `settled === true`.** During the size tween, render only `preview` (or a
  fixed-size placeholder) inside the morphing box.
- **Open:** use Motion's `onLayoutAnimationComplete` to flip `settled = true` →
  chart cross-fades in once, measures once at final size.
- **Close:** flip `settled = false` first (unmount the chart) **then** let the
  layout shrink, so the heavy SVG isn't present during the shrink. (Sequence via
  a close handler that sets `settled=false` before `setOpen(false)`, or gate the
  exit on it.)
- Reserve the chart area height so the panel doesn't jump when the chart mounts.

### Hushållsbudget overlay

- Same principle: gate the `BudgetDonutChart` mount on an `opened` flag set a
  frame after the overlay opens; remove it the moment a close begins (it already
  has a `.closing` animation state to hook into).

### Secondary (optional, note only)

- Debounce `ParentSize`, or wrap inline charts (Bolånekoll/Månadsavslut) in a
  fixed-height stable container, to smooth **window-resize** jank. Not required by
  the "minimize" complaint — flag as a follow-up.

## Edge cases

- **Reduced-motion** path already does a plain fade ([ExpandableChartCard.tsx:79](../web/src/components/charts/ExpandableChartCard.tsx#L79)) —
  there, mount the chart immediately (no morph, no thrash).
- Keep `aria`/focus correct: the panel + title appear immediately; the chart
  arriving a beat later is fine, but don't move focus to a not-yet-mounted chart.
- Avoid a flash of empty panel — the reserved-height placeholder covers it.

## Testing

- Manual / Playwright: open + close repeatedly on Bostadskalkyl and
  Hushållsbudget; observe smoothness; assert no console errors.
- Unit: assert the chart child is not rendered until `settled` is true.

## Effort

**Small–Medium.** Independent — can land anytime (good early win alongside #5/#6).
