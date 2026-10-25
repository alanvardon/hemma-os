// salary-email-send — plan 139 (D7 partner email, D8 results email). Scheduled
// every 5 minutes (prod-only pg_cron, see README.md). It drains the
// public.salary_emails outbox that the database fills:
//   'partner_submitted' — a person's half was first submitted; tell the other
//                         person (no amounts);
//   'month_results'     — a month completed (auto) or someone asked for a
//                         resend (manual); tell both people the totals, "each
//                         takes home" and who pays whom, read from the row AS
//                         IT IS NOW.
//
// Not invoked from the browser — no CORS. verify_jwt is OFF for this function
// (Supabase's pattern for cron/pg_net callers using `sb_secret_…` keys), so the
// in-function isTrustedServerCaller check is the only gate: the request must
// carry one of the project's secret keys (apikey header or Bearer), or the
// legacy service_role key. Anon/publishable keys get 403.
//
// Per run: claim up to 50 rows (claim_salary_emails: skip-locked + a 15-minute
// lease + attempts + 1), then per row load the household's settings, people,
// current members, the month's/row's salary_submissions data and drafts, ask
// the pure salaryEmailDecision, and either send and mark 'sent', mark
// 'skipped' with the reason, or mark 'failed' (retried next run, at most 5
// attempts in all).
//
// Logging: outbox row id, household id, kind, slot(s) and Resend status codes
// only. NEVER an address, a name, an email body or any amount. last_error in
// the table holds the same status-code-only text.
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendEmail } from '../_shared/resend.ts'
import {
  adminKey,
  buildMonthResultsEmail,
  buildPartnerSubmittedEmail,
  isTrustedServerCaller,
  personDisplayName,
  salaryEmailDecision,
  type SalaryEmailRow,
  type SalaryEmailSettings,
  type SalaryResultsFigures,
  type SalarySlot,
} from '../_shared/salary-reminder-logic.ts'

const CLAIM_LIMIT = 50

interface ClaimedRow extends SalaryEmailRow {
  id: string
  household_id: string
  month: string
  attempts: number
}

interface HouseholdContext {
  settings: SalaryEmailSettings | null
  people: Array<{ slot: string; assigned_email: string | null }>
  members: Array<{ user_id: string; email: string | null }>
  profileNameByUser: Map<string, string | null>
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// Error text for logs without household data: Resend's error body can echo
// the recipient address, so only its status code survives. Other messages are
// this function's own "failed to …" strings (PostgREST error text, no data).
function safeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const resend = /^Resend send failed: (\d+)/.exec(msg)
  if (resend) return `Resend ${resend[1]}`
  return msg
}

// The even shorter text stored in salary_emails.last_error: a status code or
// a fixed word, never a message body.
function lastErrorCode(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const resend = /^Resend send failed: (\d+)/.exec(msg)
  if (resend) return `Resend ${resend[1]}`
  if (/RESEND_API_KEY \/ RESEND_FROM are not set/.test(msg)) return 'Resend not configured'
  return 'error'
}

// Lower-cased email → user id for every auth user (Admin API; auth.users is
// not exposed over PostgREST — same approach as salary-reminder-send).
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

async function loadHousehold(
  supabase: SupabaseClient,
  householdId: string,
  emailByUserId: Map<string, string>,
): Promise<HouseholdContext> {
  const [{ data: settings, error: settingsError }, { data: people, error: peopleError }, { data: members, error: membersError }] =
    await Promise.all([
      supabase.from('salary_reminder_settings').select('notify_partner, email_results').eq('household_id', householdId).maybeSingle(),
      supabase.from('household_people').select('slot, assigned_email').eq('household_id', householdId),
      supabase.from('household_members').select('user_id').eq('household_id', householdId),
    ])
  if (settingsError) throw new Error(`failed to load salary_reminder_settings: ${settingsError.message}`)
  if (peopleError) throw new Error(`failed to load household_people: ${peopleError.message}`)
  if (membersError) throw new Error(`failed to load household_members: ${membersError.message}`)

  const memberIds = (members ?? []).map((m) => m.user_id as string)
  const profileNameByUser = new Map<string, string | null>()
  if (memberIds.length) {
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles').select('user_id, display_name').in('user_id', memberIds)
    if (profilesError) throw new Error(`failed to load profiles: ${profilesError.message}`)
    for (const p of profiles ?? []) profileNameByUser.set(p.user_id, p.display_name)
  }
  return {
    settings: (settings as SalaryEmailSettings | null) ?? null,
    people: (people ?? []) as HouseholdContext['people'],
    members: memberIds.map((user_id) => ({ user_id, email: emailByUserId.get(user_id) ?? null })),
    profileNameByUser,
  }
}

