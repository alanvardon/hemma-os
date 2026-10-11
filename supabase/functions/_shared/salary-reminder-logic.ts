// Pure logic for plan 132's monthly salary-submission emails: send-day and
// month arithmetic, token expiry, the modal's prefill split, payload
// validation and the reminder email body.
//
// NO IMPORTS, on purpose: both the Deno Edge Functions
// (salary-reminder-send, salary-reminder) and Vitest in web/ load this file
// directly by relative path (web/src/lib/salary-reminder-logic.test.ts).
// Every function is pure and deterministic — callers pass `now` in; nothing
// here reads the clock or the environment.
//
// The salary transfer is deliberately NOT computed here: it lives only in
// private.finalize_salary_month (SQL), so there is a single server-side source.

const STOCKHOLM = 'Europe/Stockholm'

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

const DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/

/** Default when a household has no salary_reminder_settings row (plan 132 D10). */
export const DEFAULT_SEND_DAY = 25

// ── Time zone helpers ───────────────────────────────────────────────────────

interface WallClock { year: number; month: number; day: number; hour: number; minute: number; second: number }

// Wall-clock fields of `instant` in Europe/Stockholm. formatToParts with
// numeric fields is locale-independent in both V8 (Node) and Deno.
function stockholmWallClock(instant: Date): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: STOCKHOLM,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute'), second: get('second') }
}

// Stockholm's UTC offset (ms) at `instant`: +1 h (CET) or +2 h (CEST).
function stockholmOffsetMs(instant: Date): number {
  const w = stockholmWallClock(instant)
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  const truncated = instant.getTime() - (instant.getTime() % 1000 + 1000) % 1000
  return asUtc - truncated
}

// The UTC instant at which Stockholm's wall clock reads 00:00 on the given
// date. Only used for the 1st of a month, which is never inside a DST
// transition (those happen on the last Sunday of March/October at 01:00 UTC),
// so the wall-clock time always exists and is unambiguous.
function stockholmMidnight(year: number, month: number, day: number): Date {
  const naive = Date.UTC(year, month - 1, day)
  // Two passes converge: the first guess may sit on the other side of a DST
  // change relative to the target, the second uses the offset at the target.
  let guess = naive - stockholmOffsetMs(new Date(naive))
  guess = naive - stockholmOffsetMs(new Date(guess))
  return new Date(guess)
}

const pad2 = (n: number) => String(n).padStart(2, '0')

// ── Dates and send day ─────────────────────────────────────────────────────

/** Today's calendar date in Europe/Stockholm as `YYYY-MM-DD`. */
export function stockholmToday(now: Date): string {
  const w = stockholmWallClock(now)
  return `${w.year}-${pad2(w.month)}-${pad2(w.day)}`
}

/**
 * Whether `today` (a Stockholm `YYYY-MM-DD`) is this household's send day.
 * `null` settings (no row) means enabled on day 25 (D10). A disabled row
 * never sends. A malformed `today` never sends.
 */
export function isSendDay(today: string, settings: { enabled: boolean; send_day: number } | null): boolean {
  const m = DATE_RE.exec(today)
  if (!m) return false
  const effective = settings ?? { enabled: true, send_day: DEFAULT_SEND_DAY }
  if (!effective.enabled) return false
  return Number(m[3]) === effective.send_day
}

/** The `YYYY-MM` month a reminder sent on `today` (`YYYY-MM-DD`) is for. Throws on malformed input. */
export function monthFor(today: string): string {
  if (!DATE_RE.test(today)) throw new Error(`monthFor: expected YYYY-MM-DD, got ${JSON.stringify(today)}`)
  return today.slice(0, 7)
}

/**
 * When a token for `month` (`YYYY-MM`) stops being valid (D8: "until the end
 * of the following month", Europe/Stockholm).
 *
 * EXCLUSIVE bound: returns 00:00 Stockholm time on the 1st of month+2. The
 * token is valid while `expires_at > now()`, so the whole last day of month+1
 * (up to 23:59:59.999 Stockholm) is still valid and the first instant of
 * month+2 is not. Example: month 2026-10 → 2026-12-01T00:00 CET =
 * 2026-11-30T23:00:00Z. Handles CET/CEST and year rollover. Throws on a
 * malformed month.
 */
