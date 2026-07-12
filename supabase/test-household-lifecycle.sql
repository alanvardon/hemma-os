-- Plan 95 functional/security proof (replaces the pre-concurrency Plan 50/51
-- script). Run against local Supabase after reset, then run the companion
-- test-household-lifecycle-concurrency.sql for genuine two-session coverage.
-- All fixtures are fictional and the outer transaction rolls back everything.
begin;

do $$
declare
  u_data uuid := gen_random_uuid(); u_empty uuid := gen_random_uuid();
  u_ambig uuid := gen_random_uuid(); u_claim uuid := gen_random_uuid();
  u_same uuid := gen_random_uuid(); u_move uuid := gen_random_uuid();
  u_stay uuid := gen_random_uuid(); u_hostile uuid := gen_random_uuid();
  h_data uuid := gen_random_uuid(); h_empty uuid := gen_random_uuid();
  h_ambig uuid := gen_random_uuid(); h_same uuid := gen_random_uuid();
  h_shared uuid := gen_random_uuid(); h_hostile uuid := gen_random_uuid();
  h_target_a uuid := gen_random_uuid(); h_target_b uuid := gen_random_uuid();
  before_households integer; got uuid; cnt integer;
begin
  -- Definer functions pin search_path and expose lifecycle entry points only to
  -- authenticated. The private data predicate is not directly client-callable.
  select count(*) into cnt
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where (n.nspname,p.proname) in (
    ('public','claim_household'),('public','accept_invite'),
    ('public','leave_household'),('private','household_has_persisted_data')
  ) and (not p.prosecdef or not coalesce(p.proconfig,'{}') @> array['search_path=""']);
  if cnt<>0 then raise exception 'FAIL security: % lifecycle functions lack definer/empty search_path',cnt; end if;
  if has_function_privilege('anon','public.claim_household()','execute')
    or has_function_privilege('anon','public.accept_invite()','execute')
    or has_function_privilege('anon','public.leave_household()','execute')
    or has_function_privilege('authenticated','private.household_has_persisted_data(uuid)','execute')
  then raise exception 'FAIL security: lifecycle grants are too broad'; end if;
  if not has_function_privilege('authenticated','public.claim_household()','execute')
    or not has_function_privilege('authenticated','public.accept_invite()','execute')
    or not has_function_privilege('authenticated','public.leave_household()','execute')
  then raise exception 'FAIL security: authenticated lifecycle grant missing'; end if;

  -- Every standard household-owned table must carry the FK that makes the
  -- household FOR UPDATE lock authoritative against concurrent inserts.
  select count(*) into cnt
  from pg_catalog.pg_attribute a
  join pg_catalog.pg_class c on c.oid = a.attrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
    and a.attname = 'household_id' and a.attnum > 0 and not a.attisdropped
    and not exists (
      select 1 from pg_catalog.pg_constraint fk
      where fk.contype = 'f' and fk.conrelid = c.oid
        and a.attnum = any(fk.conkey)
        and fk.confrelid = 'public.households'::regclass
    );
  if cnt <> 0 then raise exception 'FAIL invariant: % household-owned tables lack households FK', cnt; end if;

  insert into auth.users(id,email,aud,role) values
    (u_data,'data.plan95@example.com','authenticated','authenticated'),
    (u_empty,'empty.plan95@example.com','authenticated','authenticated'),
    (u_ambig,'ambig.plan95@example.com','authenticated','authenticated'),
    (u_claim,'claim.plan95@example.com','authenticated','authenticated'),
    (u_same,'same.plan95@example.com','authenticated','authenticated'),
    (u_move,'move.plan95@example.com','authenticated','authenticated'),
    (u_stay,'stay.plan95@example.com','authenticated','authenticated'),
    (u_hostile,'hostile.plan95@example.com','authenticated','authenticated');
  insert into public.households(id,name) values
    (h_data,'Data origin'),(h_empty,'Empty origin'),(h_ambig,'Ambiguous origin'),
    (h_same,'Same target'),(h_shared,'Shared origin'),(h_hostile,'Hostile origin'),
    (h_target_a,'Target A'),(h_target_b,'Target B');
  insert into public.household_members(household_id,user_id,role) values
    (h_data,u_data,'owner'),(h_empty,u_empty,'owner'),(h_ambig,u_ambig,'owner'),
    (h_same,u_same,'owner'),(h_shared,u_move,'owner'),(h_shared,u_stay,'member'),
    (h_hostile,u_hostile,'owner');
  insert into public.tool_state(household_id,tool,data) values
    (h_data,'plan95','{}'),(h_shared,'plan95','{}');
  insert into public.household_invites(household_id,email,created_at) values
    (h_target_a,'data.plan95@example.com',now()),
    (h_target_a,'empty.plan95@example.com',now()),
    (h_target_b,'empty.plan95@example.com',now()-interval '31 days'),
    (h_target_a,'ambig.plan95@example.com',now()),
    (h_target_b,'ambig.plan95@example.com',now()),
    (h_target_a,'claim.plan95@example.com',now()),
    (h_target_b,'claim.plan95@example.com',now()),
    (h_same,'same.plan95@example.com',now()),
    (h_target_a,'move.plan95@example.com',now()),
    (h_target_a,'someone.else@example.com',now());

  perform set_config('request.jwt.claims','{}',true);
  begin perform public.accept_invite(); raise exception 'FAIL unauthenticated accept succeeded';
  exception when others then if sqlerrm not like '%not authenticated%' then raise; end if; end;
  begin perform public.leave_household(); raise exception 'FAIL unauthenticated leave succeeded';
  exception when others then if sqlerrm not like '%not authenticated%' then raise; end if; end;

  -- Multiple active targets: accept rejects and changes nothing.
  perform set_config('request.jwt.claims',json_build_object('sub',u_ambig,'email','ambig.plan95@example.com')::text,true);
  begin perform public.accept_invite(); raise exception 'FAIL ambiguous accept succeeded';
  exception when sqlstate 'P0003' then null; end;
  select count(*) into cnt from public.household_invites where email='ambig.plan95@example.com';
  if cnt<>2 then raise exception 'FAIL ambiguous accept consumed invites'; end if;
  select household_id into got from public.household_members where user_id=u_ambig;
  if got<>h_ambig then raise exception 'FAIL ambiguous accept moved membership'; end if;

  -- First-sign-in claim follows the same ambiguity rule and creates nothing.
  select count(*) into before_households from public.households;
  perform set_config('request.jwt.claims',json_build_object('sub',u_claim,'email','claim.plan95@example.com')::text,true);
  begin perform public.claim_household(); raise exception 'FAIL ambiguous claim succeeded';
  exception when sqlstate 'P0003' then null; end;
  select count(*) into cnt from public.household_members where user_id=u_claim;
  if cnt<>0 then raise exception 'FAIL ambiguous claim created membership'; end if;
  select count(*) into cnt from public.households;
  if cnt<>before_households then raise exception 'FAIL ambiguous claim created household'; end if;
  select count(*) into cnt from public.household_invites where email='claim.plan95@example.com';
  if cnt<>2 then raise exception 'FAIL ambiguous claim consumed invites'; end if;

  -- A sole member with persisted data cannot move; all state and invite remain.
  perform set_config('request.jwt.claims',json_build_object('sub',u_data,'email','data.plan95@example.com')::text,true);
  begin perform public.accept_invite(); raise exception 'FAIL data-bearing solo move succeeded';
  exception when sqlstate 'P0004' then null; end;
  select household_id into got from public.household_members where user_id=u_data;
  if got<>h_data then raise exception 'FAIL blocked move changed membership'; end if;
  if not exists(select 1 from public.tool_state where household_id=h_data) then raise exception 'FAIL blocked move changed data'; end if;
  if not exists(select 1 from public.household_invites where household_id=h_target_a and email='data.plan95@example.com') then raise exception 'FAIL blocked move consumed invite'; end if;

  -- A data-free solo household is removed; only the exact active invite is consumed.
  perform set_config('request.jwt.claims',json_build_object('sub',u_empty,'email','empty.plan95@example.com')::text,true);
  select public.accept_invite() into got;
  if got<>h_target_a then raise exception 'FAIL data-free move target'; end if;
  if exists(select 1 from public.households where id=h_empty) then raise exception 'FAIL empty old household remains'; end if;
  if not exists(select 1 from public.household_invites where household_id=h_target_b and email='empty.plan95@example.com') then raise exception 'FAIL expired unrelated invite consumed'; end if;

  -- Same-household acceptance consumes only the stale invite and preserves role.
  perform set_config('request.jwt.claims',json_build_object('sub',u_same,'email','same.plan95@example.com')::text,true);
  select public.accept_invite() into got;
  if got<>h_same then raise exception 'FAIL same-household target'; end if;
  if not exists(select 1 from public.household_members where user_id=u_same and household_id=h_same and role='owner') then raise exception 'FAIL same-household membership changed'; end if;

  -- A member may move out of a data-bearing household when another member stays.
  perform set_config('request.jwt.claims',json_build_object('sub',u_move,'email','move.plan95@example.com')::text,true);
  select public.accept_invite() into got;
  if got<>h_target_a then raise exception 'FAIL shared-household move target'; end if;
  if not exists(select 1 from public.household_members where user_id=u_stay and household_id=h_shared) then raise exception 'FAIL shared household stranded'; end if;
  if not exists(select 1 from public.tool_state where household_id=h_shared) then raise exception 'FAIL shared data changed'; end if;

  -- Hostile caller has no target parameter and cannot act on another email's invite.
  perform set_config('request.jwt.claims',json_build_object('sub',u_hostile,'email','hostile.plan95@example.com')::text,true);
  begin perform public.accept_invite(); raise exception 'FAIL hostile accept succeeded';
  exception when others then if sqlerrm not like '%no invite%' then raise; end if; end;
  if not exists(select 1 from public.household_invites where email='someone.else@example.com') then raise exception 'FAIL hostile caller consumed invite'; end if;

  -- Expired-only and no-invite paths are both refused.
  begin
    perform set_config('request.jwt.claims',json_build_object('sub',u_empty,'email','empty.plan95@example.com')::text,true);
    perform public.accept_invite(); raise exception 'FAIL expired-only invite accepted';
  exception when others then if sqlerrm not like '%no invite%' then raise; end if; end;

  raise notice 'ALL PASS — Plan 95 lifecycle policy and isolation';
end; $$;

rollback;
