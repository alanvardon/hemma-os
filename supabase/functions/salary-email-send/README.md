# salary-email-send — runbook (plan 139, D7 + D8)

One Edge Function sends both salary emails that plan 139 adds:

| Kind | When it is queued | Who gets it | Content |
|---|---|---|---|
| `partner_submitted` (D7) | a person's half is **first** submitted, in the app or by the email link (AFTER INSERT trigger on `salary_submission_drafts`; edits never queue one) | the **other** slot's assigned email, if it is a current member and not the person who acted | who submitted, the month, an "Open Löner" button to `<APP_ORIGIN>/#/loner`. **No amounts** |
| `month_results` (D8) | `finalize_salary_month` completes a month (`trigger = 'auto'`), or someone clicks "Skicka resultatet igen" (`public.request_salary_results_email`, `trigger = 'manual'`) | both slots' assigned emails that are current members, in **one** email | each total, "Each takes home", who pays whom (or "Nothing to transfer"). No itemised lines, no notes. A resend after an earlier one is subjected "Updated: …" |

| Caller | Auth |
|---|---|
| prod-only pg_cron, every 5 minutes | **none at the gateway** (`verify_jwt = false` in `supabase/config.toml`); the function itself requires one of the project's **secret keys** (`sb_secret_…`) in the `apikey` header (or as `Authorization: Bearer`), or the legacy `service_role` key. Anon/publishable keys and anything else get `403` |

None of this is deployed or scheduled by CI or by an agent. The owner runs
every step below by hand against the linked prod project, after the plan 139
PR is merged. The outbox and its functions (`salary_emails`,
`claim_salary_emails`, `complete_salary_email`,
`request_salary_results_email`, `salary_results_email_status`, the redefined
`finalize_salary_month`) ship in the normal migration
`20261025110000_salary_emails.sql`. Only the deploy, secrets and the cron below
are prod-only, and none of it belongs in `supabase/migrations/`.

**Never run `supabase config push`.** `config.toml` holds local-only values
and would overwrite production Auth settings.

## Rollout (owner only, after merge)

1. Apply the migrations (`20261025100000_salary_app_halves.sql`, then
   `20261025110000_salary_emails.sql`).
2. Deploy this function (section 1).
3. Create the Vault secrets and the 5-minute cron (section 3).

Until the cron exists, emails just **queue up** in `salary_emails`; the first
run sends them all. If that backlog would be stale by then (e.g. the cron is
added weeks after the migration), mark the old rows skipped **before**
scheduling:

```sql
update public.salary_emails
   set skipped_reason = 'rollout_backlog'
 where sent_at is null and skipped_reason is null
   and created_at < now() - interval '1 day';
```

## 1. Deploy

```sh
supabase functions deploy salary-email-send --no-verify-jwt
```

`config.toml` already sets `verify_jwt = false`, which a plain `deploy`
honours; the flag is passed as well so it can't come up with the gateway check
on (the cron's `sb_secret_…` key would then be rejected before the function's
own check runs). Afterwards, check in the dashboard (Edge Functions →
salary-email-send → Details) that "Enforce JWT verification" is **off**.

## 2. Secrets

Already set by plan 131 / plan 132 (see [`../_shared/README.md`](../_shared/README.md)).
Confirm with `supabase secrets list` that these names exist:

- `RESEND_API_KEY`, `RESEND_FROM`: the shared Resend sender.
- `APP_ORIGIN`: the app origin, e.g. `https://www.vardon-family.se` (no
  trailing path). The function **refuses to run** without it (before claiming
  anything) and builds the button link as `<APP_ORIGIN>/#/loner`. That page
  needs a login; there is no token in these emails.

`EMAIL_DRY_RUN` must **not** be set in prod. With it set, the function marks
rows **sent** but sends nothing, so those emails would silently never go out.

`SUPABASE_URL`, `SUPABASE_SECRET_KEYS` and the legacy `SUPABASE_SERVICE_ROLE_KEY`
are injected automatically. The function uses the `default` secret key for its
database client, falling back to the legacy key.

## 3. Schedule: pg_cron every 5 minutes

Same Vault pattern as `salary-reminder-send` (the job body is readable by
anyone who can query `cron.job`, so the key is never inlined). `pg_cron`/`pg_net`
are already enabled by plan 72's runbook. You can reuse the secret key stored
for the reminder job (`salary_reminder_send_key`), or store a dedicated one so
each can be rotated alone:

```sql
select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/salary-email-send', 'salary_email_send_url');
select vault.create_secret('<sb_secret_… key>', 'salary_email_send_key');

select cron.schedule(
  'salary-email-send',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'salary_email_send_url'),
    headers := jsonb_build_object(
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'salary_email_send_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
```

A run with nothing queued is a no-op (`{"ok":true,"claimed":0,…}`) and touches
no other table. (No plan-137 heartbeat exists in `_shared/` yet; when it lands,
register this job there.)

## What a run does

1. `claim_salary_emails(50)`: up to 50 rows that are unsent, unskipped, have
   fewer than 5 attempts and are not leased by a live run, oldest first. Each
   claim adds one attempt and sets a 15-minute lease (`claimed_at`), with
   `FOR UPDATE SKIP LOCKED`, so overlapping runs never take the same row.
