# #3 — Bostadskalkyl scenarios dashboard

## Decisions locked

- **Dashboard-first.** Opening Bostadskalkyl lands on a **full-page scenarios
  overview** (`/bostadskalkyl`), a grid of saved-scenario cards + a "New
  scenario" action. Clicking a card opens the calculator for that scenario at
  `/bostadskalkyl/:id`. The current `ScenariosModal` goes away.
- **Hybrid save model.** Named scenario cards **auto-save** on edit (no
  Save/Update button, no dirty dot — the card always shows live numbers).
  **"New scenario"** opens a **scratch draft** that only becomes a card once you
  name & save it.

## Why this is the foundation

This restructures routing + the store, which both #2 (per-scenario constants live
inside the `Scenario` record) and #1 (the card-expand morph lands on this
dashboard) build on. Do this first.

## Current state

- Flat `HashRouter`, single route `/bostadskalkyl` → [`Bostadskalkyl.tsx`](../web/src/routes/Bostadskalkyl.tsx)
  renders the two-column calculator and a `<ScenariosModal>`.
- Store [`useStore.ts`](../web/src/store/useStore.ts): one global live `inputs`
  (the "session"), `scenarios: Scenario[]`, `activeScenarioId`, `isDirty`.
  - `Scenario = { id, name, savedAt, inputs }` ([storage.ts:16](../web/src/lib/storage.ts#L16)).
  - Session (`{ inputs, activeScenarioId, isDirty }`) persisted separately from
    the scenarios list. `setField` mutates the global `inputs` + flips `isDirty`.
  - Save flow: `saveNewScenario(name)` / `updateActiveScenario()` /
    `loadScenario(id)` / `duplicateScenario` / `deleteScenario` + undo.
- Drift/savings line items are **session-level, not per-scenario** (store
  comment, [useStore.ts:21](../web/src/store/useStore.ts#L21)) — leave as-is.

## Target design

### Routes ([App.tsx:38](../web/src/App.tsx#L38))

Replace the single `/bostadskalkyl` route with:

| Path | Component | Mode |
|------|-----------|------|
| `/bostadskalkyl` | `ScenariosDashboard` (new) | overview grid |
| `/bostadskalkyl/new` | `Bostadskalkyl` calculator | **draft** (scratch) |
| `/bostadskalkyl/:id` | `Bostadskalkyl` calculator | **bound** (auto-save) |

`useParams()` / the matched route decides the calculator's mode.

### Store refactor

Introduce an explicit editing mode rather than one global mutable `inputs`:

```ts
// mode is derived from the route, not stored as truth, but the store needs:
draftInputs: Inputs            // the scratch buffer for /new
updateDraft(partial)           // edits in draft mode
saveDraftAsScenario(name)      // draft -> new Scenario, returns id (redirect to it)
updateScenarioInputs(id, partial)  // bound mode: write-through + debounced persist
getScenario(id): Scenario | undefined
```

- **Bound mode** (`/:id`): `setField` → `updateScenarioInputs(id, …)`, which
  updates the scenario in `scenarios[]` and debounce-persists (≈300–500 ms) to
  avoid hammering localStorage on every keystroke. `savedAt` bumps on write.
  This replaces the manual `updateActiveScenario()` + dirty tracking.
- **Draft mode** (`/new`): `setField` → `updateDraft`. Nothing hits `scenarios[]`
  until **Save** → `saveDraftAsScenario(name)` → redirect to `/bostadskalkyl/:id`.
- Keep `duplicateScenario` (branch a what-if), `deleteScenario` + undo toast.
- `loadScenario`/`activeScenarioId`/`isDirty` largely retire; `derive(inputs)` is
  fed the active scenario's (or draft's) inputs.

### Components

- **`ScenariosDashboard.tsx`** (new route): page header (‹ Hemma back-link,
  theme toggle, **New scenario** primary button), responsive grid of scenario
  cards, empty state, delete-undo toast. **Reuse the card markup** currently in
  [`ScenariosModal.tsx`](../web/src/components/ScenariosModal.tsx) (`.scenario-card`,
  the derive() stats) by extracting a shared `ScenarioCard` component. Card actions:
  Open (→ `/:id`), Duplicate, Delete.
- **`Bostadskalkyl.tsx`** becomes the calculator shell parameterized by route:
  - header back-link changes from "Scenarios" button to **‹ All scenarios** (→ `/bostadskalkyl`).
  - **Bound mode:** drop Save/Update button + dirty dot; show a quiet "All
    changes saved" / `savedAt` indicator. Keep the editable scenario name inline
    in the header (renames the card).
  - **Draft mode:** keep a **Save scenario** primary button (opens the existing
    `SavePrompt` to name it) — that's the only place a card is born.
- Retire `ScenariosModal.tsx` (or keep only as the extracted `ScenarioCard`).

## Edge cases

- **Deleting the scenario you're editing** → navigate back to `/bostadskalkyl`.
- **Unknown `:id`** (stale link) → redirect to the dashboard.
- **Existing users' migration:** their current session has live `inputs` that may
  be a non-default unsaved calc. On first dashboard load, if the session is dirty
  / non-default, offer a **"Continue unsaved draft"** entry (or silently seed
  `/new`). Saved scenarios already carry over untouched (same localStorage keys).
- **Auto-save debounce** so typing in an amount field doesn't write 10×/second.
- **Empty dashboard** (new user, zero scenarios): friendly empty state + a
  prominent New scenario CTA that goes straight to `/new`.

## Testing

- Store unit tests ([useStore.test.ts](../web/src/store/useStore.test.ts) — update):
  draft → save creates a scenario and returns its id; bound edit auto-saves &
  bumps `savedAt`; delete-active path; duplicate.
- Component test: dashboard renders cards from store, empty state, New navigates
  to `/new`.
- Keep the golden `derive()` test untouched (calc unaffected here).

## Effort

**Medium–Large** — the biggest of the six. Router restructure + store mode
refactor + new dashboard page + a small migration nicety.

## Sequencing

Do **first**. #2 extends `Scenario` with per-scenario `constants`; #1's morph
destination is this dashboard.
