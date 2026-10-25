// Pure logic for plan 132's monthly salary-submission emails: send-day and
// month arithmetic, token expiry, the modal's prefill split, payload
// validation and the reminder email body. Plan 139 adds the salary-email
// outbox decision and the partner / month-results email bodies.
//
// NO IMPORTS, on purpose: both the Deno Edge Functions
// (salary-reminder-send, salary-reminder, salary-email-send) and Vitest in web/ load this file
// directly by relative path (web/src/lib/salary-reminder-logic.test.ts).
// Every function is pure and deterministic — callers pass `now` in; nothing
// here reads the clock or the environment.
//
// The salary transfer is deliberately NOT computed here: it lives only in
// private.finalize_salary_month (SQL), so there is a single server-side source.
// The results email only DISPLAYS the stored row's figures.

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

/**
 * The exact log line salary-reminder-send writes for a minted link, or null
 * when it must not log it. The ONLY place the raw link may reach a log; it is
 * gated on isLocalDryRunLinkLoggingAllowed so a production token (a live
 * credential) can never be logged.
 */
export function localDryRunLinkLine(
  env: { EMAIL_DRY_RUN?: string; SUPABASE_URL?: string },
  slot: 'a' | 'b',
  link: string,
): string | null {
  return isLocalDryRunLinkLoggingAllowed(env) ? `[local dry-run] ${slot} link: ${link}` : null
}

// ── Tokens and names (Stage 3) ──────────────────────────────────────────────

/** A link token is 32 random bytes as unpadded base64url: exactly 43 chars. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

export function isTokenFormat(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_RE.test(token)
}

/** Unpadded base64url of raw bytes (the token encoding). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Lower-case hex of raw bytes (matches Postgres encode(…, 'hex')). */
export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * A slot's display name, mirroring private.household_person_display_name /
 * private.resolve_person_name (plan 111): the assigned account's profile name,
 * else the assigned email, else "Person A"/"Person B".
 */
export function personDisplayName(
  profileName: string | null | undefined,
  assignedEmail: string | null | undefined,
  slot: 'a' | 'b',
): string {
  if (assignedEmail) return profileName || assignedEmail
  return `Person ${slot.toUpperCase()}`
}

export type FinalizeOutcome = 'finalized' | 'pending' | 'already_logged' | 'zero_total'
export type SubmitStatus = 'submitted' | 'finalized' | 'already_logged' | 'zero_total'

/** finalize_salary_month's result → the public submit status ('pending' → 'submitted'). Null on anything unexpected. */
export function submitStatusFor(outcome: unknown): SubmitStatus | null {
  switch (outcome) {
    case 'pending': return 'submitted'
    case 'finalized':
    case 'already_logged':
    case 'zero_total':
      return outcome
    default: return null
  }
}

// ── Server-to-server auth (salary-reminder-send) ──────────────────────────────

/** Constant-time string compare; the length difference is folded in, not short-circuited. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  let diff = ea.length ^ eb.length
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0)
  return diff === 0
}

export interface ServerKeyEnv {
  /** JSON dictionary of the project's secret keys (`sb_secret_…`), injected by Supabase. */
  SUPABASE_SECRET_KEYS?: string
  /** Legacy service_role JWT, injected by Supabase (deprecated path). */
  SUPABASE_SERVICE_ROLE_KEY?: string
}

/** The project's secret keys, `default` first. Malformed or missing JSON → []. */
function secretKeys(env: ServerKeyEnv): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(env.SUPABASE_SECRET_KEYS ?? '')
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const dict = parsed as Record<string, unknown>
  const names = Object.keys(dict).sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : 0))
  return names.map((n) => dict[n]).filter((v): v is string => typeof v === 'string' && v !== '')
}

/**
 * Whether a request carries a key that may run privileged server jobs: any of
 * the project's secret keys, or the legacy service_role key, presented in the
 * `apikey` header (Supabase's documented pattern for cron/pg_net calls) or as
 * `Authorization: Bearer`. Anon/publishable keys never match. Fails closed on a
 * missing or malformed env. With verify_jwt = false this is the ONLY gate.
 */
