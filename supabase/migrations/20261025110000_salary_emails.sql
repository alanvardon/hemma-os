-- Plan 139 Stage 5 — salary emails (D7 partner email, D8 results email).
--
-- Two new emails, sent by the salary-email-send Edge Function (prod-only
-- pg_cron every 5 minutes, see supabase/functions/salary-email-send/README.md):
--   • 'partner_submitted' (D7) — when one person's half is FIRST submitted (app
--     or email link), the other person is told, with NO amounts.
--   • 'month_results'     (D8) — when finalize_salary_month completes a month,
--     both people get the totals, "each takes home" and who pays whom (amounts
--     in email are owner-approved, 2026-10-25). Any member can re-request it
--     ("Skicka resultatet igen") with the row's figures as they are at send time.
--
-- One outbox, public.salary_emails, so claim/retry/logging exists once. Rows are
-- only ever ENQUEUED here, inside the database:
--   • an AFTER INSERT trigger on salary_submission_drafts (partner email). An
--     upsert that hits the conflict path fires UPDATE triggers, not INSERT, so
--     editing a half never enqueues. One trigger covers both the app RPC
--     (public.save_salary_half) and the salary-reminder Edge Function's direct
--     upsert, with no change to that function;
--   • private.finalize_salary_month's 'finalized' branch (automatic results).
--     Rows created any other way — JSON import / sync_apply_rows, the legacy
--     first-login import — enqueue NOTHING, so importing history never floods
--     anyone's inbox;
--   • public.request_salary_results_email (manual resend, authenticated).
-- The sender decides send/skip at send time (salaryEmailDecision in
-- supabase/functions/_shared/salary-reminder-logic.ts): e.g. a partner email
-- for a month that has since completed is skipped, since the results email
-- covers it.
--
-- Ownership: salary_emails is HOUSEHOLD-owned (household_id → households, on
-- delete cascade). private.household_has_persisted_data discovers it
-- automatically. RLS on, NO policies, no client grants: only the service role
-- reads or writes it directly (like salary_reminder_tokens). Clients see their
-- household's results-email status only through
-- public.salary_results_email_status().
--
-- No cron, HTTP or extension wiring here: safe on `supabase db reset` and in CI.

-- ── settings: two household toggles (D7/D8), default ON ───────────────────────
-- "No row" still means every default, so both on. The existing hh_insert /
-- hh_update policies and the table-level grants cover the new columns.
-- email_results only stops the AUTOMATIC results email; a manual resend is an
-- explicit request and always sends.

alter table public.salary_reminder_settings
  add column if not exists notify_partner boolean not null default true,
  add column if not exists email_results  boolean not null default true;

-- ── the outbox ────────────────────────────────────────────────────────────────

create table if not exists public.salary_emails (
  id             uuid not null primary key default gen_random_uuid(),
  household_id   uuid not null references public.households(id) on delete cascade,
  month          text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  kind           text not null check (kind in ('partner_submitted', 'month_results')),
  -- partner_submitted only: whose half was submitted.
  submitter_slot text check (submitter_slot in ('a', 'b')),
  -- month_results only: the salary_submissions.id it reports. No foreign key on
  -- purpose: a month row may be deleted; the sender then skips the email.
  submission_id  text,
  "trigger"      text not null check ("trigger" in ('auto', 'manual')),
  -- auth.uid() at enqueue time; null on the service-role (email link) path.
  actor_user_id  uuid,
  created_at     timestamptz not null default now(),
  -- Incremented by every claim; a row is claimed at most 5 times.
  attempts       smallint not null default 0 check (attempts between 0 and 5),
  -- Lease: set by a claim, cleared by a failed completion. A row claimed by a
  -- run that died is claimable again after 15 minutes (see claim below).
  claimed_at     timestamptz,
  -- Status code only (e.g. 'Resend 503'), NEVER a response body or address.
  last_error     text check (pg_catalog.length(last_error) <= 200),
  sent_at        timestamptz,
  skipped_reason text check (pg_catalog.length(skipped_reason) <= 64),
  check (
    (kind = 'partner_submitted' and submitter_slot is not null and submission_id is null and "trigger" = 'auto')
    or (kind = 'month_results' and submitter_slot is null and submission_id is not null)
  )
);

