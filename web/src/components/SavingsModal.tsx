import { Dialog } from 'radix-ui'
import { useStore } from '../store/useStore'
import { fmt } from '../lib/format'
import type { LineItem } from '../lib/storage'
import AnimatedDialog from './AnimatedDialog'
import LineItemRow from './LineItemRow'

const sum = (items: LineItem[]) => items.reduce((s, i) => s + (i.amount || 0), 0)
const newId = () => `savings_${Date.now()}`

// Savings entries that augment the cash surplus / shortfall (Phase 7).
export default function SavingsModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const items = useStore((s) => s.savingsItems)
  const setSavingsItems = useStore((s) => s.setSavingsItems)

  const total = sum(items)

  const editLabel = (id: string, label: string) => setSavingsItems(items.map((i) => (i.id === id ? { ...i, label } : i)))
  const editAmount = (id: string, amount: number) => setSavingsItems(items.map((i) => (i.id === id ? { ...i, amount } : i)))
  const remove = (id: string) => setSavingsItems(items.filter((i) => i.id !== id))
  const add = () => setSavingsItems([...items, { id: newId(), label: '', amount: 0 }])

  return (
    <AnimatedDialog open={open} onOpenChange={onOpenChange} contentClassName="modal modal-narrow">
      <div className="modal-header">
        <Dialog.Title className="modal-title">Savings</Dialog.Title>
        <Dialog.Close className="modal-close" aria-label="Close">
          ×
        </Dialog.Close>
      </div>
      <div className="modal-body">
        <p className="modal-note" style={{ marginBottom: '1.25rem' }}>
          Add savings entries to include them in your cash surplus / shortfall.
        </p>

        <div>
          {items.map((it, n) => (
            <LineItemRow
              key={it.id}
              label={it.label}
              amount={it.amount}
              onLabel={(v) => editLabel(it.id, v)}
              onAmount={(v) => editAmount(it.id, v)}
              onRemove={() => remove(it.id)}
              labelAriaLabel={`Savings entry ${n + 1} name`}
              amountAriaLabel={`Savings entry ${n + 1} amount`}
              removeAriaLabel={`Remove ${it.label || 'savings entry'}`}
            />
          ))}
        </div>

        <button className="btn btn-ghost modal-add-btn" onClick={add}>
          + Add entry
        </button>

        <div className="drift-total-row">
          <span className="modal-total-label">Total savings</span>
          <span className="modal-total-val accent">{fmt(total)}</span>
        </div>
      </div>
    </AnimatedDialog>
  )
}
