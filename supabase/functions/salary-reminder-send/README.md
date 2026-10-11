# salary-reminder-send + salary-reminder — runbook (plan 132)

Two Edge Functions back the monthly salary emails:

| Function | Caller | Auth |
|---|---|---|
| `salary-reminder-send` | prod-only pg_cron, once a day | gateway JWT check **and** an in-function check that the bearer is exactly the service-role key (the anon key is a valid JWT too, so the gateway alone isn't enough) — anything else gets `403` |
| `salary-reminder` | the public `#/lon/<token>` page in the browser | **none at the gateway** (`verify_jwt = false` for this function only, in `supabase/config.toml`); the link token in the request body is the credential |

None of this is deployed or scheduled by CI or by an agent. The owner runs
every step below by hand against the linked prod project, after the plan 132
PR is merged. The tables and functions (`salary_reminder_settings`,
`salary_submission_drafts`, `salary_reminder_tokens`,
`public.finalize_salary_month`) ship in the normal migration
`20261011100000_salary_reminders.sql`. Only the deploy, secrets and the cron
below are prod-only, and none of it belongs in `supabase/migrations/`.

## 1. Deploy

```sh
supabase functions deploy salary-reminder-send
supabase functions deploy salary-reminder --no-verify-jwt
```

`config.toml` already sets `verify_jwt = false` for `salary-reminder`, which a
plain `deploy` honours. `--no-verify-jwt` is passed as well so the public
function can't come up with the gateway check turned on (the page would then
get `401`s). **Never** pass `--no-verify-jwt` for `salary-reminder-send`.

Afterwards, check in the dashboard (Edge Functions → each function → Details)
that "Enforce JWT verification" is **off** for `salary-reminder` and **on** for
`salary-reminder-send`.

## 2. Secrets

Already set by plan 131 (see [`../_shared/README.md`](../_shared/README.md)).
Confirm with `supabase secrets list` that these names exist:

- `RESEND_API_KEY`, `RESEND_FROM`: the shared Resend sender.
- `APP_ORIGIN`: the app origin, e.g. `https://www.vardon-family.se` (no
  trailing path). Both functions **refuse to run** without it. The send job
  builds links as `<APP_ORIGIN>/#/lon/<token>`, and the public function uses it
  as the exact `Access-Control-Allow-Origin`, so the page only works from that
  origin.

`EMAIL_DRY_RUN` must **not** be set in prod. With it set, the job still mints
tokens and records `notification_state`, but sends nothing, so that month's
emails would silently never go out.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

## 3. Schedule: one daily pg_cron

`salary-reminder-send` checks each household's send day against the
**Stockholm** date, so a single UTC time works all year: `0 7 * * *` is 08:00
CET or 09:00 CEST. Same Vault pattern as policy-rate-notify (the job body is
readable by anyone who can query `cron.job`, so the key is never inlined).
`pg_cron`/`pg_net` are already enabled by plan 72's runbook.

The bearer stored in Vault must be the **legacy service-role JWT**: the exact
value the function sees as `SUPABASE_SERVICE_ROLE_KEY` (Dashboard → Project
Settings → API Keys → Legacy API keys → `service_role`). An `sb_secret_…` key
or the anon key gets `403`.

```sql
select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/salary-reminder-send', 'salary_reminder_send_url');
select vault.create_secret('<legacy service_role JWT>', 'salary_reminder_send_key');

select cron.schedule(
  'salary-reminder-send',
  '0 7 * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'salary_reminder_send_url'),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'salary_reminder_send_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
```

(You can reuse plan 72's `policy_rate_notify_key` secret instead of creating
a second copy of the same key.)

## What a run does

For each household whose send day is today (no `salary_reminder_settings` row
means enabled, day 25), with `month` = the Stockholm month:

1. Skip the household if `salary_submissions` already has a row for `month`.
2. For slot `a` and `b`, skip the slot if:
   - it has no `assigned_email`, or that email isn't a **current member's**
     account email (pending invites get nothing);
   - it already has a draft for the month; or
   - `notification_state` has key `salary_reminder:<month>:<slot>` for the
     household. This makes runs idempotent; the row's `value` is the token
     id.
3. Otherwise it mints a 32-byte random token, stores only its sha256 hex
   (`expires_at` = 00:00 Stockholm on the 1st of month+2), emails the link,
   then records `notification_state`. If the send fails, the token row is
   deleted and no state is written, so the next run tries again.

The response is `{ok, month, due, sent, failures}`. It is `500` if any slot
failed. Failures are logged per household and slot, and the run carries on
with the rest (fail loud, plan 44).

## 4. Verify in prod (by hand)

- Temporarily set a test household's send day to today in the app
  (Hushållsbudget → salary reminder row), or wait for the 25th.
- Invoke once:
  ```sh
  curl -X POST "https://<project-ref>.supabase.co/functions/v1/salary-reminder-send" \
    -H "Authorization: Bearer <legacy service_role JWT>"
  ```
  Expect `{"ok":true,…,"sent":N}`, with one email per member-assigned slot.
  Invoke it again and expect `sent: 0`.
