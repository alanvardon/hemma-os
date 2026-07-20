-- Plan 111 (Stage 1) — household person identity: canonical people,
-- account-to-person mapping and per-tool A/B bindings.
--
-- Three deliberately separate concepts (see planning/111):
--   • household_people             — the two canonical financial people of a
--                                    household (slot 'a'/'b' is stable canonical
--                                    order, never a login role).
--   • household_members.person_id  — which canonical person the signed-in
--                                    ACCOUNT represents. Nullable: accounts
--                                    start unmapped; leaving a household drops
--                                    the mapping with the membership row and
--                                    never deletes household_people.
--   • household_tool_person_bindings — compatibility layer binding each legacy
--                                    tool A/B slot to a canonical person so no
--                                    persisted A/B row is ever reordered.
--
-- Write path: security-definer RPCs only (like household_members). Tables are
-- household-readable via RLS; direct client mutation grants are revoked so the
-- atomic/validated RPCs cannot be bypassed.
--
-- Lifecycle interplay (no changes needed in the lifecycle RPCs):
--   • accept_invite/claim/leave delete the membership row → mapping goes with
--     it; the new membership row starts with person_id null (unmapped).
--   • private.household_has_persisted_data() discovers household_id tables
--     dynamically, so a household with configured people now counts as
--     "persisted data" and a sole member is P0004-blocked from abandoning it —
--     consistent with never stranding or deleting person history.

-- ── canonical household people ────────────────────────────────────────────────

create table if not exists public.household_people (
  id           uuid not null default gen_random_uuid() primary key,
  household_id uuid not null references public.households(id),
  slot         text not null check (slot in ('a', 'b')),
  display_name text not null
    check (display_name = btrim(display_name)
           and length(display_name) between 1 and 60),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (household_id, slot),
  -- Composite target for same-household FKs below.
  unique (household_id, id)
);

alter table public.household_people enable row level security;
drop policy if exists hh_select on public.household_people;
create policy hh_select on public.household_people for select to authenticated
  using (household_id = (select private.current_household()));
create or replace trigger set_updated_at before update on public.household_people
  for each row execute function extensions.moddatetime('updated_at');

revoke all on table public.household_people from public, anon, authenticated;
grant select on table public.household_people to authenticated;
grant all on table public.household_people to service_role;

-- ── account-to-person mapping ─────────────────────────────────────────────────

alter table public.household_members
  add column if not exists person_id uuid;

-- Same-household composite FK: an account can only map to a person of the
-- household it belongs to. person_id null ⇒ FK not enforced (MATCH SIMPLE).
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'household_members_person_fkey'
      and conrelid = 'public.household_members'::regclass
  ) then
    alter table public.household_members
      add constraint household_members_person_fkey
      foreign key (household_id, person_id)
      references public.household_people (household_id, id);
  end if;
end $$;

-- Two accounts in one household can never claim the same person.
create unique index if not exists household_members_person_unique
  on public.household_members (household_id, person_id)
  where person_id is not null;

-- ── tool A/B bindings ─────────────────────────────────────────────────────────

create table if not exists public.household_tool_person_bindings (
  household_id uuid not null references public.households(id),
  tool         text not null
    check (tool in ('bolanekoll', 'hushallsbudget', 'manadsavslut')),
  tool_slot    text not null check (tool_slot in ('a', 'b')),
  person_id    uuid not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (household_id, tool, tool_slot),
  unique (household_id, tool, person_id),
  foreign key (household_id, person_id)
    references public.household_people (household_id, id)
);

alter table public.household_tool_person_bindings enable row level security;
drop policy if exists hh_select on public.household_tool_person_bindings;
create policy hh_select on public.household_tool_person_bindings
  for select to authenticated
  using (household_id = (select private.current_household()));
create or replace trigger set_updated_at
  before update on public.household_tool_person_bindings
  for each row execute function extensions.moddatetime('updated_at');

revoke all on table public.household_tool_person_bindings
  from public, anon, authenticated;
grant select on table public.household_tool_person_bindings to authenticated;
grant all on table public.household_tool_person_bindings to service_role;

-- ── read RPC: the client identity view ────────────────────────────────────────
-- Everything the client needs in one household-scoped payload:
--   { "household_id": uuid,
--     "my_person_id": uuid | null,
--     "people":   [ { "id": uuid, "slot": "a"|"b", "display_name": text } ],
--     "bindings": { "<tool>": { "a": person-uuid, "b": person-uuid } } }
-- Returns null when the caller has no household. Nothing outside the caller's
-- household is ever read.

create or replace function public.household_identity()
    returns jsonb
    language plpgsql
    security definer
    set search_path to ''
    as $$
declare
  uid uuid := (select auth.uid());
  hid uuid;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  select household_id into hid from public.household_members where user_id = uid;
  if hid is null then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'household_id', hid,
    'my_person_id',
      (select person_id from public.household_members where user_id = uid),
    'people', coalesce(
      (select pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                  'id', p.id, 'slot', p.slot, 'display_name', p.display_name)
                order by p.slot)
         from public.household_people p
        where p.household_id = hid),
      '[]'::jsonb),
    'bindings', coalesce(
      (select pg_catalog.jsonb_object_agg(t.tool, t.slots)
         from (select b.tool,
                      pg_catalog.jsonb_object_agg(b.tool_slot, b.person_id) as slots
                 from public.household_tool_person_bindings b
                where b.household_id = hid
                group by b.tool) t),
      '{}'::jsonb));
end;
$$;

alter function public.household_identity() owner to postgres;
revoke all on function public.household_identity() from public, anon;
grant execute on function public.household_identity() to authenticated;

