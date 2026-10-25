import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useToolPageActive } from '../lib/toolTransition'
import { computeBudget, money as fmt } from '../lib/hushallsbudget'
import type { IncomeItem, SalarySubmission } from '../lib/hushallsbudget'
import { loadBudget } from '../lib/hushallsbudget-store'
import { buildMonthViews, replaceHalf } from '../lib/loner'
import type { HalfSource, HalfView, MonthView, Slot } from '../lib/loner'
import { toPersistenceError } from '../lib/persistence-error'
import * as salaryStore from '../lib/salary-store'
import * as salaryDraftsStore from '../lib/salary-drafts-store'
import { SalaryHalfConflict, SalaryHalfForbidden } from '../lib/salary-drafts-store'
import * as salaryReminderSettingsStore from '../lib/salary-reminder-settings-store'
import type { SalaryReminderSettings } from '../lib/salary-reminder-settings-store'
import * as salaryEmailStore from '../lib/salary-email-store'
import type { ResultsEmailStatus } from '../lib/salary-email-store'
import { SYNC_STATUS_EVENT } from '../lib/sync'
import DialogShell from '../components/DialogShell'
import PageHeader from '../components/PageHeader'
import ThemeToggle from '../components/ThemeToggle'
import { PersonLabel } from '../components/PersonBadge'
import { useSaveFlash } from '../components/useSaveFlash'
import { useToast } from '../components/useToast'
import { useConfirm } from '../components/useConfirm'
import { usePersonIdentity } from '../components/usePersonIdentity'
import { SalaryItemColumn, type SalaryColumnCopy, type SalaryItem } from './hushallsbudget-salary'
import {
  currentMonth, genitive, monthLabel, monthStatusText, shortDate, transferSentence, wasEdited,
} from './loner-labels'

// ── Swedish copy for the shared income column ───────────────────────────────
const COLUMN_COPY: SalaryColumnCopy = {
  emailTag: 'Inskickad via e-post',
  labelPlaceholder: 't.ex. Lön, Barnbidrag, skatt',
  labelAria: 'Inkomstens namn',
  amountAria: 'Belopp, kr',
  removeAria: 'Ta bort inkomst',
  add: '+ Lägg till inkomst',
}

const MSG_SAVE_FAILED = 'Kunde inte spara — försök igen.'
const MSG_CONFLICT = 'Någon annan ändrade precis den här lönen. Ladda om och försök igen.'
const MSG_FORBIDDEN = 'Du kan bara skicka in din egen lön.'
const MSG_SETTING_SAVE_FAILED = 'Kunde inte spara inställningen — försök igen.'
const MSG_RESEND_QUEUED = 'Resultatet mejlas till er båda inom några minuter.'
const MSG_RESEND_ALREADY = 'Ett mejl är redan på väg.'
const MSG_RESEND_FAILED = 'Kunde inte skicka — försök igen.'
const MSG_ALREADY_LOGGED = 'Månaden blev klar under tiden — dina ändringar ligger nu på den färdiga månaden'

interface ResendFeedback { kind: 'ok' | 'error'; text: string }

/** The status line under "Skicka resultatet igen". `changed` = the month was
    edited after the last results email (updated_at later than last_sent_at). */
function emailStatusLine(row: SalarySubmission, status: ResultsEmailStatus | undefined): { text: string | null; changed: boolean } {
  const queued = status?.queued === true
  const sentAt = status?.last_sent_at ?? null
  const updated = Date.parse(row.updated_at ?? '')
  const sent = sentAt ? Date.parse(sentAt) : NaN
  // A queued mail already covers the current state, so nothing is "changed" then.
  const changed = !queued && Number.isFinite(updated) && Number.isFinite(sent) && updated > sent
  if (queued) return { text: 'Ett mejl är på väg', changed: false }
  if (changed) return { text: 'Månaden har ändrats sedan senaste mejlet', changed }
  const date = shortDate(sentAt)
  return { text: date ? `Senast mejlat ${date}` : null, changed }
}

function sumItems(list: { amount: number }[]): number {
  return list.reduce((t, it) => t + (it.amount || 0), 0)
}

function ownerItems(row: SalarySubmission, owner: Slot): IncomeItem[] {
  const all = Array.isArray(row.income_items) ? row.income_items : []
  return all.filter((it) => it.owner === owner).map((it) => ({ label: it.label, amount: it.amount }))
}

function sourceText(source: HalfSource, iso: string | null | undefined): string {
  const date = shortDate(iso)
  const suffix = date ? ' · ' + date : ''
  if (source === 'email') return 'Inskickad via e-post' + suffix
  if (source === 'app') return 'Inskickad i appen' + suffix
  return 'Klar'
}

