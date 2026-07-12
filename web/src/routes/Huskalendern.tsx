import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ClipboardCheck, FileText, House, Pencil, Wrench, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useToolPageActive } from '../lib/toolTransition'
import * as Store from '../lib/huskalendern-store'
import {
  timelineEntries, needsAttention, nextDue, status, isDivider,
  type HouseItem, type TimelineEntry, type ItemStatus,
} from '../lib/huskalendern'
import { todayISO } from '../lib/date'
import Icon from '../components/Icon'
import PageHeader from '../components/PageHeader'
import ThemeToggle from '../components/ThemeToggle'
import { useToast } from '../components/useToast'
import { useSaveFlash } from '../components/useSaveFlash'
import { persistenceErrorMessage } from '../lib/persistence-error'
import ItemDialog, { type ItemDraft } from './huskalendern/ItemDialog'

// ── Display helpers ───────────────────────────────────────────────────────────
const CATEGORY_ICON: Record<string, LucideIcon> = {
  underhåll: Wrench, avtal: FileText, besiktning: ClipboardCheck, övrigt: House,
}
function categoryIcon(cat: string): LucideIcon { return CATEGORY_ICON[cat] || House }

function fmtDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric' }).replace(/\.$/, '')
}
function fmtMonth(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('sv-SE', { month: 'short', year: 'numeric' }).replace(/\.$/, '')
}
function fmtKr(n: number): string {
  return new Intl.NumberFormat('sv-SE', { style: 'currency', currency: 'SEK', maximumFractionDigits: 0 }).format(n)
}

// Relative Swedish phrasing for the attention strip / status pill.
function dueLabel(item: HouseItem, today: string): string {
  const due = nextDue(item)
  if (!due) return ''
  const days = Math.round((new Date(due + 'T00:00:00').getTime() - new Date(today + 'T00:00:00').getTime()) / 86400000)
  const soft = item.type === 'log' ? '≈ ' : ''
  if (days < 0) return `Försenad ${-days} ${-days === 1 ? 'dag' : 'dagar'}`
  if (days === 0) return 'Idag'
  if (days <= 31) return `${soft}om ${days} ${days === 1 ? 'dag' : 'dagar'}`
  const months = Math.round(days / 30)
  return `${soft}om ${months} mån`
}

// One-tap seed examples for the empty state (plan 62).
const EXAMPLES: Array<Omit<ItemDraft, 'notes'> & { notes: string | null }> = [
  { type: 'log', title: 'Avloppsspolning', category: 'underhåll', date: '', cost: null, vendor: null, interval_years: 3, remind_days: 60, notes: null },
  { type: 'contract', title: 'Elavtal', category: 'avtal', date: '', cost: null, vendor: null, interval_years: null, remind_days: 60, notes: null },
  { type: 'log', title: 'Besiktning', category: 'besiktning', date: '', cost: null, vendor: null, interval_years: null, remind_days: 60, notes: null },
]