2. Per row, it loads **at send time** the household's settings, people,
   current members (pending invites are not members) and the salary data, and
   calls the pure `salaryEmailDecision` (`_shared/salary-reminder-logic.ts`,
   unit-tested in `web/src/lib/salary-reminder-logic.test.ts`):
   - `partner_submitted` is **skipped** when `notify_partner` is off; when the
     month now has a `salary_submissions` row (the results email covers it,
     so the second submitter's partner never gets two emails); when the
     recipient has meanwhile submitted their own half; or when the other slot
     isn't a current member or is the person who acted. Otherwise it is sent to
     the other slot.
   - `month_results` is **skipped** when the reported row was deleted or lacks
     a figure, or, for `trigger = 'auto'` only, when `email_results` is off. A
     manual resend always sends. Otherwise **one** email goes to both
     current-member slots (a non-member slot is dropped). The figures are the
     row's **current** values, so a resend carries an edit. If a results email
     for the same row was sent before, the subject is "Updated: salary results
     for <Month YYYY>" and it says "These figures replace the ones we sent on
     <date>".
3. `complete_salary_email(id, outcome, detail)`: `sent` → `sent_at`; `skipped`
   → `skipped_reason` (e.g. `opted_out`, `month_complete`, `no_recipient`,
   `submission_deleted`); `failed` → `last_error` (status code only, e.g.
   `Resend 503`) and the lease is released, so the **next** run retries it, up
   to 5 attempts in all. A run that dies mid-send leaves the lease, and the row
   is retried once the lease is 15 minutes old.

The response is `{ok, claimed, sent, skipped, failures}`; it is `500` if any row
failed. Failures are logged per row and the run carries on (fail loud, plan 44).

Throttle (D8): at most **one unsent** results email per month can be queued.
A second "Skicka resultatet igen" while one is waiting returns
`already_queued` ("Ett mejl är redan på väg"). A row that used up its 5
attempts no longer counts, so it can't block the month forever.

## 4. Verify in prod (by hand)

- Submit your half in Löner for a test month; within 5 minutes your partner
  should get "<you> has submitted their salary for <Month YYYY>".
- Invoke once by hand, without the key reaching shell history:
  ```sh
  read -rs SK    # paste the sb_secret_… key, press Enter
  curl -X POST "https://<project-ref>.supabase.co/functions/v1/salary-email-send" -H "apikey: $SK"
  unset SK
  ```
- Inspect the outbox (no addresses or amounts are stored in it):
  ```sql
  select id, household_id, month, kind, submitter_slot, "trigger", attempts,
         last_error, sent_at, skipped_reason, created_at
    from public.salary_emails order by created_at desc limit 20;
  ```

## Local testing (always dry-run)

Never use a real Resend key locally, and never set `RESEND_API_KEY` in the
local env file. Put it **outside the repo**:

```sh
cat > /tmp/salary-email.env <<'EOF'
EMAIL_DRY_RUN=1
APP_ORIGIN=http://localhost:5174
EOF
supabase functions serve salary-email-send --env-file /tmp/salary-email.env
```

With `EMAIL_DRY_RUN=1`, `sendEmail` returns before any network call and logs
only `[email dry-run] would send "<subject>" to <N> recipient(s)`. The
partner-email subject names the submitter; neither subject carries an amount.

Fictional fixture (local DB only, `docker exec -i supabase_db_hemma-os psql -U postgres`):
a household with two fictional member accounts assigned to `household_people`
slots `a`/`b`, then drafts inserted as `service_role` (or saved in the app at
http://localhost:5174). Then:

```sh
SK=<SECRET_KEY (sb_secret_…) from `supabase status`>
curl -X POST http://127.0.0.1:54321/functions/v1/salary-email-send -H "apikey: $SK"
```

Expected: one half → one partner dry-run line; the second half → one results
line ("Salary results for …") and the second submitter's partner row skipped as
`month_complete`; `select public.request_salary_results_email('<id>')` as a
member, then invoke → one "Updated: salary results for …" line. Run
`supabase db reset` afterwards to get back to the seed.

## Security notes

- The outbox has RLS on, **no policies** and no client grants; only the
  service role reads it. Members see only `salary_results_email_status()` (per
  month row: last sent time, whether one is queued) and can only enqueue a
  results email for a row in their **own** household (`42501` otherwise).
- **The results email is the first salary email that carries amounts**
  (totals, each takes home, the transfer). The owner approved this on
  2026-10-25 (plan 139 D8). Resend's dashboard logs, and both mailboxes, keep
  those figures. Itemised income lines and notes are never included. The
  partner email carries no amounts.
- Logs carry the outbox row id, household id, kind, slot(s) and Resend status
  codes only. Never an address, an email body or an amount. Resend error
  bodies are cut to their status code, and `last_error` stores only that code.
- Duplicate risk: if a send succeeds but recording `sent` fails (database
  unavailable at that instant), the row is retried after its lease expires and
  the email can go out twice. Accepted; the reverse (losing an email) is worse.

## Rollback

```sql
select cron.unschedule('salary-email-send');
select vault.delete_secret((select id from vault.secrets where name = 'salary_email_send_url'));
select vault.delete_secret((select id from vault.secrets where name = 'salary_email_send_key'));
-- Stop everything still queued from going out if the cron is re-added later:
update public.salary_emails set skipped_reason = 'rolled_back'
 where sent_at is null and skipped_reason is null;
```

```sh
supabase functions delete salary-email-send
```

With the function gone, the database keeps queueing rows (the trigger and
finalize still enqueue), which is harmless; they are never sent. Dropping the
table, trigger or the finalize enqueue is a separate migration decision.
