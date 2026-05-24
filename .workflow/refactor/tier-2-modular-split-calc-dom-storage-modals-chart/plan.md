# Tier 2 modular split — calc, dom, storage, modals, charts, orchestrator app

**Type:** refactor

## Source design doc

`notes/10-refactor-out-of-single-html.md`

## Affected areas

**File rename:**
- `bostadskalkyl.html` → `index.html`

**CSS:**
- Extract the `<style>` block of `bostadskalkyl.html` into `styles.css`
- Replace `<style>…</style>` in `index.html` with `<link rel="stylesheet" href="styles.css">`

**HTML:**
- Remove all 34 inline `onclick`/`onchange`/`oninput` attributes
- Final script tag order at the bottom of `<body>`: Chart.js CDN, then `calc.js`, `dom.js`, `storage.js`, `modals.js`, `charts.js`, `app.js`
- Add `inputs-loading` class to the inputs column for async boot mitigation

**JavaScript — new files produced by carving `app.js`:**
- `calc.js` — pure math and formatters
- `dom.js` — `set()`, `val()`
- `storage.js` — async Promise-returning localStorage wrappers, `onChange` pub/sub, `_v1` key migration
- `modals.js` — all six modal open/close pairs plus their backdrop listeners
- `charts.js` — amort chart, fullscreen chart, lump-sum logic
- `app.js` — `window.App = {}`, `App.recalc()`, event wiring, async boot

**New files:**
- `calc.test.js` — `node --test` unit tests for pure calculations
- `.netlifyignore` — excludes `*.test.js`

## Decisions made before implementation

1. **`closeModal()` is renamed to `closeScenariosModal()` in Commit 2d**, and its single `onclick="closeModal()"` HTML attribute is migrated to `addEventListener` in the same commit. The remaining 33 inline handlers are removed in Commit 3.

2. **`getSavingsTotal()` lives in `modals.js` as `App.modals.getSavingsTotal()`**, reading from an in-memory cache that boot populates via `App.modals.setSavingsItems(items)`. Storage stays a leaf; it only exposes raw `loadSavingsItems()`.

3. **`initTheme()` / `toggleTheme()` stay in `app.js`** — theme is global orchestrator chrome, not modal-internal.

4. **`calc.js` gets a guarded CJS export tail** so `calc.test.js` can `require('./calc.js')` without a `global.window = global` shim:
   ```js
   if (typeof module !== 'undefined') module.exports = window.App.calc;
   ```
   Invisible in the browser.

5. **Drift and savings items are pre-loaded at boot in `app.js`** and pushed to modals via `App.modals.setDriftItems(items)` / `App.modals.setSavingsItems(items)`. `App.recalc()` (sync) depends on both totals, so lazy modal-open loading would be incorrect.

## Functions impacted

**`calc()` (master orchestrator) → renamed to `App.recalc()` in `app.js`.** Pure math inside it is promoted to named functions in `calc.js`.

**`calc.js` (pure):**
- `lagfart(price)` — `price * 0.015`
- `pantbrevCost(loan, existingPantbrev)` — `Math.max(0, loan - existingPantbrev) * 0.02`
- `ranteavdrag(annualInterest)` — two-bracket: 30% on ≤100 000, 21% above
- `monthlyCost(loanAmount, annualRatePct, monthlyAmort, taxMonthly, driftkostnad)` — sum
- `fastighetsavgiftCap(propertyTax)` — `Math.min(propertyTax, 9287)`
- `equityPct(loanAmount, price)` — LTV%; equity = 100 − result
- `buildAmortSchedule(startBalance, annualAmortRate, lumpPayments, termCap)`
- `fmt(n)`, `pct(n)`, `formatWithSpaces(n)`, `parseFormatted(str)`

**`dom.js`:** `set(id, text, cls)`, `val(id)`

**`storage.js`** (all async, return Promises; bodies sync localStorage today):
- `loadScenarios()`, `saveScenarios(scenarios)`
- `loadSession()`, `saveSession(inputs, activeScenarioId, isDirty)`
- `loadDriftItems()`, `saveDriftItems(items)`
- `loadSavingsItems()`, `saveSavingsItems(items)`
- `onChange(key, cb)` — pub/sub registry, never fires today (callbacks stored for future Supabase realtime)
- Versioned keys: `bostadskalkyl_scenarios_v1`, `bostadskalkyl_session_v1`, `bostadskalkyl_drift_items_v1`, `bostadskalkyl_savings_items_v1` with one-time migration from unversioned

