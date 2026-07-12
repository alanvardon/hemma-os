import { useEffect, useState } from 'react'
import DialogShell from '../../components/DialogShell'
import FormField from '../../components/FormField'
import Segmented from '../../components/Segmented'
import { todayISO } from '../../lib/date'
import type { HouseItem, HouseItemType } from '../../lib/huskalendern'

// The categories, in display order. Value is stored verbatim (Swedish enum).
const CATEGORIES = ['underhåll', 'avtal', 'besiktning', 'övrigt'] as const

// Parse a free-typed kr amount ("12 500", "12500,5") → number, or null when
// blank/invalid. No clamping — an invalid entry just doesn't save a cost.
function parseNum(s: string): number | null {
  const t = s.trim().replace(/\s/g, '').replace(',', '.')
  if (t === '') return null
  const n = Number(t)
  return isFinite(n) ? n : null
}

export interface ItemDraft {
  type: HouseItemType
  title: string
  category: string
  date: string | null
  cost: number | null
  vendor: string | null
  interval_years: number | null
  remind_days: number
  notes: string | null
}

interface Props {
  open: boolean
  item: HouseItem | null                 // null = add
  onSave: (draft: ItemDraft) => void
  onClose: () => void
}

export default function ItemDialog({ open, item, onSave, onClose }: Props) {
  const [form, setForm] = useState({
    type: 'log' as HouseItemType, title: '', category: 'underhåll',
    date: todayISO(), cost: '', vendor: '', interval: '', remind: '60', notes: '',
  })

  useEffect(() => {
    if (!open) return
    if (item) {
      setForm({
        type: item.type, title: item.title, category: item.category || 'övrigt',
        date: item.date || todayISO(),
        cost: item.cost != null ? String(item.cost) : '',
        vendor: item.vendor || '',
        interval: item.interval_years != null ? String(item.interval_years) : '',
        remind: String(item.remind_days || 60),
        notes: item.notes || '',
      })
    } else {
      setForm({ type: 'log', title: '', category: 'underhåll', date: todayISO(), cost: '', vendor: '', interval: '', remind: '60', notes: '' })
    }
  }, [open, item])

  const isLog = form.type === 'log'
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((p) => ({ ...p, [k]: v }))

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const title = form.title.trim()
    if (!title || !form.date) return
    const remind = parseNum(form.remind)
    onSave({
      type: form.type,
      title,
      category: form.category,
      date: form.date,
      cost: parseNum(form.cost),
      vendor: form.vendor.trim() || null,
      interval_years: isLog ? parseNum(form.interval) : null,
      remind_days: !isLog && remind != null && remind > 0 ? Math.round(remind) : 60,
      notes: form.notes.trim() || null,
    })
  }

  return (
    <DialogShell open={open} onClose={onClose} className="hk-dialog" ariaLabel={item ? 'Redigera post' : 'Lägg till post'}>
      <form className="dialog-body" onSubmit={submit}>
        <h3 className="dialog-title">{item ? 'Redigera' : 'Lägg till'}</h3>
        <div className="form-grid">
          <div className="form-field form-wide">
            <span>Typ</span>
            <Segmented value={form.type} onChange={(v) => set('type', v)}
              options={[{ v: 'log' as HouseItemType, label: 'Utfört (logg)' }, { v: 'contract' as HouseItemType, label: 'Avtal (går ut)' }]} />
          </div>

          <FormField label="Vad?" wide>
            <input type="text" autoComplete="off" placeholder={isLog ? 't.ex. Avloppsspolning' : 't.ex. Elavtal Tibber'}
              value={form.title} onChange={(e) => set('title', e.target.value)} />
          </FormField>

          <div className="form-field form-wide">
            <span>Kategori</span>
            <Segmented small responsive value={form.category} onChange={(v) => set('category', v)}
              options={CATEGORIES.map((c) => ({ v: c, label: c.charAt(0).toUpperCase() + c.slice(1) }))} />
          </div>

          <FormField label={isLog ? 'Utfördes' : 'Går ut'}>
            <input type="date" value={form.date} onChange={(e) => set('date', e.target.value)} />
          </FormField>

          {isLog ? (
            <FormField label="Intervall (år, valfritt)">
              <input type="text" inputMode="decimal" autoComplete="off" placeholder="t.ex. 4"
                value={form.interval} onChange={(e) => set('interval', e.target.value)} />
            </FormField>
          ) : (
            <FormField label="Påminn (dagar innan)">
              <input type="text" inputMode="numeric" autoComplete="off" placeholder="60"
                value={form.remind} onChange={(e) => set('remind', e.target.value)} />
            </FormField>
          )}

          <FormField label="Kostnad (kr, valfritt)">
            <input type="text" inputMode="decimal" autoComplete="off" placeholder="0"
              value={form.cost} onChange={(e) => set('cost', e.target.value)} />
          </FormField>

          <FormField label={isLog ? 'Utförare (valfritt)' : 'Leverantör (valfritt)'}>
            <input type="text" autoComplete="off" placeholder="namn · telefon"
              value={form.vendor} onChange={(e) => set('vendor', e.target.value)} />
          </FormField>

          <FormField label="Anteckning (valfritt)" wide>
            <input type="text" autoComplete="off" value={form.notes} onChange={(e) => set('notes', e.target.value)} />
          </FormField>
        </div>
        <p className="form-hint">
          {isLog
            ? 'En logg visas i historiken. Med intervall dyker den även upp som en mjuk framtida ≈-påminnelse.'
            : 'Ett avtal visas i framtiden och flaggas när det närmar sig sitt slutdatum.'}
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Avbryt</button>
          <button type="submit" className="btn btn-primary" disabled={!form.title.trim() || !form.date}>Spara</button>
        </div>
      </form>
    </DialogShell>
  )
}
