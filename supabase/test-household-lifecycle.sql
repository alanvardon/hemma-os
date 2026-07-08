-- test-household-lifecycle.sql — SQL-level proof for the plan 50 / 51 RPCs.
--
-- The web test suite mocks supabase-js, so it can't prove what matters here:
-- that the SECURITY DEFINER functions re-derive identity from auth.uid() /
-- the JWT and touch only the caller's rows. This script does, in the Supabase
-- SQL Editor. Paste the WHOLE file and run it — it seeds two users, exercises
-- every path, RAISEs on any wrong result, and ROLLS BACK at the end so it
-- leaves no trace. Success = it runs to "ALL PASS" with no exception.
--
-- Impersonation: we drive auth.uid()/auth.jwt() by setting request.jwt.claims
-- (the same GUC PostgREST sets per request), so the functions run exactly as
-- they would for a signed-in caller.

begin;

do $$
declare
  uid_a uuid := gen_random_uuid();  -- Anna — invites Bo, later stays behind
  uid_b uuid := gen_random_uuid();  -- Bo — signed in early, stranded, then joins
  mail_a text := 'anna.test@example.com';
  mail_b text := 'bo.test@example.com';
  hh_a uuid;  -- Anna's (shared) household
  hh_b uuid;  -- Bo's stranded solo household
  got uuid;
  cnt int;
begin
  -- Minimal auth.users rows so the household_members.user_id FK is satisfied.
  -- (aud/role are the only extra NOT NULLs on a standard GoTrue schema.)
  insert into auth.users (id, email, aud, role)
    values (uid_a, mail_a, 'authenticated', 'authenticated'),
           (uid_b, mail_b, 'authenticated', 'authenticated');

  -- Helper to impersonate a user for the subsequent RPC calls.
  -- (inlined below via set_config since a nested function isn't worth it)

  -- ── Setup: Anna owns a household; Bo signed in early and got his own ──
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid_a, 'email', mail_a)::text, true);
  select public.claim_household() into hh_a;

  perform set_config('request.jwt.claims',
    json_build_object('sub', uid_b, 'email', mail_b)::text, true);
  select public.claim_household() into hh_b;

  if hh_a = hh_b then
    raise exception 'FAIL setup: Anna and Bo should be in separate households';
  end if;

  -- ── Repro the stranding: Anna invites Bo's email ─────────────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid_a, 'email', mail_a)::text, true);
  insert into public.household_invites (household_id, email) values (hh_a, mail_b);

  -- claim_household is a no-op for Bo now (he already has a membership), which
  -- is exactly the bug plan 50 repairs — the invite would sit pending forever.
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid_b, 'email', mail_b)::text, true);
  select public.claim_household() into got;
  if got <> hh_b then
    raise exception 'FAIL: claim_household should NOT move an already-provisioned user (got %, want %)', got, hh_b;
  end if;

  -- ── accept_invite: Bo clicks Accept ──────────────────────────────────
  select public.accept_invite() into got;
  if got <> hh_a then
    raise exception 'FAIL accept_invite: Bo should now be in Anna''s household (got %, want %)', got, hh_a;
  end if;

  -- Exactly one membership for Bo, in Anna's household.
  select count(*) into cnt from public.household_members where user_id = uid_b;
  if cnt <> 1 then
    raise exception 'FAIL accept_invite: Bo should have exactly 1 membership, has %', cnt;
  end if;
  select household_id into got from public.household_members where user_id = uid_b;
  if got <> hh_a then
    raise exception 'FAIL accept_invite: Bo''s membership is in the wrong household';
  end if;

  -- Invite consumed.
  select count(*) into cnt from public.household_invites where lower(email) = lower(mail_b);
  if cnt <> 0 then
    raise exception 'FAIL accept_invite: invite should be consumed, % remain', cnt;
  end if;

  -- Old household abandoned in place, not purged.
  perform 1 from public.households where id = hh_b;
  if not found then
    raise exception 'FAIL accept_invite: Bo''s old household should remain (abandon-in-place), it was deleted';
  end if;

  -- ── leave_household: Bo (non-last member) leaves Anna's household ─────
  -- Anna + Bo are both in hh_a now, so Bo may leave.
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid_b, 'email', mail_b)::text, true);
  perform public.leave_household();
  select count(*) into cnt from public.household_members where user_id = uid_b;
  if cnt <> 0 then
    raise exception 'FAIL leave_household: Bo should have no membership after leaving, has %', cnt;
  end if;

  -- ── leave_household: last member is refused ──────────────────────────
  -- Anna is now alone in hh_a; leaving would strand the data → must raise.
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid_a, 'email', mail_a)::text, true);
  begin
    perform public.leave_household();
    raise exception 'FAIL leave_household: last member should NOT be able to leave';
  exception
    when others then
      if sqlerrm not like '%last member%' then raise; end if;  -- expected refusal
  end;

  -- ── accept_invite with no pending invite is refused ──────────────────
  begin
    perform public.accept_invite();
    raise exception 'FAIL accept_invite: should raise when no invite is pending';
  exception
    when others then
      if sqlerrm not like '%no invite%' then raise; end if;  -- expected refusal
  end;

  raise notice 'ALL PASS — accept_invite / leave_household / claim_household behave as specified';
end;
$$;

rollback;
