-- Hemma·OS — Supabase schema (source of truth for the migration, plan 16).
--
-- ⚠ APPLY VERBATIM. This whole file is IDEMPOTENT — every statement is
-- `… if not exists`, `create or replace`, or `drop policy if exists` + recreate.
-- To set up OR repair the database, paste this entire file into the SQL Editor
-- and run it. NEVER hand-edit objects in the dashboard and copy changes back:
-- that is how the RLS drift happened (a `for select`-only policy silenced every
-- insert). Re-running this file re-asserts the correct state.
--
-- After any change here, verify with `npm run audit:rls` (scripts/audit-rls.mjs)
-- and the per-table RLS round-trip in each phase's Definition of Done.

-- ── Household + membership (OURS → real uuid keys) ───────────────────────────
create table if not exists public.households (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.household_members (
  household_id uuid not null references public.households(id),
  user_id      uuid not null references auth.users(id),
  role         text not null default 'member',
  primary key (household_id, user_id)
);

create table if not exists public.household_invites (   -- used in 16h; created now
  household_id uuid not null references public.households(id),
  email        text not null,
  created_at   timestamptz not null default now(),
  primary key (household_id, email)
);

-- current_household() — security definer (avoids RLS recursion on
-- household_members) + the grant (authenticated must USE the private schema).
-- `order by household_id` makes it DETERMINISTIC: the column default and the
-- RLS with_check both call this, and if a user were ever in >1 household an
-- unordered `limit 1` could return different rows for each → a spurious insert
-- rejection. The app's model is one household per user, but this is cheap
-- insurance.
create schema if not exists private;

create or replace function private.current_household()
returns uuid
language sql
security definer
set search_path = ''
as $$
  select household_id from public.household_members
  where user_id = (select auth.uid())
  order by household_id
  limit 1;
$$;

grant usage on schema private to authenticated;

-- Household RLS — read-only from the client (the seed runs as owner, bypassing
-- RLS). These are `for select` ON PURPOSE (the client never inserts here).
alter table public.households        enable row level security;
alter table public.household_members enable row level security;
alter table public.household_invites enable row level security;

drop policy if exists hh_read on public.households;
create policy hh_read on public.households for select to authenticated
  using (id = (select private.current_household()));

drop policy if exists hm_read on public.household_members;
create policy hm_read on public.household_members for select to authenticated
  using (household_id = (select private.current_household()));

-- moddatetime powers every data table's updated_at trigger.
create extension if not exists moddatetime schema extensions;

-- ── Data tables ──────────────────────────────────────────────────────────────
-- Every table below carries `household_id` + the SAME policy shape. The policy
-- MUST be `for all` (not `for select`) with a `with check`, or inserts are
-- denied for everyone while reads still work — the exact bug that bit us.

-- 16b — salary_submissions (pilot). Mirrors SalarySubmission in
-- hushallsbudget.ts. id is TEXT (Decision 7); equal_share is NUMERIC.
create table if not exists public.salary_submissions (
  id              text primary key default gen_random_uuid()::text,
  household_id    uuid not null references public.households(id)
                  default private.current_household(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  month           text not null,               -- 'YYYY-MM'
  person_a_name   text,
  income_a        numeric,
  person_b_name   text,
  income_b        numeric,
  transfer_from   text,                         -- 'a' | 'b'
  transfer_to     text,
  transfer_amount numeric,
  equal_share     numeric,                      -- NOT boolean
  note            text,
  income_items    jsonb                         -- [{owner,label,amount}], never queried
);
alter table public.salary_submissions enable row level security;
drop policy if exists hh_all on public.salary_submissions;
create policy hh_all on public.salary_submissions for all to authenticated
  using      (household_id = (select private.current_household()))
  with check (household_id = (select private.current_household()));
create or replace trigger set_updated_at before update on public.salary_submissions
  for each row execute procedure moddatetime (updated_at);

-- 16c — tool_state: one jsonb blob row per household per tool (reused by
-- manadsavslut settings, hushallsbudget, konsult, lonevaxling, bolanekoll, …).
create table if not exists public.tool_state (
  household_id uuid not null references public.households(id)
               default private.current_household(),
  tool         text not null,          -- 'manadsavslut-settings', 'hushallsbudget', …
  data         jsonb not null,
  updated_at   timestamptz not null default now(),
  primary key (household_id, tool)
);
alter table public.tool_state enable row level security;
drop policy if exists hh_all on public.tool_state;
create policy hh_all on public.tool_state for all to authenticated
  using      (household_id = (select private.current_household()))
  with check (household_id = (select private.current_household()));
create or replace trigger set_updated_at before update on public.tool_state
  for each row execute procedure moddatetime (updated_at);

-- 16c — monthend_items.
create table if not exists public.monthend_items (
  id text primary key default gen_random_uuid()::text,
  household_id uuid not null references public.households(id) default private.current_household(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  date_purchased text not null default '',
  description    text not null default '',
  enter_amount   numeric not null default 0,
  split          boolean not null default true,
  amount         numeric not null default 0,
  fronted_by     text not null default 'a',    -- 'a' | 'b'
  owed_by        text not null default 'a',
  paid           boolean not null default false,
  pending        boolean not null default false,
  payment_id     text,                          -- text id of the settling payment
  note           text not null default '',
  personal_items jsonb not null default '[]',   -- [{person,amount,note}]
  personal_a     numeric not null default 0,    -- derived sums, store re-derives
  personal_b     numeric not null default 0
);
alter table public.monthend_items enable row level security;
drop policy if exists hh_all on public.monthend_items;
create policy hh_all on public.monthend_items for all to authenticated
  using      (household_id = (select private.current_household()))
  with check (household_id = (select private.current_household()));
create or replace trigger set_updated_at before update on public.monthend_items
  for each row execute procedure moddatetime (updated_at);

-- 16c — monthend_payments.
create table if not exists public.monthend_payments (
  id text primary key default gen_random_uuid()::text,
  household_id uuid not null references public.households(id) default private.current_household(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  item_ids     jsonb not null default '[]',     -- ["<item id>", …]
  from_person  text,                            -- 'a' | 'b' | null
  to_person    text,
  amount       numeric not null default 0,
  period_label text not null default '',
  note         text not null default ''
);
alter table public.monthend_payments enable row level security;
drop policy if exists hh_all on public.monthend_payments;
create policy hh_all on public.monthend_payments for all to authenticated
  using      (household_id = (select private.current_household()))
  with check (household_id = (select private.current_household()));
create or replace trigger set_updated_at before update on public.monthend_payments
  for each row execute procedure moddatetime (updated_at);
