import { CurrencyInput } from './fields'

// A label + amount + delete row, shared by the driftkostnad breakdown and the
// savings list (Phase 7). Styled with the legacy `.drift-item-row` grid.
interface Props {
  label: string
  amount: number
  onLabel: (value: string) => void
  onAmount: (value: number) => void
  onRemove: () => void
  suffix?: string
  labelAriaLabel: string
  amountAriaLabel: string
  removeAriaLabel: string
}

export default function LineItemRow({
  label,
  amount,
  onLabel,
  onAmount,
  onRemove,
  suffix = 'kr',
  labelAriaLabel,
  amountAriaLabel,
  removeAriaLabel,
}: Props) {
  return (
    <div className="drift-item-row">
      <input
        type="text"
        className="drift-item-label-input"
        value={label}
        placeholder="Category name"
        onChange={(e) => onLabel(e.target.value)}
        aria-label={labelAriaLabel}
      />
      <CurrencyInput value={amount} onChange={onAmount} suffix={suffix} ariaLabel={amountAriaLabel} />
      <button className="drift-delete" title="Remove" aria-label={removeAriaLabel} onClick={onRemove}>
        ×
      </button>
    </div>
  )
}
