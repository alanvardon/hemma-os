// Small labelled form controls shared by the Vindsplanen panels. Every control
// has a visible <label>; centimetre fields commit on blur / Enter and clamp to
// their range exactly as v41's `cm` fields did (the geometry's own semantics,
// not money), so typing mid-number never rewrites the plan.

import { useState, type ReactNode } from 'react'
import { clamp, cm } from '../../lib/vindsplanen/attic'

export function Row({ id, label, children, out }: { id: string; label: string; children: ReactNode; out?: ReactNode }) {
  return (
    <div className="vp-row">
      <label htmlFor={id}>{label}</label>
      {children}
      {out !== undefined ? <span className="vp-unit">{out}</span> : <span />}
    </div>
  )
}

/**
 * The bare number input behind CmField. `value` is in metres (shown in whole
 * cm) unless `count` is set, where it is shown and committed as-is.
 */
export function CmInput({
  id, ariaLabel, title, value, min, max, onChange, count, disabled,
}: {
  id?: string
  ariaLabel?: string
  title?: string
  value: number
  /** In display units (cm, or the count). */
  min: number
  max: number
  onChange: (v: number) => void
  count?: boolean
  disabled?: boolean
}) {
  const shown = count ? Math.round(value) : cm(value)
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const v = parseFloat(draft.replace(',', '.'))
    setDraft(null)
    if (!Number.isFinite(v)) return
    const c = clamp(v, min, max)
    if (c === shown) return
    onChange(count ? c : c / 100)
  }
  return (
    <input
      id={id}
      aria-label={ariaLabel}
      title={title}
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      step={1}
      disabled={disabled}
      value={draft ?? String(shown)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
    />
  )
}

export function CmField({
  id, label, value, min, max, onChange, count, disabled, unit,
}: {
  id: string
  label: string
  value: number
  min: number
  max: number
  onChange: (v: number) => void
  count?: boolean
  disabled?: boolean
  /** Unit text; default cm (empty for a count). */
  unit?: string
}) {
  return (
    <Row id={id} label={label} out={unit ?? (count ? '' : 'cm')}>
      <CmInput id={id} value={value} min={min} max={max} onChange={onChange} count={count} disabled={disabled} />
    </Row>
  )
}

/**
 * A plain number field (degrees, latitude…): `value` is shown as-is and
 * committed on blur / Enter, clamped to [min, max] and rounded to `decimals`
 * (the plan's own sanitiser clamps the same way, so the stored value never
 * differs from what is shown). Invalid text is dropped without a change.
 */
export function NumField({
  id, label, value, min, max, decimals = 0, unit, onChange,
}: {
  id: string
  label: string
  value: number
  min: number
  max: number
  decimals?: number
  unit?: string
  onChange: (v: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const v = parseFloat(draft.replace(',', '.'))
    setDraft(null)
    if (!Number.isFinite(v)) return
    const f = 10 ** decimals
    const c = Math.round(clamp(v, min, max) * f) / f
    if (c !== value) onChange(c)
  }
  return (
    <Row id={id} label={label} out={unit ?? ''}>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={decimals ? 1 / 10 ** decimals : 1}
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
    </Row>
  )
}

export function RangeField({
  id, label, value, min, max, step, format, onChange,
}: {
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
}) {
  return (
    <Row id={id} label={label} out={<output htmlFor={id}>{format(value)}</output>}>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
    </Row>
  )
}

export function SelectField<T extends string | number>({
  id, label, value, options, onChange,
}: {
  id: string
  label: string
  value: T
  options: readonly (readonly [T, string])[]
  onChange: (v: T) => void
}) {
  return (
    <Row id={id} label={label}>
      <select
        id={id}
        value={String(value)}
        onChange={(e) => {
          const o = options.find(([v]) => String(v) === e.target.value)
          if (o) onChange(o[0])
        }}
      >
        {options.map(([v, t]) => (
          <option key={String(v)} value={String(v)}>
            {t}
          </option>
        ))}
      </select>
    </Row>
  )
}

export function CheckField({ id, label, checked, onChange, disabled }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <Row id={id} label={label}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </Row>
  )
}
