import type { ReactNode } from 'react'

// The dialog-form field wrapper shared by Bolånekoll and Månadsavslut: a
// `<label class="form-field">` with the caption in a `<span>` and the control as
// children. Extracted from ~40 hand-written copies (plan 39d) — it emits the
// exact same markup and classes, so each route's existing `.form-field` CSS
// keeps styling it unchanged; this is a DRY pass, not a restyle (plan 42 owns
// CSS). `wide` adds `form-wide` (full-width across the grid). Children is any
// control — text/date/decimal inputs and <select>s all fit; the checkbox and
// Segmented fields keep their own inline markup (different inner structure).
export default function FormField({ label, wide, children }: {
  label: ReactNode
  wide?: boolean
  children: ReactNode
}) {
  return (
    <label className={wide ? 'form-field form-wide' : 'form-field'}>
      <span>{label}</span>
      {children}
    </label>
  )
}