export function tokenExpiry(month: string): Date {
  const m = MONTH_RE.exec(month)
  if (!m) throw new Error(`tokenExpiry: expected YYYY-MM, got ${JSON.stringify(month)}`)
  const zeroBased = Number(m[2]) - 1 + 2
  const year = Number(m[1]) + Math.floor(zeroBased / 12)
  return stockholmMidnight(year, (zeroBased % 12) + 1, 1)
}

// ── Prefill ─────────────────────────────────────────────────────────────────

export interface SalaryHalfItem { label: string; amount: number }

export const PREFILL_FALLBACK: SalaryHalfItem = { label: 'Lön / Salary', amount: 0 }

/**
 * Split the Hushållsbudget baseline incomes (`tool_state.hushallsbudget
 * .data.incomes`) into one slot's prefill rows, mirroring SalaryModal's
 * prefillItems (web/src/routes/Hushallsbudget.tsx) exactly:
 *   - slot 'b' gets rows with `owner === 'b'`;
 *   - slot 'a' gets every other row (`owner !== 'b'`), INCLUDING 'joint' and
 *     rows with a missing/unknown owner — the modal's deliberate quirk;
 *   - each row maps to `{label, amount}` as stored (no trimming, like the modal);
 *   - no rows for the slot → a single `{label: 'Lön / Salary', amount: 0}`.
 *
 * Defensive (raw jsonb, never throws): a non-array `incomes` is treated as
 * empty (→ fallback). Entries that are not plain objects, whose `label` is not
 * a string, or whose `amount` is not a finite number are skipped — the typed
 * client store would never produce them, and passing junk into a financial
 * form is worse than leaving the row out.
 */
export function splitPrefill(incomes: unknown, slot: 'a' | 'b'): SalaryHalfItem[] {
  const rows = Array.isArray(incomes) ? incomes : []
  const out: SalaryHalfItem[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const { owner, label, amount } = row as Record<string, unknown>
    if (typeof label !== 'string') continue
    if (typeof amount !== 'number' || !Number.isFinite(amount)) continue
    const isB = owner === 'b'
    if (slot === 'b' ? !isB : isB) continue
    out.push({ label, amount })
  }
  return out.length ? out : [{ ...PREFILL_FALLBACK }]
}

// ── Validation ──────────────────────────────────────────────────────────────

export const MAX_ITEMS = 20
export const MAX_LABEL_LENGTH = 80
export const MAX_ABS_AMOUNT = 10_000_000
export const MAX_NOTE_LENGTH = 200

export type ValidateHalfResult =
  | { ok: true; items: SalaryHalfItem[]; note: string | null }
  | { ok: false; field: string; error: string }

/**
 * Validate one person's submitted half (`{items, note}`) from the public
 * page. Reject, never clamp or coerce:
 *   - body must be an object; `items` must be an array of AT MOST 20 entries,
 *     counted on the RAW submitted array (before dropping empties), so the
 *     server's limit matches what the page let the user build;
 *   - each item must be an object with a string `label` (≤ 80 chars after
 *     trim) and a `number` `amount` that is finite with |amount| ≤ 10 000 000
 *     (negatives allowed, e.g. a tax back-payment; strings are rejected, no
 *     coercion);
 *   - `note` may be absent/null or a string ≤ 200 chars after trim; an empty
 *     trimmed note becomes null.
 * After validation labels are trimmed and items with an empty label AND a
 * zero amount are dropped (same rule as buildSubmission / the modal).
 * Field paths: 'body', 'items', 'items[i]', 'items[i].label',
 * 'items[i].amount', 'note'.
 */
