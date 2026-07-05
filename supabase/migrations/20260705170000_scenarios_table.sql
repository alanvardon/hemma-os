-- Plan 16f — Bostadskalkyl saved scenarios → cloud. One table; global prefs
-- (globalConstants + driftItems + savingsItems) live in the shared tool_state
-- blob (tool = 'bostadskalkyl-prefs'), not here. Scenario is the one non-snake
-- row type: `savedAt` (camelCase) becomes the `saved_at` column; the nested
-- inputs/constants keep their camelCase keys inside jsonb. ids are text
-- (Decision 7 — definitely not UUIDs). STD columns + hh_all (for all) policy +
-- set_updated_at trigger, as the other tables. Idempotent.

create table if not exists public.scenarios (
  id           text primary key default gen_random_uuid()::text,
  household_id uuid not null references public.households(id) default private.current_household(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  name         text not null default '',
  saved_at     text not null default '',     -- TS field is `savedAt` (ISO string)
  inputs       jsonb not null default '{}'::jsonb,
  constants    jsonb                          -- optional per-scenario constants
);
alter table public.scenarios enable row level security;
drop policy if exists hh_all on public.scenarios;
create policy hh_all on public.scenarios for all to authenticated
  using      (household_id = (select private.current_household()))
  with check (household_id = (select private.current_household()));
create or replace trigger set_updated_at before update on public.scenarios
  for each row execute function extensions.moddatetime('updated_at');
