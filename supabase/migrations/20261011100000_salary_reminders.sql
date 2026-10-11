-- Plan 132 — monthly salary email submission (Stage 1: data model + functions).
--
-- Each person gets a monthly no-login link (tokenized, see salary_reminder_tokens)
-- to submit only their own half of the month's salaries. Halves wait in
-- salary_submission_drafts; once both exist, private.finalize_salary_month writes
-- ONE ordinary salary_submissions row in exactly the shape the in-app modal's
-- buildSubmission (web/src/lib/hushallsbudget.ts) produces, so History, export,
-- CSV and the transfer figure keep reading the same table unchanged.
--
-- Ownership: every table here is HOUSEHOLD-owned (household_id → households,
-- on delete cascade). private.household_has_persisted_data discovers them
-- automatically.
--
-- Write paths:
--   • salary_reminder_settings — household members select/insert/update their
--     own household's row (no delete; "no row" means enabled, day 25).
--   • salary_submission_drafts — members may only SELECT. Drafts are written by
--     the salary-reminder Edge Function (service role) and discarded through
--     public.discard_salary_drafts / private.finalize_salary_month.
--   • salary_reminder_tokens   — RLS on, NO policies, no client grants: only the
--     service role ever touches it. Only sha256(token) is stored.
--
-- No cron, HTTP or extension wiring here: this migration must be safe on
-- `supabase db reset` and in CI. Scheduling lives in the prod-only runbook.

-- ── shared month-format check ─────────────────────────────────────────────────

create or replace function private.is_salary_month(p_month text)
    returns boolean
    language sql
    immutable
    set search_path to ''
    as $$
  select p_month is not null and p_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$';
$$;

alter function private.is_salary_month(text) owner to postgres;
revoke all on function private.is_salary_month(text) from public, anon, authenticated;

-- ── settings: one row (or none) per household ─────────────────────────────────

create table if not exists public.salary_reminder_settings (
  household_id uuid not null primary key references public.households(id) on delete cascade,
  enabled      boolean not null default true,
  send_day     smallint not null default 25 check (send_day between 1 and 28),
  updated_at   timestamptz not null default now()
);

alter table public.salary_reminder_settings enable row level security;

create or replace trigger set_updated_at before update on public.salary_reminder_settings
  for each row execute function extensions.moddatetime('updated_at');

drop policy if exists hh_select on public.salary_reminder_settings;
create policy hh_select on public.salary_reminder_settings for select to authenticated
  using (household_id = (select private.current_household()));
drop policy if exists hh_insert on public.salary_reminder_settings;
create policy hh_insert on public.salary_reminder_settings for insert to authenticated
  with check (household_id = (select private.current_household()));
drop policy if exists hh_update on public.salary_reminder_settings;
create policy hh_update on public.salary_reminder_settings for update to authenticated
  using (household_id = (select private.current_household()))
  with check (household_id = (select private.current_household()));

revoke all on table public.salary_reminder_settings from public, anon, authenticated;
grant select, insert, update on table public.salary_reminder_settings to authenticated;
grant all on table public.salary_reminder_settings to service_role;

-- ── drafts: one pending half per (household, month, slot) ─────────────────────

create table if not exists public.salary_submission_drafts (
  household_id  uuid not null references public.households(id) on delete cascade,
  month         text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  slot          text not null check (slot in ('a', 'b')),
  -- [{label, amount}], already normalised by the Edge Function.
  income_items  jsonb not null check (pg_catalog.jsonb_typeof(income_items) = 'array'),
  note          text,
  -- 'app' is reserved; v1 only writes 'email'.
  submitted_via text not null check (submitted_via in ('email', 'app')),
  updated_at    timestamptz not null default now(),
  -- Re-submit = upsert on this key, never delete-then-insert (plan 43).
  primary key (household_id, month, slot)
);

alter table public.salary_submission_drafts enable row level security;

create or replace trigger set_updated_at before update on public.salary_submission_drafts
  for each row execute function extensions.moddatetime('updated_at');

