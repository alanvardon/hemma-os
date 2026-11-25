-- Plan 140 (Stage 2) — Vindsplanen. One household-scoped `attic_plans` table
-- holding the attic plan as ONE jsonb document per row (PlanV2, validated by
-- the client's sanitizePlan on every read). The plan is edited as a single
-- document with a local undo stack, so it is not split into item rows
-- (precedent: scenarios.inputs is jsonb). Household-level ownership: both
-- partners edit the same plan.
--
-- Table / RLS shape copied from 20260712100000_huskalendern_house_items.sql;
-- the revision column, its check constraint, the set_sync_revision trigger
-- (which replaces the moddatetime set_updated_at trigger — set_sync_revision
-- stamps updated_at itself) and the revoke of direct client writes copied from
-- how 20260714110000_optimistic_concurrency.sql applied them to house_items.
-- Idempotent (safe to re-run).

-- ── 1. Table + RLS ──────────────────────────────────────────────────────────
create table if not exists public.attic_plans (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.households(id) default private.current_household(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  name           text not null default 'Vindsplanen' check (char_length(name) between 1 and 80),
  schema_version int not null default 2 check (schema_version between 2 and 99),
  plan           jsonb not null check (jsonb_typeof(plan) = 'object' and pg_column_size(plan) < 1000000)
);
alter table public.attic_plans enable row level security;
drop policy if exists hh_all on public.attic_plans;
create policy hh_all on public.attic_plans for all to authenticated
  using      (household_id = (select private.current_household()))
  with check (household_id = (select private.current_household()));

grant all on table public.attic_plans to anon;
grant all on table public.attic_plans to authenticated;
grant all on table public.attic_plans to service_role;

-- ── 2. Server revision (as 20260714110000 did for house_items) ──────────────
alter table public.attic_plans add column if not exists revision bigint not null default 1;
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint c
    join pg_catalog.pg_class r on r.oid = c.conrelid
    join pg_catalog.pg_namespace n on n.oid = r.relnamespace
    where n.nspname = 'public' and r.relname = 'attic_plans'
      and c.conname = 'attic_plans_revision_safe'
  ) then
    alter table public.attic_plans
      add constraint attic_plans_revision_safe check (revision between 1 and 9007199254740991);
  end if;
end;
$$;
drop trigger if exists set_updated_at on public.attic_plans;
drop trigger if exists set_sync_revision on public.attic_plans;
create trigger set_sync_revision before insert or update on public.attic_plans
  for each row execute function private.set_sync_revision();

-- ── 3. Direct client writes revoked ─────────────────────────────────────────
-- As 20260714100000 (delete/truncate/references/trigger) and 20260714110000
-- (insert/update/delete) did for house_items: every write must pass through
-- the receipt-backed, revision-checked public.sync_apply_rows. Reads stay
-- household-scoped via hh_all.
revoke insert, update, delete on public.attic_plans from anon, authenticated;
revoke truncate, references, trigger on public.attic_plans from anon, authenticated;

-- ── 4. Deliberately NOT mirrored from house_items ───────────────────────────
-- * reject_tombstoned_row trigger (20260714100000): attic_plans rows are never
--   deleted (the UI's "reset to example" is a save), so no tombstone can exist
--   for this resource and the trigger would guard nothing.
-- * delete arms in public.sync_delete_rows / public.delete_household_rows: no
--   client delete path. Both CASEs fail closed for 'attic_plans'
--   (sync_delete_rows' `else` raises 22023; delete_household_rows is revoked
--   from clients and its CASE has no else), so a generic delete is rejected.
-- * The house_items uuid-id pre-check inside public.sync_apply_rows: adding it
--   would mean re-declaring that whole RPC. A non-uuid id for attic_plans
--   already fails the uuid cast in sync_apply_one_row (22P02 → validation).
-- * private.household_has_persisted_data: it discovers every public table with
--   a household_id column dynamically, so attic_plans is covered unchanged.
-- * private.sync_tool_allowed: tool_state only; attic_plans is a row resource.
-- jsonb round-trip: sync_apply_one_row populates via
-- jsonb_populate_record(null::public.attic_plans, row), so `plan` (jsonb) is
-- carried as the nested JSON value, exactly as scenarios.inputs/constants are.

-- ── 5. Sync system redeclarations ───────────────────────────────────────────
-- Plan-84 landmine: each is re-declared from its LATEST applied text; exactly
-- one 'attic_plans' arm is added and every other arm is byte-identical.

-- Copied from 20260716100000_mortgage_agreement_lifecycle.sql §8 (latest).
-- ONLY 'attic_plans' is added.
create or replace function private.sync_resource_allowed(p_resource text)
returns boolean language sql immutable set search_path to '' as $$
  select p_resource = any (array[
    'scenarios', 'salary_submissions', 'monthend_items', 'monthend_payments',
    'mortgage_loan_parts', 'mortgage_rate_periods', 'mortgage_payments',
    'mortgage_valuations', 'mortgage_contributions', 'house_items',
    'mortgages', 'attic_plans'
  ]::text[])
$$;
revoke all on function private.sync_resource_allowed(text) from public, anon, authenticated;

-- Copied from 20260716100000_mortgage_agreement_lifecycle.sql §8 (latest).
-- ONLY the 'attic_plans' arm is added.
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
    when 'attic_plans' then 'attic_plans'
  end
$$;
revoke all on function private.sync_table_for_resource(text) from public, anon, authenticated;

-- Copied from 20260905100000_bank_charge_basis_profile.sql (latest).
-- ONLY the 'attic_plans' arm is added. household_id, updated_at and revision
-- are server-owned and therefore not client keys.
create or replace function private.sync_allowed_row_keys(p_resource text)
returns text[] language sql immutable set search_path to '' as $$
  select case p_resource
    when 'scenarios' then array['id','created_at','name','saved_at','inputs','constants']
    when 'salary_submissions' then array['id','created_at','month','person_a_name','income_a','person_b_name','income_b','transfer_from','transfer_to','transfer_amount','equal_share','note','income_items']
    when 'monthend_items' then array['id','created_at','date_purchased','description','enter_amount','split','amount','fronted_by','owed_by','paid','pending','payment_id','note','personal_items','personal_a','personal_b']
    when 'monthend_payments' then array['id','created_at','item_ids','from_person','to_person','amount','period_label','note']
    when 'mortgage_loan_parts' then array['id','created_at','label','loan_number','start_balance','start_date','archived','mortgage_id','original_balance','original_date','planned_amortization','planned_amortization_start','planned_amortization_end']
    when 'mortgage_rate_periods' then array['id','created_at','loan_part_id','start_date','end_date','rate','rate_type']
    when 'mortgage_payments' then array['id','created_at','loan_part_id','date','kind','description','amount','balance_after','paid_by','source','is_insats','paid_split','mortgage_id']
    when 'mortgage_valuations' then array['id','created_at','date','value','note','is_purchase']
    when 'mortgage_contributions' then array['id','created_at','owner','date','amount','note']
    when 'mortgage_banks' then array['id','created_at','label','year_basis','year_basis_source','billing','billing_source','catalog_id','charge_basis','charge_basis_source']
    when 'mortgages' then array['id','created_at','bank_id','label','start_date','archived','end_date']
    when 'house_items' then array['id','created_at','type','title','category','date','cost','vendor','interval_years','remind_days','notes']
    when 'attic_plans' then array['id','created_at','name','schema_version','plan']
  end
$$;
revoke all on function private.sync_allowed_row_keys(text) from public, anon, authenticated;
