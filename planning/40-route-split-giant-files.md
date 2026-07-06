# Plan 40 — Split the giant routes: Bolånekoll 1,493 → modular files

**Status:** plan · **Owner model:** Opus-suitable (large mechanical move,
needs discipline to not "improve" while moving) · **Req:** 5 (build order
36→…→42, after 39 — dialogs must already sit on DialogShell/useDialog so
what moves is small) · **Relationship:** pure file reorganization; behavior
and rendered output identical. Touches `web/src/routes/`.

## Goal

Three route files carry whole sub-apps in one file: `Bolanekoll.tsx` (1,493
lines — 13 dialog components defined at lines 84-509 before the main
component even starts, main body ~530-1493), `Hushallsbudget.tsx` (1,050),
`Manadsavslut.tsx` (886). Split by feature into per-route folders so each
file is one component at ~100-300 lines.

## A. `routes/bolanekoll/`

- Move each dialog to its own file: `PartDialog.tsx`, `PaymentDialog.tsx`,
  `ValuationDialog.tsx`, `PeriodDialog.tsx`, `SettingsDialog.tsx`, … (13
  components at `Bolanekoll.tsx:84-509`). Shared route-local types/helpers
  go in `routes/bolanekoll/shared.ts`.
- `Bolanekoll.tsx` stays the route entry: state, handlers, layout JSX.
- Import path for the router (`App.tsx`) unchanged, or update the lazy
  import if the file moves into the folder as `bolanekoll/index.tsx` —
  prefer keeping `routes/Bolanekoll.tsx` as entry to minimize churn.

## B. `routes/manadsavslut/`

Same treatment: `PersonalOffsetDialog.tsx`, `ItemDialog.tsx`,
`SettleDialog.tsx`, `SettingsDialog.tsx` (defined around
`Manadsavslut.tsx:310+`).

## C. Hushållsbudget extractions

- `EditableName` (`Hushallsbudget.tsx:128-171`) → `components/EditableName.tsx`
  (it's generic: click-to-rename with commit/cancel).
- Its `AmountInput` should already be merged into `CurrencyInput` by plan 39;
  if not, do it here.

## D. CSV/file-import UI — extract only what's truly shared

Bolanekoll (`~1057-1157`) and Manadsavslut both build a dropzone +
hidden-file-input (+ ref-clearing) + triage-table flow. READ BOTH first:

- The dropzone + file-input handling looks genuinely identical → extract
  `components/FileDropzone.tsx`.
- The mapping/triage tables differ in columns and semantics → keep per-route
  (`routes/bolanekoll/ImportPanel.tsx`, `routes/manadsavslut/ImportPanel.tsx`).
- Do NOT build a generic `ImportWorkflow<T>` unless, once side by side, the
  two flows are near-identical — premature abstraction here is worse than
  two clear copies.

## E. Sweep while moving (no logic edits)

- Replace the two remaining `Fragment` imports usable as `<>` shorthand.
- `Lonevaxling.tsx`/`Konsultkalkyl.tsx` import `motion` only for
  `useReducedMotion` — import the hook directly.
- Kill any now-dead `let CURRENT_CURRENCY` module vars (plan 37's formatter
  factory replaces them).

## Out of scope

- Any behavior/handler/state changes — if a bug is spotted, note it in the
  PR description, don't fix it in this diff.
- Lonevaxling/Konsultkalkyl (418/415 lines) — fine as single files.

## Verify

- `npm run test` + `npm run build`.
- `git diff --stat` should show moves + import changes; grep the PR for any
  changed JSX inside moved components (there should be ~none).
- `npm run dev`: click through every dialog and both import flows end-to-end
  (Bolånekoll CSV import incl. column mapping + triage; Månadsavslut
  statement import), compare against the deployed site.
