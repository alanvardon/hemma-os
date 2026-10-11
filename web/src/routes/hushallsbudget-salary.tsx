// hushallsbudget-salary.tsx — shared pieces of the "Submit this month's
// salaries" modal (Hushallsbudget.tsx's SalaryModal), extracted so the public
// `#/lon/<token>` page (SalarySubmitPage, plan 132) can render an identical
// income column outside the modal. No visual or behavioural change versus the
// modal: same markup, same classnames, same money-input formatting.
import { useEffect, useState } from 'react'
import { formatWithSpaces, parseFormatted, money as fmt } from '../lib/hushallsbudget'
import { PersonLabel } from '../components/PersonBadge'

export interface SalaryItem { uid: number; label: string; amount: number }

// AmountInput variant that exposes a ref to the underlying input (for focus).
export function AmountInputRef({ value, onChange, className, ariaLabel, inputRef }: {
  value: number; onChange: (n: number) => void; className: string; ariaLabel: string
  inputRef?: React.RefObject<HTMLInputElement | null>
}) {
  const [buf, setBuf] = useState(() => formatWithSpaces(value))
  const [focused, setFocused] = useState(false)
  useEffect(() => { if (!focused) setBuf(formatWithSpaces(value)) }, [value, focused])
  return (
    <input
      ref={inputRef} type="text" inputMode="numeric" className={className} aria-label={ariaLabel} value={buf}
      onFocus={() => setFocused(true)}
      onChange={(e) => { setBuf(e.target.value); onChange(parseFormatted(e.target.value)) }}
      onBlur={() => { setFocused(false); setBuf(formatWithSpaces(parseFormatted(buf))) }}
    />
  )
}

/**
 * One person's income column: a name/total head, the itemised list
 * (`.sal-row` — label, amount, remove) and "+ Add income". Used twice inside
 * SalaryModal (one per owner) and once, standalone, on SalarySubmitPage. A
 * stable, module-level component — not one defined inside a render function —
 * so mounting it via JSX never remounts the inputs and loses focus (the thing
 * the original inline `itemColumn` helper in Hushallsbudget.tsx was written to
 * avoid).
 */
export function SalaryItemColumn({
  name, self, other, total, items, firstAmountRef, onItemChange, onRemoveItem, onAddItem, emailTag,
}: {
  name: string
  self?: boolean
  other?: boolean
  total: number
  items: SalaryItem[]
  firstAmountRef?: React.RefObject<HTMLInputElement | null>
  onItemChange: (uid: number, patch: Partial<SalaryItem>) => void
  onRemoveItem: (uid: number) => void
  onAddItem: () => void
  /** Plan 132: this slot's current values came from an emailed submission (a
      pending salary_submission_drafts row) instead of the budget baseline. A
      text tag — never colour-only. */
  emailTag?: boolean
}) {
  return (
    <div className="income-col">
      <div className="income-col-head">
        <span className="income-col-name">
          <PersonLabel name={name} self={self} other={other} />
          {emailTag && <span className="income-col-tag">Submitted via email</span>}
        </span>
        <span className="income-col-sub">{fmt(total)}</span>
      </div>
      <div className="sal-list">
        {items.map((it, i) => (
          <div className="sal-row" key={it.uid}>
            <input
              type="text" className="sal-row-label" value={it.label} placeholder="e.g. Lön, Barnbidrag, skatt" aria-label="Income name"
              onChange={(e) => onItemChange(it.uid, { label: e.target.value })}
            />
            <AmountInputRef
              inputRef={i === 0 ? firstAmountRef : undefined}
              value={it.amount} onChange={(n) => onItemChange(it.uid, { amount: n })}
              className="sal-row-amount" ariaLabel="Amount, kr"
            />
            <button type="button" className="sal-row-remove" aria-label="Remove income" onClick={() => onRemoveItem(it.uid)}>×</button>
          </div>
        ))}
      </div>
      <button type="button" className="btn btn-ghost row-add-btn" onClick={onAddItem}>+ Add income</button>
    </div>
  )
}
