-- Plan 103 — Mortgage domain model: Bank → Mortgage → Lånedel.
-- Restructures the flat household → loan-parts model into the real Swedish bolån
-- hierarchy. Additive + idempotent (safe to re-run):
--   * new mortgage_banks   (label only — plan 104 adds the profile columns)
--   * new mortgages        (one bolån agreement, linked to exactly one bank)
--   * mortgage_loan_parts gains mortgage_id + original_balance + original_date
--   * seed one bank ("Danske") + one mortgage per household that already has
--     parts, then backfill every existing part's mortgage_id, and split the
--     origination anchor out of start_balance / start_date.
-- All ids are text and all dates are text, matching the bolanekoll baseline
-- (20260705160000): the app sorts dates lexicographically and legacy rows carry
-- ''. Std columns + hh_all RLS + set_updated_at trigger, exactly as the sibling
-- mortgage_* tables.

-- ── mortgage_banks ───────────────────────────────────────────────────────────
create table if not exists public.mortgage_banks (
  id           text primary key default gen_random_uuid()::text,
  household_id uuid not null references public.households(id) default private.current_household(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  label        text not null default ''
);
alter table public.mortgage_banks enable row level security;
drop policy if exists hh_all on public.mortgage_banks;
create policy hh_all on public.mortgage_banks for all to authenticated
  using      (household_id = (select private.current_household()))
  with check (household_id = (select private.current_household()));
create or replace trigger set_updated_at before update on public.mortgage_banks
  for each row execute function extensions.moddatetime('updated_at');
grant all on table public.mortgage_banks to anon;
grant all on table public.mortgage_banks to authenticated;
grant all on table public.mortgage_banks to service_role;

-- ── mortgages ────────────────────────────────────────────────────────────────
create table if not exists public.mortgages (
  id           text primary key default gen_random_uuid()::text,
  household_id uuid not null references public.households(id) default private.current_household(),
  bank_id      text references public.mortgage_banks(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  label        text not null default '',
  start_date   text,                               -- origination date (nullable)
  archived     boolean not null default false
);
alter table public.mortgages enable row level security;
drop policy if exists hh_all on public.mortgages;
create policy hh_all on public.mortgages for all to authenticated
  using      (household_id = (select private.current_household()))
  with check (household_id = (select private.current_household()));
create or replace trigger set_updated_at before update on public.mortgages
  for each row execute function extensions.moddatetime('updated_at');
grant all on table public.mortgages to anon;
grant all on table public.mortgages to authenticated;
grant all on table public.mortgages to service_role;

-- ── mortgage_loan_parts: new columns ─────────────────────────────────────────
-- mortgage_id reaches the bank via mortgage → bank. original_balance/_date are
-- the explicit origination anchor split out of the overloaded start_balance /
-- start_date pair (plan 103). All nullable; legacy rows fall back gracefully.
alter table public.mortgage_loan_parts
  add column if not exists mortgage_id      text references public.mortgages(id),
  add column if not exists original_balance numeric,
  add column if not exists original_date    text;

-- ── Seed + backfill (idempotent) ─────────────────────────────────────────────
-- One bank per household that owns parts, but only if it has none yet.
insert into public.mortgage_banks (household_id, label)
select distinct lp.household_id, 'Danske'
from public.mortgage_loan_parts lp
where not exists (
  select 1 from public.mortgage_banks b where b.household_id = lp.household_id
);

-- One mortgage per household that owns parts, linked to that household's bank,
-- but only if it has none yet.
insert into public.mortgages (household_id, bank_id, label)
select b.household_id, b.id, 'Bolån'
from public.mortgage_banks b
where not exists (
  select 1 from public.mortgages m where m.household_id = b.household_id
);

-- Backfill every part still lacking a mortgage to its household's mortgage.
-- min(id) is deterministic and, since this migration is the first to create
-- mortgages, resolves to the single seeded row per household.
update public.mortgage_loan_parts lp
set mortgage_id = (
  select min(m.id) from public.mortgages m where m.household_id = lp.household_id
)
where lp.mortgage_id is null
  and exists (select 1 from public.mortgages m where m.household_id = lp.household_id);

-- Split the origination anchor out of the overloaded start_balance / start_date.
-- Today's start_balance values already ARE origination amounts (plan 103).
update public.mortgage_loan_parts
set original_balance = start_balance,
    original_date    = start_date
where original_balance is null;

-- ── Wire the new tables into the plan-98 optimistic-concurrency sync system ──
-- Every mutable household table mutates ONLY through the receipt-backed
-- sync_apply_rows / sync_delete_rows RPCs (plan 98). The bank + mortgage tables
-- join that contract exactly like the sibling mortgage_* tables: a server-issued
-- `revision` stamped by the shared trigger, and direct client INSERT/UPDATE/DELETE
-- revoked so a stale client fails closed instead of bypassing the revision check.
-- (SELECT stays granted — reads are direct; only writes go through the RPC.)
alter table public.mortgage_banks add column if not exists revision bigint not null default 1;
alter table public.mortgages     add column if not exists revision bigint not null default 1;
do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'mortgage_banks_revision_safe') then
    alter table public.mortgage_banks add constraint mortgage_banks_revision_safe check (revision between 1 and 9007199254740991);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'mortgages_revision_safe') then
    alter table public.mortgages add constraint mortgages_revision_safe check (revision between 1 and 9007199254740991);
  end if;