drop policy if exists hh_select on public.salary_submission_drafts;
create policy hh_select on public.salary_submission_drafts for select to authenticated
  using (household_id = (select private.current_household()));

revoke all on table public.salary_submission_drafts from public, anon, authenticated;
grant select on table public.salary_submission_drafts to authenticated;
grant all on table public.salary_submission_drafts to service_role;

-- ── tokens: service role only ─────────────────────────────────────────────────

create table if not exists public.salary_reminder_tokens (
  id              uuid not null primary key default gen_random_uuid(),
  household_id    uuid not null references public.households(id) on delete cascade,
  slot            text not null check (slot in ('a', 'b')),
  month           text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  -- encode(sha256(token), 'hex'). The raw token is never stored.
  token_hash      text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  -- Snapshot at send time, for audit.
  recipient_email text not null,
  -- End of month+1, Europe/Stockholm (D8).
  expires_at      timestamptz not null,
  -- Set on finalise / discard and when the slot's email changes.
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists salary_reminder_tokens_household_month
  on public.salary_reminder_tokens (household_id, month);

alter table public.salary_reminder_tokens enable row level security;
-- Deliberately NO policies.

revoke all on table public.salary_reminder_tokens from public, anon, authenticated;
grant all on table public.salary_reminder_tokens to service_role;

-- ── display name helper (plan 111 resolution) ─────────────────────────────────
-- The household's person at a slot: the assigned account's profile name, else
-- the assigned email, else "Person A"/"Person B". Same rule as the inline
-- display_name in public.household_identity() (left unchanged).

create or replace function private.household_person_display_name(p_household uuid, p_slot text)
    returns text
    language sql
    security definer
    set search_path to ''
    stable
    as $$
  select coalesce(
    private.resolve_person_name(
      (select hp.assigned_email from public.household_people hp
        where hp.household_id = p_household and hp.slot = p_slot)),
    'Person ' || pg_catalog.upper(p_slot));
$$;

alter function private.household_person_display_name(uuid, text) owner to postgres;
revoke all on function private.household_person_display_name(uuid, text) from public, anon, authenticated;

-- ── draft items → owned submission items ──────────────────────────────────────
-- Mirrors buildSubmission's items(): labels trimmed, items with an empty label
-- AND a zero amount dropped, order preserved, each tagged with its owner.
-- Malformed items raise instead of being guessed (the Edge Function validates
-- first; this is defence in depth). Amounts stay exact numeric — no rounding.

create or replace function private.salary_owned_items(p_items jsonb, p_owner text)
    returns jsonb
    language plpgsql
    immutable
    set search_path to ''
    as $$
declare
  result jsonb;
begin
  if p_owner is null or p_owner not in ('a', 'b') then
    raise exception using errcode = '22023', message = 'invalid salary owner';
  end if;
  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid salary draft items';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_items) e(item)
    where pg_catalog.jsonb_typeof(e.item) <> 'object'
       or pg_catalog.jsonb_typeof(e.item -> 'label') is distinct from 'string'
       or pg_catalog.jsonb_typeof(e.item -> 'amount') is distinct from 'number'
  ) then
    raise exception using errcode = '22023', message = 'invalid salary draft items';
  end if;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object('owner', p_owner, 'label', n.label, 'amount', n.amount)
             order by n.ord),
           '[]'::jsonb)
    into result
  from (
    select e.ord,
           pg_catalog.btrim(e.item ->> 'label', E' \t\n\r\f\v') as label,
           (e.item ->> 'amount')::numeric as amount
    from pg_catalog.jsonb_array_elements(p_items) with ordinality e(item, ord)
  ) n
  where n.label <> '' or n.amount <> 0;

  return result;
end;
$$;

alter function private.salary_owned_items(jsonb, text) owner to postgres;
revoke all on function private.salary_owned_items(jsonb, text) from public, anon, authenticated;

-- ── clear a month's pending state (drafts + live tokens) ──────────────────────
-- Caller must already hold the month's advisory lock.

