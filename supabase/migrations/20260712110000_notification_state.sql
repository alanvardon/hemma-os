-- Plan 72 — notification_state: idempotency guard for the policy-rate email
-- cron (supabase/functions/policy-rate-notify). Records, per household, the
-- last value we emailed about for a given notification `key` (only
-- 'policy_rate' for now). The Edge Function runs as the service role and
-- bypasses RLS to read/write this table; authenticated users get read-only
-- access for observability (so a member can see "when did we last notify
-- about this"), never write access — only the function ever changes rows.
--
-- This migration ONLY creates the table + RLS policy. It must be safe to run
-- in CI and on `supabase db reset`: no cron scheduling, no HTTP calls, no
-- extensions. The pg_cron/pg_net wiring lives in the prod-only runbook
-- (supabase/functions/policy-rate-notify/README.md) — never here.

create table if not exists public.notification_state (
  household_id uuid not null references public.households(id) on delete cascade,
  key          text not null,
  value        text not null,
  notified_at  timestamptz not null default now(),
  primary key (household_id, key)
);

alter table public.notification_state enable row level security;

create policy hh_select on public.notification_state for select to authenticated
  using (household_id = (select private.current_household()));
