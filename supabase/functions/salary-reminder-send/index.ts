// salary-reminder-send — plan 132. Scheduled daily (prod-only pg_cron, see
// README.md). On each household's send day (default the 25th, Stockholm date)
// it emails each member-assigned person (household_people slot a/b) their own
// single-purpose, no-login link to submit their half of the month's salaries.
//
// Not invoked from the browser — no CORS. verify_jwt is OFF for this function
// (Supabase's pattern for cron/pg_net callers using `sb_secret_…` keys), so the
// in-function isTrustedServerCaller check is the only gate: the request must
// carry one of the project's secret keys (apikey header or Bearer), or the
// legacy service_role key. Anon/publishable keys get 403.
//
// Per household × slot:
//   skip if the month already has a salary_submissions row (D11), the slot has
//   no assigned email or it isn't a CURRENT member's email (pending invites get
//   nothing — same member lookup as policy-rate-notify), a draft already exists
//   for the slot, or notification_state 'salary_reminder:<month>:<slot>' exists
//   (idempotent re-runs). Otherwise: mint 32 random bytes → base64url token,
//   insert ONLY its sha256 hex, send, then record notification_state. If the
//   send fails the token row is deleted so a re-run mints a fresh one.
//
// Logging: token id, household id and slot only. NEVER the token, the link,
// an address, the email body or any amount — except the local-only
// `[local dry-run] <slot> link: <url>` line, gated by localDryRunLinkLine.
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendEmail } from '../_shared/resend.ts'
import {
  adminKey,
  base64UrlEncode,
  buildReminderEmail,
  isSendDay,
  isTrustedServerCaller,
  localDryRunLinkLine,
  monthFor,
  personDisplayName,
  stockholmToday,
  toHex,
  tokenExpiry,
} from '../_shared/salary-reminder-logic.ts'

type Slot = 'a' | 'b'
const SLOTS: Slot[] = ['a', 'b']

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// Error text for logs without household data: Resend's error body can echo
// the recipient address, so only its status code survives.
function safeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const resend = /^Resend send failed: (\d+)/.exec(msg)
  if (resend) return `Resend send failed: ${resend[1]}`
  return msg
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return toHex(new Uint8Array(digest))
}

// Lower-cased email → user id for every auth user (Admin API; auth.users is
// not exposed over PostgREST — same approach as policy-rate-notify).
async function listUserIdsByEmail(supabase: SupabaseClient): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`failed to list users: ${error.message}`)
    for (const user of data.users) if (user.email) out.set(user.email.toLowerCase(), user.id)
    if (data.users.length < 200) break
  }
  return out
}

