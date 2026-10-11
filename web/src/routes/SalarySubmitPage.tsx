// SalarySubmitPage — plan 132's public, token-only page at `#/lon/<token>`.
// Rendered by App.tsx BEFORE AuthGate, the router, or any store: this module's
// import graph must never reach `lib/supabase` or a `*-store.ts` (there is no
// Supabase session here — the link token in the request body is the only
// credential). It talks to the `salary-reminder` Edge Function with a plain
// `fetch`, reading the project URL and publishable ("anon") key straight from
// Vite env vars rather than importing the shared client (see the
// import-boundary test, SalarySubmitPage.test.tsx).
//
// It reuses SalaryItemColumn (hushallsbudget-salary.tsx) and the modal's own
// CSS classnames (modal-head/-body/-foot, field, income-col, sal-row…), which
// are scoped under `.hb-root` via CSS nesting in hushallsbudget.css (loaded
// globally by main.tsx regardless of route). This page supplies that scope
// through `.salary-submit-shell` without taking on `.hb-root`'s own
// full-viewport split-view layout — see salary-submit.css.
import { useCallback, useEffect, useRef, useState } from 'react'
import { SalaryItemColumn, type SalaryItem } from './hushallsbudget-salary'
// Pure, import-free module shared with the Deno edge function (plan 132); the
// existing Vitest suite already imports it the same way (relative path,
// `allowImportingTsExtensions` in tsconfig.app.json).
import { monthLabelEn } from '../../../supabase/functions/_shared/salary-reminder-logic.ts'

const FUNCTIONS_PATH = '/functions/v1/salary-reminder'
// A real navigation to the app root (no hash), not `#/`: App.tsx picks the
// token branch once at mount, so a hash-only change would leave this page up.
const APP_ROOT_HREF = './'

interface ContextItem { label: string; amount: number }

type ContextResponse =
  | { status: 'already_logged'; month: string }
  | {
      month: string
      slot: 'a' | 'b'
      displayName: string
      status: 'open' | 'submitted'
      items: ContextItem[]
      note: string | null
      expiresAt: string
    }

type SubmitStatus = 'submitted' | 'finalized' | 'already_logged' | 'zero_total'
type SubmitResponse =
  | { status: SubmitStatus }
  | { error: 'invalid'; field: string; message: string }
  | { error: string }

function isContextResponse(body: unknown): body is ContextResponse {
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  if (b.status === 'already_logged') return typeof b.month === 'string'
  return (
    typeof b.month === 'string' &&
    (b.slot === 'a' || b.slot === 'b') &&
    typeof b.displayName === 'string' &&
    (b.status === 'open' || b.status === 'submitted') &&
    Array.isArray(b.items) &&
    typeof b.expiresAt === 'string'
  )
}

