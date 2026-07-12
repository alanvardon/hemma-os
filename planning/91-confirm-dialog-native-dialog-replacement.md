# Plan 91 — Replace every native `confirm()` with a themed `ConfirmDialog`

**Status:** plan · **Owner model:** Split — **Opus** for the `ConfirmDialog`
component + `useConfirm()` promise-based API design (the imperative→declarative
bridge and focus/Escape/promise-resolution semantics must be reasoned, not
pattern-matched); **Sonnet** can fan out the ~19 call-site swaps once the
component + first converted call site exist · **Source:** user report
2026-07-12 ("dialog boxes are standard browser dialog boxes e.g. when
delete") · **Sequencing:** independent of plan 90, but **coordinate on
Hushållsbudget** — plan 90 Layer 3 converts the two save/delete-failure
`alert()`s there to a `useToast` toast; this plan does **not** touch those. If
90 lands first, `useToast` is already wired into Hushållsbudget and this plan
reuses it for the three leftover `alert()`s; if this plan lands first, it wires
`useToast` itself and 90 Layer 3 becomes a no-op merge. Either order works; do
not double-convert lines 221/331. · **Touches:** `web/src/components/ConfirmDialog.tsx`
(**new**), `web/src/components/useConfirm.tsx` (**new**), `web/src/App.tsx`
(mount the provider), `web/src/styles/modals.css` (dialog CSS),
`web/src/routes/Bolanekoll.tsx`, `web/src/routes/Manadsavslut.tsx`,
`web/src/routes/Hushallsbudget.tsx`, `web/src/routes/bolanekoll/PartDialog.tsx`,
`web/src/routes/bolanekoll/ContribDialog.tsx`,
`web/src/routes/bolanekoll/ValuationDialog.tsx`,
`web/src/routes/bolanekoll/PaymentDialog.tsx`,
`web/src/routes/bolanekoll/PeriodDialog.tsx`, and a new component test.

## Finding

The app is themed (light + a dark mode with an aurora video backdrop), yet
every destructive confirmation is a **native `window.confirm()`** — an unstyled
OS dialog that ignores the theme, can't render a danger-red button, blocks the
main thread, and looks foreign against the polished UI. There are **19** such
calls (excluding `SavePrompt.tsx:45`, which is a *local* function named
`confirm`, not the native one — leave it alone).

Meanwhile the building block already exists:
[DialogShell.tsx](../web/src/components/DialogShell.tsx) wraps a native
`<dialog>` and gives focus-trap, Escape-to-close, backdrop-click-to-close, and
background inert-ing for free via `showModal()`. Every tool dialog is already
built on it. A confirm dialog is just DialogShell + a title + a message + a
cancel/confirm button pair.

### The 19 native `confirm()` call sites

Grep to regenerate the exact list before starting:
`grep -rn "[^.]confirm(" web/src --include="*.tsx" | grep -v SavePrompt`

**Single-item deletes (danger):**
- [Bolanekoll.tsx:272](../web/src/routes/Bolanekoll.tsx#L272) — delete loan part + all its payments (cascade)
- [Bolanekoll.tsx:1277](../web/src/routes/Bolanekoll.tsx#L1277) — delete valuation
- [Bolanekoll.tsx:1471](../web/src/routes/Bolanekoll.tsx#L1471) — delete payment
- [Bolanekoll.tsx:1575](../web/src/routes/Bolanekoll.tsx#L1575) — delete contribution
- [PartDialog.tsx:61](../web/src/routes/bolanekoll/PartDialog.tsx#L61) — delete rate period
- [PartDialog.tsx:72](../web/src/routes/bolanekoll/PartDialog.tsx#L72) — delete loan part + payments (cascade)
- [ContribDialog.tsx:36](../web/src/routes/bolanekoll/ContribDialog.tsx#L36) — delete contribution
- [ValuationDialog.tsx:33](../web/src/routes/bolanekoll/ValuationDialog.tsx#L33) — delete valuation
- [PaymentDialog.tsx:60](../web/src/routes/bolanekoll/PaymentDialog.tsx#L60) — delete payment
- [PeriodDialog.tsx:40](../web/src/routes/bolanekoll/PeriodDialog.tsx#L40) — delete rate period
- [Manadsavslut.tsx:188](../web/src/routes/Manadsavslut.tsx#L188) — delete item
- [Hushallsbudget.tsx:329](../web/src/routes/Hushallsbudget.tsx#L329) — delete submission

**Bulk / irreversible (danger, needs a strong "sure?"):**
- [Manadsavslut.tsx:199](../web/src/routes/Manadsavslut.tsx#L199) — delete all N open items
- [Bolanekoll.tsx:639](../web/src/routes/Bolanekoll.tsx#L639) — delete N payments
- [Hushallsbudget.tsx:639](../web/src/routes/Hushallsbudget.tsx#L639) — reset budget to example data
- [Hushallsbudget.tsx:591](../web/src/routes/Hushallsbudget.tsx#L591) — remove category (rows move to fallback)

**Multi-line decisions (NOT deletes — these especially need a real dialog,
because native `confirm` renders `\n` as cramped monospace):**
- [Bolanekoll.tsx:466](../web/src/routes/Bolanekoll.tsx#L466) — rate-drift import: "replace expected rows with imported amounts?" with a bulleted body
- [Hushallsbudget.tsx:217](../web/src/routes/Hushallsbudget.tsx#L217) — duplicate-month: "already logged X, add another?"
- [Manadsavslut.tsx:208](../web/src/routes/Manadsavslut.tsx#L208) — reopen settlement

### Failure sequence this replaces

1. User in dark mode taps the ✕ to delete a payment in Bolånekoll.
2. A stark white native OS dialog slams over the aurora UI, using the OS font,
   with "OK / Cancel" buttons in the wrong language and no danger styling.
3. The destructive action ("OK") and the safe action are visually identical —
   nothing signals that the left button erases data. On mobile the two buttons
   are OS-default and easy to fat-finger.

It works, but it reads as unfinished and undermines the "this is a real product"
feel the rest of the app has earned.

## Fix

### 1. New component — `web/src/components/ConfirmDialog.tsx`

Built on DialogShell. Presentational; state is owned by the provider (below).

```tsx
import DialogShell from './DialogShell'

export interface ConfirmOptions {
  title: string
  /** Body text. Newlines render as paragraph breaks (unlike native confirm). */
  message?: string
  /** Optional pre-formatted lines shown as a list (rate-drift import case). */
  lines?: string[]
  confirmLabel?: string   // default 'Ta bort'
  cancelLabel?: string    // default 'Avbryt'
  /** Danger styling on the confirm button. Default true (most calls are deletes). */
  danger?: boolean
}

export default function ConfirmDialog({
  open, options, onResolve,
}: {
  open: boolean
  options: ConfirmOptions | null
  onResolve: (ok: boolean) => void
}) {
  const o = options
  return (
    <DialogShell
      open={open}
      onClose={() => onResolve(false)}
      className="confirm-dialog"
      ariaLabel={o?.title}
    >
      {o && (
        <div className="confirm-body">
          <h2 className="confirm-title">{o.title}</h2>
          {o.message && o.message.split('\n').map((p, i) => (
            <p key={i} className="confirm-message">{p}</p>
          ))}
          {o.lines && o.lines.length > 0 && (
            <ul className="confirm-lines">
              {o.lines.map((l, i) => <li key={i}>{l}</li>)}
            </ul>
          )}
          <div className="confirm-actions">
            <button type="button" className="btn btn-ghost" onClick={() => onResolve(false)}>
              {o.cancelLabel ?? 'Avbryt'}
            </button>
            <button
              type="button"
              className={o.danger === false ? 'btn btn-primary' : 'btn btn-primary confirm-danger'}
              autoFocus
              onClick={() => onResolve(true)}
            >
              {o.confirmLabel ?? 'Ta bort'}
            </button>
          </div>
        </div>
      )}
    </DialogShell>
  )
}
```

### 2. New provider + hook — `web/src/components/useConfirm.tsx`

A promise-based imperative API so the existing `if (confirm(...)) { … }` control
flow converts with **minimal churn** — `if (confirm(...))` becomes
`if (await confirm({ … }))`. One `ConfirmDialog` instance is mounted app-wide;
`confirm(opts)` opens it and returns a `Promise<boolean>` that resolves when the
user picks. Mirrors the existing `ThemeContext`/`useTheme` pattern in
[App.tsx:30-31](../web/src/App.tsx#L30-L31).

```tsx
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import ConfirmDialog, { type ConfirmOptions } from './ConfirmDialog'

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>
const ConfirmContext = createContext<ConfirmFn>(async () => false)
export const useConfirm = () => useContext(ConfirmContext)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ open: boolean; options: ConfirmOptions | null }>({
    open: false, options: null,
  })
  const resolver = useRef<((ok: boolean) => void) | null>(null)

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve
      setState({ open: true, options })
    })
  }, [])

  const handleResolve = useCallback((ok: boolean) => {
    setState((s) => ({ ...s, open: false }))
    resolver.current?.(ok)
    resolver.current = null
  }, [])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog open={state.open} options={state.options} onResolve={handleResolve} />
    </ConfirmContext.Provider>
  )
}
```

**Mount it in [App.tsx](../web/src/App.tsx)** wrapping the router, inside
`ThemeContext` (so the dialog is themed) and inside `AuthGate`'s children isn't
required — put `ConfirmProvider` high enough that every route is a descendant.
The single mounted `ConfirmDialog` means DialogShell's focus-trap and Escape are
inherited for free; Escape → `onCancel` → `onResolve(false)`.

### 3. CSS — append to `web/src/styles/modals.css`

`.btn-danger` today is scoped only to `.bk-root`/`.ma-root`
([components.css:412](../web/src/styles/components.css#L412)), so it won't apply
to a top-level dialog. Give the confirm dialog its own danger token instead.
Match the existing dialog look (`--paper-card`, `--rule`, radius/shadow already
used by `.undo-toast` in this file at line 120).

```css
.confirm-dialog { border: none; padding: 0; background: transparent; max-width: min(28rem, 92vw); }
.confirm-body {
  background: var(--paper-card);
  border: 1px solid var(--rule);
  border-radius: 16px;
  padding: 20px 22px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.28);
  color: var(--ink);
}
.confirm-title { font-size: 1.05rem; margin: 0 0 0.5rem; }
.confirm-message { font-size: 0.9rem; color: var(--ink-soft); margin: 0 0 0.5rem; line-height: 1.5; }
.confirm-lines { font-size: 0.85rem; color: var(--ink-soft); margin: 0 0 0.75rem 1rem; }
.confirm-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1.25rem; }
.confirm-danger { background: var(--warn); border-color: var(--warn); }
.confirm-danger:hover:not(:disabled) { background: var(--warn-light, var(--warn)); }
```

Verify `--warn` / `--ink-soft` / `--paper-card` exist in
[tokens.css](../web/src/styles/tokens.css) before using; substitute the closest
existing token if a name differs. `.confirm-dialog::backdrop` styling is
optional — DialogShell already dims via the UA default; add a
`backdrop-filter`/`background` rule here only if it looks too light in dark mode.

### 4. Convert the 19 call sites

Every route/dialog that calls `confirm()` must call `const confirm = useConfirm()`
at the top of the component, then swap the guard. The handler becomes `async`
where it isn't already.

**Simple delete — e.g. [Bolanekoll.tsx:1471](../web/src/routes/Bolanekoll.tsx#L1471):**
```tsx
// before:
onClick={() => { if (confirm('Delete this payment?')) handleDeletePay(p.id) }}
// after:
onClick={async () => {
  if (await confirm({ title: 'Ta bort betalning?', message: 'Detta kan inte ångras.' }))
    handleDeletePay(p.id)
}}
```

**Cascade delete — [Bolanekoll.tsx:272](../web/src/routes/Bolanekoll.tsx#L272) /
[PartDialog.tsx:72](../web/src/routes/bolanekoll/PartDialog.tsx#L72):** keep the
"and all its payments" warning in `message`.

**Bulk — [Manadsavslut.tsx:199](../web/src/routes/Manadsavslut.tsx#L199):** the
count string moves into `title`/`message`; the handler is already `async`.
```tsx
if (!(await confirm({
  title: `Ta bort alla ${openIds.length} öppna poster?`,
  message: `Avräknade poster behålls.${pendNote} Detta kan inte ångras.`,
}))) return
```

**Multi-line decision — [Bolanekoll.tsx:466](../web/src/routes/Bolanekoll.tsx#L466):**
this is the payoff case. `danger: false`, pass the bulleted body via `lines`:
```tsx
if (!(await confirm({
  title: 'Räntan avviker från prognosen',
  message: 'Ränteändring, avgift eller extra amortering? Ersätt de förväntade raderna med de importerade beloppen?',
  lines,
  confirmLabel: 'Ersätt', cancelLabel: 'Behåll', danger: false,
}))) return
```

**Non-delete confirms** ([Hushallsbudget.tsx:217](../web/src/routes/Hushallsbudget.tsx#L217)
duplicate-month, [Manadsavslut.tsx:208](../web/src/routes/Manadsavslut.tsx#L208)
reopen): `danger: false`, sensible `confirmLabel` ("Lägg till ändå" / "Öppna
igen").

Keep every user-facing string in the same language it is today (most are
English placeholders; the two Swedish ones stay Swedish). **Do not silently
translate** — matching the current copy keeps the diff reviewable; a
copy-consistency pass is out of scope (see below).

### 5. Leftover `alert()`s NOT owned by plan 90

Plan 90 Layer 3 converts [Hushallsbudget.tsx:221](../web/src/routes/Hushallsbudget.tsx#L221)
and [:331](../web/src/routes/Hushallsbudget.tsx#L331) to a toast. Three `alert()`s
remain and are **in scope here** (they're the same "native popup feels
unfinished" complaint):
- [Hushallsbudget.tsx:349](../web/src/routes/Hushallsbudget.tsx#L349) — import result (info) → `showToast`
- [Hushallsbudget.tsx:352](../web/src/routes/Hushallsbudget.tsx#L352) — import failed → `showToast`
- [Hushallsbudget.tsx:586](../web/src/routes/Hushallsbudget.tsx#L586) — "Keep at least one category" (validation) → `showToast`

Reuse the `useToast` hook ([useToast.ts](../web/src/components/useToast.ts)) and
the `.hb-toast` element that plan 90 adds. **If plan 90 has not landed when this
one is built**, wire `useToast` into Hushållsbudget as part of this plan and
convert all five `alert()`s here — then plan 90 Layer 3 is a no-op. Decide at
build time based on what's merged; state which path you took in the PR
description. These three are validation/info, never "are you sure" — a toast is
correct, not a `ConfirmDialog`.

## Accepted trade-off

**Promise-based imperative `confirm()` over a fully declarative modal.** A
declarative approach (each call site owns `useState` for open + a rendered
`<ConfirmDialog>`) is more "Reacty" but would rewrite the control flow at all 19
sites and balloon the diff. The imperative `await confirm({…})` preserves the
existing `if (…) return` shape one-for-one, which is why it's chosen. The known
caveat: the promise rejects nothing — a component unmounting mid-dialog leaves a
dangling resolver. That's harmless (the resolve is dropped, no state update on an
unmounted component because state lives in the provider, which does not unmount).
Document this in a comment in `useConfirm.tsx`.

## Acceptance criteria

- `grep -rn "[^.]confirm(" web/src --include="*.tsx" | grep -v SavePrompt`
  returns **zero** results. `SavePrompt.tsx:45` (local function) is untouched.
- `grep -rn "alert(" web/src/routes` returns zero results (combined with plan 90).
- New `ConfirmProvider` is mounted once in [App.tsx](../web/src/App.tsx), inside
  `ThemeContext`; every route is a descendant.
- Manually verify **both themes**: delete a Bolånekoll payment in **dark mode** —
  the dialog uses the aurora-era card styling, the confirm button is danger-red,
  Escape and backdrop-click both cancel, the confirm button is focused on open so
  Enter confirms. Repeat one delete in **light mode**.
- Manually verify the rate-drift import dialog
  ([Bolanekoll.tsx:466](../web/src/routes/Bolanekoll.tsx#L466)) renders its
  bulleted `lines` legibly (the case native `confirm` rendered as cramped `\n`).
- Manually verify at **mobile width (≤430px)**: dialog is centered, `max-width`
  clamps to `92vw`, buttons don't overflow.
- New component test `web/src/components/ConfirmDialog.test.tsx`
  (`// @vitest-environment jsdom`, harness per plan 78): renders via
  `ConfirmProvider`, asserts (a) calling `confirm()` shows the title, (b)
  clicking the confirm button resolves the promise `true`, (c) clicking cancel /
  firing Escape resolves `false`, (d) `danger: false` renders no
  `.confirm-danger` class.
- Verify gates from [web/CLAUDE.md](../web/CLAUDE.md): `npm run build` (the real
  typecheck), `npm test`, `npm run lint` all green.

## Out of scope

- **Undo-toast for single-item deletes.** The nicer end-state for *reversible*
  single deletes is delete-immediately + a "Deleted · Ångra" toast (the
  [UndoToast.tsx](../web/src/components/UndoToast.tsx) pattern already used once
  in [ScenariosDashboard.tsx:249](../web/src/routes/ScenariosDashboard.tsx#L249)).
  Deferred to a **separate follow-up plan** because it requires each store to
  support *restore* (re-insert with the same id/data), and the cascade deletes
  (loan-part-with-payments) can't be trivially restored — that's real per-store
  design work and risk, not a mechanical swap. `ConfirmDialog` is the safe,
  uniform, zero-store-change baseline; undo-toast can layer on top later where
  restore is cheap.
- **Copy/localisation pass.** Several strings are English placeholders. Keep them
  as-is for a reviewable diff; a Swedish-copy sweep is its own concern.
- **Non-`confirm`/`alert` dialogs.** The existing tool dialogs (PartDialog,
  PaymentDialog, etc.) already use DialogShell and are fine — only their inner
  `confirm()` delete guards change here.
