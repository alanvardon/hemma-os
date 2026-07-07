import { useEffect, useState } from 'react'
import DialogShell from '../../components/DialogShell'
import type { LoanPart, Payment } from '../../lib/mortgage'

interface CopyDlgProps {
  open: boolean; source: Payment | null; parts: LoanPart[]
  onConfirm: (targetIds: string[]) => void; onClose: () => void
}
export default function CopyToPartsDialog({ open, source, parts, onConfirm, onClose }: CopyDlgProps) {
  const candidates = source
    ? (source.loan_part_id == null ? parts : parts.filter(p => p.id !== source.loan_part_id))
    : []
  const [checked, setChecked] = useState<Set<string>>(new Set())
  useEffect(() => { if (open) setChecked(new Set(candidates.map(p => p.id))) }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string) => setChecked(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })
  return (
    <DialogShell open={open} onClose={onClose} className="bk-dialog">
      <div className="dialog-body">
        <h3 className="dialog-title">Copy payment to parts</h3>
        <p className="config-note" style={{ marginBottom: '1rem' }}>Copies this payment (same date, amount, type) to each selected part with balance cleared.</p>
        <div className="copy-parts-list">
          {candidates.map(pt => (
            <label key={pt.id} className="copy-part-row">
              <input type="checkbox" checked={checked.has(pt.id)} onChange={() => toggle(pt.id)} />
              <span>{pt.label || pt.id}</span>
            </label>
          ))}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={checked.size === 0}
            onClick={() => onConfirm([...checked])}>
            Copy to {checked.size} part{checked.size === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </DialogShell>
  )
}
