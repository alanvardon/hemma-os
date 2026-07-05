-- Plan 16e — Bolånekoll → cloud. Five data tables mirroring the five row types
-- in web/src/lib/mortgage.ts. Settings stay in the shared tool_state blob (tool
-- = 'bolanekoll-settings'), no table here. All ids are text (Decision 7) and all
-- dates are text (Decision 8 — the app sorts dates lexicographically and legacy
-- rows carry ''). Each table gets the STD columns + hh_all (for all) policy +
-- set_updated_at trigger, exactly as salary_submissions / monthend_* in the
-- baseline migration. Idempotent (safe to re-run).

-- ── mortgage_loan_parts ──────────────────────────────────────────────────────
create table if not exists public.mortgage_loan_parts (
  id            text primary key default gen_random_uuid()::text,
  household_id  uuid not null references public.households(id) default private.current_household(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  label         text not null default '',
  loan_number   text not null default '',
  start_balance numeric not null default 0,
  start_date    text not null default '',
  archived      boolean not null default false
);
alter table public.mortgage_loan_parts enable row level security;
drop policy if exists hh_all on public.mortgage_loan_parts;
create policy hh_all on public.mortgage_loan_parts for all to authenticated
  using      (household_id = (select private.current_household()))
  with check (household_id = (select private.current_household()));
create or replace trigger set_updated_at before update on public.mortgage_loan_parts
  for each row execute function extensions.moddatetime('updated_at');

-- ── mortgage_rate_periods ────────────────────────────────────────────────────
create table if not exists public.mortgage_rate_periods (
  id           text primary key default gen_random_uuid()::text,
  household_id uuid not null references public.households(id) default private.current_household(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  loan_part_id text,                              -- text id, null = property-wide
  start_date   text not null default '',
  end_date     text,
  rate         numeric,
  rate_type    text not null default 'rörlig'     -- 'rörlig' | 'bunden'
);
alter table public.mortgage_rate_periods enable row level security;
drop policy if exists hh_all on public.mortgage_rate_periods;
create policy hh_all on public.mortgage_rate_periods for all to authenticated
  using      (household_id = (select private.current_household()))
  with check (household_id = (select private.current_household()));
create or replace trigger set_updated_at before update on public.mortgage_rate_periods
  for each row execute function extensions.moddatetime('updated_at');

-- ── mortgage_payments ────────────────────────────────────────────────────────
create table if not exists public.mortgage_payments (
  id            text primary key default gen_random_uuid()::text,
  household_id  uuid not null references public.households(id) default private.current_household(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  loan_part_id  text,
  date          text not null default '',
  kind          text not null default 'payment',  -- interest|amortization|payment|loan|fee|other
  description   text not null default '',
  amount        numeric not null default 0,
  balance_after numeric,
  paid_by       text not null default 'joint',    -- 'a' | 'b' | 'joint'
  source        text not null default '',
  is_insats     boolean not null default false,
  paid_split    jsonb                             -- {a,b} | null
);
alter table public.mortgage_payments enable row level security;
drop policy if exists hh_all on public.mortgage_payments;
create policy hh_all on public.mortgage_payments for all to authenticated
  using      (household_id = (select private.current_household()))
  with check (household_id = (select private.current_household()));
create or replace trigger set_updated_at before update on public.mortgage_payments
  for each row execute function extensions.moddatetime('updated_at');

-- ── mortgage_valuations ──────────────────────────────────────────────────────
create table if not exists public.mortgage_valuations (
  id           text primary key default gen_random_uuid()::text,
  household_id uuid not null references public.households(id) default private.current_household(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  date         text not null default '',
  value        numeric not null default 0,
  note         text not null default '',
  is_purchase  boolean not null default false
);
alter table public.mortgage_valuations enable row level security;
drop policy if exists hh_all on public.mortgage_valuations;
create policy hh_all on public.mortgage_valuations for all to authenticated
  using      (household_id = (select private.current_household()))
  with check (household_id = (select private.current_household()));
create or replace trigger set_updated_at before update on public.mortgage_valuations
  for each row execute function extensions.moddatetime('updated_at');

-- ── mortgage_contributions ───────────────────────────────────────────────────
create table if not exists public.mortgage_contributions (
  id           text primary key default gen_random_uuid()::text,
  household_id uuid not null references public.households(id) default private.current_household(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  owner        text not null default 'joint',     -- 'a' | 'b' | 'joint'
  date         text not null default '',
  amount       numeric not null default 0,
  note         text not null default ''
);
alter table public.mortgage_contributions enable row level security;
drop policy if exists hh_all on public.mortgage_contributions;
create policy hh_all on public.mortgage_contributions for all to authenticated
  using      (household_id = (select private.current_household()))
  with check (household_id = (select private.current_household()));
create or replace trigger set_updated_at before update on public.mortgage_contributions
  for each row execute function extensions.moddatetime('updated_at');
