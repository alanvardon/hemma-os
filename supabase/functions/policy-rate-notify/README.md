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

Secrets: see [`../_shared/README.md`](../_shared/README.md) (plan 131) for
the full Resend domain/key setup and the exact `supabase secrets set` command.

`APP_ORIGIN` is **required** — the owner-facing link in the email body (plan
130); the function throws and refuses to run without it rather than ever
falling back to a guessed or stale domain. Plan 132 reuses the same secret.

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

The function runs **every day** and has no decision calendar (removed
2026-11-25: the hand-mirrored calendar went stale and skipped the 2026-11-03
decision). It fetches the last 400 days of the daily `SECBREPOEFF` series and
emails a household only when the latest rate **value** differs from the one
stored in `notification_state`. That series changes on the rate's
**effective** date (about a week after the 09:30 announcement), so the email
arrives on the effective date and says "gällande från <effective date>".

Any daily time works. The two schedules below predate that change and are
kept as-is: a second same-day run is a no-op (`notification_state` already
holds the value), so you can leave both or unschedule one.

- `40 7 * * *` → 07:40 UTC
- `40 8 * * *` → 08:40 UTC

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

- **Run it once** (any day). Easiest without a key in shell history: in the
  SQL editor, run the cron job's own `net.http_post` body from step 3, then
  read the reply:
  ```sql
  select status_code, content, created from net._http_response order by id desc limit 3;
  ```
  It should return `{"ok":true,"notified":N,"failures":0,"ratePoint":{...}}`.
  `N` is the number of households whose stored rate differs from today's;
  each of their members gets exactly one email. `pg_net` keeps replies for
  about 6 hours only, so check soon after.
- **Inspect state:**
  ```sql
  select household_id, key, value, notified_at from public.notification_state order by notified_at desc;
  ```
  `value` is the JSON-serialised `{date, value}` point last emailed about;
  `date` is the effective date. Only `value` decides whether to email.
- **Confirm no second email on re-run:** run it again immediately. It should
  return `notified:0`: `notification_state` already holds the current value,
  so `shouldNotify` returns false. This is also why the two daily schedules
  never double-send.
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
