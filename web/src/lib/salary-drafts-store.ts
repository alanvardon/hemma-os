/* salary-drafts-store.ts — the pending per-slot salary halves
   (salary_submission_drafts, supabase/migrations/20261011100000_
   salary_reminders.sql + 20261025100000_salary_app_halves.sql).

   A half is written two ways: the plan 132 email link (the salary-reminder
   Edge Function, submitted_via = 'email') and, since plan 139, the app itself
   through public.save_salary_half (submitted_via = 'app'). The table stays
   select-only for clients; every in-app write goes through that RPC, which
   enforces own-slot creation, optimistic concurrency on `updated_at`, and
   completes the month once both halves exist.

   Deliberately cache-free and queue-free: drafts are server state, so a
   failed read means "nothing pending shown", not "show a stale local copy",
   and a failed write throws so the UI can keep the dialog open — there is no
   offline promise. RLS (`hh_select`) already scopes every read to the
   caller's household — no household_id filter here.

   Rows are parsed defensively: a malformed row (bad month/slot/channel, a
   missing updated_at, non-array items) is skipped rather than thrown, and a
   malformed item (non-finite amount) is dropped from its row, so one corrupt
   draft can never break the whole list.

   `updated_at` is kept as the exact server string (microsecond precision).
   Never round-trip it through Date: the RPC compares it for equality, and a
   millisecond-truncated value would raise a conflict on every edit. */

import { supabase } from './supabase'
import { reportPersistenceWarning } from './persistence-error'
import { parseYearMonth } from './persistence-schema'

export interface SalaryDraftItem { label: string; amount: number }

export interface SalaryDraft {
  month: string
  slot: 'a' | 'b'
  income_items: SalaryDraftItem[]
  note: string | null
  /** Channel of the latest save of this half. */
  submitted_via: 'email' | 'app'
  /** Exact server timestamp string — pass back unchanged to saveHalf. */
  updated_at: string
}

export type SaveHalfStatus = 'already_logged' | 'pending' | 'finalized' | 'zero_total'

export interface SaveHalfResult {
  status: SaveHalfStatus
  /** The half's new updated_at while the month is still pending/zero_total;
      null for 'finalized' (the draft is gone) and 'already_logged' (no write). */
  updated_at: string | null
}

/** Someone else saved this half since it was loaded (SQLSTATE 40001). */
export class SalaryHalfConflict extends Error {
  constructor(message = 'salary half conflict') {
    super(message)
    this.name = 'SalaryHalfConflict'
  }
}

/** The caller may not create this half: it belongs to another assigned person,
    or the caller has no household (SQLSTATE 42501). */
export class SalaryHalfForbidden extends Error {
  constructor(message = 'not your salary') {
    super(message)
    this.name = 'SalaryHalfForbidden'
  }
}

function parseItem(raw: unknown): SalaryDraftItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const item = raw as Record<string, unknown>
  if (typeof item.label !== 'string') return null
  if (typeof item.amount !== 'number' || !Number.isFinite(item.amount)) return null
  return { label: item.label, amount: item.amount }
}

function parseDraft(raw: unknown): SalaryDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  const month = parseYearMonth(row.month)
  if (!month.ok) return null
  if (row.slot !== 'a' && row.slot !== 'b') return null
  if (row.submitted_via !== 'email' && row.submitted_via !== 'app') return null
  if (typeof row.updated_at !== 'string' || !row.updated_at) return null
  if (!Array.isArray(row.income_items)) return null
  const items: SalaryDraftItem[] = []
  for (const raw_item of row.income_items) {
    const parsed = parseItem(raw_item)
    if (parsed) items.push(parsed) // skip malformed items rather than reject the whole draft
  }
  const note = typeof row.note === 'string' ? row.note : null
  return {
    month: month.value, slot: row.slot, income_items: items, note,
    submitted_via: row.submitted_via, updated_at: row.updated_at,
  }
}

/** The household's pending halves — for one month, or every pending month when
    `month` is omitted. A read failure (RLS, offline, down) is reported as a
    recoverable warning and resolves to an empty list. */
export async function listDrafts(month?: string): Promise<SalaryDraft[]> {
  const query = supabase
    .from('salary_submission_drafts')
    .select('month, slot, income_items, note, submitted_via, updated_at')
  const { data, error } = await (month === undefined ? query : query.eq('month', month))
  if (error || !data) {
    reportPersistenceWarning(month === undefined
      ? 'Kunde inte hämta inskickade löner som väntar på den andra halvan — försök igen senare.'
      : 'Couldn’t load salary entries submitted by email for this month — showing the usual prefill instead.')
    return []
  }
  const drafts: SalaryDraft[] = []
  for (const row of data) {
    const parsed = parseDraft(row)
    if (parsed) drafts.push(parsed) // skip a malformed row, keep the rest visible
  }
  return drafts
}

const SAVE_STATUSES: readonly SaveHalfStatus[] = ['already_logged', 'pending', 'finalized', 'zero_total']

function parseSaveResult(raw: unknown): SaveHalfResult {
  const malformed = () => new Error('Malformed save_salary_half response')
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw malformed()
  const result = raw as Record<string, unknown>
  const status = result.status
  if (typeof status !== 'string' || !SAVE_STATUSES.includes(status as SaveHalfStatus)) throw malformed()
  const updatedAt = result.updated_at
  if (status === 'pending' || status === 'zero_total') {
    // The half still exists, so the server must hand back its new version.
    if (typeof updatedAt !== 'string' || !updatedAt) throw malformed()
    return { status, updated_at: updatedAt }
  }
  // already_logged omits updated_at; finalized sends null (the draft is gone).
  if (updatedAt !== undefined && updatedAt !== null) throw malformed()
  return { status: status as SaveHalfStatus, updated_at: null }
}

/** Create or edit one person's half through public.save_salary_half.
    `expectedUpdatedAt` is null when creating, else the half's `updated_at`
    exactly as listDrafts returned it. Throws SalaryHalfConflict (40001),
    SalaryHalfForbidden (42501), the backend error for anything else, or an
    Error on a malformed response. Never cached or queued. */
export async function saveHalf(
  month: string,
  slot: 'a' | 'b',
  items: SalaryDraftItem[],
  note: string | null,
  expectedUpdatedAt: string | null,
): Promise<SaveHalfResult> {
  const { data, error } = await supabase.rpc('save_salary_half', {
    p_month: month,
    p_slot: slot,
    p_items: items.map((item) => ({ label: item.label, amount: item.amount })),
    p_note: note,
    p_expected_updated_at: expectedUpdatedAt,
  })
  if (error) {
    const code = (error as { code?: unknown }).code
    const message = (error as { message?: unknown }).message
    if (code === '40001') throw new SalaryHalfConflict(typeof message === 'string' ? message : undefined)
    if (code === '42501') throw new SalaryHalfForbidden(typeof message === 'string' ? message : undefined)
    throw error
  }
  return parseSaveResult(data)
}

/** Discard this month's drafts and revoke its tokens (public.discard_salary_drafts,
    run after a successful in-app save — the row is already written, so any
    leftover draft is now stale). Throws on error so the caller can tell the user:
    the submission itself still counts, only the cleanup failed. */
export async function discardDrafts(month: string): Promise<void> {
  const { error } = await supabase.rpc('discard_salary_drafts', { p_month: month })
  if (error) throw error
}