export function isTrustedServerCaller(
  headers: { apikey: string | null; authorization: string | null },
  env: ServerKeyEnv,
): boolean {
  const allowed = [...secretKeys(env), ...(env.SUPABASE_SERVICE_ROLE_KEY ? [env.SUPABASE_SERVICE_ROLE_KEY] : [])]
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? '')?.[1]?.trim()
  const presented = [headers.apikey?.trim(), bearer].filter((v): v is string => !!v)
  let ok = false
  // Compare every pair (no early exit) so timing doesn't reveal which matched.
  for (const p of presented) for (const k of allowed) if (safeEqual(p, k)) ok = true
  return ok
}

/** The key Edge Functions use for their RLS-bypassing client: the `default` secret key, else any secret key, else the legacy service_role key. */
export function adminKey(env: ServerKeyEnv): string | null {
  return secretKeys(env)[0] ?? (env.SUPABASE_SERVICE_ROLE_KEY || null)
}

// ── Salary emails (plan 139 D7/D8, salary-email-send) ───────────────────────
//
// One outbox (public.salary_emails) carries two kinds:
//   'partner_submitted' — one person's half was FIRST submitted (app or email
//     link); tell the other person, no amounts (D7).
//   'month_results'     — the month is complete; tell both people the totals,
//     "each takes home" and who pays whom (D8; amounts in email are
//     owner-approved). No itemised lines, no notes.
// salaryEmailDecision decides send/skip from data the caller loads at SEND
// time, so a resend always carries the row as it is now.

export type SalarySlot = 'a' | 'b'

export interface SalaryEmailRow {
  kind: 'partner_submitted' | 'month_results'
  trigger: 'auto' | 'manual'
  /** The slot whose half was submitted (partner_submitted only). */
  submitter_slot: SalarySlot | null
  /** The salary_submissions.id the results email reports (month_results only). */
  submission_id: string | null
  /** auth.uid() at enqueue time; null on the email-link (service role) path. */
  actor_user_id: string | null
}

/** salary_reminder_settings toggles; a missing row or field means ON (D7/D8 defaults). */
export interface SalaryEmailSettings { notify_partner?: boolean | null; email_results?: boolean | null }

/** Figures of a salary_submissions row, as read at send time (raw: validated here). */
export interface SalaryResultsFigures {
  person_a_name?: string | null
  person_b_name?: string | null
  income_a: unknown
  income_b: unknown
  transfer_from: unknown
  transfer_to: unknown
  transfer_amount: unknown
  equal_share: unknown
}

export interface CompleteResultsFigures extends SalaryResultsFigures {
  income_a: number; income_b: number; transfer_amount: number; equal_share: number
  transfer_from: SalarySlot; transfer_to: SalarySlot
}

export interface SalaryEmailRecipient { slot: SalarySlot; email: string; userId: string }

export type SalaryEmailSkipReason =
  | 'malformed'
  | 'opted_out'
  | 'month_complete'
  | 'partner_already_submitted'
  | 'submission_deleted'
  | 'submission_malformed'
  | 'no_recipient'

export type SalaryEmailDecision =
  | { action: 'send'; recipients: SalaryEmailRecipient[] }
  | { action: 'skip'; reason: SalaryEmailSkipReason }

const otherSlot = (slot: SalarySlot): SalarySlot => (slot === 'a' ? 'b' : 'a')
const isSlot = (v: unknown): v is SalarySlot => v === 'a' || v === 'b'
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Whether a stored row carries every figure the results email shows. Never guessed or defaulted. */
export function isCompleteResultsFigures(s: SalaryResultsFigures | null | undefined): s is CompleteResultsFigures {
  return !!s && isFiniteNumber(s.income_a) && isFiniteNumber(s.income_b)
    && isFiniteNumber(s.transfer_amount) && isFiniteNumber(s.equal_share)
    && isSlot(s.transfer_from) && isSlot(s.transfer_to) && s.transfer_from !== s.transfer_to
}

