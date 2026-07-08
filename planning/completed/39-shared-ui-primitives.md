# Plan 39 — Shared UI primitives: dialog lifecycle, save-flash/toast, PageHeader, person names

**Status:** shipped, across 5 PRs (one per sub-item below) · **Owner model:**
Opus-suitable (touches all 5 tool routes; mechanical but wide) · **Req:** 4
(build order 36→…→42, after 37) · **Relationship:** extracts the cross-route
scaffolding so plan 40's file split moves small dialogs, not copy-pasted
boilerplate. Touches `web/src/components/` (new hooks/components) + all tool
routes.

> Shipped as: A (dialog lifecycle) → PR #233 `ui/dialog-shell`, plus the
> Hushållsbudget overlay→DialogShell conversion → PR #234
> `ui/hushallsbudget-dialog`; B+C (`useSaveFlash`/`useToast`/`PageHeader`) →
> PR #232 `ui/shared-primitives`; D (`usePersonNames`, tracked informally as
> "39e") → PR #242 `ui/use-person-names`; E (field reuse in dialog forms,
> tracked informally as "39d") → PR #240 `ui/shared-form-field`.

## Goal

Every tool route re-implements the same four UI patterns by hand. Extract
them once, adopt everywhere, no visual change.

## A. Dialog lifecycle — `useDialog` + `DialogShell`

~15 dialogs repeat the identical `<dialog>` scaffold: a
`useRef<HTMLDialogElement>` + `useEffect(() => { open ? ref.current?.showModal()
: ref.current?.close() })` pair (Bolanekoll PartDialog:132-134,
PaymentDialog:250-252, ValuationDialog:210-212, PeriodDialog:84-86, …;
Manadsavslut :78-80, :151-153, :244-246), and callers hold
`useState<{ open: boolean; id: string | null }>` pairs — 7 of them in
`Bolanekoll.tsx:553-564` alone.

- `components/useDialog.ts`:
  - `useDialogElement(open)` → the ref + showModal/close effect.
  - `useDialogState<TId = string>()` → `{ open, id, show(id?), close }`.
- `components/DialogShell.tsx` — thin wrapper rendering `<dialog>` with the
  shared classes/onClose wiring; dialog BODIES stay per-feature.
- Pick ONE pattern: native `<dialog>` wins (used everywhere except
  Hushållsbudget's hand-rolled overlay `Modal` — convert it to DialogShell).

## B. `useSaveFlash` + `useToast`

The saved-✓ flash (state + timeout ref + 1400ms reset) and auto-dismiss toast
are duplicated in `Bolanekoll.tsx:542-573`, `Hushallsbudget.tsx:574`,
`Lonevaxling.tsx:87-119`, `Konsultkalkyl.tsx:48-76`.

- `components/useSaveFlash.ts` → `{ saveVisible, flashSaved }` (owns the
  timer, clears on unmount).
- `components/useToast.ts` → `{ toast, showToast }` with the same auto-hide.
  Check `UndoToast.tsx` first — if its rendering fits, reuse it for the
  visual layer instead of a second toast look.

## C. `PageHeader`

Same header JSX in every route: `‹ Hemma` back-link (viewTransition), h1 +
tagline, save-state span, theme toggle (`Bolanekoll.tsx:898-911`,
`Lonevaxling.tsx:188-210`, `Konsultkalkyl.tsx:126-146`, Manadsavslut,
Hushallsbudget). New `components/PageHeader.tsx` with
`{ title, tagline, saveVisible?, actions? }`; Home keeps its custom bento
header.

## D. `usePersonNames`

`nameOf(p)` fallback (`owner_a_name || 'Alex'` / `owner_b_name || 'Sam'`)
duplicated at `Bolanekoll.tsx:588` and `Manadsavslut.tsx:394` plus inline in
dialogs. `components/usePersonNames.ts` (or `lib/household.ts` if it fits
there) → `{ a, b, nameOf }`.

## E. Field reuse in dialog forms

`fields.tsx` already exports `Field`/`CurrencyInput` but only Bostadskalkyl
uses them; dialog forms hand-write `label.form-field` + input ~100× across
Bolanekoll/Manadsavslut/Hushallsbudget. While converting each dialog to
DialogShell, swap raw inputs for the `fields.tsx` components where they fit
(don't force selects/dates — add `FieldSelect` only if ≥3 uses materialize).
Merge Hushållsbudget's local `AmountInput` (`Hushallsbudget.tsx:105-119`,
same focus-format behavior) into `CurrencyInput`.

## Out of scope

- Moving dialogs into their own files — plan 40 (keeps this diff reviewable).
- CSV-import UI — plan 40.
- Restyling anything; CSS untouched until plan 42.

## Verify

- `npm run test` + `npm run build`.
- `npm run dev`, per tool: open/close every converted dialog (incl. Escape
  and backdrop), trigger a save → flash shows once and fades, toast paths
  fire, header back-link still runs the view transition, person names show
  the configured names and the Alex/Sam fallbacks.
