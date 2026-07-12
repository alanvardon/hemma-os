// policy-rate-notify — plan 72. Scheduled (via prod-only pg_cron, see
// README.md) to run on the morning of each Riksbank decision date and email
// every household when the policy rate (styrränta) has actually changed
// since the last time that household was notified.
//
// Not invoked from the browser — no CORS handling needed. Invoked by pg_cron
// with a service-role bearer, or manually by the owner for a dry run.
//
// Reuses the SWEA "Latest" fetch approach from riksbank-proxy/index.ts
// (GET Observations/Latest/SECBREPOEFF) — that endpoint 200s with an empty
// body when an Origin header is present, so this must run server-side, which
// it already does. Decision-calendar + change-detection logic lives in
// logic.ts and is mirrored by hand from web/src/lib/riksbank.ts (see that
// file's header comment) — plan 88 will automate the sync later.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  buildNotificationEmail,
  isDecisionDate,
  parsePoint,
  serializePoint,
  shouldNotify,
  type RatePoint,
} from './logic.ts'

const SERIES = 'SECBREPOEFF'
const SWEA_BASE = 'https://api.riksbank.se/swea/v1'
const APP_URL = 'https://hemma-os.se/bolanekoll' // owner-facing link in the email body; update if the prod domain changes

function stockholmToday(): string {
  // en-CA formats as YYYY-MM-DD, which is exactly what the decision calendar
  // and notification_state use.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Stockholm' })
}

async function fetchLatestRate(): Promise<RatePoint> {
  const res = await fetch(`${SWEA_BASE}/Observations/Latest/${SERIES}`)
  if (!res.ok) throw new Error(`riksbank SWEA latest fetch failed: ${res.status}`)
  const body = await res.json()
  if (!body || typeof body.date !== 'string' || typeof body.value !== 'number') {
    throw new Error(`riksbank SWEA latest fetch returned an unexpected shape: ${JSON.stringify(body)}`)
  }
  return { date: body.date, value: body.value }
}

async function sendEmail(to: string[], email: { subject: string; text: string; html: string }): Promise<void> {
  const apiKey = Deno.env.get('RESEND_API_KEY')
  const from = Deno.env.get('RESEND_FROM')
  if (!apiKey || !from) throw new Error('RESEND_API_KEY / RESEND_FROM are not set')
  if (to.length === 0) throw new Error('sendEmail called with no recipients')

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject: email.subject, text: email.text, html: email.html }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable body>')
    throw new Error(`Resend send failed: ${res.status} ${body}`)
  }
}

Deno.serve(async (_req: Request) => {
  try {
    const today = stockholmToday()
    if (!isDecisionDate(today)) {
      console.log(`policy-rate-notify: no Riksbank decision today (${today}) — no-op`)
      return new Response(JSON.stringify({ ok: true, notified: 0, reason: 'not a decision date' }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceRoleKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set')

    const current = await fetchLatestRate()
    const supabase = createClient(supabaseUrl, serviceRoleKey)

    // household_members is in the exposed `public` schema (queryable via the
    // normal REST client); auth.users is NOT exposed via PostgREST (only
    // `public`/`graphql_public` are, per supabase/config.toml [api].schemas),
    // so member emails must come from the Admin Auth API instead of a
    // PostgREST embed — the same reason household_roster() exists as a
    // security-definer RPC for the browser client (20260705190000_household_roster.sql).
    const { data: members, error: membersError } = await supabase.from('household_members').select('household_id, user_id')
    if (membersError) throw new Error(`failed to load household_members: ${membersError.message}`)

    const emailByUserId = new Map<string, string>()
    for (let page = 1; ; page++) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 })
      if (error) throw new Error(`failed to list users: ${error.message}`)
      for (const user of data.users) if (user.email) emailByUserId.set(user.id, user.email)
      if (data.users.length < 200) break
    }

    const emailsByHousehold = new Map<string, string[]>()
    for (const row of members ?? []) {
      const email = emailByUserId.get(row.user_id)
      if (!email) continue
      const list = emailsByHousehold.get(row.household_id) ?? []
      list.push(email)
      emailsByHousehold.set(row.household_id, list)
    }

    const { data: stateRows, error: stateError } = await supabase
      .from('notification_state')
      .select('household_id, value')
      .eq('key', 'policy_rate')
    if (stateError) throw new Error(`failed to load notification_state: ${stateError.message}`)

    const storedByHousehold = new Map<string, string>()
    for (const row of stateRows ?? []) storedByHousehold.set(row.household_id, row.value)

    let notified = 0
    let failures = 0

    for (const [householdId, recipients] of emailsByHousehold) {
      const stored = storedByHousehold.get(householdId) ?? null
      if (!shouldNotify(stored, current)) continue

      try {
        const previous = parsePoint(stored)
        const email = buildNotificationEmail(previous, current, APP_URL)
        await sendEmail(recipients, email)

        const { error: upsertError } = await supabase
          .from('notification_state')
          .upsert(
            { household_id: householdId, key: 'policy_rate', value: serializePoint(current), notified_at: new Date().toISOString() },
            { onConflict: 'household_id,key' },
          )
        if (upsertError) throw new Error(`failed to record notification_state: ${upsertError.message}`)

        notified++
      } catch (err) {
        // Fail loud per plan 44: never swallow — log and keep going so one
        // household's failure doesn't block the rest, but surface it via a
        // non-2xx response so cron logs show it.
        console.error(`policy-rate-notify: failed for household ${householdId}:`, err)
        failures++
      }
    }

    const summary = { ok: failures === 0, notified, failures, ratePoint: current }
    console.log('policy-rate-notify:', JSON.stringify(summary))
    return new Response(JSON.stringify(summary), {
      status: failures === 0 ? 200 : 500,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('policy-rate-notify: fatal error', err)
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
