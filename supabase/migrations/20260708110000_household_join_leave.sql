-- Plan 50 (M4) — Household lifecycle: accept-invite-when-already-provisioned
-- + leave-household.
--
-- claim_household() only consumes an invite when the caller has NO membership
-- yet. So a user who signs in BEFORE being invited gets their own single-member
-- household forever, and an invite to their email sits pending eternally, never
-- matched again. There was also no way to leave a household — household_members
-- is SELECT-only and the sole write path was claim_household.
--
-- Two security-definer RPCs cover the real cases without any merge/transfer
-- machinery:
--   • accept_invite()   — I already have a household but there's a pending invite
--                         to my email: move me into the inviting household.
--   • leave_household()  — remove me from my household (unless I'm the last
--                         member); next sign-in re-provisions a fresh one.
--
-- DATA POLICY (settled with the user): the old household's data is ABANDONED IN
-- PLACE, never purged. When accept/leave empties a household we leave the
-- households row + its orphaned data untouched — zero deletion risk, and it's
-- recoverable by re-adding a membership row via SQL. Nothing here deletes a
-- households row or any tool_state / scenarios / bolånekoll / monthend data.
--
-- Both functions are SECURITY DEFINER (they bypass RLS to write
-- household_members, which has no client write policy) so every statement
-- re-derives identity from auth.uid() / the JWT email and can touch only the
-- caller's own rows. search_path is '' so all names are schema-qualified.
-- The plan-51 unique index on household_members(user_id) guarantees the
-- delete-then-insert in accept_invite leaves exactly one membership.

-- ── accept_invite: move the caller into a household that invited their email ──
-- Returns the joined household id. Raises 'no invite' when nothing is pending,
-- so the UI only ever calls this behind a visible invite banner. Idempotent-ish:
-- if the invite is for the household the caller is already in, it's a no-op join
-- that simply consumes the stale invite.
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

  -- The household that invited my email (case-insensitive, matching plan 45).
  select household_id into target_hid
    from public.household_invites where lower(email) = lower(mail) limit 1;
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

  -- Consume the invite (and any duplicates to my email).
  delete from public.household_invites where lower(email) = lower(mail);

  return target_hid;
end;
$$;

alter function "public"."accept_invite"() owner to "postgres";
grant execute on function "public"."accept_invite"() to "authenticated";

-- ── leave_household: remove the caller from their household ───────────────────
-- Refuses when the caller is the last member — leaving would strand the shared
-- data behind an unreachable household. A non-last member is simply removed;
-- their next sign-in runs claim_household and provisions a fresh private
-- household. Nothing is deleted but the membership row.
create or replace function "public"."leave_household"()
    returns void
    language "plpgsql"
    security definer
    set "search_path" to ''
    as $$
declare
  uid uuid := (select auth.uid());
  hid uuid;
  member_count int;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select household_id into hid
    from public.household_members where user_id = uid;
  if hid is null then
    raise exception 'not in a household';
  end if;

  select count(*) into member_count
    from public.household_members where household_id = hid;
  if member_count <= 1 then
    raise exception 'last member cannot leave';
  end if;

  delete from public.household_members where user_id = uid;
end;
$$;

alter function "public"."leave_household"() owner to "postgres";
grant execute on function "public"."leave_household"() to "authenticated";
