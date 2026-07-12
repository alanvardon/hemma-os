-- Plan 71 — Huskalendern. One household-scoped row-store table `house_items`
-- (row per log/contract, à la manadsavslut/monthend_* and bolanekoll — NOT a
-- tool_state blob: items are edited independently and must survive concurrent
-- edits). Std columns + hh_all (for all) RLS policy + set_updated_at trigger,
-- exactly matching mortgage_* / monthend_*. Idempotent (safe to re-run).

create table if not exists public.house_items (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.households(id) default private.current_household(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  type           text not null default 'log',        -- 'log' | 'contract'
  title          text not null default '',
  category       text not null default 'övrigt',      -- underhåll | avtal | besiktning | övrigt
  date           date,                                -- log: when done · contract: when it expires
  cost           numeric,                             -- optional kr
  vendor         text,                                -- who did it / contract counterparty (free text)
  interval_years numeric,                             -- logs only: "every N years" soft hint
  remind_days    integer not null default 60,         -- contracts: flag within this window
  notes          text
);
alter table public.house_items enable row level security;
drop policy if exists hh_all on public.house_items;
create policy hh_all on public.house_items for all to authenticated
  using      (household_id = (select private.current_household()))
  with check (household_id = (select private.current_household()));
create or replace trigger set_updated_at before update on public.house_items
  for each row execute function extensions.moddatetime('updated_at');

grant all on table public.house_items to anon;
grant all on table public.house_items to authenticated;
grant all on table public.house_items to service_role;
