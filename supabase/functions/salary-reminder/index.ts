// salary-reminder — plan 132. PUBLIC, UNAUTHENTICATED endpoint
// (verify_jwt = false in supabase/config.toml) behind the emailed
// `<APP_ORIGIN>/#/lon/<token>` page. The bearer link token is the only
// credential: 32 random bytes (256 bits), single household + slot + month,
// only its sha256 stored, valid until end of month+1 (D8) or finalisation.
//
//   POST {action:'context', token}
//     → {status:'already_logged', month}
//     | {month, slot, displayName, status:'open'|'submitted', items, note, expiresAt}
//   POST {action:'submit', token, items, note}
//     → {status:'submitted'|'finalized'|'already_logged'|'zero_total'}
//     | 422 {error:'invalid', field, message}
//
// Responses carry NOTHING about the other slot (D5): no name, items or status.
//
// Response-code ordering is chosen so an unauthenticated caller can learn
// nothing about token validity: method (405), size (413), JSON shape and
// action (400) are all decided BEFORE the token is looked at and never depend
// on it. Every token failure — bad format, unknown, revoked, expired, slot
// reassigned, recipient no longer a member — returns the byte-identical
// 404 {"error":"invalid_link"}. Only a valid token holder ever sees 200/422/500.
// (A malformed token skips the DB round trip, so timing can reveal "not even
// the right shape" — which is public knowledge, not a secret.)
//
// Logging: token row id + household id + slot only; never the token, a hash,
// an address, items, amounts or notes. DB errors return a generic 500.
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  adminKey,
  isTokenFormat,
  personDisplayName,
  splitPrefill,
  submitStatusFor,
  toHex,
  validateHalf,
  type SalaryHalfItem,
} from '../_shared/salary-reminder-logic.ts'

const MAX_BODY_BYTES = 32 * 1024

type Slot = 'a' | 'b'
interface TokenRow {
  id: string
  household_id: string
  slot: Slot
  month: string
  recipient_email: string
  expires_at: string
  revoked_at: string | null
}

class HttpError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(String(body.error))
  }
}
const INVALID_LINK = () => new HttpError(404, { error: 'invalid_link' })
const SERVER_ERROR = () => new HttpError(500, { error: 'server_error' })

function corsHeaders(appOrigin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': appOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
  }
}

function respond(appOrigin: string, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(appOrigin), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

// Read the body with a hard byte cap (Content-Length may be absent or lie).
async function readCappedBody(req: Request): Promise<string> {
  const declared = Number(req.headers.get('Content-Length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpError(413, { error: 'too_large' })
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {})
      throw new HttpError(413, { error: 'too_large' })
    }
    chunks.push(value)
  }
  const buf = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { buf.set(c, offset); offset += c.byteLength }
  return new TextDecoder().decode(buf)
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return toHex(new Uint8Array(digest))
}

function dbFail(where: string, message: string, token?: TokenRow): never {
  const ctx = token ? ` token ${token.id} household ${token.household_id} slot ${token.slot}` : ''
  console.error(`salary-reminder: ${where} failed${ctx}: ${message}`)
  throw SERVER_ERROR()
}

interface Recipient { userId: string; email: string }

// Every check that decides whether a token is usable. Any miss → INVALID_LINK.
async function resolveToken(supabase: SupabaseClient, token: unknown): Promise<{ row: TokenRow; recipient: Recipient }> {
  if (!isTokenFormat(token)) throw INVALID_LINK()
  const hash = await sha256Hex(token)
  const { data: row, error } = await supabase
    .from('salary_reminder_tokens')
    .select('id, household_id, slot, month, recipient_email, expires_at, revoked_at')
    .eq('token_hash', hash)
    .maybeSingle<TokenRow>()
  if (error) dbFail('token lookup', error.message)
  if (!row || row.revoked_at !== null || !(Date.parse(row.expires_at) > Date.now())) throw INVALID_LINK()

  // The link is bound to the person it was sent to. If the slot has since
  // been reassigned, or that person is no longer a household member, the link
  // is dead (the migration doesn't revoke tokens on reassignment, so this is
  // checked live).
  const recipientEmail = row.recipient_email.toLowerCase()
  const [{ data: person, error: personError }, { data: members, error: membersError }] = await Promise.all([
    supabase.from('household_people').select('assigned_email')
      .eq('household_id', row.household_id).eq('slot', row.slot).maybeSingle(),
    supabase.from('household_members').select('user_id').eq('household_id', row.household_id),
  ])
  if (personError) dbFail('household_people lookup', personError.message, row)
  if (membersError) dbFail('household_members lookup', membersError.message, row)
  if (!person || (person.assigned_email ?? '').toLowerCase() !== recipientEmail) throw INVALID_LINK()

  for (const m of members ?? []) {
    const { data, error: userError } = await supabase.auth.admin.getUserById(m.user_id)
    if (userError) dbFail('member lookup', userError.message, row)
    if (data.user?.email && data.user.email.toLowerCase() === recipientEmail) {
      return { row, recipient: { userId: data.user.id, email: recipientEmail } }
    }
  }
  throw INVALID_LINK()
}

async function isMonthLogged(supabase: SupabaseClient, row: TokenRow): Promise<boolean> {
  const { data, error } = await supabase.from('salary_submissions').select('id')
    .eq('household_id', row.household_id).eq('month', row.month).limit(1)
  if (error) dbFail('salary_submissions lookup', error.message, row)
  return (data ?? []).length > 0
}

