-- Plan 111 — household person identity (account-based).
--
-- Two deliberately separate concepts:
--   • profiles.display_name  — each ACCOUNT's own name, global to the user and
--                              self-set; falls back to the login email.
--   • household_people        — the household's two people, slot 'a'/'b' (stable
--                              order). Each slot is ASSIGNED an email chosen from
--                              the household's members / pending invites; the
--                              account that owns that email IS that person. The
--                              signed-in account is "du" for the slot carrying
--                              its own email. Tools map by position: tool slot A
--                              is always the household's Person A (no per-tool
--                              binding).
--
-- Names are never typed here: a slot's display name resolves to the assigned
-- account's profile name, then the assigned email, then "Person A"/"Person B".
-- An invited partner's email fills their slot until they log in and set a name.
--
-- Write path: security-definer RPCs only. Tables are household-readable via RLS;
-- direct client mutation grants are revoked so the validated RPCs can't be
-- bypassed. Any household member may assign either slot (a shared decision);
-- profile names are self-only.
--
-- Lifecycle: household_people rows are keyed by household_id, so a configured
-- household counts as persisted data (private.household_has_persisted_data),
-- keeping a sole member from abandoning person history. Leaving/rejoining a
-- household does not delete household_people; a returning account is "du" again
-- automatically once its email still matches a slot.

-- ── per-account profile name ──────────────────────────────────────────────────

create table if not exists public.profiles (
  user_id      uuid not null primary key references auth.users(id) on delete cascade,
  display_name text
    check (display_name is null
           or (display_name = btrim(display_name)
               and length(display_name) between 1 and 60)),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;
create or replace trigger set_updated_at before update on public.profiles
  for each row execute function extensions.moddatetime('updated_at');

-- No direct client access: names are read through household_roster/identity
-- (security definer) and written through set_my_profile_name.
revoke all on table public.profiles from public, anon, authenticated;
grant all on table public.profiles to service_role;

-- ── the household's two people ────────────────────────────────────────────────

create table if not exists public.household_people (
  id             uuid not null default gen_random_uuid() primary key,
  household_id   uuid not null references public.households(id),
  slot           text not null check (slot in ('a', 'b')),
  -- The email of the account (member or pending invite) that IS this person;
  -- null while the slot is unassigned. Stored lowercase/trimmed.
  assigned_email text
    check (assigned_email is null
           or (assigned_email = lower(btrim(assigned_email))
               and length(assigned_email) between 3 and 254
               and assigned_email like '%_@_%')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (household_id, slot),
  -- Composite target for same-household FKs (kept for future use).
  unique (household_id, id)
);

-- One email can hold at most one slot in a household.
create unique index if not exists household_people_assigned_email_unique
  on public.household_people (household_id, assigned_email)
  where assigned_email is not null;

alter table public.household_people enable row level security;
drop policy if exists hh_select on public.household_people;
create policy hh_select on public.household_people for select to authenticated
  using (household_id = (select private.current_household()));
create or replace trigger set_updated_at before update on public.household_people
  for each row execute function extensions.moddatetime('updated_at');

revoke all on table public.household_people from public, anon, authenticated;
grant select on table public.household_people to authenticated;
grant all on table public.household_people to service_role;

-- ── name resolution helper ────────────────────────────────────────────────────
-- The display name for an assigned email: the account's profile name, else the
-- email itself, else null. Security definer so it can read auth.users/profiles.

create or replace function private.resolve_person_name(p_email text)
    returns text
    language sql
    security definer
    set search_path to ''
    stable
    as $$
  select case
    when p_email is null then null
    else coalesce(
      (select pr.display_name
         from auth.users u
         join public.profiles pr on pr.user_id = u.id
        where lower(u.email) = p_email
        limit 1),
      p_email)
  end;
$$;

alter function private.resolve_person_name(text) owner to postgres;

-- ── read RPC: the client identity view ────────────────────────────────────────
--   { "household_id": uuid,
--     "my_person_id": uuid | null,          -- the slot carrying my email
--     "people": [ { "id", "slot", "assigned_email", "display_name" } ] }
-- display_name is always a usable string: profile name → email → "Person A/B".
-- Returns null when the caller has no household.

create or replace function public.household_identity()
    returns jsonb
    language plpgsql
    security definer
    set search_path to ''
    as $$
declare
  uid uuid := (select auth.uid());
  my_email text;
  hid uuid;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  select household_id into hid from public.household_members where user_id = uid;
  if hid is null then
    return null;
  end if;
  select lower(email) into my_email from auth.users where id = uid;
  return pg_catalog.jsonb_build_object(
    'household_id', hid,
    'my_person_id',
      (select p.id from public.household_people p
        where p.household_id = hid and p.assigned_email = my_email
        limit 1),
    -- The caller's own raw profile name (null when unset), for the name editor.
    'my_profile_name',
      (select display_name from public.profiles where user_id = uid),
    'people', coalesce(
      (select pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                  'id', p.id,
                  'slot', p.slot,
                  'assigned_email', p.assigned_email,
                  'display_name', coalesce(
                    private.resolve_person_name(p.assigned_email),
                    'Person ' || pg_catalog.upper(p.slot)))
                order by p.slot)
         from public.household_people p
        where p.household_id = hid),
      '[]'::jsonb));
