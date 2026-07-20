import { useEffect, useState } from 'react'
import { Pencil } from 'lucide-react'
import DialogShell from '../../components/DialogShell'
import FormField from '../../components/FormField'
import Icon from '../../components/Icon'
import Segmented from '../../components/Segmented'
import { usePersonNames } from '../../components/usePersonNames'
import { parseAmount, otherPerson, personalSums, computeOwed, makeItem } from '../../lib/manadsavslut'
import type { Item, MonthEndSettings, Person, Treatment, PersonalEntry } from '../../lib/manadsavslut'
import { todayISO } from '../../lib/date'
import { fmtMoney, clean } from './shared'
import PersonalOffsetDialog from './PersonalOffsetDialog'

interface ItemDlgProps {
  open: boolean; id: string | null; items: Item[]; settings: MonthEndSettings; defaultClass: Treatment
  displayNames?: { a: string; b: string }; selfSlot?: 'a' | 'b' | null
  onSave: (rec: Omit<Item, 'id' | 'created_at'>) => void; onClose: () => void
}
export default function ItemDialog({ open, id, items, settings, defaultClass, displayNames, selfSlot, onSave, onClose }: ItemDlgProps) {
  const rec = id ? items.find(i => i.id === id) : null
  const [form, setForm] = useState({ date: todayISO(), desc: '', amount: '', note: '', fronted: 'a' as Person, split: 'split' as 'split' | 'full' })
  const [personalItems, setPersonalItems] = useState<PersonalEntry[]>([])
  const [offsetDlg, setOffsetDlg] = useState(false)
  useEffect(() => {
    if (open) setForm({
      date: rec?.date_purchased || todayISO(), desc: rec?.description || '', amount: rec?.enter_amount != null ? String(rec.enter_amount) : '',
      note: rec?.note || '', fronted: rec ? rec.fronted_by : 'a', split: rec ? (rec.split ? 'split' : 'full') : (defaultClass === 'full' ? 'full' : 'split'),
    })
  }, [open, id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) { setPersonalItems(rec?.personal_items ?? []); setOffsetDlg(false) } }, [open, id]) // eslint-disable-line react-hooks/exhaustive-deps
  const { a: aName, b: bName, nameOf } = usePersonNames(displayNames?.a ?? settings.person_a_name, displayNames?.b ?? settings.person_b_name)
  const duName = (p: Person | null | undefined) => (selfSlot && p === selfSlot ? `${nameOf(p)} (du)` : nameOf(p))
  const aLabel = selfSlot === 'a' ? `${aName} (du)` : aName
  const bLabel = selfSlot === 'b' ? `${bName} (du)` : bName

  const amt = parseAmount(form.amount)
  const isSplit = form.split === 'split'
  const sums = personalSums(personalItems)
  const hasOffset = isSplit && (sums.a > 0 || sums.b > 0)
  const hint = (() => {
    if (!isFinite(amt) || amt === 0) return ''
    const owed = otherPerson(form.fronted)
    const share = computeOwed(amt, isSplit, form.fronted, sums.a, sums.b)
    const verb = amt < 0 ? ' is credited ' : ' will owe '
    const suffix = isSplit ? (hasOffset ? ' (shared ' + fmtMoney(Math.abs(amt) - sums.a - sums.b) + ' split)' : ' (half of ' + fmtMoney(Math.abs(amt)) + ')') : ''
    return duName(owed) + verb + fmtMoney(Math.abs(share)) + suffix
  })()

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const a = parseAmount(form.amount)
    if (!isFinite(a) || a === 0) return
    onSave(makeItem({
      date_purchased: clean(form.date), description: clean(form.desc) || '(no description)',
      enter_amount: a, split: isSplit, fronted_by: form.fronted, owed_by: otherPerson(form.fronted), note: clean(form.note),
      // Personal applies under Split only; "Owes all" drops it (Decision 3).
      personal_items: isSplit ? personalItems : [],
    }))
  }
  return (
    <>
      <DialogShell open={open} onClose={onClose} className="ma-dialog">
        <form className="dialog-body" onSubmit={submit}>
          <h3 className="dialog-title">{id ? 'Edit item' : 'Add item'}</h3>
          <div className="form-grid">
            <FormField label="Date"><input type="date" value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} /></FormField>
            <FormField label="Description" wide><input type="text" autoComplete="off" placeholder="e.g. Groceries" value={form.desc} onChange={e => setForm(p => ({ ...p, desc: e.target.value }))} /></FormField>
            <FormField label="Charge — minus for a refund"><input type="text" inputMode="decimal" autoComplete="off" placeholder="0" value={form.amount} onChange={e => setForm(p => ({ ...p, amount: e.target.value }))} /></FormField>
            <div className="form-field">
              <span>Paid by</span>
              <Segmented value={form.fronted} onChange={v => setForm(p => ({ ...p, fronted: v }))} options={[{ v: 'a' as Person, label: aLabel }, { v: 'b' as Person, label: bLabel }]} />
            </div>
            <div className="form-field">
              <span>Treatment</span>
              <Segmented value={form.split} onChange={v => setForm(p => ({ ...p, split: v }))} options={[{ v: 'split' as const, label: 'Split 50/50' }, { v: 'full' as const, label: 'Owes all' }]} />
            </div>
            <FormField label="Note (optional)" wide><input type="text" autoComplete="off" value={form.note} onChange={e => setForm(p => ({ ...p, note: e.target.value }))} /></FormField>
            {isSplit && (
              <div className="form-field form-wide personal-row">
                {hasOffset ? (
                  <button type="button" className="personal-chip" onClick={() => setOffsetDlg(true)}>
                    <span>Personal: {sums.a > 0 && (aName + ' ' + fmtMoney(sums.a))}{sums.a > 0 && sums.b > 0 ? ' · ' : ''}{sums.b > 0 && (bName + ' ' + fmtMoney(sums.b))} · {personalItems.length} item{personalItems.length === 1 ? '' : 's'}</span>
                    <Icon icon={Pencil} size={13} className="personal-edit" />
                  </button>
                ) : (
                  <button type="button" className="link-btn personal-add" onClick={() => setOffsetDlg(true)}>+ Add personal items (not shared)</button>
                )}
              </div>
            )}
          </div>
          <p className="form-hint">{hint}</p>
          <div className="dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">Save</button>
          </div>
        </form>
      </DialogShell>
      <PersonalOffsetDialog open={offsetDlg} enterAmount={amt} frontedBy={form.fronted} aName={aName} bName={bName} selfSlot={selfSlot}
        initial={personalItems}
        onSave={entries => { setPersonalItems(entries); setOffsetDlg(false) }}
        onClose={() => setOffsetDlg(false)} />
    </>
  )
}
