-- Plan 84 — restore the first-sign-in race guard that plan 52
-- (20260708100000_one_household_per_user.sql) added and plan 53
-- (20260708130000_invite_hygiene.sql) accidentally reverted by rewriting
-- claim_household from a stale copy. Two concurrent first-time claims (React
-- StrictMode double-fires AuthGate's effect in dev; two tabs in prod) both
-- reached the bare owner-insert; the unique index on user_id made the loser
-- 409 back to the client. This body is the union of both parents: plan 53's
-- 30-day invite expiry + plan 52's on-conflict / re-select / orphan-cleanup
-- tail. If you rewrite this function again, START FROM THIS TEXT.

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
  new_hid uuid;
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

  -- Otherwise: a fresh private household with this user as its owner. Two racing
  -- first-time claims both land here; the unique index on user_id lets exactly
  -- one membership survive.
  insert into public.households (name) values ('Mitt hushåll') returning id into new_hid;
  insert into public.household_members (household_id, user_id, role)
    values (new_hid, uid, 'owner')
    on conflict (user_id) do nothing;

  -- Re-select the surviving membership so the race loser returns the winner's
  -- household id rather than its own orphaned one.
  select household_id into strict hid
    from public.household_members where user_id = uid;

  -- If we lost the race, drop the empty household THIS call just created (it has
  -- no members and no data — brand new). Scoped to new_hid only: never touches
  -- abandoned-but-populated households left behind by plan 50's leave/accept,
  -- whose data rows would otherwise trip the (non-cascading) household_id FKs.
  if new_hid is distinct from hid then
    delete from public.households where id = new_hid;
  end if;

  return hid;
end;
$$;

alter function "public"."claim_household"() owner to "postgres";
grant execute on function "public"."claim_household"() to "authenticated";