end;
$$;
drop trigger if exists set_updated_at on public.mortgage_banks;
drop trigger if exists set_sync_revision on public.mortgage_banks;
create trigger set_sync_revision before insert or update on public.mortgage_banks
  for each row execute function private.set_sync_revision();
drop trigger if exists set_updated_at on public.mortgages;
drop trigger if exists set_sync_revision on public.mortgages;
create trigger set_sync_revision before insert or update on public.mortgages
  for each row execute function private.set_sync_revision();
revoke insert, update, delete on public.mortgage_banks, public.mortgages from anon, authenticated;

-- Register the two new resources with the sync RPCs, and add the plan-103 columns
-- to the mortgage_loan_parts allowlist. Re-declared verbatim from
-- 20260714110000_optimistic_concurrency (the latest definitions). The
-- mortgage_loan_parts key list is the UNION of plan 103's origination columns and
-- plan 105's planned_amortization columns: this migration is timestamped AFTER
-- 105's (…120000), so it must preserve 105's keys or a later `supabase db reset`
-- would drop them. Listing a key whose column is absent (105 not yet applied) is
-- harmless — sync_apply_rows only REJECTS rows carrying a disallowed key; it never
-- requires a listed key to exist.
create or replace function private.sync_table_for_resource(p_resource text)
returns text language sql immutable set search_path to '' as $$
  select case p_resource
    when 'scenarios' then 'scenarios'
    when 'salary_submissions' then 'salary_submissions'
    when 'monthend_items' then 'monthend_items'
    when 'monthend_payments' then 'monthend_payments'
    when 'mortgage_loan_parts' then 'mortgage_loan_parts'
    when 'mortgage_rate_periods' then 'mortgage_rate_periods'
    when 'mortgage_payments' then 'mortgage_payments'
    when 'mortgage_valuations' then 'mortgage_valuations'
    when 'mortgage_contributions' then 'mortgage_contributions'
    when 'mortgage_banks' then 'mortgage_banks'
    when 'mortgages' then 'mortgages'
    when 'house_items' then 'house_items'
  end
$$;
revoke all on function private.sync_table_for_resource(text) from public, anon, authenticated;

create or replace function private.sync_allowed_row_keys(p_resource text)
returns text[] language sql immutable set search_path to '' as $$
  select case p_resource
    when 'scenarios' then array['id','created_at','name','saved_at','inputs','constants']
    when 'salary_submissions' then array['id','created_at','month','person_a_name','income_a','person_b_name','income_b','transfer_from','transfer_to','transfer_amount','equal_share','note','income_items']
    when 'monthend_items' then array['id','created_at','date_purchased','description','enter_amount','split','amount','fronted_by','owed_by','paid','pending','payment_id','note','personal_items','personal_a','personal_b']
    when 'monthend_payments' then array['id','created_at','item_ids','from_person','to_person','amount','period_label','note']
    when 'mortgage_loan_parts' then array['id','created_at','label','loan_number','start_balance','start_date','archived','mortgage_id','original_balance','original_date','planned_amortization','planned_amortization_start','planned_amortization_end']
    when 'mortgage_rate_periods' then array['id','created_at','loan_part_id','start_date','end_date','rate','rate_type']
    when 'mortgage_payments' then array['id','created_at','loan_part_id','date','kind','description','amount','balance_after','paid_by','source','is_insats','paid_split']
    when 'mortgage_valuations' then array['id','created_at','date','value','note','is_purchase']
    when 'mortgage_contributions' then array['id','created_at','owner','date','amount','note']
    when 'mortgage_banks' then array['id','created_at','label']
    when 'mortgages' then array['id','created_at','bank_id','label','start_date','archived']
    when 'house_items' then array['id','created_at','type','title','category','date','cost','vendor','interval_years','remind_days','notes']
  end
$$;
revoke all on function private.sync_allowed_row_keys(text) from public, anon, authenticated;
