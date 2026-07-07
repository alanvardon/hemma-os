-- Plan 45 — case-insensitive invite email matching.
--
-- household_invites.email is stored lowercased by the client (createInvite),
-- but both functions below compared it case-sensitively. GoTrue normalizes the
-- JWT email to lowercase, but the LOGIN-SCREEN input is whatever the user
-- typed ("Sam@Gmail.com"), and a mixed-case row can also reach the invites
-- table directly via the API (inv_write accepts any string). Either mismatch
-- broke the one onboarding path: email_may_sign_in() returned false, GoTrue
-- was told shouldCreateUser=false, and the invited partner's magic link
-- silently failed to create their account.
--
-- Fix: lower() both comparisons. create or replace replaces the whole
-- function body, so claim_household() is re-declared in full (copied from
-- 20260705180000_invites_claim_join.sql) rather than partially edited.

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

  -- A pending invite to this email — join that household, consume the invite.
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

  -- Otherwise: a fresh private household with this user as its owner.
  insert into public.households (name) values ('Mitt hushåll') returning id into hid;
  insert into public.household_members (household_id, user_id, role)
    values (hid, uid, 'owner');
  return hid;
end;
$$;

alter function "public"."claim_household"() owner to "postgres";
grant execute on function "public"."claim_household"() to "authenticated";

create or replace function "public"."email_may_sign_in"("addr" "text")
    returns boolean
    language "sql"
    security definer
    set "search_path" to ''
    as $$
  select exists (select 1 from public.household_invites where lower(email) = lower(addr));
$$;

alter function "public"."email_may_sign_in"("text") owner to "postgres";
grant execute on function "public"."email_may_sign_in"("text") to "anon", "authenticated";