Deno.serve(async (req: Request) => {
  try {
    const keyEnv = {
      SUPABASE_SECRET_KEYS: Deno.env.get('SUPABASE_SECRET_KEYS'),
      SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    }
    if (!isTrustedServerCaller({ apikey: req.headers.get('apikey'), authorization: req.headers.get('Authorization') }, keyEnv)) {
      return json({ ok: false, error: 'forbidden' }, 403)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceKey = adminKey(keyEnv)
    if (!supabaseUrl || !serviceKey) throw new Error('SUPABASE_URL / SUPABASE_SECRET_KEYS are not set')

    // Link origin (plan 131 secret). Checked before anything else so a
    // misconfiguration fails loudly every day, not only on send days.
    const appOriginRaw = Deno.env.get('APP_ORIGIN')
    if (!appOriginRaw) throw new Error('APP_ORIGIN is not set')
    const appOrigin = appOriginRaw.replace(/\/$/, '')

    const now = new Date()
    const today = stockholmToday(now)
    const month = monthFor(today)
    const supabase = createClient(supabaseUrl, serviceKey)

    // Which households are due today. No settings row = enabled, day 25.
    const [{ data: households, error: hhError }, { data: settingsRows, error: settingsError }] = await Promise.all([
      supabase.from('households').select('id'),
      supabase.from('salary_reminder_settings').select('household_id, enabled, send_day'),
    ])
    if (hhError) throw new Error(`failed to load households: ${hhError.message}`)
    if (settingsError) throw new Error(`failed to load salary_reminder_settings: ${settingsError.message}`)
    const settingsByHousehold = new Map<string, { enabled: boolean; send_day: number }>()
    for (const row of settingsRows ?? []) settingsByHousehold.set(row.household_id, { enabled: row.enabled, send_day: row.send_day })
    const due = (households ?? [])
      .map((h) => h.id as string)
      .filter((id) => isSendDay(today, settingsByHousehold.get(id) ?? null))

    if (due.length === 0) {
      console.log(`salary-reminder-send: no household due on ${today} — no-op`)
      return json({ ok: true, sent: 0, failures: 0, reason: 'no household due today' })
    }

    const stateKeyPrefix = `salary_reminder:${month}:`
    const [
      { data: logged, error: loggedError },
      { data: people, error: peopleError },
      { data: drafts, error: draftsError },
      { data: states, error: statesError },
      { data: members, error: membersError },
    ] = await Promise.all([
      supabase.from('salary_submissions').select('household_id').eq('month', month).in('household_id', due),
      supabase.from('household_people').select('household_id, slot, assigned_email').in('household_id', due),
      supabase.from('salary_submission_drafts').select('household_id, slot').eq('month', month).in('household_id', due),
      supabase.from('notification_state').select('household_id, key').like('key', `${stateKeyPrefix}%`).in('household_id', due),
      supabase.from('household_members').select('household_id, user_id').in('household_id', due),
    ])
    if (loggedError) throw new Error(`failed to load salary_submissions: ${loggedError.message}`)
    if (peopleError) throw new Error(`failed to load household_people: ${peopleError.message}`)
    if (draftsError) throw new Error(`failed to load salary_submission_drafts: ${draftsError.message}`)
    if (statesError) throw new Error(`failed to load notification_state: ${statesError.message}`)
    if (membersError) throw new Error(`failed to load household_members: ${membersError.message}`)

    const loggedSet = new Set((logged ?? []).map((r) => r.household_id as string))
    const draftSet = new Set((drafts ?? []).map((r) => `${r.household_id}:${r.slot}`))
    const stateSet = new Set((states ?? []).map((r) => `${r.household_id}:${r.key}`))
    const memberSet = new Set((members ?? []).map((r) => `${r.household_id}:${r.user_id}`))

    const userIdByEmail = await listUserIdsByEmail(supabase)

    // Profile names for the greeting (plan-111 resolution, see personDisplayName).
    const memberUserIds = [...new Set((members ?? []).map((r) => r.user_id as string))]
    const profileNameByUser = new Map<string, string | null>()
    if (memberUserIds.length) {
      const { data: profiles, error: profilesError } = await supabase
        .from('profiles').select('user_id, display_name').in('user_id', memberUserIds)
      if (profilesError) throw new Error(`failed to load profiles: ${profilesError.message}`)
      for (const p of profiles ?? []) profileNameByUser.set(p.user_id, p.display_name)
    }

    const dryRun = Deno.env.get('EMAIL_DRY_RUN') === '1'
    const emailEnv = { apiKey: Deno.env.get('RESEND_API_KEY'), from: Deno.env.get('RESEND_FROM'), dryRun }
    const logEnv = { EMAIL_DRY_RUN: Deno.env.get('EMAIL_DRY_RUN'), SUPABASE_URL: supabaseUrl }
    const expiresAt = tokenExpiry(month)

    let sent = 0
    let failures = 0
    for (const householdId of due) {
      if (loggedSet.has(householdId)) continue // D11: month already logged

      for (const slot of SLOTS) {
        const person = (people ?? []).find((p) => p.household_id === householdId && p.slot === slot)
        const email = (person?.assigned_email as string | null | undefined)?.toLowerCase() ?? null
        if (!email) continue
        // Only a CURRENT member's account email; a pending invite gets nothing.
        const userId = userIdByEmail.get(email)
        if (!userId || !memberSet.has(`${householdId}:${userId}`)) continue
        if (draftSet.has(`${householdId}:${slot}`)) continue
        const stateKey = `${stateKeyPrefix}${slot}`
        if (stateSet.has(`${householdId}:${stateKey}`)) continue

        let tokenId: string | null = null
        try {
          const token = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))
          const tokenHash = await sha256Hex(token)
          const { data: inserted, error: insertError } = await supabase
            .from('salary_reminder_tokens')
            .insert({
              household_id: householdId,
              slot,
              month,
              token_hash: tokenHash,
              recipient_email: email,
              expires_at: expiresAt.toISOString(),
            })
            .select('id')
            .single()
          if (insertError || !inserted) throw new Error(`failed to insert token: ${insertError?.message ?? 'no row'}`)
          tokenId = inserted.id as string

          const link = `${appOrigin}/#/lon/${token}`
          const message = buildReminderEmail({
            displayName: personDisplayName(profileNameByUser.get(userId), email, slot),
            month,
            link,
            expiresAt,
          })

          try {
            await sendEmail(emailEnv, [email], message)
          } catch (sendErr) {
            const { error: deleteError } = await supabase.from('salary_reminder_tokens').delete().eq('id', tokenId)
            if (deleteError) {
              console.error(`salary-reminder-send: could not delete unsent token ${tokenId}: ${deleteError.message}`)
            }
            tokenId = null
            throw sendErr
          }

          const line = localDryRunLinkLine(logEnv, slot, link)
          if (line) console.log(line)

          const { error: stateError } = await supabase.from('notification_state').upsert(
            { household_id: householdId, key: stateKey, value: tokenId, notified_at: new Date().toISOString() },
            { onConflict: 'household_id,key' },
          )
          if (stateError) throw new Error(`email sent but failed to record notification_state: ${stateError.message}`)

          console.log(`salary-reminder-send: sent token ${tokenId} household ${householdId} slot ${slot}`)
          sent++
        } catch (err) {
          // Fail loud (plan 44): log, keep going with the other slots and
          // households, and surface a non-2xx response for the cron logs.
          console.error(
            `salary-reminder-send: failed for household ${householdId} slot ${slot}` +
              (tokenId ? ` token ${tokenId}` : '') + `: ${safeError(err)}`,
          )
          failures++
        }
      }
    }

    const summary = { ok: failures === 0, month, due: due.length, sent, failures }
    console.log('salary-reminder-send:', JSON.stringify(summary))
    return json(summary, failures === 0 ? 200 : 500)
  } catch (err) {
    console.error(`salary-reminder-send: fatal error: ${safeError(err)}`)
    return json({ ok: false, error: 'fatal' }, 500)
  }
})
