import { Dialog } from 'radix-ui'
import { useStore } from '../store/useStore'
import { fmt } from '../lib/format'
import type { LineItem } from '../lib/storage'
import AnimatedDialog from './AnimatedDialog'
import LineItemRow from './LineItemRow'

// Default categories shown the first time the breakdown is opened (all 0, so
// opening never clobbers a set driftkostnad — only amount edits / removes do).
const DEFAULT_DRIFT: LineItem[] = [
  { id: 'drift_0', label: 'Electricity', amount: 0 },
  { id: 'drift_1', label: 'Vatten / avlopp', amount: 0 },
  { id: 'drift_2', label: 'Renhållning', amount: 0 },
  { id: 'drift_3', label: 'Home insurance', amount: 0 },
  { id: 'drift_4', label: 'Internet', amount: 0 },
]

const sum = (items: LineItem[]) => items.reduce((s, i) => s + (i.amount || 0), 0)
const newId = () => `drift_${Date.now()}`

export default function DriftModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const stored = useStore((s) => s.driftItems)
  const yearly = useStore((s) => s.driftYearly)
  const setDriftItems = useStore((s) => s.setDriftItems)
  const applyDriftItems = useStore((s) => s.applyDriftItems)
  const setDriftYearly = useStore((s) => s.setDriftYearly)

  const items = stored.length ? stored : DEFAULT_DRIFT
  const monthlyTotal = sum(items)
  const factor = yearly ? 12 : 1

  // amount edits / removes write the monthly total back to driftkostnad (apply);
  // label edits / adds only persist the list (set).
  const editLabel = (id: string, label: string) => setDriftItems(items.map((i) => (i.id === id ? { ...i, label } : i)))
  const editAmount = (id: string, shown: number) =>
    applyDriftItems(items.map((i) => (i.id === id ? { ...i, amount: yearly ? shown / 12 : shown } : i)))
  const remove = (id: string) => applyDriftItems(items.filter((i) => i.id !== id))
  const add = () => setDriftItems([...items, { id: newId(), label: '', amount: 0 }])

  return (
    <AnimatedDialog open={open} onOpenChange={onOpenChange} contentClassName="modal modal-narrow">
      <div className="modal-header">
        <Dialog.Title className="modal-title">Driftkostnad breakdown</Dialog.Title>
        <Dialog.Close className="modal-close" aria-label="Close">
          ×
        </Dialog.Close>
      </div>
      <div className="modal-body">
        <div className="modal-note-row">
          <p className="modal-note">Enter costs per category — the total updates the driftkostnad field automatically.</p>
          <div className="mode-switch">
            <span className="mode-switch-label">Monthly</span>
            <label className="toggle">
              <input
                type="checkbox"
                checked={yearly}
                onChange={(e) => setDriftYearly(e.target.checked)}
                aria-label="Show amounts as yearly"
              />
              <span className="toggle-slider" />
            </label>
            <span className="mode-switch-label">Yearly</span>
          </div>
        </div>

        <div>
          {items.map((it, n) => (
            <LineItemRow
              key={it.id}
              label={it.label}
              amount={Math.round(it.amount * factor)}
              onLabel={(v) => editLabel(it.id, v)}
              onAmount={(v) => editAmount(it.id, v)}
              onRemove={() => remove(it.id)}
              suffix={yearly ? 'kr/yr' : 'kr/mo'}
              labelAriaLabel={`Cost category ${n + 1} name`}
              amountAriaLabel={`Cost category ${n + 1} amount`}
              removeAriaLabel={`Remove ${it.label || 'category'}`}
            />
          ))}
        </div>

        <button className="btn btn-ghost modal-add-btn" onClick={add}>
          + Add item
        </button>

        <div className="drift-total-row">
          <span className="modal-total-label">Total monthly driftkostnad</span>
          <span className="modal-total-val">{fmt(monthlyTotal)}</span>
        </div>
      </div>
    </AnimatedDialog>
  )
}
