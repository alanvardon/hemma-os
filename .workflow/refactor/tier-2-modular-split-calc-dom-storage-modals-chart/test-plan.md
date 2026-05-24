# Test plan — Tier 2 modular split

## Boot and session

- [ ] Open `index.html` in a browser (file:// or localhost) — no console errors on load
- [ ] Inputs column is briefly hidden (inputs-loading class) then reveals after boot completes
- [ ] All input fields show their saved values from the previous session on reload
- [ ] All derived values and summary panel update on first load without user interaction
- [ ] With no prior session data, default values render correctly

## Calculation integrity (App.recalc)

- [ ] Change any currency input — all sections recalculate immediately
- [ ] Change any number input (interest rate, amort rate, term) — recalculates
- [ ] Change bank name — bank diff label updates
- [ ] Move the stress slider — stress test results update
- [ ] Toggle ränteavdrag checkbox — effective monthly cost recalculates
- [ ] Change affordability threshold — required salary updates
- [ ] Verify lagfart (1.5% of purchase price) appears correctly in Section 2
- [ ] Verify ränteavdrag (30%/21% bracket) matches manual calculation
- [ ] Verify equity bar colour: green ≥30%, amber 15–30%, red <15%

## Scenarios modal

- [ ] Click Scenarios — modal opens with correct saved scenarios list
- [ ] Click × close button — modal closes
- [ ] Click outside modal backdrop — modal closes
- [ ] Save a scenario (Save button) → modal shows it in list
- [ ] Load a scenario → all inputs repopulate, all outputs match saved values
- [ ] Delete a scenario → disappears from list, header label updates
- [ ] Update an existing scenario (dirty state) → name unchanged, inputs updated
- [ ] Session state (activeScenarioId, isDirty) persists across reload

## Save prompt

- [ ] Click Save — save prompt appears
- [ ] Enter a name and press Enter — scenario saved
- [ ] Press Escape — save prompt closes without saving
- [ ] Click Cancel — save prompt closes without saving

## Drift modal

- [ ] Click drift cost card — modal opens with saved items
- [ ] Add a drift item → appears in list, total updates
- [ ] Edit label and amount — persists on close and reopen
- [ ] Delete a drift item — total updates, driftkostnad input in Section 3 updates, App.recalc runs
- [ ] Toggle Monthly/Yearly mode — amounts scale correctly
- [ ] Click × close button — modal closes
- [ ] Click outside modal backdrop — modal closes
- [ ] Drift items persist across browser reload

## Savings modal

- [ ] Click cash surplus/shortfall card — savings modal opens
- [ ] Add a savings entry — total updates, cash balance card in summary updates
- [ ] Edit label and amount — persists
- [ ] Delete an entry — total and cash balance update
- [ ] Click × close button — modal closes
- [ ] Click outside modal backdrop — modal closes
- [ ] Savings entries persist across browser reload

## Amort modal

- [ ] Click mortgage card — amort modal opens, chart renders without `ReferenceError: renderAmortChart is not defined` (fixed: now calls `App.charts.renderAmortChart()`)
- [ ] Chart shows current and new mortgage lines with correct payoff years
- [ ] Add a lump sum payment — chart updates
- [ ] Edit lump sum year and amount — chart updates
- [ ] Remove a lump sum — chart updates
- [ ] Use target payoff calculator — result appears for valid inputs
- [ ] Click chart expand area — fullscreen chart opens
- [ ] Fullscreen chart renders correctly
- [ ] Close fullscreen with × button — closes correctly
- [ ] Click outside fullscreen backdrop — closes correctly
- [ ] Close amort modal with × button — closes correctly
- [ ] Click outside amort modal backdrop — closes correctly

## Theme toggle

- [ ] Click sun/moon button — theme switches between light and dark
- [ ] Amort chart re-renders with new theme colours after toggle
- [ ] Theme preference persists across reload

## Listing URL

- [ ] Enter a URL and click Open › — browser navigates to URL
- [ ] URL without http prefix gets https:// prepended

## localStorage migration

- [ ] If legacy unversioned keys (bostadskalkyl_scenarios, bostadskalkyl_session, etc.) exist,
      they are migrated to _v1 keys on first load and the unversioned keys are removed
- [ ] Migrated data loads correctly (scenarios, drift items, savings, session)

## File integrity

- [ ] node --check passes for all JS files: calc.js, dom.js, storage.js, modals.js, charts.js, app.js
- [ ] node --test calc.test.js: all 11 tests pass
- [ ] No console errors after any interaction
- [ ] No inline onclick/onchange/oninput/onfocus/onblur attributes remain in index.html
