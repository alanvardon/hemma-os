/* salary-drafts-store.ts — read access to the pending per-slot salary halves
   submitted via the plan 132 email link (supabase/migrations/20261011100000_
   salary_reminders.sql). Deliberately cache-free: drafts are transient
   server state (the Edge Function writes them, the app only ever reads or
   discards them), so a failed read means "no prefill today", not "show a
   stale local copy". RLS (`hh_select` on salary_submission_drafts) already
   scopes every read to the caller's household — no household_id filter here.

   Rows are parsed defensively: a malformed row (bad slot, non-array items, a
   non-finite amount) is skipped rather than thrown, so one corrupt draft can
   never break the whole prefill or crash the modal. */

import { supabase } from './supabase'
import { reportPersistenceWarning } from './persistence-error'

export interface SalaryDraftItem { label: string; amount: number }

export interface SalaryDraft {
  slot: 'a' | 'b'
  income_items: SalaryDraftItem[]
  note: string | null
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
  if (row.slot !== 'a' && row.slot !== 'b') return null
  if (!Array.isArray(row.income_items)) return null
  const items: SalaryDraftItem[] = []
  for (const raw_item of row.income_items) {
    const parsed = parseItem(raw_item)
    if (parsed) items.push(parsed) // skip malformed items rather than reject the whole draft
  }
  const note = typeof row.note === 'string' ? row.note : null
  return { slot: row.slot, income_items: items, note }
}

/** The household's pending email halves for one month. A read failure (RLS,
    offline, down) is reported as a recoverable warning and resolves to an
    empty list — the modal simply falls back to its baseline prefill. */
export async function listDrafts(month: string): Promise<SalaryDraft[]> {
  const { data, error } = await supabase
    .from('salary_submission_drafts')
    .select('slot, income_items, note')
    .eq('month', month)
  if (error || !data) {
    reportPersistenceWarning('Couldn’t load salary entries submitted by email for this month — showing the usual prefill instead.')
    return []
  }
  const drafts: SalaryDraft[] = []
  for (const row of data) {
    const parsed = parseDraft(row)
    if (parsed) drafts.push(parsed) // skip a malformed row, keep the rest visible
  }
  return drafts
}

/** Discard this month's drafts and revoke its tokens (public.discard_salary_drafts,
    run after a successful in-app save — the row is already written, so any
    leftover draft is now stale). Throws on error so the caller can tell the user:
    the submission itself still counts, only the cleanup failed. */
export async function discardDrafts(month: string): Promise<void> {
  const { error } = await supabase.rpc('discard_salary_drafts', { p_month: month })
  if (error) throw error
}
