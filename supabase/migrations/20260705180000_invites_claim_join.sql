-- Plan 16h — self-service household join + invite policies + a sign-in gate.
--
-- Replaces the manual 16a SQL seed with a real onboarding path:
--   • claim_household()   — idempotent; runs on every sign-in. Joins a pending
--                           invite, else creates the user's own household.
--   • email_may_sign_in() — anon-callable gate so AuthGate can pass
--                           shouldCreateUser=true ONLY for invited emails. This
--                           is the hardening (strangers can't create accounts)
--                           without breaking invited-partner self-onboarding —
--                           GoTrue checks shouldCreateUser BEFORE any invite
--                           logic, so a blanket `false` would lock invitees out.
--   • invite RLS          — members create/list/remove invites for their
--                           household; a user may read invites to their email.
-- Membership writes stay INSIDE claim_household (security definer) — the client
-- never gets to insert household_members directly. Idempotent throughout.

-- ── claim_household: called via supabase.rpc() right after each sign-in ───────
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
      from public.household_invites where email = mail limit 1;
    if hid is not null then
      insert into public.household_members (household_id, user_id, role)
        values (hid, uid, 'member') on conflict do nothing;
      delete from public.household_invites where email = mail;
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

-- ── email_may_sign_in: anon gate driving shouldCreateUser (hardening) ────────
-- True only when the email has a pending invite. AuthGate passes the result as
-- shouldCreateUser, so a stranger with no invite can't create an account, while
-- an invited partner still self-onboards on their first magic link. The
-- 16a-seeded couple already have auth accounts, so GoTrue mails them a link
-- regardless of shouldCreateUser — they're unaffected.
create or replace function "public"."email_may_sign_in"("addr" "text")
    returns boolean
    language "sql"
    security definer
    set "search_path" to ''
    as $$
  select exists (select 1 from public.household_invites where email = addr);
$$;

alter function "public"."email_may_sign_in"("text") owner to "postgres";
grant execute on function "public"."email_may_sign_in"("text") to "anon", "authenticated";

-- ── Invite table: default household_id + RLS ─────────────────────────────────
-- Default lets the client insert just { email }; the with_check still pins it to
-- the caller's household, so the default can't be spoofed.
alter table "public"."household_invites"
  alter column "household_id" set default "private"."current_household"();

-- A user may read invites addressed to their own email (pre-join visibility).
drop policy if exists "inv_read_own" on "public"."household_invites";
create policy "inv_read_own" on "public"."household_invites" for select to "authenticated"
  using ("email" = (select auth.jwt() ->> 'email'));

-- A member may list the pending invites of their own household (for the UI).
drop policy if exists "inv_read_household" on "public"."household_invites";
create policy "inv_read_household" on "public"."household_invites" for select to "authenticated"
  using ("household_id" = (select "private"."current_household"()));

-- A member may create an invite for their household.
drop policy if exists "inv_write" on "public"."household_invites";
create policy "inv_write" on "public"."household_invites" for insert to "authenticated"
  with check ("household_id" = (select "private"."current_household"()));

-- A member may withdraw a pending invite of their household.
drop policy if exists "inv_delete" on "public"."household_invites";
create policy "inv_delete" on "public"."household_invites" for delete to "authenticated"
  using ("household_id" = (select "private"."current_household"()));