-- ── write RPC: configure people + a complete tool binding atomically ──────────
-- Creates/renames the two canonical people (upsert by household+slot) and, when
-- a tool is given, replaces that tool's binding with a COMPLETE a+b mapping.
-- p_tool_slot_a_person / p_tool_slot_b_person name the CANONICAL slot ('a'|'b')
-- each tool slot represents, so the first call can create people and bind a
-- tool in one transaction. Any household member may call it (same collaboration
-- semantics as editing shared tool names). Idempotent: retrying the identical
-- call rewrites nothing and can never create duplicate people or bindings.

create or replace function public.configure_household_people(
    p_person_a_name text,
    p_person_b_name text,
    p_tool text default null,
    p_tool_slot_a_person text default null,
    p_tool_slot_b_person text default null
) returns jsonb
    language plpgsql
    security definer
    set search_path to ''
    as $$
declare
  uid uuid := (select auth.uid());
  hid uuid;
  name_a text := pg_catalog.btrim(coalesce(p_person_a_name, ''));
  name_b text := pg_catalog.btrim(coalesce(p_person_b_name, ''));
  slot_a_person_id uuid;
  slot_b_person_id uuid;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  select household_id into hid from public.household_members where user_id = uid;
  if hid is null then
    raise exception 'not in a household';
  end if;
  -- Serialize concurrent identity configuration per household.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(hid::text, 9501));

  if name_a = '' or name_b = ''
     or pg_catalog.length(name_a) > 60 or pg_catalog.length(name_b) > 60 then
    raise exception 'invalid person name';
  end if;

  insert into public.household_people as hp (household_id, slot, display_name)
  values (hid, 'a', name_a), (hid, 'b', name_b)
  on conflict (household_id, slot) do update
    set display_name = excluded.display_name,
        updated_at = pg_catalog.now()
    where hp.display_name is distinct from excluded.display_name;

  if p_tool is not null
     or p_tool_slot_a_person is not null
     or p_tool_slot_b_person is not null then
    if p_tool is null
       or p_tool not in ('bolanekoll', 'hushallsbudget', 'manadsavslut') then
      raise exception 'invalid tool';
    end if;
    if p_tool_slot_a_person is null or p_tool_slot_b_person is null
       or p_tool_slot_a_person not in ('a', 'b')
       or p_tool_slot_b_person not in ('a', 'b') then
      raise exception 'incomplete tool binding';
    end if;
    if p_tool_slot_a_person = p_tool_slot_b_person then
      raise exception 'duplicate tool binding';
    end if;

    select id into strict slot_a_person_id from public.household_people
      where household_id = hid and slot = p_tool_slot_a_person;
    select id into strict slot_b_person_id from public.household_people
      where household_id = hid and slot = p_tool_slot_b_person;

    -- Remove stale rows first (a swap would otherwise trip the per-person
    -- unique constraint), then insert only what is missing: a retry with the
    -- same arguments deletes nothing and inserts nothing.
    delete from public.household_tool_person_bindings b
      where b.household_id = hid and b.tool = p_tool
        and b.person_id is distinct from
          case b.tool_slot when 'a' then slot_a_person_id
                           else slot_b_person_id end;
    insert into public.household_tool_person_bindings
        (household_id, tool, tool_slot, person_id)
      values (hid, p_tool, 'a', slot_a_person_id),
             (hid, p_tool, 'b', slot_b_person_id)
      on conflict (household_id, tool, tool_slot) do nothing;
  end if;

  return public.household_identity();
end;
$$;

alter function public.configure_household_people(text, text, text, text, text)
  owner to postgres;
revoke all on function
  public.configure_household_people(text, text, text, text, text)
  from public, anon;
grant execute on function
  public.configure_household_people(text, text, text, text, text)
  to authenticated;

-- ── write RPC: set/clear the CALLER'S own person mapping ──────────────────────
-- Only the caller's own membership row is ever touched; there is deliberately
-- no way to assign another account's mapping. null clears the mapping.
-- Idempotent: re-setting the same person is a no-op success.

create or replace function public.set_my_household_person(p_person_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path to ''
    as $$
declare
  uid uuid := (select auth.uid());
  hid uuid;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  select household_id into hid from public.household_members where user_id = uid;
  if hid is null then
    raise exception 'not in a household';
  end if;
  if p_person_id is not null and not exists (
    select 1 from public.household_people
      where household_id = hid and id = p_person_id
  ) then
    raise exception 'person not in household';
  end if;
  begin
    update public.household_members
      set person_id = p_person_id
      where user_id = uid;
  exception when unique_violation then
    raise exception 'person already claimed';
  end;
end;
$$;

alter function public.set_my_household_person(uuid) owner to postgres;
revoke all on function public.set_my_household_person(uuid) from public, anon;
grant execute on function public.set_my_household_person(uuid) to authenticated;

-- ── household_roster: also expose each member's mapped person ─────────────────
-- Starts from the LATEST prior text (20260705190000, grants re-tightened in
-- 20260713110000): same columns, household scope and ordering, plus the mapped
-- person_id and its display name (null while unmapped). The return type grows,
-- so the old function must be dropped first (create-or-replace cannot change
-- OUT parameters).

drop function if exists public.household_roster();
create function public.household_roster()
    returns table (
      "user_id" uuid,
      "role" text,
      "email" text,
      "person_id" uuid,
      "person_display_name" text
    )
    language sql
    security definer
    set search_path to ''
    as $$
  select m.user_id, m.role, u.email::text, m.person_id, p.display_name
  from public.household_members m
  join auth.users u on u.id = m.user_id
  left join public.household_people p
    on p.household_id = m.household_id and p.id = m.person_id
  where m.household_id = (select private.current_household())
  order by (m.role = 'owner') desc, u.email;
$$;

alter function public.household_roster() owner to postgres;
revoke all on function public.household_roster() from public, anon;
grant execute on function public.household_roster() to authenticated;
