# #7 — Bostadskalkyl scenarios dashboard: UI/UX polish

Follow-up to [04-scenarios-dashboard.md](04-scenarios-dashboard.md), which shipped
the dashboard (PR #172). The structure works; the surface is thin — the cards are
the old in-calculator **modal** cards stretched onto a full page (`.scenario-card`
still lives in [`modals.css`](../web/src/styles/modals.css#L103)), capped at
1120px with lots of dead side-margin, showing only 3 of the many figures
`derive()` already computes. This doc redesigns the dashboard as a **purpose-built
launcher** that uses the screen.

## Decisions locked

Grilled 2026-06-27. Each line is the source of truth.

1. **Role = better launcher.** Stay an open-to-edit launcher (no comparison
   matrix, no portfolio/hero surface) — but designed for a page, not a stretched
   modal.
2. **Wider + denser.** Widen the canvas and fit more cards per row; expect a fair
   few scenarios.
3. **Six figures per card.** Price · Monthly cost · Cash surplus/shortfall ·
   **LTV (equity share)** · **Required monthly salary** · **Effective monthly
   (after ränteavdrag)**. No per-card sparkline.
4. **Whole card opens; kebab for the rest.** Click anywhere on a card → open it.
   Duplicate / Rename / Delete live in a `⋯` menu (top-right, on hover/focus).
5. **Sort + search.** Header gets a sort selector (Recently saved · Name · Price ·
   Monthly cost) **and** a text filter by name.
6. **Hero number + chips.** Monthly cost rendered large as the card's anchor (with
   effective cost as a small sub); price, cash, LTV, req-salary as compact chips.
7. **Full polish + NumberFlow.** Staggered entrance (Motion), hover-lift, animated
   kebab, and NumberFlow count-up on the **hero Monthly** figure on card entrance.
   All gated by `useReducedMotion`.
8. **Canvas fluid to ~1600px.** Centered, auto-fill columns (~min 280px): ~3 cards
   at 1120px, ~5 at 1600px, single column on phones. Caps on ultra-wide.
9. **Add-tile + pinned draft.** A persistent dashed **"+ New scenario"** tile as
   the first grid cell (header button stays). The unsaved draft, if any, sits
   right after it as a distinct card. Empty state = the add-tile + a short hint.
10. **Muted health cues.** Color-code **LTV** (green ≤70% · amber 70–85% · red
    >85%, per amorteringskrav/bolånetak) and **cash** (green/red) in *desaturated*
    tones that fit the editorial palette — not loud traffic lights. Everything
    else neutral ink.

## Current state

- [`ScenariosDashboard.tsx`](../web/src/routes/ScenariosDashboard.tsx) — page
  header + `auto-fill minmax(260px)` grid. Inline `CardStats`
  ([:14](../web/src/routes/ScenariosDashboard.tsx#L14)) renders 3 stats via
  `fmt()`. Cards carry 3 full-width buttons (Open/Duplicate/Delete,
  [:149](../web/src/routes/ScenariosDashboard.tsx#L149)). Sort is hard-coded
  newest-first ([:85](../web/src/routes/ScenariosDashboard.tsx#L85)).
- **Card CSS is dashboard-only now** — `ScenariosModal` was retired in #04, so
  `.scenario-card*` in [`modals.css:103–151`](../web/src/styles/modals.css#L103)
  has no other consumer, and `.scenario-grid` / `.active-card` are **dead code**.
  Grid/empty/draft live in
  [`components.css:401–425`](../web/src/styles/components.css#L401).
- `derive(inputs)` already returns everything we need:
  `totalMonthly`, `effectiveMonthly`, `cashBalance`, `ltv`, `equityShare`,
  `reqSalaryMonthly` (plus `newPrice` from inputs) — see
  [`calc.ts`](../web/src/lib/calc.ts#L100).
- Store actions exist: `duplicateScenario`, `deleteScenario` + `restoreScenario`
  (undo), `renameScenario`, `discardDraft`
  ([`useStore.ts`](../web/src/store/useStore.ts#L137)).
- Libs available: `radix-ui` (`import { DropdownMenu } from 'radix-ui'`, matching
  the existing `Dialog` usage), `motion` (`import { motion, AnimatePresence,
  useReducedMotion } from 'motion/react'`), `@number-flow/react`.
- `format.ts` has `fmt`/`pct` only — **no compact formatter** for chips.

## Target design

### Canvas & grid

- `.dashboard` max-width `1120px → min(1600px, 94vw)`, still `margin: 0 auto`.
- `.dashboard-grid` `repeat(auto-fill, minmax(280px, 1fr))`, gap ~`1.1rem`.
- Single column under ~560px (cards full-width).

### Header control row

Below the existing `page-header`, add a thin toolbar:

- **Sort** selector (Recently saved · Name · Price · Monthly cost) — Radix
  Select or a plain `<select>` styled to match. Default `Recently saved` (current
  behaviour). Sorting derived from `scenarios` in the component; no store change.
- **Search** text input filtering by `name` (case-insensitive `includes`). Empty
  query = show all. Filter applies to saved cards only — the add-tile and draft
  card always stay pinned (don't hide them on filter).
- Show a small "N scenarios" / "no matches" count.

### Card anatomy (`ScenarioCard` — extract from the inline map)

```
┌────────────────────────────┐
│ Söder                    ⋯ │  name (h3) + kebab (hover/focus reveal)
│ Saved 3 Jun 2026           │  muted date
│                            │
│ 18 400 kr / mo             │  HERO — NumberFlow count-up on entrance
│ eff. 16 100 after relief   │  sub (effectiveMonthly), small/muted
│ ───────────────────────────│  hairline
│ 4.2M  ·  +120k  ·  72% LTV │  chips: price · cash(±color) · LTV(±color)
│ req. 61k / mo              │  chip: required salary
└────────────────────────────┘
```

- **Hero:** `totalMonthly` via `<NumberFlow value={…} suffix=" kr / mo" />`;
  `effectiveMonthly` as the sub-line. Count-up only on mount; respect reduced
  motion (render the final value, no animation).
- **Chips:** small pill/inline elements. `cashBalance` keeps `+`/`−` and
  green/red; `ltv` gets the muted health color (see below); `newPrice` and
  `reqSalaryMonthly` neutral.
- **Whole card = open target.** Render the card as an accessible click target
  (a `<button>`/`<Link>`-wrapped card or `role="link"` + keyboard handler) →
  `navigate('/bostadskalkyl/:id')`. The kebab trigger calls
  `e.stopPropagation()` so menu interactions don't open the card.

### Kebab menu (Radix `DropdownMenu`)

Items: **Duplicate** (`duplicateScenario`), **Rename**, **Delete**
(`deleteScenario` → existing undo toast). Trigger `⋯`, top-right, opacity 0 →
1 on card hover/focus-within (always visible on touch/keyboard focus for a11y).

- **Rename:** inline-edit the card name in place (reuse the
  `.scenario-title-input` pattern from
  [`components.css:427`](../web/src/styles/components.css#L427)) → `renameScenario`
  on blur/Enter; Esc cancels. (Avoids a second dialog component.)

### Health color semantics

| Chip | Green | Amber | Red |
|------|-------|-------|-----|
| **LTV** (`ltv`) | ≤ 70% (no/low amort) | 70–85% (2% amorteringskrav) | > 85% (over bolånetak) |
| **Cash** (`cashBalance`) | ≥ 0 | — | < 0 |

Use **desaturated** variants of the existing `--accent` (green) and `--warn`
(red) plus a muted amber token. Reuse existing `--accent`/`--warn` where possible;
add one `--warn-soft`/amber token if needed. Keep contrast AA.

### Add-tile, draft, empty

- **Add-tile:** dashed `.dashboard-add-tile` as the **first** grid cell, big `+`
  / "New scenario", → `/bostadskalkyl/new`. Same height as cards.
- **Draft card:** keep the distinct dashed/accent treatment
  ([`components.css:422`](../web/src/styles/components.css#L422)); render the same
  `ScenarioCard` body from `draftInputs` with a "Continue / Discard" footer
  instead of the kebab. Pin it **immediately after** the add-tile.
- **Empty state** (no scenarios, no draft): just the add-tile + a one-line hint
  ("No scenarios yet — start your first calculation."). Retire the separate
  `.dashboard-empty` block, or keep a slimmed version.

### Motion spec (`motion/react`, gate everything on `useReducedMotion`)

- **Entrance:** wrap cards in a staggered fade+rise (`opacity 0→1`, `y 8→0`,
  ~30ms stagger, ~0.22s, ease matching the app's `cubic-bezier(0.22,1,0.36,1)`).
  Use a `motion.div` per card; `AnimatePresence` so deletes animate out.
- **Hover:** keep the existing CSS lift (`translateY(-2px)` + shadow).
- **Kebab:** scale/fade the Radix content (the app already animates Radix content
  via Motion — mirror that pattern).
- **NumberFlow:** hero only; reduced-motion → static value.

### Formatting

Add a **compact** money formatter to
[`format.ts`](../web/src/lib/format.ts) for the chips so six figures stay tight,
e.g. `fmtCompact(4_200_000) → "4,2 mn kr"`, `fmtCompact(120_000) → "120k"`.
Hero stays full `fmt()`-style. (Decide sv-SE compact wording during build;
unit-test the thresholds.)

### Style relocation / cleanup

- Move `.scenario-card*` out of [`modals.css`](../web/src/styles/modals.css#L103)
  into the dashboard section of `components.css` (or a new `dashboard.css`), since
  the modal is gone.
- **Delete dead** `.scenario-grid` and `.scenario-card.active-card`.

## Edge cases

- **Search hides everything** → "No matches" message; add-tile + draft stay.
- **Sort + draft/add-tile** → these are pinned and excluded from the sort.
- **Kebab vs card-open** → `stopPropagation` on the trigger and all menu items;
  keyboard: card opens on Enter/Space, kebab reachable via Tab.
- **Delete from kebab** → reuse the existing 6s undo toast
  ([:72](../web/src/routes/ScenariosDashboard.tsx#L72)); the card animates out via
  `AnimatePresence`, restore re-inserts it.
- **Rename to empty** → fall back to "Untitled" (matches current render).
- **Long names** → truncate with ellipsis; keep the kebab clear of the title.
- **Reduced motion** → no entrance stagger, no NumberFlow count-up, no kebab
  scale; hover-lift (CSS) may stay or be dropped per existing convention.
- **Many scenarios** → grid + filter already handle volume; no virtualization
  needed at expected counts.

## Testing

- **Component (`ScenariosDashboard`)**: renders a card per scenario; add-tile
  always present; draft card shown when `draftInputs` set; **sort** reorders
  (price/name/monthly/date); **search** filters by name and shows "no matches";
  kebab opens and Duplicate/Delete call the store; whole-card click navigates to
  `/bostadskalkyl/:id`; kebab click does **not** navigate.
- **`format.ts`**: unit-test `fmtCompact` boundaries (thousands/millions, sign,
  rounding).
- **`calc.ts` golden test** untouched (no math change).
- Manual: dark mode, reduced-motion, keyboard-only nav, mobile single-column.

## Effort

**Medium.** No store/routing/calc changes — it's a presentational rebuild of one
route + its CSS, a `ScenarioCard` extraction, a Radix `DropdownMenu`, header
sort/search state, a compact formatter, and Motion/NumberFlow wiring.

## Sequencing

Independent of the parked #05 (editable constants) and #06 (card-expand
animation), but **touches the same files** as #06 (the dashboard + card markup is
#06's morph destination). If both are built, do this **first** so #06's View
Transition lands on the final card design — otherwise #06 will need rework. Own
branch `ui/bostadskalkyl-dashboard-polish`, base `main`, single PR.

## Revision — card grid → wide rows (during build, PR #175)

After the first card-grid pass shipped to PR #175, feedback reframed two things:
**price and monthly cost are equally the most important figures** (one hero
under-weighted price), and **every value must be clearly labelled** (bare chips
were guessable, and `+2 mnkr` for cash read like equity). That, plus the fact
that the real job of saving multiple scenarios is to **compare** them, moved the
layout from a grid of vertical cards to a **vertical list of full-width labelled
rows** ("wide row cards" — the chosen option over a bare comparison table and
over refined cards).

Each row: identity (name + date) on the left, then aligned stat columns —
**Price** and **Monthly** as large serif **co-anchors** (Monthly keeps the
NumberFlow count-up + an `eff.` sub), then **Cash · LTV · Req. lön** as smaller
labelled cells with the muted health tones. Every cell carries an uppercase
label, and fixed per-column min-widths keep the columns lining up down the list
(verified: price right-edges within 1px across rows). Toolbar sort/search,
add-row, draft row (Continue/Discard), kebab actions, inline rename, Motion
stagger/exit and reduced-motion handling all carry over unchanged. Under 720px
the row stacks: name on top, stats reflow into a 2-col `auto-fit` grid, kebab
pinned top-right. Class rename `.scenario-card*` → `.scenario-row*`. The #06
morph is **unaffected** — it targets the page root (`.bk-page-root`), not the
individual scenario elements, so card-vs-row is free to change.