// ── The half editor (one person's income for one month) ─────────────────────
interface EditorTarget {
  /** Bumped on every (re)open so the dialog body remounts with fresh inputs. */
  key: number
  mode: 'new' | 'draft' | 'complete'
  month: string
  slot: Slot
  items: IncomeItem[]
  note: string
  /** The draft's exact server updated_at; null when creating. Never reformatted. */
  draftUpdatedAt: string | null
  rowId: string | null
  source: HalfSource | null
  notice: string | null
}

function HalfEditor({
  target, names, mySlot, otherTotalFor, onClose, onSaved, onAlreadyLogged, onReloadHalf,
}: {
  target: EditorTarget
  names: Record<Slot, string>
  mySlot: Slot | null
  otherTotalFor: (month: string, slot: Slot) => number | null
  onClose: () => void
  onSaved: (editedRowId: string | null) => void
  onAlreadyLogged: (month: string, slot: Slot, items: IncomeItem[], note: string) => Promise<void>
  onReloadHalf: (month: string, slot: Slot) => Promise<void>
}) {
  const uid = useRef(0)
  const makeItems = (list: IncomeItem[]): SalaryItem[] =>
    (list.length ? list : [{ label: 'Lön', amount: 0 }]).map((it) => ({ uid: uid.current++, label: it.label, amount: it.amount }))
  const [items, setItems] = useState<SalaryItem[]>(() => makeItems(target.items))
  const [note, setNote] = useState(target.note)
  const [month, setMonth] = useState(target.month)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<{ kind: 'conflict' | 'forbidden'; text: string } | null>(null)
  const { toast, showToast } = useToast()
  const firstAmountRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const t = setTimeout(() => { firstAmountRef.current?.focus(); firstAmountRef.current?.select() }, 30)
    return () => clearTimeout(t)
  }, [])

  const slot = target.slot
  const name = names[slot]
  const total = sumItems(items)
  const otherTotal = otherTotalFor(month, slot)
  let preview: React.ReactNode = null
  if (otherTotal !== null) {
    const r = computeBudget({ incomes: [
      { id: 'a', label: '', amount: slot === 'a' ? total : otherTotal, owner: 'a' },
      { id: 'b', label: '', amount: slot === 'b' ? total : otherTotal, owner: 'b' },
    ] })
    preview = r.transfer.amount < 0.5
      ? <>Med detta är ni jämna — ingen överföring. Var och en får {fmt(r.equalShare)}.</>
      : <>
          Med detta betalar <strong>{names[r.transfer.from === 'b' ? 'b' : 'a']}</strong>{' '}
          <strong>{names[r.transfer.to === 'b' ? 'b' : 'a']}</strong>{' '}
          <strong className="pot-transfer-amount">{fmt(r.transfer.amount)}</strong>
          {' · var och en får ' + fmt(r.equalShare)}
        </>
  }

  function patchItem(uidv: number, patch: Partial<SalaryItem>) {
    setItems((list) => list.map((it) => (it.uid === uidv ? { ...it, ...patch } : it)))
  }

  async function save() {
    if (saving) return
    const clean: IncomeItem[] = items
      .map((it) => ({ label: it.label.trim(), amount: it.amount }))
      .filter((it) => it.label || it.amount)
    const noteText = note.trim()
    setSaving(true)
    setProblem(null)
    try {
      if (target.mode === 'complete') {
        // Read the row fresh so an edit never rebuilds from a stale copy.
        const rows = await salaryStore.list()
        const row = rows.find((r) => r.id === target.rowId)
        if (!row) { showToast('Månaden finns inte längre — ladda om sidan.'); return }
        await salaryStore.update(replaceHalf(row, slot, clean, noteText || null))
        onSaved(target.rowId)
        return
      }
      const result = await salaryDraftsStore.saveHalf(
        month, slot, clean, noteText || null,
        target.mode === 'draft' ? target.draftUpdatedAt : null,
      )
      if (result.status === 'already_logged') {
        await onAlreadyLogged(month, slot, clean, noteText)
        return
      }
      onSaved(null)
    } catch (err) {
      if (err instanceof SalaryHalfConflict) setProblem({ kind: 'conflict', text: MSG_CONFLICT })
      else if (err instanceof SalaryHalfForbidden) setProblem({ kind: 'forbidden', text: MSG_FORBIDDEN })
      else if (target.mode === 'complete' && toPersistenceError(err).category === 'conflict') {
        // The app-wide PersistenceNotice offers reload-or-keep; here we only
        // keep the editor open with the inputs intact.
        setProblem({ kind: 'conflict', text: MSG_CONFLICT })
      } else showToast(MSG_SAVE_FAILED)
    } finally {
      setSaving(false)
    }
  }

  const title = target.mode === 'new'
    ? (mySlot === slot ? 'Skicka in din lön' : `Skicka in för ${name}`)
    : (mySlot === slot ? 'Redigera din lön' : `Redigera ${genitive(name)} lön`)

  return (
    <>
      <div className="modal-head">
        <span className="modal-title">{title}</span>
        <button type="button" className="modal-close" aria-label="Stäng" onClick={onClose}>×</button>
      </div>
      <div className="modal-body">
        {target.notice && <p className="ln-notice" role="status">{target.notice}</p>}
        <div className="field">
          <label htmlFor="lonerMonth">Månad</label>
          {target.mode === 'new'
            ? <input type="month" id="lonerMonth" value={month} onChange={(e) => setMonth(e.target.value)} />
            : <input type="text" id="lonerMonth" value={monthLabel(month)} readOnly />}
        </div>
        <p className="field-label">Inkomst i månaden — lön plus barnbidrag, skatteåterbäring, allt annat</p>
        <div className="income-cols salary-income-cols ln-single-col">
          <SalaryItemColumn
            name={name}
            self={mySlot === slot}
            other={mySlot != null && mySlot !== slot}
            total={total}
            items={items}
            firstAmountRef={firstAmountRef}
            onItemChange={patchItem}
            onRemoveItem={(uidv) => setItems((list) => list.filter((it) => it.uid !== uidv))}
            onAddItem={() => setItems((list) => [...list, { uid: uid.current++, label: '', amount: 0 }])}
            emailTag={target.source === 'email'}
            copy={COLUMN_COPY}
          />
        </div>
        <div className="field">
          <label htmlFor="lonerNote">Anteckning <span className="field-optional">(valfritt)</span></label>
          <input type="text" id="lonerNote" value={note} placeholder="t.ex. bonus, föräldraledighet…" autoComplete="off" onChange={(e) => setNote(e.target.value)} />
        </div>
        {preview && <div className="salary-preview">{preview}</div>}
        {problem && (
          <div className="ln-problem" role="alert">
            <span>{problem.text}</span>
            {problem.kind === 'conflict' && target.mode !== 'complete' && (
              <button type="button" className="btn btn-ghost" onClick={() => { void onReloadHalf(month, slot) }}>Ladda om</button>
            )}
          </div>
        )}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn btn-ghost" onClick={onClose}>Avbryt</button>
        <button type="button" className="btn btn-primary" disabled={saving} aria-busy={saving} onClick={() => { void save() }}>Spara</button>
      </div>
      <div className={'hb-toast' + (toast.show ? ' show' : '')} role="status" aria-live="polite">{toast.msg}</div>
    </>
  )
}