**`modals.js`:**
- All six modal open/close pairs (including renamed `closeScenariosModal`)
- `saveMode` state; `handleSaveClick`, `openNewSavePrompt`, `openUpdatePrompt`, `closeSavePrompt`, `confirmSave`
- `renderScenariosModal`, `loadScenario`, `deleteScenario`
- `updateHeaderLabel`
- Drift CRUD + in-memory cache + `setDriftItems(items)` setter
- Savings CRUD + in-memory cache + `setSavingsItems(items)` setter + `getSavingsTotal()`
- All backdrop click handlers; `saveNameInput` keydown
- `// FUTURE: extract to drift.js once >200 lines` markers above drift/savings sections

**`charts.js`:**
- Top of IIFE: `const Chart = window.Chart;` with `// FUTURE: replace with ESM import` comment
- `amortChartInstance`, `fullscreenChartInstance`, `lumpSums` module-level state
- `getChartColors()`, `renderAmortChart()`, `addLumpSum()`, `removeLumpSum()`, `renderLumpSums()`, `calcTargetLumpSum()`
- `openFullscreenChart`, `closeFullscreenChart` (moved here — charts.js owns the canvas)

**`app.js`:**
- `window.App = {}` init
- `activeScenarioId`, `isDirty`, `saveMode` state
- `readInputs()`, `writeInputs(data)`, `markDirty()`
- `initTheme()`, `toggleTheme()`
- `App.recalc()` orchestrator
- Event listener wiring for all inputs and header buttons
- Async boot sequence

## localStorage

**New versioned keys:**
- `bostadskalkyl_scenarios_v1`
- `bostadskalkyl_session_v1`
- `bostadskalkyl_drift_items_v1`
- `bostadskalkyl_savings_items_v1`

**Migration:** on first read of each `_v1` key — if unversioned exists and `_v1` does not, copy and delete the unversioned. Runs once per user.

**Unchanged:** `bostadskalkyl_drift_yearly`, `bostadskalkyl_theme`.

## New DOM elements / CSS

- CSS class `.inputs-loading { visibility: hidden; }` in `styles.css`
- Applied to the inputs column `<div>` in `index.html`
- Removed by `app.js` after the first `App.recalc()` completes during boot

## Implementation order

### Commit 0 — Behavioural safety net

1. In `bostadskalkyl.html`, extract pure calculations from the inline body of `calc()` into named functions above `calc()` (still inside the single `<script>` block):
   - `lagfart`, `pantbrevCost`, `ranteavdrag`, `equityPct`, `fastighetsavgiftCap`
   - Verify `buildAmortSchedule`, `fmt`, `pct`, `formatWithSpaces`, `parseFormatted` are already named — they are, no change
2. Update `calc()` body to call the new named functions.
3. Create `calc.test.js` at repo root using `node:test` and `node:assert`. At Commit 0 the test file defines functions inline (baseline) — updated in Commit 2a to load from `calc.js`. Cases:
   - `lagfart(2_000_000) === 30_000`; `lagfart(0) === 0`
   - `pantbrevCost(1_500_000, 1_000_000) === 10_000`; `pantbrevCost(800_000, 1_000_000) === 0`
   - `ranteavdrag(80_000) === 24_000`; `ranteavdrag(100_000) === 30_000`; `ranteavdrag(150_000) === 40_500`
   - `equityPct(1_500_000, 2_000_000) === 75`; `equityPct(0, 0) === 0`
   - `fastighetsavgiftCap(12_000) === 9_287`; `fastighetsavgiftCap(6_000) === 6_000`
4. Create `.netlifyignore` at repo root containing `*.test.js`.
5. Verify: `node calc.test.js` passes. Open `bostadskalkyl.html` in browser — no console errors, all sections compute.

### Commit 1 — Tier 1 mechanical extract

