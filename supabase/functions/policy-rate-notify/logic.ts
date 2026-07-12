// policy-rate-notify/logic.ts — pure helpers for the plan-72 rate-change email
// cron. Kept dependency-free (no Deno/network/Supabase imports) so it can be
// unit tested directly. Two things are mirrored by hand from other modules
// because the Deno edge-function runtime can't import from web/src:
//   - RIKSBANK_DECISIONS_2026 mirrors web/src/lib/riksbank.ts — keep in sync
//     (plan 88 will automate the decision calendar later).
//   - The SWEA "Latest" shape mirrors supabase/functions/riksbank-proxy.

export interface RatePoint {
  date: string
  value: number
}

// Announcement (publication) dates — the 09:30 day the decision is published.
// MIRROR of web/src/lib/riksbank.ts RIKSBANK_DECISIONS_2026 — update both by
// hand whenever the calendar changes.
export const RIKSBANK_DECISIONS_2026: string[] = [
  '2026-01-29',
  '2026-03-19',
  '2026-05-07',
  '2026-06-17',
  '2026-08-19',
]

/** Is `today` (YYYY-MM-DD, Europe/Stockholm) a Riksbank decision day? */
export function isDecisionDate(today: string, calendar: string[] = RIKSBANK_DECISIONS_2026): boolean {
  return (calendar || []).includes(today)
}

/**
 * Serialise a rate point into the string stored in notification_state.value
 * so equality comparison is exact (date AND value, not just value) — a rate
 * held at the same number but re-published under a new effective date should
 * not be treated as "already notified".
 */
export function serializePoint(point: RatePoint): string {
  return JSON.stringify({ date: point.date, value: point.value })
}

export function parsePoint(stored: string | null | undefined): RatePoint | null {
  if (!stored) return null
  try {
    const parsed = JSON.parse(stored)
    if (parsed && typeof parsed.date === 'string' && typeof parsed.value === 'number') return parsed
    return null
  } catch {
    return null
  }
}

/** Should we send a notification: is `current` different from what's stored? */
export function shouldNotify(storedValue: string | null | undefined, current: RatePoint): boolean {
  const stored = parsePoint(storedValue)
  if (!stored) return true
  return stored.date !== current.date || stored.value !== current.value
}

export interface NotificationEmail {
  subject: string
  text: string
  html: string
}

const fmtRate = (v: number) => v.toFixed(2).replace('.', ',')

const fmtDateSv = (iso: string) => {
  const d = new Date(iso + 'T00:00:00')
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('sv-SE', { year: 'numeric', month: 'long', day: 'numeric' })
}

/**
 * Build the Swedish subject/body for a policy-rate-change email. `previous`
 * is the last rate we notified about (null if this household has never been
 * notified before — first-run case, no "från X" framing).
 */
export function buildNotificationEmail(previous: RatePoint | null, current: RatePoint, appUrl: string): NotificationEmail {
  const newPct = fmtRate(current.value)
  const subject = `Riksbanken ändrade styrräntan till ${newPct} %`

  const changeLine = previous
    ? `Styrräntan ändrades från ${fmtRate(previous.value)} % till ${newPct} %, gällande från ${fmtDateSv(current.date)}.`
    : `Styrräntan är nu ${newPct} %, gällande från ${fmtDateSv(current.date)}.`

  const text = `${changeLine}\n\nSe hur det påverkar ert lån i Bolånekoll: ${appUrl}`
  const html = `<p>${changeLine}</p><p><a href="${appUrl}">Se hur det påverkar ert lån i Bolånekoll</a></p>`

  return { subject, text, html }
}