export default function Huskalendern() {
  const active = useToolPageActive('/huskalendern')
  useLayoutEffect(() => { document.documentElement.classList.remove('calc-layout') }, [])

  const [items, setItems] = useState<HouseItem[]>([])
  const [dlg, setDlg] = useState<{ open: boolean; item: HouseItem | null }>({ open: false, item: null })
  const { toast, showToast } = useToast()
  const { saveVisible: saved, flashSaved } = useSaveFlash()

  const today = todayISO()
  const buckets = useMemo(() => timelineEntries(items, today), [items, today])
  const attention = useMemo(() => needsAttention(items, today), [items, today])

  const refresh = useCallback(async () => { setItems(await Store.listItems()) }, [])
  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { document.title = 'Huskalendern — Hemma·OS' }, [])

  // Auto-scroll so "Idag" sits in view once the timeline has data. Runs after
  // the buckets render; instant (no animation) so the page doesn't visibly jump.
  const dividerRef = useRef<HTMLLIElement>(null)
  const scrolledRef = useRef(false)
  useEffect(() => {
    if (scrolledRef.current || !items.length) return
    const el = dividerRef.current
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'auto' }); scrolledRef.current = true }
  }, [items, buckets])

  function saveErr(err: unknown) { showToast(persistenceErrorMessage(err)) }

  async function handleSave(draft: ItemDraft) {
    // A seeded example (id === '') is an ADD, not an edit — only a real row id
    // routes to updateItem.
    const editId = dlg.item && dlg.item.id ? dlg.item.id : null
    try {
      if (editId) await Store.updateItem(editId, draft)
      else await Store.addItem({ ...draft } as Omit<HouseItem, 'id' | 'created_at'>)
      await refresh(); flashSaved(); setDlg({ open: false, item: null })
      showToast(editId ? 'Sparad.' : 'Tillagd.')
    } catch (err) { saveErr(err) }
  }
  async function handleDelete(item: HouseItem) {
    if (!confirm(`Ta bort "${item.title}"? Det går inte att ångra.`)) return
    try { await Store.removeItem(item.id); await refresh(); flashSaved(); showToast('Borttagen.') }
    catch (err) { saveErr(err) }
  }
  // Seed a one-tap example: open the dialog pre-filled with today's date so the
  // owner just confirms (never writes a bare/empty rail).
  function seedExample(ex: typeof EXAMPLES[number]) {
    setDlg({ open: true, item: { id: '', created_at: '', ...ex, date: today } as HouseItem })
  }

  return (
    <div className={'hk-root' + (active ? ' vt-page' : '')}>
      <PageHeader
        backTo="/huskalendern"
        title="Huskalendern"
        tagline="Husets minne — vad som gjorts och vad som snart går ut"
        saveVisible={saved}
        actions={<>
          <button className="btn btn-primary" onClick={() => setDlg({ open: true, item: null })}>+ Lägg till</button>
          <ThemeToggle />
        </>}
      />

      <main className="wrap hk-wrap">
        {/* ── Attention strip (plan 61/63) ── */}
        {attention.length > 0 && (
          <section className="hk-attention" aria-label="Behöver ses över">
            <div className="hk-attention-head">
              <Icon icon={AlertTriangle} size={16} />
              <span>Behöver ses över ({attention.length})</span>
            </div>
            <ul className="hk-attention-list">
              {attention.map((it) => (
                <li key={it.id} className={'hk-att-item is-' + status(it, today)}>
                  <button type="button" className="hk-att-btn" onClick={() => setDlg({ open: true, item: it })}>
                    <span className="hk-att-title">{it.title}</span>
                    <span className="hk-att-due">{dueLabel(it, today)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {items.length === 0 ? (
          // ── Empty state (plan 62) ──
          <section className="card hk-empty">
            <h2>Husets minne, på ett ställe</h2>
            <p className="hk-empty-lead">
              Två sorters poster: <strong>loggar</strong> (något som gjorts — t.ex. avloppsspolning,
              med ett valfritt intervall) och <strong>avtal</strong> (något som går ut — t.ex. elavtal).
              Allt visas som en tidslinje runt idag, med flaggor när något närmar sig.
            </p>
            <p className="hk-empty-cta">Lägg till:</p>
            <div className="hk-example-row">
              {EXAMPLES.map((ex) => (
                <button key={ex.title} type="button" className="hk-example" onClick={() => seedExample(ex)}>
                  <Icon icon={categoryIcon(ex.category)} size={15} />
                  {ex.title}
                </button>
              ))}
              <button type="button" className="btn btn-ghost hk-example-manual" onClick={() => setDlg({ open: true, item: null })}>
                + Egen post
              </button>
            </div>
          </section>
        ) : (
          // ── Timeline ──
          <section className="hk-timeline" aria-label="Tidslinje">
            {buckets.map((bucket) => (
              <div key={bucket.year} className="hk-year">
                <div className="hk-year-marker"><span>{bucket.year}</span></div>
                <ul className="hk-nodes">
                  {bucket.nodes.map((node) => {
                    if (isDivider(node)) {
                      return (
                        <li key="today" ref={dividerRef} className="hk-node hk-today">
                          <span className="hk-today-dot" aria-hidden />
                          <span className="hk-today-label">Idag · {fmtDate(node.date)}</span>
                        </li>
                      )
                    }
                    return <TimelineRow key={node.id} entry={node} today={today}
                      onEdit={() => setDlg({ open: true, item: node.item })}
                      onDelete={() => handleDelete(node.item)} />
                  })}
                </ul>
              </div>
            ))}
          </section>
        )}
      </main>

      <ItemDialog open={dlg.open} item={dlg.item} onSave={handleSave} onClose={() => setDlg({ open: false, item: null })} />

      <div className={'hk-toast' + (toast.show ? ' show' : '')} role="status" aria-live="polite">{toast.msg}</div>
    </div>
  )
}

// ── One node on the rail ──────────────────────────────────────────────────────
function TimelineRow({ entry, today, onEdit, onDelete }: {
  entry: TimelineEntry; today: string; onEdit: () => void; onDelete: () => void
}) {
  const st: ItemStatus = entry.status
  const isFutureFlag = !entry.past && (st === 'soon' || st === 'overdue')
  const cls = 'hk-node hk-entry'
    + (entry.past ? ' is-past' : ' is-future')
    + (entry.soft ? ' is-soft' : '')
    + (isFutureFlag ? ' is-' + st : '')
  const dateLabel = entry.soft ? '≈ ' + fmtMonth(entry.date) : fmtDate(entry.date)
  const kindLabel = entry.kind === 'expiry' ? 'Går ut' : entry.kind === 'interval' ? 'Åter' : null
  return (
    <li className={cls}>
      <span className="hk-dot" aria-hidden><Icon icon={categoryIcon(entry.category)} size={13} /></span>
      <div className="hk-card">
        <div className="hk-card-top">
          <span className="hk-date">{dateLabel}</span>
          {kindLabel && <span className="hk-kind">{kindLabel}</span>}
          {isFutureFlag && <span className={'hk-flag is-' + st}>{st === 'overdue' ? 'Försenad' : 'Snart'}</span>}
        </div>
        <span className="hk-title">{entry.title}</span>
        <div className="hk-meta">
          {entry.vendor && <span className="hk-vendor">{entry.vendor}</span>}
          {entry.cost != null && <span className="hk-cost">{fmtKr(entry.cost)}</span>}
          {!entry.past && <span className="hk-rel">{dueLabel(entry.item, today)}</span>}
        </div>
        {entry.notes && <p className="hk-notes">{entry.notes}</p>}
      </div>
      <div className="hk-actions">
        <button type="button" className="icon-btn" title="Redigera" aria-label="Redigera" onClick={onEdit}><Icon icon={Pencil} /></button>
        <button type="button" className="icon-btn" data-del title="Ta bort" aria-label="Ta bort" onClick={onDelete}><Icon icon={X} /></button>
      </div>
    </li>
  )
}