-- One partner email per half per month, EVER. Accepted (plan 139): if a month
-- is deleted and someone submits it afresh, no second partner email goes out.
create unique index if not exists salary_emails_partner_once
  on public.salary_emails (household_id, month, submitter_slot)
  where kind = 'partner_submitted';

-- The D8 throttle: at most one UNSENT results email per month in the queue.
-- A row that exhausted its 5 attempts no longer counts (attempts < 5), so a
-- permanently failed email can never block every future request for the month.
create unique index if not exists salary_emails_results_one_unsent
  on public.salary_emails (household_id, month)
  where kind = 'month_results' and sent_at is null and skipped_reason is null and attempts < 5;

create index if not exists salary_emails_claimable
  on public.salary_emails (created_at)
  where sent_at is null and skipped_reason is null;

create index if not exists salary_emails_submission
  on public.salary_emails (household_id, submission_id)
  where kind = 'month_results';

alter table public.salary_emails enable row level security;
-- Deliberately NO policies.

revoke all on table public.salary_emails from public, anon, authenticated;
grant all on table public.salary_emails to service_role;

-- ── D7: enqueue the partner email when a half is FIRST inserted ───────────────
-- AFTER INSERT only (see header). on conflict do nothing: one per half per
-- month, ever. The sender skips it if the month is complete by send time, if
-- notify_partner is off, or if the recipient is not a current member / is the
-- person who acted.

create or replace function private.enqueue_salary_partner_email()
    returns trigger
    language plpgsql
    security definer
    set search_path to ''
    as $$
begin
  insert into public.salary_emails (household_id, month, kind, submitter_slot, "trigger", actor_user_id)
  values (new.household_id, new.month, 'partner_submitted', new.slot, 'auto', (select auth.uid()))
  on conflict (household_id, month, submitter_slot) where kind = 'partner_submitted' do nothing;
  return null;
end;
$$;

alter function private.enqueue_salary_partner_email() owner to postgres;
revoke all on function private.enqueue_salary_partner_email() from public, anon, authenticated;

drop trigger if exists enqueue_salary_partner_email on public.salary_submission_drafts;
create trigger enqueue_salary_partner_email after insert on public.salary_submission_drafts
  for each row execute function private.enqueue_salary_partner_email();

-- ── finalise: redefined to enqueue the automatic results email (D8) ───────────
--
-- Copied VERBATIM from the latest definition (20261011100000_salary_reminders.sql;
-- 20261025100000_salary_app_halves.sql calls it but does not redefine it).
-- The ONLY changes: `new_id` is declared, the salary_submissions insert gains
-- `returning id into new_id`, and the 'finalized' branch enqueues one
-- 'month_results' / 'auto' row for that id. Everything else — locking, the
-- outcomes, the buildSubmission-shaped row, the grants — is unchanged; the
-- plan-132 comment above the original definition still describes it.
--
-- The enqueue uses on conflict do nothing on the one-unsent throttle: the only
-- way to hit it is a manual request still queued for an earlier (since deleted)
-- row of the same month. Finalizing must never fail a person's save over an
-- email; that stale request is skipped by the sender as 'submission_deleted'.

create or replace function private.finalize_salary_month(p_household uuid, p_month text)
    returns text
    language plpgsql
    security definer
    set search_path to ''
    as $$
declare
  draft_a public.salary_submission_drafts%rowtype;
  draft_b public.salary_submission_drafts%rowtype;
  items_a jsonb;
  items_b jsonb;
  income_a numeric;
  income_b numeric;
  gap numeric;
  note_out text;
  new_id text;