async function postSalaryReminder(body: Record<string, unknown>): Promise<{ httpStatus: number; body: unknown }> {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
  const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined
  if (!url || !anonKey) throw new Error('salary-reminder: Supabase env vars are not configured')
  const res = await fetch(`${url.replace(/\/$/, '')}${FUNCTIONS_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    body: JSON.stringify(body),
  })
  let json: unknown = null
  try { json = await res.json() } catch { /* empty or non-JSON body */ }
  return { httpStatus: res.status, body: json }
}

// ── Loading skeleton — the column's shape, no amounts (no "0 kr" flash) ─────
function Skeleton() {
  return (
    <div className="modal hb-root salary-submit-card" aria-hidden="true">
      <div className="modal-head">
        <span className="modal-title">Submit your salary</span>
      </div>
      <div className="modal-body">
        <div className="salary-submit-skeleton">
          <div className="salary-submit-skeleton-row" style={{ width: '60%' }} />
          <div className="salary-submit-skeleton-row" />
          <div className="salary-submit-skeleton-row" />
        </div>
      </div>
    </div>
  )
}

// ── A terminal, form-less message (invalid link / already logged / finalized) ─
function StatusCard({ title, message }: { title: string; message: string }) {
  return (
    <div className="modal hb-root salary-submit-card">
      <div className="modal-head">
        <span className="modal-title">{title}</span>
      </div>
      <div className="modal-body">
        <p className="salary-submit-status" role="status" aria-live="polite">
          {message} <a href={APP_ROOT_HREF}>Go to Hemma OS</a>
        </p>
      </div>
    </div>
  )
}

let uidCounter = 0
function itemsFromContext(items: ContextItem[]): SalaryItem[] {
  return items.map((it) => ({ uid: uidCounter++, label: it.label, amount: it.amount }))
}

export default function SalarySubmitPage({ token }: { token: string }) {
  const [phase, setPhase] = useState<'loading' | 'invalid_link' | 'context_error' | 'already_logged' | 'finalized' | 'form'>('loading')
  const [month, setMonth] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [items, setItems] = useState<SalaryItem[]>([])
  const [note, setNote] = useState('')
  const [formNote, setFormNote] = useState<'submitted' | 'zero_total' | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const firstAmountRef = useRef<HTMLInputElement>(null)

  const loadContext = useCallback(async () => {
    setPhase('loading')
    try {
      const { httpStatus, body } = await postSalaryReminder({ action: 'context', token })
      if (httpStatus === 404) { setPhase('invalid_link'); return }
      if (httpStatus !== 200 || !isContextResponse(body)) { setPhase('context_error'); return }
      if (body.status === 'already_logged') {
        setMonth(body.month)
        setPhase('already_logged')
        return
      }
      setMonth(body.month)
      setDisplayName(body.displayName)
      setItems(itemsFromContext(body.items))
      setNote(body.note ?? '')
      setFormNote(body.status === 'submitted' ? 'submitted' : null)
      setPhase('form')
    } catch {
      setPhase('context_error')
    }
  }, [token])

  useEffect(() => { void loadContext() }, [loadContext])

  // Focus the first amount field once the form appears, matching the modal.
  useEffect(() => {
    if (phase !== 'form') return
    const t = setTimeout(() => { firstAmountRef.current?.focus(); firstAmountRef.current?.select() }, 30)
    return () => clearTimeout(t)
  }, [phase])

  function patchItem(uidv: number, patch: Partial<SalaryItem>) {
    setItems((list) => list.map((it) => (it.uid === uidv ? { ...it, ...patch } : it)))
  }
  function removeItem(uidv: number) {
    setItems((list) => list.filter((it) => it.uid !== uidv))
  }
  function addItem() {
    setItems((list) => [...list, { uid: uidCounter++, label: '', amount: 0 }])
  }

  const total = items.reduce((t, it) => t + (it.amount || 0), 0)

  async function submit() {
    setSaving(true)
    setSaveError(null)
    try {
      const { httpStatus, body } = await postSalaryReminder({
        action: 'submit',
        token,
        items: items.map((it) => ({ label: it.label, amount: it.amount })),
        note: note.trim() === '' ? null : note,
      })
      const payload = body as SubmitResponse | null
      // 'message' only exists on the {error:'invalid', field, message} member —
      // checking for it (rather than `error === 'invalid'`) is what actually
      // narrows the union, since the other error member's `error: string` is
      // too wide for equality narrowing to rule out.
      if (httpStatus === 422 && payload && 'message' in payload && typeof payload.message === 'string') {
        setSaveError(payload.message)
        return
      }
      if (httpStatus === 404) {
        // The token died between load and submit (finalised or expired
        // elsewhere) — same user-facing treatment as an invalid link.
        setPhase('invalid_link')
        return
      }
      if (httpStatus !== 200 || !payload || !('status' in payload)) {
        setSaveError('Could not save — check your connection and try again.')
        return
      }
      if (payload.status === 'finalized') { setPhase('finalized'); return }
      if (payload.status === 'already_logged') { setPhase('already_logged'); return }
      setFormNote(payload.status) // 'submitted' | 'zero_total'
    } catch {
      setSaveError('Could not save — check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  if (phase === 'loading') {
    return (
      <div className="salary-submit-page">
        <Skeleton />
      </div>
    )
  }

  if (phase === 'invalid_link') {
    return (
      <div className="salary-submit-page">
        <StatusCard
          title="Link no longer valid"
          message="This link has expired or is no longer valid. Log in to Hemma OS to submit."
        />
      </div>
    )
  }

  if (phase === 'context_error') {
    return (
      <div className="salary-submit-page">
        <div className="modal hb-root salary-submit-card">
          <div className="modal-head">
            <span className="modal-title">Submit your salary</span>
          </div>
          <div className="modal-body">
            <p className="salary-submit-status" role="alert">Could not load this link — check your connection and try again.</p>
            <button type="button" className="btn btn-primary" onClick={() => void loadContext()}>Retry</button>
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'already_logged') {
    return (
      <div className="salary-submit-page">
        <StatusCard title="Already logged" message={`${monthLabelEn(month)} is already logged.`} />
      </div>
    )
  }

  if (phase === 'finalized') {
    return (
      <div className="salary-submit-page">
        <StatusCard title="Submitted" message={`Both salaries are in — ${monthLabelEn(month)} is logged.`} />
      </div>
    )
  }

  return (
    <div className="salary-submit-page">
      <div className="modal hb-root salary-submit-card">
        <div className="modal-head">
          <div>
            <span className="modal-title">Submit your salary</span>
            <p className="modal-subtitle">{displayName} · {monthLabelEn(month)}</p>
          </div>
        </div>
        <div className="modal-body">
          <p className="modal-note">
            Enter what you earned this month. Your partner gets their own link — nothing here is shared with them.
          </p>
          <SalaryItemColumn
            name={displayName}
            total={total}
            items={items}
            firstAmountRef={firstAmountRef}
            onItemChange={patchItem}
            onRemoveItem={removeItem}
            onAddItem={addItem}
          />
          <div className="field">
            <label htmlFor="salaryNote">Note <span className="field-optional">(optional)</span></label>
            <input
              type="text" id="salaryNote" value={note} placeholder="e.g. bonus, parental leave…" autoComplete="off"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {formNote === 'submitted' && (
            <p className="salary-submit-status" role="status" aria-live="polite">
              Saved. Waiting for your partner — you can still edit until they submit.
            </p>
          )}
          {formNote === 'zero_total' && (
            <p className="salary-submit-status" role="status" aria-live="polite">
              Both entries are 0 kr — open Hemma OS to finish this month.
            </p>
          )}
          {saveError && (
            <div className="salary-submit-error" role="alert">
              <span>{saveError}</span>
              <button type="button" className="btn btn-ghost" onClick={() => void submit()} disabled={saving}>Retry</button>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void submit()}>
            {saving ? 'Saving…' : 'Confirm & save'}
          </button>
        </div>
      </div>
    </div>
  )
}