// ── Main component ───────────────────────────────────────────────────────────
export default function Loner() {
  const active = useToolPageActive('/loner')
  useLayoutEffect(() => { document.documentElement.classList.remove('calc-layout') }, [])
  useEffect(() => { document.title = 'Löner — Hemma·OS' }, [])

  const { toast, showToast } = useToast()
  const confirm = useConfirm()
  const { saveVisible, flashSaved } = useSaveFlash()
  const identity = usePersonIdentity()

  const [subs, setSubs] = useState<SalarySubmission[]>([])
  const [drafts, setDrafts] = useState<salaryDraftsStore.SalaryDraft[]>([])
  const [loaded, setLoaded] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [editor, setEditor] = useState<EditorTarget | null>(null)
  const editorKey = useRef(0)
  const importInputRef = useRef<HTMLInputElement>(null)
  const requestRef = useRef(0)

  // Loads both sources; only the latest request's result is applied.
  const reload = useCallback(async () => {
    const request = ++requestRef.current
    const [rows, pending] = await Promise.all([salaryStore.list(), salaryDraftsStore.listDrafts()])
    if (request === requestRef.current) { setSubs(rows); setDrafts(pending); setLoaded(true) }
    return { rows, pending }
  }, [])
  useEffect(() => { void reload() }, [reload])

  // The sync coordinator publishes every outbox state change (including a
  // conflict being resolved by PersistenceNotice): re-read so the list never
  // keeps showing a version the user just discarded or replaced.
  useEffect(() => {
    const onSync = () => { void reload() }
    window.addEventListener(SYNC_STATUS_EVENT, onSync)
    return () => window.removeEventListener(SYNC_STATUS_EVENT, onSync)
  }, [reload])

  // ── Reminder settings (moved from Hushållsbudget) ──────────────────────────
  const [reminderSettings, setReminderSettings] = useState<SalaryReminderSettings | null>(null)
  const [reminderSettingsUnknown, setReminderSettingsUnknown] = useState(false)
  useEffect(() => {
    salaryReminderSettingsStore.loadSalaryReminderSettings().then((loadedSettings) => {
      setReminderSettings(loadedSettings.settings)
      setReminderSettingsUnknown(loadedSettings.unknown)
    })
  }, [])
  async function updateReminderSettings(patch: Partial<SalaryReminderSettings>, failureMessage = 'Kunde inte spara påminnelsen — försök igen.') {
    if (!reminderSettings) return
    const prevSettings = reminderSettings
    const prevUnknown = reminderSettingsUnknown
    const next = { ...reminderSettings, ...patch }
    setReminderSettings(next)
    setReminderSettingsUnknown(false)
    try {
      await salaryReminderSettingsStore.saveSalaryReminderSettings(next)
    } catch {
      setReminderSettings(prevSettings)
      setReminderSettingsUnknown(prevUnknown)
      showToast(failureMessage)
    }
  }

  // ── Results email (D8): status per month + manual resend ───────────────────
  const [emailStatus, setEmailStatus] = useState<Map<string, ResultsEmailStatus>>(new Map())
  const [sending, setSending] = useState<Record<string, boolean>>({})
  const [feedback, setFeedback] = useState<Record<string, ResendFeedback>>({})
  const [offer, setOffer] = useState<string | null>(null)
  const offerTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshEmailStatus = useCallback(async () => {
    setEmailStatus(await salaryEmailStore.listResultsEmailStatus())
  }, [])
  useEffect(() => { void refreshEmailStatus() }, [refreshEmailStatus])
  useEffect(() => () => { if (offerTimer.current) clearTimeout(offerTimer.current) }, [])

  async function resendResults(id: string): Promise<ResendFeedback> {
    setSending((s) => ({ ...s, [id]: true }))
    let result: ResendFeedback
    try {
      const answer = await salaryEmailStore.requestResultsEmail(id)
      result = { kind: 'ok', text: answer === 'queued' ? MSG_RESEND_QUEUED : MSG_RESEND_ALREADY }
    } catch {
      result = { kind: 'error', text: MSG_RESEND_FAILED }
    }
    setFeedback((f) => ({ ...f, [id]: result }))
    setSending((s) => ({ ...s, [id]: false }))
    await refreshEmailStatus()
    return result
  }
  function showOffer(id: string) {
    if (offerTimer.current) clearTimeout(offerTimer.current)
    setOffer(id)
    offerTimer.current = setTimeout(() => setOffer(null), 10_000)
  }
  async function acceptOffer() {
    const id = offer
    if (!id) return
    if (offerTimer.current) clearTimeout(offerTimer.current)
    setOffer(null)
    const result = await resendResults(id)
    showToast(result.text)
  }

  // ── Who is who ─────────────────────────────────────────────────────────────
  // The caller's canonical slot comes from the household identity, not from a
  // tool binding (D2/D3).
  const myPersonId = identity.identity?.myPersonId ?? null
  const mySlot: Slot | null = identity.myPerson?.slot
    ?? identity.people.find((p) => p.id === myPersonId)?.slot
    ?? null
  const personOf = (slot: Slot) => identity.people.find((p) => p.slot === slot) ?? null
  const snapshot = subs.find((row) => row.person_a_name || row.person_b_name)
  const names: Record<Slot, string> = {
    a: personOf('a')?.display_name || snapshot?.person_a_name || 'Person A',
    b: personOf('b')?.display_name || snapshot?.person_b_name || 'Person B',
  }
  const nameOf = (slot: Slot) => names[slot]
  const isSelf = (slot: Slot) => mySlot === slot
  const isOther = (slot: Slot) => mySlot != null && mySlot !== slot
  // D2/D3: you may create your own half, or the half of a slot nobody is assigned to.
  // Until the identity has loaded nothing is offered, so an unassigned-looking
  // slot is never shown for a moment and then taken away.
  const identityReady = identity.status === 'ready'
  const canCreate = (slot: Slot) => identityReady && (mySlot === slot || (personOf(slot)?.assigned_email ?? null) === null)
  const editLabel = (slot: Slot) => (isSelf(slot) ? 'Redigera din lön' : `Redigera ${genitive(nameOf(slot))} lön`)

  const thisMonth = currentMonth()
  const views = useMemo(() => buildMonthViews(subs, drafts, thisMonth), [subs, drafts, thisMonth])
  const currentView = views.find((v) => v.month === thisMonth)

  // ── Opening the editor ─────────────────────────────────────────────────────
  async function baselineItems(slot: Slot): Promise<IncomeItem[]> {
    try {
      const budget = await loadBudget()
      return (budget?.incomes ?? [])
        .filter((row) => (slot === 'b' ? row.owner === 'b' : row.owner !== 'b'))
        .map((row) => ({ label: row.label, amount: row.amount }))
    } catch { return [] }
  }
  function openTarget(t: Omit<EditorTarget, 'key'>) { setEditor({ ...t, key: ++editorKey.current }) }

  async function openNew(month: string, slot: Slot) {
    openTarget({
      mode: 'new', month, slot, items: await baselineItems(slot), note: '',
      draftUpdatedAt: null, rowId: null, source: null, notice: null,
    })
  }
  function openHalf(view: MonthView, slot: Slot, row: SalarySubmission | null, notice: string | null = null) {
    if (view.status === 'complete' && row) {
      openTarget({
        mode: 'complete', month: view.month, slot, items: ownerItems(row, slot), note: row.note ?? '',
        draftUpdatedAt: null, rowId: row.id ?? null, source: 'complete', notice,
      })
      return
    }
    const half = view.halves[slot]
    if (!half) return
    openTarget({
      mode: 'draft', month: view.month, slot, items: half.items, note: half.note ?? '',
      draftUpdatedAt: half.draftUpdatedAt, rowId: null, source: half.source, notice,
    })
  }

  // The month became complete between opening the editor and saving: keep what
  // the user typed and reopen it as an edit of the finished month.
  async function onAlreadyLogged(month: string, slot: Slot, items: IncomeItem[], note: string) {
    const fresh = await reload()
    const view = buildMonthViews(fresh.rows, fresh.pending, thisMonth).find((v) => v.month === month)
    const row = view?.submission ?? null
    if (view?.status === 'complete' && row) {
      openTarget({
        mode: 'complete', month, slot, items, note,
        draftUpdatedAt: null, rowId: row.id ?? null, source: 'complete', notice: MSG_ALREADY_LOGGED,
      })
    } else {
      setEditor(null)
      showToast(MSG_SAVE_FAILED)
    }
  }

  // "Ladda om" after a conflict: re-read the server and reopen on its version.
  async function reloadHalf(month: string, slot: Slot) {
    const fresh = await reload()
    const view = buildMonthViews(fresh.rows, fresh.pending, thisMonth).find((v) => v.month === month)
    if (!view) { setEditor(null); return }
    if (view.status === 'complete') openHalf(view, slot, view.submission)
    else if (view.halves[slot]) openHalf(view, slot, null)
    else void openNew(month, slot)
  }

  const otherTotalFor = (month: string, slot: Slot): number | null => {
    const other: Slot = slot === 'a' ? 'b' : 'a'
    const half = views.find((v) => v.month === month)?.halves[other]
    return half ? half.total : null
  }

  async function removeRow(id: string | undefined) {
    if (!id) return
    if (!(await confirm({ title: 'Ta bort den här månaden?', message: 'Det går inte att ångra.', confirmLabel: 'Ta bort' }))) return
    try { await salaryStore.remove(id) } catch {
      showToast('Kunde inte ta bort — du kanske är offline.'); return
    }
    void reload()
  }

  // ── Export / import (moved from Hushållsbudget) ────────────────────────────
  function download(filename: string, text: string, type: string) {
    const blob = new Blob([text], { type })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = filename
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url)
  }
  async function exportJSON() { download('salary-submissions.json', await salaryStore.exportJSON(), 'application/json') }
  async function exportCSV() { download('salary-submissions.csv', await salaryStore.exportCSV(), 'text/csv') }
  function onImportFile(file: File | undefined) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      salaryStore.importJSON(String(reader.result)).then((added) => {
        void reload(); flashSaved()
        showToast(added > 0
          ? 'Importerade ' + added + (added === 1 ? ' post.' : ' poster.')
          : 'Inget nytt att importera — posterna finns redan.')
      }).catch((err) => showToast('Importen misslyckades: ' + (err && err.message ? err.message : 'okänt fel')))
    }
    reader.readAsText(file)
  }

  // ── Year summary (moved from the History modal) ────────────────────────────
  const year = subs.reduce((latest, row) => (String(row.month) > latest ? String(row.month) : latest), '').slice(0, 4)
  const yearRows = year ? subs.filter((row) => String(row.month || '').slice(0, 4) === year) : []
  const yearNameA = yearRows[0]?.person_a_name || names.a
  const yearNameB = yearRows[0]?.person_b_name || names.b
  let totalA = 0, totalB = 0, net = 0
  yearRows.forEach((row) => {
    totalA += row.income_a || 0
    totalB += row.income_b || 0
    const amount = row.transfer_amount || 0
    net += row.transfer_from === 'b' ? -amount : amount // positive = A pays B
  })
  const netText = Math.abs(net) < 0.5
    ? 'Jämnt över året'
    : (net > 0 ? yearNameA + ' → ' + yearNameB : yearNameB + ' → ' + yearNameA) + '  ' + fmt(Math.abs(net))

  function detailRow(label: string, value: string, key?: string | number, text = false) {
    return <div className="detail-row" key={key}><span className="detail-label">{label}</span><span className={'detail-val' + (text ? ' is-text' : '')}>{value}</span></div>
  }

  // ── This month card ────────────────────────────────────────────────────────
  function slotLine(view: MonthView, slot: Slot) {
    const half = view.halves[slot]
    const createdAt = view.submission?.created_at
    return (
      <li className="ln-person" key={slot}>
        <div className="ln-person-main">
          <PersonLabel name={nameOf(slot)} self={isSelf(slot)} other={isOther(slot)} />
          <span className="ln-person-state">
            {half ? sourceText(half.source, half.source === 'complete' ? createdAt : half.draftUpdatedAt) : 'Ej inskickad'}
          </span>
          {half && <span className="ln-person-amount">{fmt(half.total)}</span>}
        </div>
        {slotAction(view, slot, half)}
      </li>
    )
  }
  function slotAction(view: MonthView, slot: Slot, half: HalfView | undefined) {
    if (half) {
      return (
        <button type="button" className={'btn ' + (isSelf(slot) ? 'btn-secondary' : 'btn-ghost')} onClick={() => openHalf(view, slot, view.submission)}>
          {editLabel(slot)}
        </button>
      )
    }
    if (!canCreate(slot)) return null
    return (
      <button type="button" className="btn btn-primary" onClick={() => { void openNew(view.month, slot) }}>
        {isSelf(slot) ? 'Skicka in din lön' : `Skicka in för ${nameOf(slot)}`}
      </button>
    )
  }

  const missingSlots = currentView ? (['a', 'b'] as const).filter((slot) => !currentView.halves[slot]) : []
  const hasNoSlotHint = identityReady && mySlot === null && missingSlots.length > 0 && missingSlots.every((slot) => !canCreate(slot))

  const monthCard = currentView && (
    <section className="section ln-card" aria-labelledby="lonerCardTitle">
      <div className="section-label">
        <span className="section-title" id="lonerCardTitle">Löner för {monthLabel(thisMonth)}</span>
        <span className="ln-chip" data-status={currentView.status}>{monthStatusText(currentView, nameOf)}</span>
      </div>
      <ul className="ln-people">
        {(['a', 'b'] as const).map((slot) => slotLine(currentView, slot))}
      </ul>
      {currentView.status === 'complete' && currentView.submission && (
        <div className="pot-transfer">
          <span className="pot-transfer-icon" aria-hidden="true">⇄</span>
          <span className="pot-transfer-text">
            {transferSentence(currentView.submission)}
            {' · var och en får ' + fmt(currentView.submission.equal_share)}
          </span>
        </div>
      )}
      {(currentView.status === 'waiting' || currentView.status === 'empty') && (
        <p className="section-note ln-hint">Överföringen räknas ut när båda har skickat in</p>
      )}
      {currentView.status === 'zero_total' && (
        <p className="section-note ln-hint">Båda har skickat in men summan är 0 kr — justera ett belopp.</p>
      )}
      {hasNoSlotHint && (
        <p className="section-note ln-hint">Ditt konto är inte kopplat till en person i hushållet.</p>
      )}
    </section>
  )

  // ── Month list ─────────────────────────────────────────────────────────────
  const entries = views.filter((v) => v.status !== 'empty').flatMap((view) =>
    view.status === 'complete'
      ? view.duplicates.map((row, i) => ({ key: row.id ?? `${view.month}-${i}`, view, row: row as SalarySubmission | null, duplicate: i > 0 }))
      : [{ key: view.month, view, row: null as SalarySubmission | null, duplicate: false }])

  function resendBlock(row: SalarySubmission) {
    const id = row.id
    if (!id) return null
    const { text, changed } = emailStatusLine(row, emailStatus.get(id))
    const busy = sending[id] === true
    const result = feedback[id]
    return (
      <div className="ln-resend">
        <div className="detail-subhead">Resultatmejl</div>
        {text && <p className="ln-resend-status" data-changed={changed || undefined}>{changed ? '! ' : ''}{text}</p>}
        <button type="button" className={'btn ' + (changed ? 'btn-primary' : 'btn-ghost')} disabled={busy} aria-busy={busy}
          onClick={() => { void resendResults(id) }}>
          Skicka resultatet igen
        </button>
        <p className="ln-resend-feedback" data-kind={result?.kind} role="status" aria-live="polite">{result?.text ?? ''}</p>
      </div>
    )
  }

  function entryDetail(view: MonthView, row: SalarySubmission | null) {
    if (row) {
      return (
        <>
          {detailRow('Inskickad', shortDate(row.created_at) || '—')}
          {wasEdited(row) && detailRow('Ändrad', shortDate(row.updated_at))}
          {detailRow(`${row.person_a_name || nameOf('a')}${isSelf('a') ? ' (du)' : ''} totalt`, fmt(row.income_a || 0))}
          {detailRow(`${row.person_b_name || nameOf('b')}${isSelf('b') ? ' (du)' : ''} totalt`, fmt(row.income_b || 0))}
          {detailRow('Var och en får', fmt(row.equal_share || 0))}
          {detailRow('Överföring', transferSentence(row), undefined, true)}
          {(['a', 'b'] as const).map((slot) => {
            const its = ownerItems(row, slot)
            return (
              <div key={slot}>
                <div className="detail-subhead">{(slot === 'a' ? row.person_a_name : row.person_b_name) || nameOf(slot)}{isSelf(slot) ? ' (du)' : ''} inkomst</div>
                {its.map((it, i) => detailRow(it.label || 'Inkomst', fmt(it.amount || 0), i))}
                <button type="button" className="btn btn-ghost ln-edit" onClick={() => openHalf(view, slot, row)}>{editLabel(slot)}</button>
              </div>
            )
          })}
          {row.note && (
            <>
              <div className="detail-subhead">Anteckning</div>
              <p className="detail-note">{row.note}</p>
            </>
          )}
          {resendBlock(row)}
          <button type="button" className="btn btn-ghost ln-delete" onClick={() => { void removeRow(row.id) }}>Ta bort månaden</button>
        </>
      )
    }
    return (['a', 'b'] as const).map((slot) => {
      const half = view.halves[slot]
      return (
        <div key={slot}>
          <div className="detail-subhead">{nameOf(slot)}{isSelf(slot) ? ' (du)' : ''}</div>
          {half ? (
            <>
              {detailRow(sourceText(half.source, half.draftUpdatedAt), fmt(half.total))}
              {half.items.map((it, i) => detailRow(it.label || 'Inkomst', fmt(it.amount || 0), i))}
              {half.note && <p className="detail-note">{half.note}</p>}
              <button type="button" className="btn btn-ghost ln-edit" onClick={() => openHalf(view, slot, null)}>{editLabel(slot)}</button>
            </>
          ) : (
            <>
              <p className="detail-note">Ej inskickad</p>
              {canCreate(slot) && (
                <button type="button" className="btn btn-ghost ln-edit" onClick={() => { void openNew(view.month, slot) }}>
                  {isSelf(slot) ? 'Skicka in din lön' : `Skicka in för ${nameOf(slot)}`}
                </button>
              )}
            </>
          )}
        </div>
      )
    })
  }

  return (
    <div className={'ln-root hb-root' + (active ? ' vt-page' : '')}>
      <PageHeader
        backTo="/loner"
        title="Löner"
        tagline={<>Var och en skickar in sin egen lön — månaden räknas ut när båda är inne</>}
        saveVisible={saveVisible}
        actions={<ThemeToggle />}
      />

      <div className="ln-wrap">
        {monthCard}

        <section className="section" aria-labelledby="lonerListTitle">
          <div className="section-label">
            <span className="section-title" id="lonerListTitle">Månader</span>
          </div>
          {yearRows.length > 0 && (
            <div className="year-summary">
              <div className="year-summary-head">
                <span className="year-summary-title">{year} hittills</span>
                <span className="year-summary-count">{yearRows.length + (yearRows.length === 1 ? ' månad' : ' månader')}</span>
              </div>
              {detailRow(`${yearNameA}${isSelf('a') ? ' (du)' : ''} inkomst`, fmt(totalA))}
              {detailRow(`${yearNameB}${isSelf('b') ? ' (du)' : ''} inkomst`, fmt(totalB))}
              {detailRow('Nettoavräkning', netText, undefined, true)}
            </div>
          )}
          <div className="history-list">
            {!loaded
              ? <p className="history-empty" role="status">Laddar…</p>
              : entries.length === 0
                ? <p className="history-empty">Inga månader har skickats in än — använd “Skicka in din lön” ovan.</p>
                : entries.map(({ key, view, row, duplicate }) => {
                  const open = !!expanded[key]
                  return (
                    <div className={'history-item' + (open ? ' open' : '')} key={key}>
                      <div className="history-head">
                        <button type="button" className="history-toggle" aria-expanded={open}
                          onClick={() => setExpanded((e) => ({ ...e, [key]: !open }))}>
                          <span className="history-month">{monthLabel(view.month)}</span>
                          {duplicate && <span className="ln-chip" data-status="duplicate">Dubblett</span>}
                          <span className="ln-chip" data-status={view.status}>{monthStatusText(view, nameOf)}</span>
                          {row && <span className="history-amount">{transferSentence(row)}</span>}
                          <span className="history-chevron" aria-hidden="true">⌄</span>
                        </button>
                      </div>
                      <div className="history-detail">
                        <div className="history-detail-inner">{open && entryDetail(view, row)}</div>
                      </div>
                    </div>
                  )
                })}
          </div>
          <div className="ln-io">
            <button type="button" className="btn btn-ghost" onClick={() => importInputRef.current?.click()}>Importera…</button>
            <button type="button" className="btn btn-ghost" onClick={() => { void exportCSV() }}>CSV</button>
            <button type="button" className="btn btn-ghost" onClick={() => { void exportJSON() }}>JSON</button>
            <input ref={importInputRef} type="file" accept="application/json,.json" hidden aria-label="Importera JSON-fil"
              onChange={(e) => { onImportFile(e.target.files?.[0]); e.target.value = '' }} />
          </div>
        </section>

        <section className="section" aria-label="Påminnelse">
          <div
            className={'salary-reminder' + (reminderSettings === null ? ' is-loading' : '')}
            aria-busy={reminderSettings === null}
          >
            <div className="salary-reminder-head">
              <span className="salary-reminder-text">
                <label className="salary-reminder-title" htmlFor="salary-reminder-enabled">
                  Månatlig lönepåminnelse
                </label>
                <span className="salary-reminder-sub">
                  Mejlar var och en en länk för att fylla i månadens lön.
                </span>
              </span>
              <label className="toggle">
                <input
                  id="salary-reminder-enabled"
                  type="checkbox"
                  checked={reminderSettings?.enabled ?? false}
                  disabled={reminderSettings === null}
                  onChange={(e) => { void updateReminderSettings({ enabled: e.target.checked }) }}
                />
                <span className="toggle-slider" />
              </label>
            </div>

            <div className="salary-reminder-day-row">
              <label htmlFor="salary-reminder-day">Skicka på dag</label>
              <select
                id="salary-reminder-day"
                className="select salary-reminder-day"
                value={reminderSettings?.send_day ?? ''}
                disabled={reminderSettings === null || !reminderSettings.enabled}
                onChange={(e) => { void updateReminderSettings({ send_day: Number(e.target.value) }) }}
              >
                {reminderSettings === null && <option value="">–</option>}
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
              <span aria-hidden="true">i månaden</span>
            </div>

            {reminderSettingsUnknown && (
              <p className="salary-reminder-hint" role="status">
                Kunde inte läsa inställningen — visar standardvärdet, inte nödvändigtvis det som är sparat.
              </p>
            )}
          </div>

          {(['notify_partner', 'email_results'] as const).map((key) => {
            const copy = key === 'notify_partner'
              ? { id: 'salary-notify-partner', title: 'Mejla när den andra har skickat in', sub: 'Den andra får ett mejl när du skickar in din lön och månaden väntar på hen.' }
              : { id: 'salary-email-results', title: 'Mejla resultatet när månaden är klar', sub: 'Ni får båda ett mejl med överföringen när den andra halvan kommit in.' }
            return (
              <div
                key={key}
                className={'salary-reminder ln-setting' + (reminderSettings === null ? ' is-loading' : '')}
                aria-busy={reminderSettings === null}
              >
                <div className="salary-reminder-head">
                  <span className="salary-reminder-text">
                    <label className="salary-reminder-title" htmlFor={copy.id}>{copy.title}</label>
                    <span className="salary-reminder-sub">{copy.sub}</span>
                  </span>
                  <label className="toggle">
                    <input
                      id={copy.id}
                      type="checkbox"
                      checked={reminderSettings?.[key] ?? false}
                      disabled={reminderSettings === null}
                      onChange={(e) => { void updateReminderSettings({ [key]: e.target.checked }, MSG_SETTING_SAVE_FAILED) }}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
              </div>
            )
          })}
        </section>
      </div>

      <DialogShell open={editor !== null} onClose={() => setEditor(null)} className="hb-modal" ariaLabel="Redigera lön">
        {editor && (
          <HalfEditor
            key={editor.key}
            target={editor}
            names={names}
            mySlot={mySlot}
            otherTotalFor={otherTotalFor}
            onClose={() => setEditor(null)}
            onSaved={(editedRowId) => {
              setEditor(null); flashSaved(); void reload()
              if (editedRowId) { void refreshEmailStatus(); showOffer(editedRowId) }
            }}
            onAlreadyLogged={onAlreadyLogged}
            onReloadHalf={reloadHalf}
          />
        )}
      </DialogShell>
      {offer && (
        <div className="ln-offer" role="status" aria-live="polite">
          <span>Sparat. Mejla det nya resultatet?</span>
          <button type="button" className="btn btn-primary" onClick={() => { void acceptOffer() }}>Mejla det nya resultatet</button>
          <button type="button" className="ln-offer-close" aria-label="Stäng" onClick={() => setOffer(null)}>×</button>
        </div>
      )}
      <div className={'hb-toast' + (toast.show ? ' show' : '')} role="status" aria-live="polite">{toast.msg}</div>
    </div>
  )
}
