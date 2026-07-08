-- Plan 53 — invite hygiene: expiry, cap, server-side email validation.
--
-- household_invites rows were forever and free-form: no expiry (a pending
-- invite is a standing account-creation grant — plan 46's hook trusts it
-- indefinitely), no cap (inv_write let a member insert unlimited rows), and
-- no server-side shape check (the EMAIL_RE guard lived only in
-- HouseholdMenu.tsx, so a junk row could still reach the table via a direct
-- PostgREST call). Pre-flight (docker exec supabase_db_hemma-os psql -U
-- postgres -c "select * from household_invites") found zero rows in every
-- environment this migration has been applied to, so the shape constraint is
-- safe to add outright — no cleanup pass needed first.
--
-- Expiry is read-side, not a cleanup job: rows older than 30 days simply stop
-- being consulted by every consumer that trusts household_invites to grant
-- account creation. Three consumers get the filter:
--   • claim_household()          — re-declared in full (create or replace),
--                                  copied from 20260705200000 with the filter
--                                  added to the invite lookup.
--   • accept_invite()            — same treatment; added in plan 50, after
--                                  plan 53 was drafted, so it's a natural
--                                  fourth consumer alongside the original
--                                  three, not a deviation from the plan.
--   • hook_before_user_created() — re-declared from 20260705210000.
--   • inv_read_own (RLS)         — the pendingInviteToJoin() banner reads
--                                  through this policy; without the same
--                                  filter here, a user could see the "you
--                                  have a pending invite" banner for an
--                                  invite that accept_invite() would then
--                                  refuse as expired. Kept in sync with
--                                  accept_invite's filter.
-- email_may_sign_in() is NOT touched — plan 52 already revoked every
-- execute grant on it (anon and authenticated), so it has no caller left to
-- filter for.
--
-- inv_read_household (the household's own pending-invite list, e.g.
-- HouseholdMenu) deliberately keeps showing expired rows — members need to
-- see and delete stale invites, not have them silently vanish from the
-- management UI.
--
-- Cap: at most 5 pending invites per household, enforced by extending
-- inv_write's with_check. private.invite_cap_ok() only counts invites still
-- inside the 30-day window, so old, no-longer-usable invites don't
-- permanently eat a household's cap — a household that never prunes stale
-- rows can still invite once they age out. Postgres doesn't expose the
-- new row being inserted to a subquery run within the same command's WITH
-- CHECK, so counting existing rows and comparing to the 5-row limit
-- correctly rejects the 6th insert.

-- ── Server-side shape check + normalization ───────────────────────────────────
alter table public.household_invites
  add constraint household_invites_email_shape
  check (email = lower(email) and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$');

-- ── Cap: at most 5 pending (non-expired) invites per household ────────────────
create or replace function "private"."invite_cap_ok"("hid" "uuid")
    returns boolean
    language "sql"
    security definer
    set "search_path" to ''
    as $$
  select count(*) < 5 from public.household_invites
    where household_id = hid and created_at > now() - interval '30 days';
$$;

alter function "private"."invite_cap_ok"("uuid") owner to "postgres";

drop policy if exists "inv_write" on "public"."household_invites";
create policy "inv_write" on "public"."household_invites" for insert to "authenticated"
  with check (
    "household_id" = (select "private"."current_household"())
    and (select "private"."invite_cap_ok"("household_id"))
  );

-- ── inv_read_own: matches accept_invite's 30-day window ───────────────────────
drop policy if exists "inv_read_own" on "public"."household_invites";
create policy "inv_read_own" on "public"."household_invites" for select to "authenticated"
  using (
    "email" = (select auth.jwt() ->> 'email')
    and "created_at" > now() - interval '30 days'
  );

-- ── claim_household: 30-day expiry on the invite lookup ───────────────────────
create or replace function "public"."claim_household"()
    returns "uuid"
    language "plpgsql"
    security definer
    set "search_path" to ''
    as $$
declare
  uid uuid := (select auth.uid());
  mail text := (select auth.jwt() ->> 'email');
  hid uuid;
begin
  if uid is null then
    return null;
  end if;

  -- Already a member — nothing to do (this runs on every sign-in / refresh).
  select household_id into hid
    from public.household_members where user_id = uid limit 1;
  if hid is not null then
    return hid;
  end if;

  -- A pending, non-expired invite to this email — join that household.
  if mail is not null then
    select household_id into hid
      from public.household_invites
      where lower(email) = lower(mail) and created_at > now() - interval '30 days'
      limit 1;
    if hid is not null then
      insert into public.household_members (household_id, user_id, role)
        values (hid, uid, 'member') on conflict do nothing;
      delete from public.household_invites where lower(email) = lower(mail);
      return hid;
    end if;
  end if;

  -- Otherwise: a fresh private household with this user as its owner.
  insert into public.households (name) values ('Mitt hushåll') returning id into hid;
  insert into public.household_members (household_id, user_id, role)
    values (hid, uid, 'owner');
  return hid;
end;
$$;

alter function "public"."claim_household"() owner to "postgres";
grant execute on function "public"."claim_household"() to "authenticated";

-- ── accept_invite: 30-day expiry on the invite lookup ─────────────────────────
create or replace function "public"."accept_invite"()
    returns "uuid"
    language "plpgsql"
    security definer
    set "search_path" to ''
    as $$
declare
  uid uuid := (select auth.uid());
  mail text := (select auth.jwt() ->> 'email');
  target_hid uuid;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if mail is null then
    raise exception 'no invite';
  end if;

  -- The household that invited my email (case-insensitive, non-expired).
  select household_id into target_hid
    from public.household_invites
    where lower(email) = lower(mail) and created_at > now() - interval '30 days'
    limit 1;
  if target_hid is null then
    raise exception 'no invite';
  end if;

  -- Drop my current membership (if any), then join the inviting household. The
  -- unique index on user_id means delete-then-insert nets exactly one row; the
  -- on-conflict guards the already-in-target case. The old household is left in
  -- place — abandoned, not purged.
  delete from public.household_members where user_id = uid;
  insert into public.household_members (household_id, user_id, role)
    values (target_hid, uid, 'member')
    on conflict (user_id) do nothing;

  -- Consume the invite (and any duplicates to my email, expired or not).
  delete from public.household_invites where lower(email) = lower(mail);

  return target_hid;
end;
$$;

alter function "public"."accept_invite"() owner to "postgres";
grant execute on function "public"."accept_invite"() to "authenticated";

-- ── hook_before_user_created: 30-day expiry on the signup gate ────────────────
create or replace function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
begin
  if exists (
    select 1 from public.household_invites
    where lower(email) = lower(event #>> '{user,email}')
      and created_at > now() - interval '30 days'
  ) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403, 'message', 'Hemma·OS är endast för inbjudna.'));
end;
$$;

grant execute on function public.hook_before_user_created to supabase_auth_admin;
revoke execute on function public.hook_before_user_created from authenticated, anon, public;
