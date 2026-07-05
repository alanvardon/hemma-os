# #5 — Hushållsbudget: lock item names behind a pen edit

## Decisions locked

- **Per-row pen icon.** Names render as plain text. A small pen icon (on hover /
  always on touch) sits next to each name; click → that one name becomes an input;
  **Enter or click-away saves and re-locks**, **Esc cancels**.
- **Scope: names only.** Line-item labels + category names. **Amounts stay
  directly editable** (unchanged). Person/income names live in modals — out of
  scope ("on the page").

## Current state

[`Hushallsbudget.tsx`](../web/src/routes/Hushallsbudget.tsx) — both are
**always-on `<input>`s**:

- **Line-item label:** `b-row-label`, `value={row.label}` ([:131](../web/src/routes/Hushallsbudget.tsx#L131)).
- **Category name:** `cat-name`, `value={cat.name}` ([:777](../web/src/routes/Hushallsbudget.tsx#L777)),
  committed via the existing rename handler ([:564](../web/src/routes/Hushallsbudget.tsx#L564)).
- Existing change handlers stay; we only gate **visibility / edit-mode**.

## Target design

### A reusable `EditableName`

```tsx
function EditableName({ value, placeholder, ariaLabel, onCommit }: {
  value: string; placeholder: string; ariaLabel: string; onCommit: (v: string) => void
}) {
  // locked:  <span> + <button class="name-edit" aria-label={`Rename ${value}`}>✎</button>
  // editing: <input autoFocus> ; Enter/blur -> onCommit, Esc -> revert
}
```

- **Single active editor** (`editingId: string | null`) is simplest — opening one
  pen closes any other. (A `Set` for multiple is possible but unnecessary.)
- Wire `onCommit` to the existing setters (line-item label setter; category
  rename at [:564](../web/src/routes/Hushallsbudget.tsx#L564)).

### Interaction details

- Pen icon: subtle, **appears on hover** (desktop) / **always visible** (touch),
  tap target ≥ 44 px on mobile.
- Entering edit mode focuses + selects the input. **Enter / blur** commit;
  **Esc** reverts to the prior value.
- Locked names render as plain text using the same typography the inputs have now,
  so the page doesn't visually shift between modes.

## Edge cases

- **Empty name on commit** → keep current placeholder fallback (category → "Category"
  in the donut [:39](../web/src/routes/Hushallsbudget.tsx#L39); line item → "What is it?").
- **New row / new category added** → optionally auto-enter edit mode so you can
  name it immediately (nice-to-have; matches the "click pen to edit" model without
  an extra click on fresh rows).
- Amount fields and the +Add buttons are untouched.

## Testing

- Component test: locked state shows text (no `<input>`); clicking the pen renders
  an input; commit calls the store setter and updates the donut label; Esc
  reverts; only one editor open at a time.

## Effort

**Small.** Independent — good to pair with #4 / #6 as a polish PR.
