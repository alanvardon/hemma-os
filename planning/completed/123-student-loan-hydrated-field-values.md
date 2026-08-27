# Plan 123 — Show hydrated Student Loan field values immediately

**Status:** plan · **Priority:** Medium · **Depends on:** —; land before Plan
102 touches the same route/input model · **Effort:** S · **Owner model:**
GPT-5.6 Terra · **Source:** owner report 2026-07-20: saved Student Loan values
only appear correctly after double-clicking a field · **Touches:**
`web/src/routes/StudentLoan.tsx`; a focused jsdom component regression test;
no calculation, persisted-shape, schema or statutory-rule change.

## Assessment

`StudentLoan` starts with `defaultStudentLoanInputs()` and then asynchronously
loads the saved blob. The resulting React state is correct and recalculates the
results, but the ordinary numeric fields and optional SLC monthly field render
with `defaultValue`. Those inputs are uncontrolled after their first mount, so
the later saved state does not reliably replace the text the user sees. Focus
or another interaction can expose the newer value, producing the reported
double-click symptom and a mismatch between visible inputs and calculated
results.

The rate-stress slider and threshold toggle are already controlled. The defect
is the text-input hydration boundary, not the Student Loan formulas or store
sanitizer.

## Product contract

- On first open or reload, never present default inputs as if they were the
  saved household values while `studentLoanStore.load()` is unresolved.
- When saved inputs exist, every visible field must show them automatically,
  without focus, click, double-click or blur.
- When nothing is saved, show the current defaults after loading completes.
- Apply the same contract to all standard numeric fields, advanced fields and
  the optional **SLC monthly repayment** field.
- Preserve the current editing behavior: grouped formatting while blurred,
  natural raw text while editing, incomplete decimal entry, blur formatting,
  units, reset and immediate calculation updates.
- Loading saved state is read-only. It must not call `save()`, flash **Saved**
  or overwrite the stored blob with defaults.
- Do not expose a transient recommendation calculated from defaults. Keep the
  existing page geometry stable with an unobtrusive loading/disabled state
  until the initial read resolves.

## Implementation

1. Add an explicit initial-load state instead of treating defaults as already
   hydrated data.
2. Replace the uncontrolled `defaultValue` contract with a controlled input
   buffer that synchronizes an external numeric value whenever the field is not
   actively being edited.
3. Keep the user's in-progress text stable while focused so entries such as
   `3.` are not collapsed mid-edit. Parse and update the model through the
   existing handlers; format from the committed numeric value on blur.
4. Use the same input primitive/contract for the optional SLC value, including
   its empty `undefined` state.
5. Keep the slider and toggle controlled and make them unavailable only during
   the initial read, matching the text fields.
6. Preserve the existing unmount guard so a late load cannot update an
   unmounted route.

This does **not** change what happens when a write succeeds, fails or disagrees
with the cache/cloud. `studentLoanStore.load/save`, write-through timing and
`reportPersistenceError` remain unchanged; the change only makes the loaded
state and edit buffer agree visibly.

## Execution

- [ ] **Stage 1 · [GPT-5.6 Terra]** — Add delayed-load component coverage, then
  implement the hydrated/controlled input contract and verify the full route.
  Gate: focused component test, then `npm run lint`, `npm run test` and
  `npm run build` from `web/`, plus local browser verification.

## Required regression coverage

- A deliberately delayed saved blob replaces every visible default value as
  soon as loading completes without any field interaction.
- The displayed recommendation and figures use the same loaded inputs shown in
  the fields.
- A `null` load produces defaults only after the load resolves.
- Hydration does not call `save()` or show save feedback.
- A user can type and retain an incomplete decimal until blur; blur formats the
  committed value correctly.
- Empty and populated optional SLC repayment values hydrate correctly.
- Reset updates all visible fields and persists exactly once through the
  existing path.
- A rejected/late result after unmount does not update the component.

## Manual verification

Using fictional locally stored data:

1. Save values that visibly differ from every default, reload the route and
   confirm all fields and results agree without clicking.
2. Repeat for advanced fields and an empty/populated SLC repayment.
3. Edit decimal, currency and year fields with keyboard and touch input; verify
   focus and blur formatting.
4. Verify at 390×844 and desktop in light/dark themes, including reduced motion.

Leave the local development server running for owner review.

## Acceptance criteria

- Saved Student Loan inputs appear automatically after reload with no click or
  double-click workaround.
- Defaults are not presented as saved values while hydration is pending.
- Visible fields, calculations and persisted state cannot disagree because of
  uncontrolled inputs.
- Editing, reset, save-failure reporting and Student Loan financial logic remain
  otherwise unchanged.

## Coordination and out of scope

- Plan 102 is the later decision-grade model rewrite. It must retain this
  hydration regression test and controlled-input contract when it changes the
  persisted input schema.
- Do not change rates, thresholds, write-off dates, recommendations, formulas
  or chart behavior here.
- Do not refactor unrelated shared field components.