/**
 * Send or skip one claimed salary_emails row (plan 139 D7/D8). Pure: the
 * caller loads everything at send time.
 *   - `members`: the household's CURRENT members with their account emails
 *     (pending invites are not members, so they never receive anything).
 *   - `people`: household_people slot → assigned_email.
 *   - `submission`: for 'partner_submitted', ANY salary_submissions row of the
 *     row's month (or null); for 'month_results', the row with id =
 *     submission_id in the household (or null when it was deleted).
 *   - `draftSlots`: the slots that currently have a pending draft for the month.
 *
 * partner_submitted: skip when notify_partner is off; when the month now has a
 * salary_submissions row (the results email covers it, so nobody gets two);
 * when the recipient has meanwhile submitted their own half (e.g. both halves
 * are in but sum to 0 — "yours is still missing" would be false); and when
 * the other slot is not a current member or IS the person who acted (the D3
 * case: A submitting unassigned B's half emails nobody). Otherwise send to the
 * other slot only.
 *
 * month_results: skip when the row was deleted or lacks a figure; for an
 * 'auto' row when email_results is off (a 'manual' resend is an explicit
 * request and always sends). Otherwise send ONE email to both slots that are
 * current members (deduplicated), dropping a non-member slot; skip if none.
 */
export function salaryEmailDecision(input: {
  row: SalaryEmailRow
  settings: SalaryEmailSettings | null
  members: ReadonlyArray<{ user_id: string; email: string | null }>
  people: ReadonlyArray<{ slot: string; assigned_email: string | null }>
  submission: SalaryResultsFigures | null
  draftSlots: ReadonlyArray<string>
}): SalaryEmailDecision {
  const { row, settings, members, people, submission, draftSlots } = input
  const memberByEmail = new Map<string, string>()
  for (const m of members) if (m.email) memberByEmail.set(m.email.trim().toLowerCase(), m.user_id)
  const recipientFor = (slot: SalarySlot): SalaryEmailRecipient | null => {
    const email = people.find((p) => p.slot === slot)?.assigned_email?.trim().toLowerCase()
    if (!email) return null
    const userId = memberByEmail.get(email)
    return userId ? { slot, email, userId } : null
  }

  if (row.kind === 'partner_submitted') {
    if (!isSlot(row.submitter_slot)) return { action: 'skip', reason: 'malformed' }
    if (settings?.notify_partner === false) return { action: 'skip', reason: 'opted_out' }
    if (submission) return { action: 'skip', reason: 'month_complete' }
    const to = otherSlot(row.submitter_slot)
    if (draftSlots.includes(to)) return { action: 'skip', reason: 'partner_already_submitted' }
    const recipient = recipientFor(to)
    if (!recipient || (row.actor_user_id !== null && recipient.userId === row.actor_user_id)) {
      return { action: 'skip', reason: 'no_recipient' }
    }
    return { action: 'send', recipients: [recipient] }
  }

  if (row.kind === 'month_results') {
    if (!row.submission_id || (row.trigger !== 'auto' && row.trigger !== 'manual')) {
      return { action: 'skip', reason: 'malformed' }
    }
    if (!submission) return { action: 'skip', reason: 'submission_deleted' }
    if (!isCompleteResultsFigures(submission)) return { action: 'skip', reason: 'submission_malformed' }
    if (row.trigger === 'auto' && settings?.email_results === false) return { action: 'skip', reason: 'opted_out' }
    const recipients: SalaryEmailRecipient[] = []
    for (const slot of ['a', 'b'] as const) {
      const r = recipientFor(slot)
      if (r && !recipients.some((x) => x.email === r.email)) recipients.push(r)
    }
    return recipients.length ? { action: 'send', recipients } : { action: 'skip', reason: 'no_recipient' }
  }

  return { action: 'skip', reason: 'malformed' }
}

/**
 * Whole-krona Swedish money, the same expression as the app's `fmt`
 * (web/src/lib/format.ts): Math.round, sv-SE grouping (a NO-BREAK SPACE,
 * U+00A0, between thousands), then " kr". Display only — the stored row keeps
 * full precision.
 */
export function formatKronor(n: number): string {
  return Math.round(n).toLocaleString('sv-SE') + ' kr'
}

/** A Stockholm calendar date as `3 October 2026`. */
export function stockholmDateEn(instant: Date): string {
  const w = stockholmWallClock(instant)
  return `${w.day} ${MONTH_NAMES[w.month - 1]} ${w.year}`
}

const BUTTON_STYLE = 'display:inline-block;padding:10px 18px;border-radius:8px;background:#2f5e45;color:#ffffff;text-decoration:none;font-weight:600'