begin
  if p_household is null then
    raise exception using errcode = '22023', message = 'invalid household';
  end if;
  if not private.is_salary_month(p_month) then
    raise exception using errcode = '22023', message = 'invalid salary month';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_household::text || p_month));

  if exists (select 1 from public.salary_submissions
              where household_id = p_household and month = p_month) then
    perform private.clear_salary_month(p_household, p_month);
    return 'already_logged';
  end if;

  -- FOR UPDATE: a concurrent re-submit either commits before we read (and is
  -- used) or waits until we commit (and then lands on an already-logged month).
  select * into draft_a from public.salary_submission_drafts
   where household_id = p_household and month = p_month and slot = 'a'
   for update;
  if not found then return 'pending'; end if;
  select * into draft_b from public.salary_submission_drafts
   where household_id = p_household and month = p_month and slot = 'b'
   for update;
  if not found then return 'pending'; end if;

  items_a := private.salary_owned_items(draft_a.income_items, 'a');
  items_b := private.salary_owned_items(draft_b.income_items, 'b');
  select coalesce(sum((e.item ->> 'amount')::numeric), 0) into income_a
    from pg_catalog.jsonb_array_elements(items_a) e(item);
  select coalesce(sum((e.item ->> 'amount')::numeric), 0) into income_b
    from pg_catalog.jsonb_array_elements(items_b) e(item);

  if income_a + income_b <= 0 then
    return 'zero_total';
  end if;

  gap := income_a - income_b;
  note_out := nullif(pg_catalog.concat_ws(' · ',
    nullif(pg_catalog.btrim(draft_a.note, E' \t\n\r\f\v'), ''),
    nullif(pg_catalog.btrim(draft_b.note, E' \t\n\r\f\v'), '')), '');

  insert into public.salary_submissions (
    household_id, month,
    person_a_name, income_a,
    person_b_name, income_b,
    transfer_from, transfer_to, transfer_amount,
    equal_share, note, income_items
  ) values (
    p_household, p_month,
    private.household_person_display_name(p_household, 'a'), income_a,
    private.household_person_display_name(p_household, 'b'), income_b,
    case when gap >= 0 then 'a' else 'b' end,
    case when gap >= 0 then 'b' else 'a' end,
    pg_catalog.trim_scale(abs(gap) * 0.5),
    pg_catalog.trim_scale((income_a + income_b) * 0.5),
    note_out,
    items_a || items_b
  )
  returning id into new_id;

  -- Plan 139 D8: the automatic results email for exactly this new row.
  insert into public.salary_emails (household_id, month, kind, submission_id, "trigger", actor_user_id)
  values (p_household, p_month, 'month_results', new_id, 'auto', (select auth.uid()))
  on conflict (household_id, month)
    where kind = 'month_results' and sent_at is null and skipped_reason is null and attempts < 5
    do nothing;

  perform private.clear_salary_month(p_household, p_month);
  return 'finalized';
end;
$$;

alter function private.finalize_salary_month(uuid, text) owner to postgres;
revoke all on function private.finalize_salary_month(uuid, text) from public, anon, authenticated;
grant execute on function private.finalize_salary_month(uuid, text) to service_role;

-- ── D8: manual resend ("Skicka resultatet igen") ──────────────────────────────
-- Household from the session, never an argument. The row must exist in the
-- caller's household, else 42501 (an id from another household is
-- indistinguishable from a missing one). Returns:
--   'queued'         — a fresh results email was enqueued;
--   'already_queued' — this month already has an unsent results email (the D8
--                      throttle; nothing written).
-- Always sends regardless of email_results (an explicit request). The figures
-- are read when the email is SENT, so it carries the row as it is then.

create or replace function public.request_salary_results_email(p_submission_id text)
    returns text
    language plpgsql
    security definer
    set search_path to ''
    as $$
declare
  hid uuid := (select private.current_household());
  uid uuid := (select auth.uid());
  sub_month text;
  new_id uuid;
begin
  if uid is null or hid is null then
    raise exception using errcode = '42501', message = 'not in a household';
  end if;
  select s.month into sub_month from public.salary_submissions s
   where s.id = p_submission_id and s.household_id = hid;
  if not found or not private.is_salary_month(sub_month) then
    raise exception using errcode = '42501', message = 'not your salary month';
  end if;

  insert into public.salary_emails (household_id, month, kind, submission_id, "trigger", actor_user_id)
  values (hid, sub_month, 'month_results', p_submission_id, 'manual', uid)
  on conflict (household_id, month)
    where kind = 'month_results' and sent_at is null and skipped_reason is null and attempts < 5
    do nothing
  returning id into new_id;

  return case when new_id is null then 'already_queued' else 'queued' end;
end;
$$;

alter function public.request_salary_results_email(text) owner to postgres;
revoke all on function public.request_salary_results_email(text) from public, anon;
grant execute on function public.request_salary_results_email(text) to authenticated;

-- ── sender: claim a batch (service role only) ─────────────────────────────────
-- Claimable: unsent, unskipped, fewer than 5 attempts, and not leased by a
-- live run (claimed_at null, or older than 15 minutes — a run that died).
-- FOR UPDATE SKIP LOCKED + the lease mean two overlapping runs never claim the
-- same row, whether they race inside one instant or one commits first.
-- Each claim counts as an attempt. p_limit must be 1..100.

