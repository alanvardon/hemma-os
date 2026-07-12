# policy-rate-notify — prod runbook (plan 72)

This function is **not** deployed or scheduled by CI or by an agent. The
owner runs every step below by hand against the linked prod project — the
agent's Bash PATH has neither the linked CLI session nor prod credentials
(same pattern as plan 85's demo-household runbook).

The `notification_state` table (migration
`20260712110000_notification_state.sql`) is a normal migration and ships
through the usual pipeline. Everything in this file is prod-only wiring on
top of it: deploying the function, its secrets, and the cron schedule. None
of it belongs in `supabase/migrations/` — it must never run in CI or on
`supabase db reset`.

## 1. Deploy the function

```sh
supabase functions deploy policy-rate-notify
```

## 2. Set secrets

```sh
supabase secrets set RESEND_API_KEY=re_xxx RESEND_FROM="Hemma OS <styrranta@your-verified-domain>"
```

Resend requires a **verified sending domain** (or their shared onboarding
domain, which is rate-limited and not suitable for production) before it will
deliver mail from `RESEND_FROM`. Set that up in the Resend dashboard first —
this is an owner action outside this repo.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` do **not** need to be set —
Supabase injects both automatically into every deployed Edge Function.

## 3. Enable extensions + schedule the cron

Run this SQL against prod (SQL editor or `supabase db execute --linked`).
It is deliberately kept out of `supabase/migrations/` because it embeds a
service-role bearer and an HTTP call — neither belongs in a migration that
CI or `db reset` can execute.

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
```

Riksbank publishes decisions at 09:30 Europe/Stockholm. The function itself
gates on the decision calendar (see `logic.ts` `isDecisionDate`), so the cron
can run a little after that with margin — the important part is covering
both UTC offsets Stockholm uses across the year (CET = UTC+1 in winter, CEST
= UTC+2 in summer), so schedule **two** daily UTC times that both land after
09:40 Stockholm in their respective season:

- `40 7 * * *` → 07:40 UTC = 09:40 CEST (summer)
- `40 8 * * *` → 08:40 UTC = 09:40 CET (winter)

Only one of the two will actually be "after 09:40 local" on any given day,
and the other fires ~1h early or ~1h late — both fine, since the function
only proceeds on decision dates and `notification_state` makes a second
same-day run a no-op (idempotency guard, see below), so it is safe to just
leave both schedules active year-round rather than flipping them at the DST
boundary.

Store the function URL and service-role key in **Supabase Vault** rather than
pasting the key inline into the cron job body (the job body is visible to
anyone who can query `cron.job`):

```sql
select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/policy-rate-notify', 'policy_rate_notify_url');
select vault.create_secret('<service-role-key>', 'policy_rate_notify_key');
```

Then schedule using `pg_net`'s `http_post`, reading both out of Vault at call
time:

```sql
select cron.schedule(
  'policy-rate-notify-summer',
  '40 7 * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'policy_rate_notify_url'),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'policy_rate_notify_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

select cron.schedule(
  'policy-rate-notify-winter',
  '40 8 * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'policy_rate_notify_url'),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'policy_rate_notify_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
```

## 4. Verify

- **Decision-day dry run:** on (or by temporarily editing `RIKSBANK_DECISIONS_2026`
  in `logic.ts` to include today, redeploying, and reverting after) a decision
  date, invoke the function directly:
  ```sh
  curl -X POST "https://<project-ref>.supabase.co/functions/v1/policy-rate-notify" \
    -H "Authorization: Bearer <service-role-key>"
  ```
  It should return `{"ok":true,"notified":N,"failures":0,"ratePoint":{...}}` and
  every household member should receive exactly one email.
- **Inspect state:**
  ```sql
  select household_id, key, value, notified_at from public.notification_state order by notified_at desc;
  ```
  `value` is the JSON-serialised `{date, value}` point last emailed about.
- **Confirm no second email on re-run:** invoke the function again immediately.
  It should return `notified:0` for every household already at the current
  rate — `notification_state` already holds that value, so `shouldNotify`
  returns false and no second email is sent. This is the idempotency
  guarantee even if both DST-bracket cron schedules fire on the same day.
- **Check function logs** in the dashboard (Edge Functions → policy-rate-notify
  → Logs) for the `policy-rate-notify: {...}` summary line, or any
  `console.error` — a non-2xx response means at least one household failed
  (fail-loud per plan 44; never silently swallowed).

### First run — suppress the baseline email (optional)

A household with **no** `notification_state` row yet is treated as "never
notified", so `shouldNotify(null, …)` returns `true`: on the *first* decision
date after deploy it will receive one email stating the current rate **even if
the rate did not change that day**. This is a one-time baseline, harmless, and
self-correcting (the row is written after). To suppress it entirely, pre-seed
the current rate for every household before the first decision date so the
first real change is the first email:

```sql
-- Seed today's published rate as the baseline for all households (run once,
-- after checking the current value at api.riksbank.se — SECBREPOEFF/Latest).
insert into public.notification_state (household_id, key, value)
select id, 'policy_rate', '{"date":"<YYYY-MM-DD>","value":<rate>}'
from public.households
on conflict (household_id, key) do nothing;
```

## Reversal

```sql
select cron.unschedule('policy-rate-notify-summer');
select cron.unschedule('policy-rate-notify-winter');
select vault.delete_secret((select id from vault.secrets where name = 'policy_rate_notify_url'));
select vault.delete_secret((select id from vault.secrets where name = 'policy_rate_notify_key'));
```

```sh
supabase secrets unset RESEND_API_KEY RESEND_FROM
```

`notification_state` rows and the function deployment itself are left in
place unless the whole feature is being removed — dropping the table is a
separate, explicit decision (it's a normal migration-managed table, not
prod-only state).
