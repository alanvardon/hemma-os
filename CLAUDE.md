# Bostadskalkyl

A personal Swedish house purchase calculator. Multi-file HTML application
that runs locally in the browser. No build step, no dependencies except
Chart.js loaded via CDN.

## File structure

```
index.html   — HTML structure; links to styles.css; loads JS files at bottom of body
styles.css   — all CSS (extracted from the old single-file <style> block)
calc.js      — pure math and formatters (IIFE, exports window.App.calc)
dom.js       — set(id, text, cls) and val(id) (IIFE, exports window.App.dom)
storage.js   — async Promise-returning localStorage wrappers, onChange pub/sub,
               _v1 key migration (IIFE, exports window.App.storage)
modals.js    — all six modal open/close pairs, drift/savings CRUD,
               in-memory drift/savings caches (IIFE, exports window.App.modals)
charts.js    — amort chart, fullscreen chart, lump-sum logic
               (IIFE, exports window.App.charts)
app.js       — App.recalc(), state vars, event wiring, async boot
```

Script load order in index.html (bottom of body):
```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<script src="calc.js"></script>
<script src="dom.js"></script>
<script src="storage.js"></script>
<script src="modals.js"></script>
<script src="charts.js"></script>
<script src="app.js"></script>
```

## Architecture

### Layout
Two-column layout with independent scroll:
- Left: inputs column (sections 1–4)
- Right: summary column (fixed-width, 360px)

### Sections
- Section 1: Selling current property
- Section 2: Buying new property
- Section 3: Monthly costs — dual bank comparison with ränteavdrag
- Section 4: Interest rate stress test table

### Key functions
- `App.recalc()` — master calculation function in app.js, runs on every input change,
  updates all derived values and summary panel. Synchronous.
- `App.dom.set(id, text, cls)` — safely updates a DOM element's text and colour class
  without wiping other classes
- `App.dom.val(id)` — reads a numeric value from any input (handles currency formatting
  and number inputs)
- `App.calc.fmt(n)` — formats a number as Swedish currency
- `App.calc.formatWithSpaces(n)` — formats a number with Swedish space separators
- `App.calc.parseFormatted(str)` — parses a space-formatted string back to a number
- `App.calc.lagfart(price)`, `pantbrevCost(loan, pb)`, `ranteavdrag(annual)`,
  `equityPct(loan, price)`, `fastighetsavgiftCap(tax)`, `buildAmortSchedule(...)` — pure math
- `App.modals.getSavingsTotal()` — returns sum of in-memory savings items cache
- `App.modals.setDriftItems(items)` / `setSavingsItems(items)` — boot pre-load setters
- `App.modals.updateHeaderLabel()` — updates scenario name label in header

### One-writer-per-App.*-key rule
Each key in the `window.App` namespace is assigned by exactly one file:
- `App.calc` → calc.js
- `App.dom` → dom.js
- `App.storage` → storage.js
- `App.modals` → modals.js
- `App.charts` → charts.js
- `App.recalc` → app.js

### Modals
Each modal follows the same pattern:
- Backdrop div with class `modal-backdrop`, opened with `.open` class
- `open[Name]Modal()` and `close[Name]Modal()` functions in modals.js
- Click-outside-to-close on the backdrop element
- All buttons wired via `addEventListener` (no inline onclick attributes)

Current modals:
- `scenariosModal` — saved scenarios
- `savePrompt` — save/update scenario prompt
- `amortModal` — mortgage payoff comparison chart
- `chartFullscreen` — fullscreen version of the amort chart
- `driftModal` — itemised driftkostnad breakdown
- `savingsModal` — savings entries

### localStorage keys
All keys use versioned `_v1` suffix; migration from unversioned runs once on first load (in storage.js):
- `bostadskalkyl_scenarios_v1` — saved scenario objects
- `bostadskalkyl_session_v1` — current session state (inputs + active scenario)
- `bostadskalkyl_drift_items_v1` — driftkostnad line items
- `bostadskalkyl_drift_yearly` — monthly/yearly toggle preference (no versioning needed)
- `bostadskalkyl_savings_items_v1` — savings entries
- `bostadskalkyl_theme` — light/dark theme preference (no versioning needed)

### Input types
- Currency inputs: `type="text"` with `data-type="currency"` —
  formatted with space separators, stripped on focus
- Number inputs: `type="number"` — used for rates, years, percentages
- Text inputs: bank names, listing URL, modal label fields

### Saved inputs
Three arrays drive save/restore (defined in app.js):
- `CURRENCY_IDS` — currency text inputs
- `NUMBER_IDS` — number inputs
- `TEXT_IDS` — plain text inputs (bank names, listing URL)
The ranteavdrag toggle is saved separately as `data.ranteavdrag`.

## Swedish property conventions
- Lagfart: 1.5% of purchase price
- Pantbrev cost: 2% of new pantbrev amount needed
- New pantbrev needed: loan amount minus existing pantbrev held
- Ränteavdrag: 30% tax relief on first 100 000 kr/yr interest,
  21% above that
- Fastighetsavgift: capped at 9 287 kr/yr (2024)
- Amortisation: set as annual % of loan, not a fixed term
- LTV displayed as inverse (equity %) — green ≥30%, amber 15–30%,
  red <15%

## Design system
- Fonts: DM Serif Display (headings), DM Sans (body)
- Colour palette defined as CSS variables in `:root`
- Key colours: `--accent` (green #2d5a3d), `--warn` (amber/brown #8b4a1a)
- Positive values: `--accent` green
- Negative values: `--warn` amber-brown
- Cards: `sum-card` class, clickable variant adds `sum-card-clickable`
- Currency always formatted with `sv-SE` locale via `fmt()` helper

## Git workflow
- Never commit directly to main
- Create a branch for every change: `feature/*`, `fix/*`, `refactor/*`
- Write a clear, specific commit message describing what changed and why
- Push the branch and open a PR — do not merge without review
- One logical change per PR — don't bundle unrelated changes

## Things to never do
- Never rename or remove `App.recalc()` — everything depends on it
- Never write to a `window.App.*` key from more than one file (one-writer rule)
- Never use `el.className = ...` to set classes — use `classList` to
  avoid wiping existing classes (this was a past bug)
- Never hardcode colours — always use CSS variables
- Never add `position: fixed` inside modals — breaks iframe height
- Never commit API keys, tokens or sensitive data
- Never force push to any branch
- Never merge to main without a PR
