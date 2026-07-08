-- Plan 51 (M5) — Enforce one household per user (unique index + claim race).
--
-- Nothing enforced the design assumption that a user belongs to exactly ONE
-- household:
--   • household_members' PK is (household_id, user_id), so the same user could
--     sit in two households.
--   • claim_household()'s "create fresh household" branch had no concurrency
--     guard — two tabs racing a first sign-in could BOTH pass the "already a
--     member?" check and each create a household + membership row.
--   • current_household() then resolves the ambiguity with an unordered
--     `limit 1`, so which household a request writes to becomes
--     nondeterministic — silently splitting the couple's data.
--
-- This migration is a prerequisite for plan 50 (accept_invite / leave_household):
-- the unique index is what lets those RPCs delete-then-insert a membership
-- without ever creating a duplicate, and gives current_household() a single
-- deterministic answer.
--
-- PRE-FLIGHT (run in the SQL editor before applying to a live environment):
--   select user_id, count(*) from public.household_members
--   group by 1 having count(*) > 1;
-- Must return zero rows. A non-empty result means someone is already in two
-- households — resolve by hand first (keep the shared-household row, delete the
-- other) or `create unique index` below will fail.

-- ── One household per user, enforced at the schema level ─────────────────────
create unique index if not exists "household_members_user_uniq"
  on "public"."household_members" ("user_id");

-- ── Race-safe claim_household ────────────────────────────────────────────────
-- Copied from migration 20260705200000 (plan 45's case-insensitive body — kept
-- verbatim, incl. the lower() invite matching) except the final owner insert now
-- rides the unique index: two parallel first-time claims both reach the insert, but
-- `on conflict (user_id) do nothing` lets only one win. Both then re-select the
-- winning membership (so the loser returns the winner's household id), and the
-- loser's just-created empty household row is cleaned up.
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

  -- A pending invite to this email — join that household, consume the invite.
  -- lower() on both sides preserves plan 45's case-insensitive matching.
  if mail is not null then
    select household_id into hid
      from public.household_invites where lower(email) = lower(mail) limit 1;
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