create or replace function public.claim_salary_emails(p_limit integer)
    returns setof public.salary_emails
    language plpgsql
    security definer
    set search_path to ''
    as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception using errcode = '22023', message = 'invalid claim limit';
  end if;
  return query
  with picked as (
    select e.id from public.salary_emails e
     where e.sent_at is null and e.skipped_reason is null and e.attempts < 5
       and (e.claimed_at is null or e.claimed_at < pg_catalog.now() - interval '15 minutes')
     order by e.created_at, e.id
     for update skip locked
     limit p_limit
  )
  update public.salary_emails e
     set attempts = e.attempts + 1, claimed_at = pg_catalog.clock_timestamp()
    from picked
   where e.id = picked.id
  returning e.*;
end;
$$;

alter function public.claim_salary_emails(integer) owner to postgres;
revoke all on function public.claim_salary_emails(integer) from public, anon, authenticated;
grant execute on function public.claim_salary_emails(integer) to service_role;

-- ── sender: record the outcome of one claimed row (service role only) ─────────
--   'sent'    → sent_at = now(), last_error cleared.
--   'skipped' → skipped_reason = p_detail (a short code, e.g. 'opted_out').
--   'failed'  → last_error = p_detail (status code only), lease released, so
--               the next run retries it until attempts = 5.
-- Only an open row (not yet sent or skipped) can be completed; anything else
-- raises P0002 so a double completion is loud, not silent.

create or replace function public.complete_salary_email(p_id uuid, p_outcome text, p_detail text)
    returns void
    language plpgsql
    security definer
    set search_path to ''
    as $$
begin
  if p_outcome is null or p_outcome not in ('sent', 'skipped', 'failed') then
    raise exception using errcode = '22023', message = 'invalid salary email outcome';
  end if;
  if p_outcome = 'skipped' and (p_detail is null or p_detail = '' or pg_catalog.length(p_detail) > 64) then
    raise exception using errcode = '22023', message = 'invalid skip reason';
  end if;

  update public.salary_emails e
     set sent_at        = case when p_outcome = 'sent' then pg_catalog.now() else e.sent_at end,
         skipped_reason = case when p_outcome = 'skipped' then p_detail else e.skipped_reason end,
         last_error     = case p_outcome
                            when 'sent' then null
                            when 'failed' then pg_catalog.left(coalesce(nullif(p_detail, ''), 'failed'), 200)
                            else e.last_error end,
         claimed_at     = case when p_outcome = 'failed' then null else e.claimed_at end
   where e.id = p_id and e.sent_at is null and e.skipped_reason is null;
  if not found then
    raise exception using errcode = 'P0002', message = 'no open salary email';
  end if;
end;
$$;

alter function public.complete_salary_email(uuid, text, text) owner to postgres;
revoke all on function public.complete_salary_email(uuid, text, text) from public, anon, authenticated;
grant execute on function public.complete_salary_email(uuid, text, text) to service_role;

-- ── Löner: results-email status per month row (authenticated) ─────────────────
-- One row per salary_submissions id in the caller's household that has ever
-- had a results email:
--   last_sent_at — when one was last sent (null if never);
--   queued       — an unsent, unskipped one with attempts left is waiting.
-- Löner shows "Senast mejlat <datum>" / "Ett mejl är på väg", and "the month has
-- changed since the last email" when the row's updated_at > last_sent_at.
-- No client grant on the table itself.

create or replace function public.salary_results_email_status()
    returns table (submission_id text, last_sent_at timestamptz, queued boolean)
    language plpgsql
    stable
    security definer
    set search_path to ''
    as $$
declare
  hid uuid := (select private.current_household());
begin
  if (select auth.uid()) is null or hid is null then
    raise exception using errcode = '42501', message = 'not in a household';
  end if;
  return query
  select e.submission_id,
         max(e.sent_at),
         coalesce(bool_or(e.sent_at is null and e.skipped_reason is null and e.attempts < 5), false)
    from public.salary_emails e
   where e.household_id = hid and e.kind = 'month_results'
   group by e.submission_id;
end;
$$;

alter function public.salary_results_email_status() owner to postgres;
revoke all on function public.salary_results_email_status() from public, anon;
grant execute on function public.salary_results_email_status() to authenticated;