create or replace function private.clear_salary_month(p_household uuid, p_month text)
    returns void
    language sql
    security definer
    set search_path to ''
    as $$
  delete from public.salary_submission_drafts
   where household_id = p_household and month = p_month;
  update public.salary_reminder_tokens
     set revoked_at = pg_catalog.now()
   where household_id = p_household and month = p_month and revoked_at is null;
$$;

alter function private.clear_salary_month(uuid, text) owner to postgres;
revoke all on function private.clear_salary_month(uuid, text) from public, anon, authenticated;

-- ── finalise: two halves → one ordinary salary_submissions row ────────────────
--
-- Accepted trade-off (plan 132): the in-app SalaryModal saves through the
-- existing salaryStore.add outbox (sync_apply_rows), NOT under this function's
-- advisory lock. If both email halves finalise at the exact moment someone saves
-- the same month in the app, the month can get TWO salary_submissions rows. That
-- is the same duplicate state the modal already allows today (its "Already
-- logged … Add another entry for it?" confirm): visible in History, deletable,
-- and no data is lost. Routing the modal through a locking RPC would rewrite the
-- outbox path for a near-zero window, so we accept it. Leftover drafts/tokens
-- from such a race are cleared by the 'already_logged' branch below.
--
-- Outcomes:
--   'already_logged' — the month already has a salary_submissions row; its
--                      drafts are deleted and its tokens revoked.
--   'pending'        — fewer than two drafts; nothing changes.
--   'zero_total'     — income_a + income_b <= 0 (the modal's own guard);
--                      drafts are left for the app to finish.
--   'finalized'      — one row inserted, drafts deleted, tokens revoked.
--
-- The inserted row matches buildSubmission field for field: income_items =
-- A items (owner 'a') then B items (owner 'b'); income_a/income_b = item totals;
-- transfer_amount = |a − b| / 2, transfer_from = 'a' when a − b >= 0 else 'b',
-- transfer_to the other; equal_share = (a + b) / 2; note = non-empty draft notes
-- joined with ' · ' (A first) or null; person names from the plan-111 helper.
-- Exact numeric arithmetic, no rounding (× 0.5 is exact; trim_scale only drops
-- trailing zeros). The set_sync_revision trigger stamps revision = 1 on insert
-- exactly as for every other insert path, and the reject_tombstoned_row trigger
-- runs as usual (service-role / postgres branch, household from the row).
--
-- Service role only: no client role may execute it. NOTE: the `private` schema
-- is neither exposed through PostgREST nor USAGE-granted to service_role, so
-- the Edge Function cannot reach this through supabase-js .rpc() as-is; Stage 3
-- must call it over a direct postgres connection or via a public wrapper
-- executable by service_role only (owner decision).

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
  );

  perform private.clear_salary_month(p_household, p_month);
  return 'finalized';
end;
$$;

alter function private.finalize_salary_month(uuid, text) owner to postgres;
revoke all on function private.finalize_salary_month(uuid, text) from public, anon, authenticated;
grant execute on function private.finalize_salary_month(uuid, text) to service_role;

-- ── app-side discard after a successful in-app save ───────────────────────────
-- Deletes the caller's household's drafts for the month and revokes its tokens.
-- Household comes from the session, never from an argument.

create or replace function public.discard_salary_drafts(p_month text)
    returns void
    language plpgsql
    security definer
    set search_path to ''
    as $$
declare
  hid uuid := (select private.current_household());
begin
  if (select auth.uid()) is null or hid is null then
    raise exception using errcode = '42501', message = 'not in a household';
  end if;
  if not private.is_salary_month(p_month) then
    raise exception using errcode = '22023', message = 'invalid salary month';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(hid::text || p_month));
  perform private.clear_salary_month(hid, p_month);
end;
$$;

alter function public.discard_salary_drafts(text) owner to postgres;
revoke all on function public.discard_salary_drafts(text) from public, anon;
grant execute on function public.discard_salary_drafts(text) to authenticated;