// The household's person at a slot, as the app shows it (plan-111 rule).
function slotName(ctx: HouseholdContext, slot: SalarySlot, userIdByEmail: Map<string, string>): string {
  const email = ctx.people.find((p) => p.slot === slot)?.assigned_email?.toLowerCase() ?? null
  const userId = email ? userIdByEmail.get(email) : undefined
  return personDisplayName(userId ? ctx.profileNameByUser.get(userId) : null, email, slot)
}

async function complete(supabase: SupabaseClient, id: string, outcome: 'sent' | 'skipped' | 'failed', detail: string | null) {
  const { error } = await supabase.rpc('complete_salary_email', { p_id: id, p_outcome: outcome, p_detail: detail })
  if (error) throw new Error(`failed to record ${outcome}: ${error.code ?? 'error'}`)
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

    // Link origin (plan 131 secret). Checked before claiming anything, so a
    // misconfiguration fails loudly without spending attempts.
    const appOriginRaw = Deno.env.get('APP_ORIGIN')
    if (!appOriginRaw) throw new Error('APP_ORIGIN is not set')
    const link = `${appOriginRaw.replace(/\/$/, '')}/#/loner`

    const supabase = createClient(supabaseUrl, serviceKey)

    const { data: claimedData, error: claimError } = await supabase.rpc('claim_salary_emails', { p_limit: CLAIM_LIMIT })
    if (claimError) throw new Error(`failed to claim salary_emails: ${claimError.message}`)
    const claimed = (claimedData ?? []) as ClaimedRow[]
    if (claimed.length === 0) {
      return json({ ok: true, claimed: 0, sent: 0, skipped: 0, failures: 0 })
    }

    let userIdByEmail: Map<string, string>
    try {
      userIdByEmail = await listUserIdsByEmail(supabase)
    } catch (err) {
      // Release the claimed rows (as failed attempts) so the next run retries
      // them, instead of leaving them leased for 15 minutes.
      for (const row of claimed) {
        await complete(supabase, row.id, 'failed', 'error').catch(() => {})
      }
      throw err
    }
    const emailByUserId = new Map<string, string>()
    for (const [email, id] of userIdByEmail) emailByUserId.set(id, email)

    const dryRun = Deno.env.get('EMAIL_DRY_RUN') === '1'
    const emailEnv = { apiKey: Deno.env.get('RESEND_API_KEY'), from: Deno.env.get('RESEND_FROM'), dryRun }
    const households = new Map<string, HouseholdContext>()

    let sent = 0
    let skipped = 0
    let failures = 0
    for (const row of claimed) {
      const tag = `row ${row.id} household ${row.household_id} kind ${row.kind}`
      try {
        let ctx = households.get(row.household_id)
        if (!ctx) {
          ctx = await loadHousehold(supabase, row.household_id, emailByUserId)
          households.set(row.household_id, ctx)
        }

        // Send-time data. Partner: is the month logged now, and who has a
        // draft? Results: the reported row itself, as it is now.
        let submission: (SalaryResultsFigures & { id?: string }) | null = null
        let draftSlots: string[] = []
        if (row.kind === 'partner_submitted') {
          const [{ data: logged, error: loggedError }, { data: drafts, error: draftsError }] = await Promise.all([
            supabase.from('salary_submissions')
              .select('id, income_a, income_b, transfer_from, transfer_to, transfer_amount, equal_share')
              .eq('household_id', row.household_id).eq('month', row.month).limit(1),
            supabase.from('salary_submission_drafts').select('slot')
              .eq('household_id', row.household_id).eq('month', row.month),
          ])
          if (loggedError) throw new Error(`failed to load salary_submissions: ${loggedError.message}`)
          if (draftsError) throw new Error(`failed to load salary_submission_drafts: ${draftsError.message}`)
          submission = (logged?.[0] as SalaryResultsFigures | undefined) ?? null
          draftSlots = (drafts ?? []).map((d) => d.slot as string)
        } else if (row.submission_id) {
          const { data: sub, error: subError } = await supabase.from('salary_submissions')
            .select('id, person_a_name, person_b_name, income_a, income_b, transfer_from, transfer_to, transfer_amount, equal_share')
            .eq('household_id', row.household_id).eq('id', row.submission_id).maybeSingle()
          if (subError) throw new Error(`failed to load salary_submissions: ${subError.message}`)
          submission = (sub as SalaryResultsFigures | null) ?? null
        }

        const decision = salaryEmailDecision({
          row, settings: ctx.settings, members: ctx.members, people: ctx.people, submission, draftSlots,
        })
        if (decision.action === 'skip') {
          await complete(supabase, row.id, 'skipped', decision.reason)
          console.log(`salary-email-send: skipped ${tag}: ${decision.reason}`)
          skipped++
          continue
        }

        let message
        if (row.kind === 'partner_submitted') {
          const recipient = decision.recipients[0]
          message = buildPartnerSubmittedEmail({
            recipientName: personDisplayName(ctx.profileNameByUser.get(recipient.userId), recipient.email, recipient.slot),
            submitterName: slotName(ctx, row.submitter_slot as SalarySlot, userIdByEmail),
            month: row.month,
            link,
          })
        } else {
          // "Updated:" when a results email for this same row went out before.
          const { data: prev, error: prevError } = await supabase.from('salary_emails')
            .select('sent_at')
            .eq('household_id', row.household_id).eq('kind', 'month_results').eq('submission_id', row.submission_id!)
            .not('sent_at', 'is', null).neq('id', row.id)
            .order('sent_at', { ascending: false }).limit(1)
          if (prevError) throw new Error(`failed to load previous results email: ${prevError.message}`)
          const previousSentAt = prev?.[0]?.sent_at ? new Date(prev[0].sent_at as string) : null
          const s = submission!
          message = buildMonthResultsEmail({
            month: row.month,
            // The stored snapshot names, as Löner shows them; else today's names.
            nameA: s.person_a_name || slotName(ctx, 'a', userIdByEmail),
            nameB: s.person_b_name || slotName(ctx, 'b', userIdByEmail),
            submission: s,
            previousSentAt,
            link,
          })
        }

        try {
          await sendEmail(emailEnv, decision.recipients.map((r) => r.email), message)
        } catch (sendErr) {
          await complete(supabase, row.id, 'failed', lastErrorCode(sendErr))
          console.error(`salary-email-send: failed ${tag} attempt ${row.attempts}: ${safeError(sendErr)}`)
          failures++
          continue
        }
        await complete(supabase, row.id, 'sent', null)
        console.log(`salary-email-send: sent ${tag} to slot(s) ${decision.recipients.map((r) => r.slot).join(',')}`)
        sent++
      } catch (err) {
        // Fail loud (plan 44): log, release the row for the next run, carry on.
        console.error(`salary-email-send: error ${tag} attempt ${row.attempts}: ${safeError(err)}`)
        try {
          await complete(supabase, row.id, 'failed', lastErrorCode(err))
        } catch {
          // The 15-minute lease frees it anyway.
        }
        failures++
      }
    }

    const summary = { ok: failures === 0, claimed: claimed.length, sent, skipped, failures }
    console.log('salary-email-send:', JSON.stringify(summary))
    return json(summary, failures === 0 ? 200 : 500)
  } catch (err) {
    console.error(`salary-email-send: fatal error: ${safeError(err)}`)
    return json({ ok: false, error: 'fatal' }, 500)
  }
})