end;
$$;

alter function public.household_identity() owner to postgres;
revoke all on function public.household_identity() from public, anon;
grant execute on function public.household_identity() to authenticated;

-- ── write RPC: set the caller's own profile name ──────────────────────────────
-- null / blank clears the name (falls back to the login email everywhere).

create or replace function public.set_my_profile_name(p_name text)
    returns void
    language plpgsql
    security definer
    set search_path to ''
    as $$
declare
  uid uuid := (select auth.uid());
  clean text := nullif(pg_catalog.btrim(coalesce(p_name, '')), '');
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if clean is not null and pg_catalog.length(clean) > 60 then
    raise exception 'invalid profile name';
  end if;
  insert into public.profiles (user_id, display_name)
  values (uid, clean)
  on conflict (user_id) do update
    set display_name = excluded.display_name,
        updated_at = pg_catalog.now()
    where public.profiles.display_name is distinct from excluded.display_name;
end;
$$;

alter function public.set_my_profile_name(text) owner to postgres;
revoke all on function public.set_my_profile_name(text) from public, anon;
grant execute on function public.set_my_profile_name(text) to authenticated;

-- ── write RPC: assign the two people to emails ────────────────────────────────
-- Creates the two slot rows if missing and sets each slot's assigned_email.
-- Each email (when not null) must belong to a current member OR a pending invite
-- of the caller's household, and the two emails must differ. Any household
-- member may call it (assigning people is a shared decision). Idempotent.
-- null clears a slot. Returns the fresh identity view.

create or replace function public.assign_household_people(
    p_slot_a_email text default null,
    p_slot_b_email text default null
) returns jsonb
    language plpgsql
    security definer
    set search_path to ''
    as $$
declare
  uid uuid := (select auth.uid());
  hid uuid;
  email_a text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_slot_a_email, ''))), '');
  email_b text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_slot_b_email, ''))), '');
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  select household_id into hid from public.household_members where user_id = uid;
  if hid is null then
    raise exception 'not in a household';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(hid::text, 9501));

  if email_a is not null and email_b is not null and email_a = email_b then
    raise exception 'duplicate person email';
  end if;
  if email_a is not null and not private.email_in_household(hid, email_a) then
    raise exception 'unknown person email';
  end if;
  if email_b is not null and not private.email_in_household(hid, email_b) then
    raise exception 'unknown person email';
  end if;

  insert into public.household_people as hp (household_id, slot, assigned_email)
  values (hid, 'a', email_a), (hid, 'b', email_b)
  on conflict (household_id, slot) do update
    set assigned_email = excluded.assigned_email,
        updated_at = pg_catalog.now()
    where hp.assigned_email is distinct from excluded.assigned_email;

  return public.household_identity();
end;
$$;

alter function public.assign_household_people(text, text) owner to postgres;
revoke all on function public.assign_household_people(text, text) from public, anon;
grant execute on function public.assign_household_people(text, text) to authenticated;

-- Is this email a current member or a pending invite of the household?
create or replace function private.email_in_household(p_hid uuid, p_email text)
    returns boolean
    language sql
    security definer
    set search_path to ''
    stable
    as $$
  select exists (
    select 1 from public.household_members m
    join auth.users u on u.id = m.user_id
    where m.household_id = p_hid and lower(u.email) = p_email
  ) or exists (
    select 1 from public.household_invites i
    where i.household_id = p_hid and lower(i.email) = p_email
  );
$$;

alter function private.email_in_household(uuid, text) owner to postgres;

-- ── household_roster: members with resolved name + assigned slot ──────────────
-- Starts from the latest prior text (20260705190000 + plan-96 grants). Now
-- returns each member's resolved display name (profile → email) and the slot
-- they are assigned to (a/b/null), for the members list and the assign dropdown.

drop function if exists public.household_roster();
create function public.household_roster()
    returns table (
      "user_id" uuid,
      "role" text,
      "email" text,
      "display_name" text,
      "slot" text
    )
    language sql
    security definer
    set search_path to ''
    as $$
  select m.user_id, m.role, u.email::text,
         coalesce(pr.display_name, u.email::text) as display_name,
         hp.slot
  from public.household_members m
  join auth.users u on u.id = m.user_id
  left join public.profiles pr on pr.user_id = m.user_id
  left join public.household_people hp
    on hp.household_id = m.household_id and hp.assigned_email = lower(u.email::text)
  where m.household_id = (select private.current_household())
  order by (m.role = 'owner') desc, u.email;
$$;

alter function public.household_roster() owner to postgres;
revoke all on function public.household_roster() from public, anon;
grant execute on function public.household_roster() to authenticated;
