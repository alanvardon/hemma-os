/* salary-email-store.ts — plan 139 D8: the manual "Skicka resultatet igen"
   request and the per-month email status behind the Löner status line.

   Both wrap SECURITY DEFINER RPCs (20261025110000_salary_emails.sql); the
   household is resolved server-side, so nothing here names one. No cache: the
   status is a small read-only decoration of the month list. */

import { supabase } from './supabase'
import { reportPersistenceWarning } from './persistence-error'

export type ResultsEmailRequest = 'queued' | 'already_queued'

export interface ResultsEmailStatus {
  submission_id: string
  /** ISO timestamp of the last sent results email, or null if none was sent yet. */
  last_sent_at: string | null
  /** An unsent results email is waiting in the queue. */
  queued: boolean
}

/** Ask for a fresh results email for one complete month. Throws on any error
    or an unexpected answer, so the caller can show the failure and keep the
    button usable. */
export async function requestResultsEmail(submissionId: string): Promise<ResultsEmailRequest> {
  const { data, error } = await supabase.rpc('request_salary_results_email', { p_submission_id: submissionId })
  if (error) throw error
  if (data === 'queued' || data === 'already_queued') return data
  throw new Error('Unexpected response from request_salary_results_email')
}

/** One entry per submission that has ever had a results email, keyed by
    submission id. A failed read warns and returns an empty map (the month then
    reads as never emailed; resend still works). */
export async function listResultsEmailStatus(): Promise<Map<string, ResultsEmailStatus>> {
  const result = new Map<string, ResultsEmailStatus>()
  const { data, error } = await supabase.rpc('salary_results_email_status')
  if (error || !Array.isArray(data)) {
    reportPersistenceWarning('Kunde inte läsa mejlstatus för månaderna.')
    return result
  }
  for (const row of data as Record<string, unknown>[]) {
    if (!row || typeof row.submission_id !== 'string') continue
    result.set(row.submission_id, {
      submission_id: row.submission_id,
      last_sent_at: typeof row.last_sent_at === 'string' ? row.last_sent_at : null,
      queued: row.queued === true,
    })
  }
  return result
}
