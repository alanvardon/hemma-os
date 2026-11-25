// policy-rate-notify/logic.ts — pure helpers for the plan-72 rate-change email
// cron. Kept dependency-free (no Deno/network/Supabase imports) so it can be
// unit tested directly (web/src/lib/policy-rate-notify-logic.test.ts).
//
// The function runs DAILY and emails when the policy rate VALUE differs from
// the last one emailed. There is deliberately no decision calendar: a
// hand-mirrored one went stale (it ended 2026-08-19 and silently skipped the
// 2026-11-03 decision), and SECBREPOEFF only changes on the EFFECTIVE date
// (about a week after the announcement), so a decision-day check could not
// see the new rate anyway. The email therefore arrives on the effective date.
// The SWEA observation shape mirrors supabase/functions/riksbank-proxy.

export interface RatePoint {
  date: string
  value: number
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Validate a SWEA `Observations/{series}/{from}/{to}` body: an array of
 * `{date: 'YYYY-MM-DD', value: number}`. Throws on any other shape (fail loud
 * rather than email a guessed rate).
 */
export function parseObservations(body: unknown): RatePoint[] {
  if (!Array.isArray(body)) {
    throw new Error(`riksbank SWEA observations: expected an array, got ${String(JSON.stringify(body)).slice(0, 200)}`)
  }
  return body.map((o, i) => {
    if (!o || typeof o.date !== 'string' || !DATE_RE.test(o.date) || typeof o.value !== 'number' || !Number.isFinite(o.value)) {
      throw new Error(`riksbank SWEA observations: unexpected item at ${i}: ${String(JSON.stringify(o)).slice(0, 200)}`)
    }
    return { date: o.date, value: o.value }
  })
}

/**
 * The rate in force at the end of a daily series, dated from the first
 * observation of its latest unchanged run (its effective date within the
 * window). If the whole window holds one value, that is the window's first
 * date. Throws on an empty series.
 */
export function currentRate(observations: RatePoint[]): RatePoint {
  if (observations.length === 0) throw new Error('riksbank SWEA observations: empty series')
  const sorted = [...observations].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const latest = sorted[sorted.length - 1]
  let since = latest.date
  for (let i = sorted.length - 1; i >= 0 && sorted[i].value === latest.value; i--) since = sorted[i].date
  return { date: since, value: latest.value }
}

/** Serialise a rate point (effective date + value) into notification_state.value. */
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

/**
 * Should we send a notification: has the rate VALUE changed since the last
 * one emailed? The date is ignored, so a daily series re-dating the same rate
 * never emails. No (or a malformed) stored point means notify.
 */
export function shouldNotify(storedValue: string | null | undefined, current: RatePoint): boolean {
  const stored = parsePoint(storedValue)
  if (!stored) return true
  return stored.value !== current.value
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