1. Rename `bostadskalkyl.html` → `index.html`.
2. Cut `<style>…</style>` contents into `styles.css`; replace with `<link rel="stylesheet" href="styles.css">`.
3. Cut `<script>…</script>` contents into `app.js`; replace with `<script src="app.js"></script>`. Keep Chart.js CDN tag above it.
4. Verify: `node --check app.js`; open `index.html` (file://) — full smoke test.

### Commit 2a — `calc.js`

1. Create `calc.js` as IIFE; assign `window.App = window.App || {}; window.App.calc = { ... }`.
2. Append guarded CJS tail: `if (typeof module !== 'undefined') module.exports = window.App.calc;`
3. In `app.js`, delete copied functions; prefix all call sites with `App.calc.` (especially the many `fmt`/`parseFormatted` sites).
4. In `index.html`, add `<script src="calc.js"></script>` before `<script src="app.js"></script>`.
5. Update `calc.test.js` to `require('./calc.js')` and pull functions from the export.
6. **Note:** any rendered `innerHTML` strings that reference `fmt`/`parseFormatted` in `onfocus`/`onblur` attributes must be updated to `App.calc.fmt` / `App.calc.parseFormatted` (these die in Commit 3 anyway when inline handlers go).
7. Verify: `node --check calc.js`, `node calc.test.js`, browser smoke test.

### Commit 2b — `dom.js`

1. Create `dom.js` IIFE with `set`, `val`; export `window.App.dom`.
2. In `app.js`, replace all `set(...)` → `App.dom.set(...)` and `val(...)` → `App.dom.val(...)`.
3. Add `<script src="dom.js"></script>` after `calc.js`.
4. Verify: `node --check dom.js`; browser smoke test.

### Commit 2c — `storage.js`

1. Create `storage.js` IIFE:
   - `KEYS` constant mapping logical names to `_v1` strings
   - One-time migration: for each key pair, if unversioned exists and `_v1` does not, copy + delete
   - All public functions return `Promise.resolve(...)` (sync localStorage body today)
   - `onChange(key, cb)` — subscriber registry; `// FUTURE: fire on Supabase realtime events`
   - `// FUTURE: per-user vs household` comment on `saveSession`
2. In `app.js`, update all localStorage calls. Boot path uses `await`; modal saves are fire-and-forget (then call `App.recalc()`).
3. Add `<script src="storage.js"></script>` after `dom.js`.
4. Verify: `node --check storage.js`; browser smoke test — session/scenarios/drift/savings all persist across reload; unversioned → `_v1` migration works on first run.

### Commit 2d — `modals.js`

1. Create `modals.js` IIFE containing all modal logic listed above.
2. **Rename `closeModal` → `closeScenariosModal`.** Update the single `onclick="closeModal()"` HTML attribute in `index.html` to `addEventListener` wiring inside `openScenariosModal()` (or boot wiring inside the IIFE).
3. In modals' save paths: after any state change affecting the main view, call `App.recalc()` directly (not via storage `onChange`).
4. Add `setDriftItems(items)` and `setSavingsItems(items)` setters so boot can populate the caches.
5. Expose `App.modals.getSavingsTotal()` for the orchestrator.
6. Add `// FUTURE: extract to drift.js once >200 lines` markers.
7. In `app.js`, remove moved functions; route remaining call sites through `App.modals.*`.
8. In `index.html`, add `<script src="modals.js"></script>` after `storage.js`. Update any remaining inline `onclick` attributes that reference modal functions to use the `App.modals.*` namespace (full removal of inline attributes happens in Commit 3).
9. Verify: `node --check modals.js`; browser smoke test — every modal opens/closes, saves persist.

### Commit 2e — `charts.js`

1. Create `charts.js` IIFE:
   - Top: `const Chart = window.Chart; // FUTURE: replace with ESM import`
   - Cut `amortChartInstance`, `fullscreenChartInstance`, `lumpSums`, `getChartColors`, `renderAmortChart`, `addLumpSum`, `removeLumpSum`, `renderLumpSums`, `calcTargetLumpSum` from `app.js`
   - Move `openFullscreenChart` / `closeFullscreenChart` from `modals.js` to `charts.js` (charts owns the canvas)
2. In `app.js` and `modals.js`, replace direct calls with `App.charts.*`.
3. Inside `renderLumpSums` the `innerHTML` string references `addLumpSum`/`removeLumpSum` — temporarily use `App.charts.addLumpSum` / `App.charts.removeLumpSum`; these die in Commit 3 when the row template switches to delegated listeners.
4. Add `<script src="charts.js"></script>` after `modals.js`.
5. Verify: `node --check charts.js`; browser smoke test — amort modal chart renders, fullscreen renders, lump sums work, theme toggle re-renders chart.

### Commit 2f — Clean `app.js` and async boot

1. `app.js` retains: `window.App = window.App || {}`, module state (`activeScenarioId`, `isDirty`, `saveMode`), `readInputs`, `writeInputs`, `markDirty`, `initTheme`, `toggleTheme`, `App.recalc()`, event wiring, async boot.
2. Boot sequence:
   ```js
   (async function boot() {
     initTheme();
     const driftItems = await App.storage.loadDriftItems();
     App.modals.setDriftItems(driftItems);
     const savingsItems = await App.storage.loadSavingsItems();
     App.modals.setSavingsItems(savingsItems);
     const session = await App.storage.loadSession();
     if (session && session.inputs) {
       writeInputs(session.inputs);
       activeScenarioId = session.activeScenarioId || null;
       isDirty = session.isDirty || false;
       App.modals.updateHeaderLabel();
     }
     App.recalc();
     document.querySelector('.inputs-col').classList.remove('inputs-loading');
   })();
   ```
3. Add `.inputs-loading { visibility: hidden; }` to `styles.css`; add class to inputs column in `index.html`.
4. Final script tag order:
   ```html
   <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
   <script src="calc.js"></script>
   <script src="dom.js"></script>
   <script src="storage.js"></script>
   <script src="modals.js"></script>
   <script src="charts.js"></script>
   <script src="app.js"></script>
   ```
5. **Update `.claude/agents/qa.md` in this commit** (not deferred to Commit 3) so QA doesn't false-fail on the renamed `calc()` — update the "Calculation integrity" checklist to reference `App.recalc()`.
6. Verify: `node --check app.js`; full browser smoke test; no flash of blank page (`.inputs-loading` removed after first recalc).

### Commit 3 — Cross-cutting cleanup

1. Remove all remaining inline `onclick`/`onchange`/`oninput` attributes from `index.html` (the 33 that weren't touched in 2d):
   - Static buttons (theme, Scenarios, Save header, modal `×` close buttons, clickable cards): `addEventListener` in `app.js` or `modals.js`
   - `driftYearlyToggle` onchange: `modals.js` boot wiring
   - `affordThreshold` oninput, `ranteavdragToggle` onchange, `stressSlider` oninput: `app.js` event block
   - "Open ›" listing URL button: `app.js`
   - Dynamic row templates (`renderLumpSums`, `renderDriftItems`, `renderSavingsItems`): replace `onclick="..."` strings with `data-*` attributes + delegated listeners in the respective render module
2. Update `.claude/skills/static-checks/static-checks.sh`:
   - Replace the awk inline-JS extraction + single `node --check` with `node --check` on each `.js` file
   - Add `node --test calc.test.js`
   - `DIFF_ADDED` covers `index.html calc.js dom.js storage.js modals.js charts.js app.js styles.css`
   - `className =` and hex colour checks run against all JS files
   - ID-array and localStorage-key searches span all JS files
3. Update `CLAUDE.md`:
   - "File structure" section: new flat file layout (7 files)
   - "Key functions": `calc()` entry → `App.recalc()` in `app.js`; add entries for `App.calc.*`, `App.dom.set/val`, `App.storage.*`, `App.modals.*`, `App.charts.*`
   - Retire the "never rename `calc()`" rule; replace with the one-writer-per-`App.*`-key rule
   - Document the load order
   - Note `_v1` suffix on localStorage keys
4. Audit `.claude/agents/*.md`:
   - `implementation.md`, `planning.md`, `coordinator.md`: replace any "inline `<script>` block" / "single-file" references
   - `qa.md` was already updated in Commit 2f; double-check for stragglers
5. Audit `notes/*.md` for stale single-file references (informational only — historical notes left intact unless they contain active instructions).
6. Verify: `node --test calc.test.js`; `bash .claude/skills/static-checks/static-checks.sh`; full definition-of-done checklist.

## Definition of done (verify byte-identical behaviour after the split)

- [ ] Save a scenario → reload → scenario still listed
- [ ] Load a scenario → all inputs repopulate, all outputs match
- [ ] Drift modal → add/edit/delete item → persists across reload
- [ ] Savings modal → add/edit/delete item → persists across reload
- [ ] Amort chart renders; fullscreen variant renders
- [ ] Session state restores on reload (all inputs)
- [ ] Ränteavdrag toggle persists
- [ ] Listing URL persists
- [ ] All 4 sections recalculate on every input change
- [ ] No console errors on load or interaction
- [ ] Inputs column hides briefly during boot then reveals (no flash of empty inputs)
- [ ] `_v1` migration runs cleanly on a profile with pre-existing unversioned data

## Risks

- **`closeModal` rename** must happen alongside the inline `onclick` migration in Commit 2d, else the scenarios modal won't close in the intermediate state.
- **`App.calc.*` in innerHTML strings** during Commits 2a–2e are easy to miss; Commit 3 eliminates them by switching to delegated listeners.
- **`getSavingsTotal()` cache freshness** depends on boot pre-loading and modals updating the cache on every CRUD operation; verify all four mutation paths (add/remove/edit/save) push the new array to the cache.
- **`static-checks.sh` is broken transiently** between Commit 1 and Commit 3 — running it during this window will misreport. PR description must call this out.
- **QA agent expectations** must be updated in Commit 2f (renamed `calc()` → `App.recalc()`), not deferred to Commit 3, or the coordinator's QA pass will false-fail.
- **Node 18+ required** for `node --test` in `calc.test.js`. Verify before Commit 0.
- **Async boot flash** on slow machines — `.inputs-loading` is the documented mitigation; surface visibly during QA.

PLAN COMPLETE: title=Tier 2 modular split — calc, dom, storage, modals, charts, orchestrator app, type=refactor
