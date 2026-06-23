import { Dialog } from 'radix-ui'
import type { Scenario } from '../lib/storage'
import { derive } from '../lib/calc'
import { fmt } from '../lib/format'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  scenarios: Scenario[]
  activeScenarioId: string | null
  onLoad: (id: string) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
}

export default function ScenariosModal({
  open,
  onOpenChange,
  scenarios,
  activeScenarioId,
  onLoad,
  onDuplicate,
  onDelete,
}: Props) {
  const sorted = [...scenarios].sort((a, b) => +new Date(b.savedAt) - +new Date(a.savedAt))

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop">
          <Dialog.Content className="modal" aria-describedby={undefined}>
            <div className="modal-header">
              <Dialog.Title className="modal-title">Saved Scenarios</Dialog.Title>
              <Dialog.Close className="modal-close" aria-label="Close">
                ×
              </Dialog.Close>
            </div>
            <div className="modal-body">
              {sorted.length === 0 ? (
                <div className="modal-empty">
                  No saved scenarios yet.
                  <br />
                  Hit <strong>Save</strong> to store your first calculation.
                </div>
              ) : (
                <div className="scenario-grid">
                  {sorted.map((s) => {
                    const f = derive(s.inputs)
                    const cash = f.cashBalance
                    const dateStr = new Date(s.savedAt).toLocaleDateString('sv-SE', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })
                    return (
                      <div
                        key={s.id}
                        className={s.id === activeScenarioId ? 'scenario-card active-card' : 'scenario-card'}
                      >
                        <div className="scenario-card-name">{s.name}</div>
                        <div className="scenario-card-date">Saved {dateStr}</div>
                        <div className="scenario-card-stats">
                          <div className="scenario-stat">
                            <span className="scenario-stat-label">New property</span>
                            <span className="scenario-stat-val">{fmt(s.inputs.newPrice || 0)}</span>
                          </div>
                          <div className="scenario-stat">
                            <span className="scenario-stat-label">Monthly cost</span>
                            <span className="scenario-stat-val">{fmt(f.totalMonthly)}</span>
                          </div>
                          <div className="scenario-stat">
                            <span className="scenario-stat-label">Cash surplus / shortfall</span>
                            <span className={`scenario-stat-val ${cash >= 0 ? 'pos' : 'neg'}`}>
                              {(cash >= 0 ? '+' : '') + fmt(cash)}
                            </span>
                          </div>
                        </div>
                        <div className="scenario-card-actions">
                          <button className="btn btn-ghost" onClick={() => onLoad(s.id)}>
                            Load
                          </button>
                          <button className="btn btn-ghost" onClick={() => onDuplicate(s.id)}>
                            Duplicate
                          </button>
                          <button className="btn btn-danger" onClick={() => onDelete(s.id)}>
                            Delete
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
