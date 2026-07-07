import { useEffect, useState } from 'react'
import DialogShell from '../../components/DialogShell'
import FormField from '../../components/FormField'
import { usePersonNames } from '../../components/usePersonNames'
import { parseAmount, otherPerson, personalSums, computeOwed } from '../../lib/manadsavslut'
import type { PersonalEntry, Person } from '../../lib/manadsavslut'
import { fmtMoney, clean } from './shared'

// ── PersonalOffsetDialog (nested in ItemDialog, Split only) ──────────────────
// Build up a list of personal line-items carved out before the 50/50 split. Each
// is { person, amount, note }. Holds a DRAFT list: "Done" hands it back to the
// ItemDialog form, "Cancel" discards. Nothing persists until the item is saved.

interface OffsetDlgProps {
  open: boolean; enterAmount: number; frontedBy: Person; aName: string; bName: string
  initial: PersonalEntry[]
  onSave: (entries: PersonalEntry[]) => void; onClose: () => void
}
export default function PersonalOffsetDialog({ open, enterAmount, frontedBy, aName, bName, initial, onSave, onClose }: OffsetDlgProps) {
  const [entries, setEntries] = useState<PersonalEntry[]>(initial)
  const [draft, setDraft] = useState({ person: frontedBy as Person, amount: '', note: '' })
  useEffect(() => { if (open) { setEntries(initial); setDraft({ person: frontedBy, amount: '', note: '' }) } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const { nameOf } = usePersonNames(aName, bName)
  const enter = isFinite(enterAmount) ? enterAmount : 0
  const owed = otherPerson(frontedBy)
  const sums = personalSums(entries)
  const remaining = enter - sums.a - sums.b
  const draftAmt = parseAmount(draft.amount) || 0
  const canAdd = draftAmt > 0 && draftAmt - remaining <= 0.005
  const addError = draft.amount.trim() === '' ? ''
    : draftAmt <= 0 ? 'Enter an amount above 0.'
      : draftAmt - remaining > 0.005 ? 'Only ' + fmtMoney(remaining) + ' left to carve out of this ' + fmtMoney(enter) + ' charge.'
        : ''
  const owedShare = computeOwed(enter, true, frontedBy, sums.a, sums.b)
  function add() {
    if (!canAdd) return
    setEntries(es => [...es, { person: draft.person, amount: Math.round(draftAmt * 100) / 100, note: clean(draft.note) }])
    setDraft(d => ({ person: d.person, amount: '', note: '' }))
  }
  function onDraftKey(e: React.KeyboardEvent) { if (e.key === 'Enter') { e.preventDefault(); add() } }
  return (
    <DialogShell open={open} onClose={onClose} className="ma-dialog ma-dialog-sm">
      <div className="dialog-body">
        <h3 className="dialog-title">Personal items (not shared)</h3>
        <p className="form-hint">Add anything in this {fmtMoney(enter)} charge that’s personal to one person — it’s taken out before the 50/50 split, and the line itself stays whole.</p>
        <div className="personal-add-grid">
          <FormField label="Personal to">
            <select className="select" value={draft.person} onChange={e => setDraft(d => ({ ...d, person: e.target.value as Person }))}>
              <option value="a">{aName}</option>
              <option value="b">{bName}</option>
            </select>
          </FormField>
          <FormField label="Amount"><input type="text" inputMode="decimal" autoComplete="off" placeholder="0" value={draft.amount} onChange={e => setDraft(d => ({ ...d, amount: e.target.value }))} onKeyDown={onDraftKey} /></FormField>
          <FormField label="Note (optional)"><input type="text" autoComplete="off" placeholder="e.g. protein powder" value={draft.note} onChange={e => setDraft(d => ({ ...d, note: e.target.value }))} onKeyDown={onDraftKey} /></FormField>
          <button type="button" className="btn btn-ghost personal-add-btn" disabled={!canAdd} onClick={add}>+ Add</button>
        </div>
        {addError && <p className="form-error">{addError}</p>}
        {entries.length > 0 && (
          <ul className="personal-entry-list">
            {entries.map((e, i) => (
              <li key={i}>
                <span className="pe-person">{nameOf(e.person)}</span>
                <span className="pe-amount num">{fmtMoney(e.amount)}</span>
                <span className="pe-note">{e.note}</span>
                <button type="button" className="icon-btn" title="Remove" aria-label="Remove" onClick={() => setEntries(es => es.filter((_, j) => j !== i))}>✕</button>
              </li>
            ))}
          </ul>
        )}
        <p className="form-hint">{entries.length
          ? <>Shared {fmtMoney(remaining)} split · {nameOf(owed)} owes {fmtMoney(owedShare)}</>
          : <>No personal items yet — the full {fmtMoney(enter)} splits 50/50.</>}</p>
        <div className="dialog-actions">
          {entries.length > 0 && <button type="button" className="btn btn-ghost btn-danger" onClick={() => setEntries([])}>Remove all</button>}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => onSave(entries)}>Done</button>
        </div>
      </div>
    </DialogShell>
  )
}