/**
 * D7: "your partner has submitted". English, like the reminder. Names, the
 * month and a login-required link to Löner ONLY — there is no amount
 * parameter, and the tests assert no amount appears for any input. Always
 * "their": the app doesn't know anyone's pronouns.
 */
export function buildPartnerSubmittedEmail({ recipientName, submitterName, month, link }: {
  recipientName: string; submitterName: string; month: string; link: string
}): ReminderEmail {
  const monthText = monthLabelEn(month)
  const subject = `${submitterName} has submitted their salary for ${monthText}`
  const greeting = `Hi ${recipientName},`
  const body = `${submitterName} has logged their salary for ${monthText} in Hemma OS. Yours is still missing — add it in Löner, or use the link from your monthly reminder.`

  const text = `${greeting}\n\n${body}\n\nOpen Löner: ${link}\n`
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(body)}</p>`,
    `<p><a href="${escapeHtml(link)}" style="${BUTTON_STYLE}">Open Löner</a></p>`,
  ].join('')
  return { subject, html, text }
}

/**
 * "Anna pays Bo 4 250 kr", or "Nothing to transfer" below half a krona — the
 * same < 0.5 rule as the app's transferSentence (web/src/routes/loner-labels.ts),
 * so the email never says "pays 0 kr".
 */
export function resultsTransferLine(s: { transfer_from: SalarySlot; transfer_amount: number }, nameA: string, nameB: string): string {
  if (s.transfer_amount < 0.5) return 'Nothing to transfer'
  const from = s.transfer_from === 'b' ? nameB : nameA
  const to = s.transfer_from === 'b' ? nameA : nameB
  return `${from} pays ${to} ${formatKronor(s.transfer_amount)}`
}

/**
 * D8: the month's results, to both people. Each total, "Each takes home" and
 * the transfer line, read from the stored row and rounded only here, for
 * display. NO itemised income lines and NO notes (asserted). When
 * `previousSentAt` is set (a results email for this row went out before) the
 * subject starts "Updated:" and a line says these figures replace that one.
 * Throws on a row missing a figure (salaryEmailDecision skips those first).
 */
export function buildMonthResultsEmail({ month, nameA, nameB, submission, previousSentAt, link }: {
  month: string; nameA: string; nameB: string; submission: SalaryResultsFigures
  previousSentAt: Date | null; link: string
}): ReminderEmail {
  if (!isCompleteResultsFigures(submission)) throw new Error('buildMonthResultsEmail: incomplete figures')
  const monthText = monthLabelEn(month)
  const previous = previousSentAt && !Number.isNaN(previousSentAt.getTime()) ? previousSentAt : null
  const subject = previous ? `Updated: salary results for ${monthText}` : `Salary results for ${monthText}`
  const intro = `Both salaries for ${monthText} are in. Here is how the month adds up in Hemma OS.`
  const replaces = previous ? `These figures replace the ones we sent on ${stockholmDateEn(previous)}.` : null
  const rows: Array<[string, string]> = [
    [nameA, formatKronor(submission.income_a)],
    [nameB, formatKronor(submission.income_b)],
    ['Each takes home', formatKronor(submission.equal_share)],
  ]
  const transfer = resultsTransferLine(submission, nameA, nameB)

  const text = [
    intro,
    ...(replaces ? [replaces] : []),
    rows.map(([k, v]) => `${k}: ${v}`).join('\n') + `\n${transfer}`,
    `Open Löner: ${link}`,
  ].join('\n\n') + '\n'

  const cell = 'padding:4px 16px 4px 0'
  const html = [
    `<p>${escapeHtml(intro)}</p>`,
    ...(replaces ? [`<p><strong>${escapeHtml(replaces)}</strong></p>`] : []),
    '<table role="presentation" style="border-collapse:collapse;margin:8px 0 12px">',
    ...rows.map(([k, v]) =>
      `<tr><td style="${cell}">${escapeHtml(k)}</td><td style="${cell};text-align:right;font-weight:600">${escapeHtml(v)}</td></tr>`),
    `<tr><td colspan="2" style="${cell};font-weight:600">${escapeHtml(transfer)}</td></tr>`,
    '</table>',
    `<p><a href="${escapeHtml(link)}" style="${BUTTON_STYLE}">Open Löner</a></p>`,
  ].join('')
  return { subject, html, text }
}
