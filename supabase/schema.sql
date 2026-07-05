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
$$;

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


-- ── 16b — salary_submissions (pilot) ─────────────────────────────────────────
-- Mirrors SalarySubmission in hushallsbudget.ts. id is TEXT (Decision 7: the
-- store's fallback id isn't a UUID); equal_share is NUMERIC, not boolean.
create table public.salary_submissions (
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
create policy hh_all on public.salary_submissions for all to authenticated
  using      (household_id = (select private.current_household()))
  with check (household_id = (select private.current_household()));
create trigger set_updated_at before update on public.salary_submissions
  for each row execute procedure moddatetime (updated_at);




  create table public.tool_state (
  household_id uuid not null references public.households(id)
               default private.current_household(),
  tool         text not null,          -- 'manadsavslut-settings', 'hushallsbudget', …
  data         jsonb not null,
  updated_at   timestamptz not null default now(),
  primary key (household_id, tool)
);
alter table public.tool_state enable row level security;
create policy hh_all on public.tool_state for all to authenticated
  using      (household_id = (select private.current_household()))
  with check (household_id = (select private.current_household()));
create trigger set_updated_at before update on public.tool_state
  for each row execute procedure moddatetime (updated_at);





  create table public.monthend_items (
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
create policy hh_all on public.monthend_items for all to authenticated
  using      (household_id = (select private.current_household()))
  with check (household_id = (select private.current_household()));
create trigger set_updated_at before update on public.monthend_items
  for each row execute procedure moddatetime (updated_at);

create table public.monthend_payments (
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
create policy hh_all on public.monthend_payments for all to authenticated
  using      (household_id = (select private.current_household()))
  with check (household_id = (select private.current_household()));
create trigger set_updated_at before update on public.monthend_payments
  for each row execute procedure moddatetime (updated_at);