- Inspect, without reading tokens:
  ```sql
  select household_id, slot, month, expires_at, revoked_at, created_at
    from public.salary_reminder_tokens order by created_at desc limit 10;
  select household_id, key, notified_at from public.notification_state
   where key like 'salary_reminder:%' order by notified_at desc;
  ```

## Local testing (always dry-run)

Never use a real Resend key locally. Put this env file **outside the repo**
(for example in a temp dir):

```sh
cat > /tmp/salary.env <<'EOF'
EMAIL_DRY_RUN=1
APP_ORIGIN=http://localhost:5174
EOF
supabase start
supabase functions serve --env-file /tmp/salary.env
```

With `EMAIL_DRY_RUN=1`, `sendEmail` returns before any network call and logs
only the subject and recipient count. To get the link for testing, the send
job logs exactly one extra line per minted token:

```text
[local dry-run] a link: http://localhost:5174/#/lon/<token>
```

That line is printed **only** when `EMAIL_DRY_RUN=1` **and** `SUPABASE_URL`'s
host is not `supabase.co` or a subdomain of it (`localDryRunLinkLine` /
`isLocalDryRunLinkLoggingAllowed` in `_shared/salary-reminder-logic.ts`,
unit-tested in `web/src/lib/salary-reminder-logic.test.ts`). A token in prod
logs would be a live credential.

Fictional fixture (local DB only, `docker exec -i supabase_db_hemma-os psql -U postgres`):
add a second fictional auth user and `household_members` row to the seeded
`Dev household`, set `household_people` slot `a`/`b` to the two member
emails, optionally add a `tool_state` `hushallsbudget` row with
`data.incomes`, and set `salary_reminder_settings.send_day` to today's
Stockholm day. Then:

```sh
SR=<SERVICE_ROLE_KEY from `supabase status`>
curl -X POST http://127.0.0.1:54321/functions/v1/salary-reminder-send -H "Authorization: Bearer $SR"
curl -X POST http://127.0.0.1:54321/functions/v1/salary-reminder \
  -H 'Content-Type: application/json' -d '{"action":"context","token":"<token from the log>"}'
curl -X POST http://127.0.0.1:54321/functions/v1/salary-reminder \
  -H 'Content-Type: application/json' \
  -d '{"action":"submit","token":"<token>","items":[{"label":"Lön","amount":42350}],"note":null}'
```

Local Kong answers `OPTIONS` itself and rewrites `Access-Control-Allow-Origin`
to `*`. The function's own CORS headers (exactly `APP_ORIGIN`) only show when
you call the edge runtime directly. The hosted gateway passes the function's
headers through. Run `supabase db reset` afterwards to get back to the seed.

## Public endpoint contract (`salary-reminder`)

- `POST` only (`OPTIONS` gets a `204` preflight), JSON body, at most 32 KB
  (`413`). Malformed JSON, a non-object body or an unknown `action` gets `400`.
  These checks never look at the token.
- Every token failure returns the **same** `404 {"error":"invalid_link"}` with
  the same headers: wrong format (not 43 base64url chars), unknown, revoked,
  expired, slot reassigned to another email, or recipient no longer a
  household member.
- `{action:'context', token}` returns `{status:'already_logged', month}`, or
  `{month, slot, displayName, status:'open'|'submitted', items, note, expiresAt}`
  for the **recipient's slot only**. `items` comes from the slot's draft, else
  the Hushållsbudget baseline split with the modal's rule.
- `{action:'submit', token, items, note}` gets `422 {error:'invalid', field,
  message}` on invalid input, and nothing is written. Otherwise it upserts the
  slot's draft, calls `finalize_salary_month` and returns
  `{status:'submitted'|'finalized'|'already_logged'|'zero_total'}`. If the
  month is already logged it writes no draft. Any DB error returns a generic
  `500 {"error":"server_error"}`.

## Security notes

- **`salary-reminder` is an unauthenticated write path** into household
  financial data. The token is 256 bits of randomness, bound to one
  household, one slot and one month. Only its sha256 is stored. It is revoked
  on finalise and on in-app discard, and expires at the end of month+1.
  `salary_reminder_tokens` has RLS on and no policies, so only the service
  role can read it. There is no rate limit; brute-forcing 256 bits isn't
  feasible.
- Logs carry token **id**, household id and slot only. They never contain
  the token, the link, an address, the email body, items, amounts or notes.
  The one exception is the local dry-run line above. Resend error bodies are
  cut to their status code before logging.
- **Resend's dashboard logs keep each sent email, including the link**, so
  anyone with access to the Resend account can use a live link until it
  expires or the month is finalised. This is accepted (plan 132): tokens are
  per slot, per month and expiring. Click tracking must stay **off** (plan
  131 D3) so links never go through a third-party redirect.

## Rollback

```sql
select cron.unschedule('salary-reminder-send');
select vault.delete_secret((select id from vault.secrets where name = 'salary_reminder_send_url'));
select vault.delete_secret((select id from vault.secrets where name = 'salary_reminder_send_key'));
-- Kill every outstanding link immediately:
update public.salary_reminder_tokens set revoked_at = now() where revoked_at is null;
```

```sh
supabase functions delete salary-reminder
supabase functions delete salary-reminder-send
```

The tables and their rows stay. Dropping them is a separate migration
decision.