export function validateHalf(input: unknown): ValidateHalfResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, field: 'body', error: 'Expected an object with items and note.' }
  }
  const { items, note } = input as Record<string, unknown>
  if (!Array.isArray(items)) return { ok: false, field: 'items', error: 'Items must be a list.' }
  if (items.length > MAX_ITEMS) return { ok: false, field: 'items', error: `At most ${MAX_ITEMS} income rows.` }

  const kept: SalaryHalfItem[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, field: `items[${i}]`, error: 'Each income row must be an object.' }
    }
    const { label, amount } = item as Record<string, unknown>
    if (typeof label !== 'string') return { ok: false, field: `items[${i}].label`, error: 'Income name must be text.' }
    const trimmed = label.trim()
    if (trimmed.length > MAX_LABEL_LENGTH) {
      return { ok: false, field: `items[${i}].label`, error: `Income name must be at most ${MAX_LABEL_LENGTH} characters.` }
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      return { ok: false, field: `items[${i}].amount`, error: 'Amount must be a number.' }
    }
    if (Math.abs(amount) > MAX_ABS_AMOUNT) {
      return { ok: false, field: `items[${i}].amount`, error: 'Amount must be at most 10 000 000 kr either way.' }
    }
    if (trimmed === '' && amount === 0) continue
    kept.push({ label: trimmed, amount })
  }

  let normalisedNote: string | null = null
  if (note !== undefined && note !== null) {
    if (typeof note !== 'string') return { ok: false, field: 'note', error: 'Note must be text.' }
    const t = note.trim()
    if (t.length > MAX_NOTE_LENGTH) return { ok: false, field: 'note', error: `Note must be at most ${MAX_NOTE_LENGTH} characters.` }
    normalisedNote = t === '' ? null : t
  }

  return { ok: true, items: kept, note: normalisedNote }
}

// ── Email ───────────────────────────────────────────────────────────────────

/** `YYYY-MM` → `October 2026`. Falls back to the raw string if malformed. */
export function monthLabelEn(month: string): string {
  const m = MONTH_RE.exec(month)
  if (!m) return month
  return `${MONTH_NAMES[Number(m[2]) - 1]} ${m[1]}`
}

/**
 * The last calendar day (Stockholm) on which a token with this exclusive
 * `expiresAt` still works, as `30 November 2026`.
 */
export function lastValidDayEn(expiresAt: Date): string {
  const w = stockholmWallClock(new Date(expiresAt.getTime() - 1))
  return `${w.day} ${MONTH_NAMES[w.month - 1]} ${w.year}`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export interface ReminderEmail { subject: string; html: string; text: string }

/**
 * The monthly reminder (English, matching the modal — D9). Contains the
 * recipient's display name, the month, one link and its expiry. It NEVER
 * contains amounts. `link` is a full `<APP_ORIGIN>/#/lon/<token>` URL built by
 * the caller; it is escaped for the href too.
 */
export function buildReminderEmail({ displayName, month, link, expiresAt }: {
  displayName: string; month: string; link: string; expiresAt: Date
}): ReminderEmail {
  const monthText = monthLabelEn(month)
  const lastDay = lastValidDayEn(expiresAt)
  const subject = `Submit your salary for ${monthText}`
  const greeting = `Hi ${displayName},`
  const intro = `It's time to log your salary for ${monthText} in Hemma OS. Enter your own income and you're done — your partner gets their own link.`
  const validity = `The link works without logging in and expires after ${lastDay}.`

  const text = `${greeting}\n\n${intro}\n\nSubmit your salary: ${link}\n\n${validity}\n`

  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(intro)}</p>`,
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#2f5e45;color:#ffffff;text-decoration:none;font-weight:600">Submit your salary</a></p>`,
    `<p style="color:#5b6660;font-size:14px">${escapeHtml(validity)}</p>`,
  ].join('')

  return { subject, html, text }
}

// ── Local dry-run guard (Stage 3) ───────────────────────────────────────────

/**
 * Whether salary-reminder-send may log the raw link (a live credential) for
 * local testing. True ONLY when EMAIL_DRY_RUN is exactly '1' AND SUPABASE_URL
 * parses and its host is not supabase.co or a subdomain of it. Missing or
 * unparseable URL → false (fail closed).
 */
export function isLocalDryRunLinkLoggingAllowed(env: { EMAIL_DRY_RUN?: string; SUPABASE_URL?: string }): boolean {
  if (env.EMAIL_DRY_RUN !== '1') return false
  if (!env.SUPABASE_URL) return false
  let host: string
  try {
    host = new URL(env.SUPABASE_URL).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return false
  }
  if (!host) return false
  return host !== 'supabase.co' && !host.endsWith('.supabase.co')
}
