-- Household + membership tables (these are OURS, so real uuid keys):

create table public.households (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households(id),
  user_id      uuid not null references auth.users(id),
  role         text not null default 'member',
  primary key (household_id, user_id)
);

create table public.household_invites (   -- used in 16h; created now
  household_id uuid not null references public.households(id),
  email        text not null,
  created_at   timestamptz not null default now(),
  primary key (household_id, email)
);
-- The current_household() helper — security definer + the grant are both mandatory (see master Household section for why: recursion + schema permission):

create schema if not exists private;

create or replace function private.current_household()
returns uuid
language sql
security definer
set search_path = ''
as $$
  select household_id from public.household_members
  where user_id = (select auth.uid())
  limit 1;


grant usage on schema private to authenticated;

--Household RLS (read-only from the client; the seed runs as owner and bypasses RLS):

alter table public.households        enable row level security;
alter table public.household_members enable row level security;
alter table public.household_invites enable row level security;

create policy hh_read on public.households for select to authenticated
  using (id = (select private.current_household()));
create policy hm_read on public.household_members for select to authenticated
  using (household_id = (select private.current_household()));


--Enable the moddatetime extension now (every later data table's updated_at trigger needs it):

create extension if not exists moddatetime schema extensions;