// Stored draft items are normalised by validateHalf, but project to exactly
// {label, amount} anyway so nothing else stored can leak into the response.
function draftItems(raw: unknown): SalaryHalfItem[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((i) => i && typeof i === 'object' && typeof i.label === 'string' && typeof i.amount === 'number')
    .map((i) => ({ label: i.label as string, amount: i.amount as number }))
}

async function handleContext(supabase: SupabaseClient, row: TokenRow, recipient: Recipient) {
  if (await isMonthLogged(supabase, row)) return { status: 'already_logged', month: row.month }

  const [{ data: draft, error: draftError }, { data: profile, error: profileError }] = await Promise.all([
    supabase.from('salary_submission_drafts').select('income_items, note')
      .eq('household_id', row.household_id).eq('month', row.month).eq('slot', row.slot).maybeSingle(),
    supabase.from('profiles').select('display_name').eq('user_id', recipient.userId).maybeSingle(),
  ])
  if (draftError) dbFail('draft lookup', draftError.message, row)
  if (profileError) dbFail('profile lookup', profileError.message, row)

  let items: SalaryHalfItem[]
  let note: string | null = null
  let status: 'open' | 'submitted'
  if (draft) {
    status = 'submitted'
    items = draftItems(draft.income_items)
    note = typeof draft.note === 'string' ? draft.note : null
  } else {
    status = 'open'
    const { data: state, error: stateError } = await supabase.from('tool_state').select('data')
      .eq('household_id', row.household_id).eq('tool', 'hushallsbudget').maybeSingle()
    if (stateError) dbFail('budget lookup', stateError.message, row)
    const incomes = state?.data && typeof state.data === 'object' ? (state.data as Record<string, unknown>).incomes : undefined
    items = splitPrefill(incomes, row.slot)
  }

  return {
    month: row.month,
    slot: row.slot,
    displayName: personDisplayName(profile?.display_name, recipient.email, row.slot),
    status,
    items,
    note,
    expiresAt: new Date(row.expires_at).toISOString(),
  }
}

async function handleSubmit(supabase: SupabaseClient, row: TokenRow, body: Record<string, unknown>) {
  const result = validateHalf({ items: body.items, note: body.note })
  if (!result.ok) throw new HttpError(422, { error: 'invalid', field: result.field, message: result.error })

  if (await isMonthLogged(supabase, row)) {
    // No draft is written. finalize's already_logged branch clears any
    // leftovers and revokes the month's tokens; a failure there is harmless.
    const { error } = await supabase.rpc('finalize_salary_month', { p_household: row.household_id, p_month: row.month })
    if (error) console.error(`salary-reminder: cleanup failed token ${row.id} household ${row.household_id} slot ${row.slot}: ${error.message}`)
    return { status: 'already_logged' }
  }

  const { error: upsertError } = await supabase.from('salary_submission_drafts').upsert(
    {
      household_id: row.household_id,
      month: row.month,
      slot: row.slot,
      income_items: result.items,
      note: result.note,
      submitted_via: 'email',
    },
    { onConflict: 'household_id,month,slot' },
  )
  if (upsertError) dbFail('draft upsert', upsertError.message, row)

  const { data: outcome, error: rpcError } = await supabase.rpc('finalize_salary_month', {
    p_household: row.household_id,
    p_month: row.month,
  })
  if (rpcError) dbFail('finalize', rpcError.message, row)
  const status = submitStatusFor(outcome)
  if (!status) dbFail('finalize', `unexpected outcome ${JSON.stringify(outcome)}`, row)
  console.log(`salary-reminder: submit token ${row.id} household ${row.household_id} slot ${row.slot} → ${status}`)
  return { status }
}

Deno.serve(async (req: Request) => {
  const appOriginRaw = Deno.env.get('APP_ORIGIN')
  if (!appOriginRaw) {
    console.error('salary-reminder: APP_ORIGIN is not set')
    return new Response(JSON.stringify({ error: 'server_error' }), {
      status: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  }
  const appOrigin = appOriginRaw.replace(/\/$/, '')

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(appOrigin) })

  try {
    if (req.method !== 'POST') throw new HttpError(405, { error: 'method_not_allowed' })

    const raw = await readCappedBody(req)
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      throw new HttpError(400, { error: 'bad_request' })
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, { error: 'bad_request' })
    const payload = body as Record<string, unknown>
    if (payload.action !== 'context' && payload.action !== 'submit') throw new HttpError(400, { error: 'bad_request' })

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceKey = adminKey({
      SUPABASE_SECRET_KEYS: Deno.env.get('SUPABASE_SECRET_KEYS'),
      SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    })
    if (!supabaseUrl || !serviceKey) {
      console.error('salary-reminder: SUPABASE_URL / SUPABASE_SECRET_KEYS are not set')
      throw SERVER_ERROR()
    }
    const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

    const { row, recipient } = await resolveToken(supabase, payload.token)
    const result = payload.action === 'context'
      ? await handleContext(supabase, row, recipient)
      : await handleSubmit(supabase, row, payload)
    return respond(appOrigin, 200, result)
  } catch (err) {
    if (err instanceof HttpError) return respond(appOrigin, err.status, err.body)
    console.error(`salary-reminder: unexpected error: ${err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : 'unknown'}`)
    return respond(appOrigin, 500, { error: 'server_error' })
  }
})
