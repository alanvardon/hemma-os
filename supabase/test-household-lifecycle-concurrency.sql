-- Plan 95 real concurrency proof. LOCAL DATABASE ONLY, after `supabase db reset`.
-- Uses dblink to run two genuine PostgreSQL sessions. Fixtures are committed so
-- both sessions can see them, then explicitly removed. The delete-delay trigger
-- makes the old count-then-delete body deterministically strand zero members;
-- the Plan 95 household lock makes the second call re-count after the first.
\set ON_ERROR_STOP on

create extension if not exists dblink with schema extensions;

-- Idempotent cleanup from an interrupted prior local run.
drop trigger if exists plan95_delay_delete on public.household_members;
drop function if exists public.plan95_test_delay_delete();
drop function if exists public.plan95_test_leave(uuid,text);
drop function if exists public.plan95_test_claim(uuid,text);
drop function if exists public.plan95_test_accept(uuid,text);
drop role if exists plan95_dblink;
delete from public.household_members where user_id in
  ('95000000-0000-0000-0000-000000000001','95000000-0000-0000-0000-000000000002','95000000-0000-0000-0000-000000000003');
delete from public.household_invites where email in ('claim-concurrent.plan95@example.com');
delete from public.households where id in
  ('95000000-0000-0000-0000-000000000010','95000000-0000-0000-0000-000000000020');
delete from auth.users where id in
  ('95000000-0000-0000-0000-000000000001','95000000-0000-0000-0000-000000000002','95000000-0000-0000-0000-000000000003');

insert into auth.users(id,email,aud,role) values
 ('95000000-0000-0000-0000-000000000001','leave-a.plan95@example.com','authenticated','authenticated'),
 ('95000000-0000-0000-0000-000000000002','leave-b.plan95@example.com','authenticated','authenticated'),
 ('95000000-0000-0000-0000-000000000003','claim-concurrent.plan95@example.com','authenticated','authenticated');
insert into public.households(id,name) values
 ('95000000-0000-0000-0000-000000000010','Concurrent leave'),
 ('95000000-0000-0000-0000-000000000020','Concurrent target');
insert into public.household_members(household_id,user_id,role) values
 ('95000000-0000-0000-0000-000000000010','95000000-0000-0000-0000-000000000001','owner'),
 ('95000000-0000-0000-0000-000000000010','95000000-0000-0000-0000-000000000002','member');
insert into public.household_invites(household_id,email) values
 ('95000000-0000-0000-0000-000000000020','claim-concurrent.plan95@example.com');

create or replace function public.plan95_test_delay_delete() returns trigger language plpgsql as $$
begin
  if old.household_id='95000000-0000-0000-0000-000000000010' then perform pg_sleep(0.75); end if;
  return old;
end; $$;
create trigger plan95_delay_delete before delete on public.household_members
for each row execute function public.plan95_test_delay_delete();

create or replace function public.plan95_test_leave(p_uid uuid,p_email text) returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claims',json_build_object('sub',p_uid,'email',p_email)::text,true);
  begin perform public.leave_household(); return 'left';
  exception when others then return 'error:'||sqlerrm; end;
end; $$;
create or replace function public.plan95_test_claim(p_uid uuid,p_email text) returns text language plpgsql as $$
declare got uuid;
begin
  perform set_config('request.jwt.claims',json_build_object('sub',p_uid,'email',p_email)::text,true);
  begin select public.claim_household() into got; return 'claimed:'||got::text;
  exception when others then return 'error:'||sqlerrm; end;
end; $$;
create or replace function public.plan95_test_accept(p_uid uuid,p_email text) returns text language plpgsql as $$
declare got uuid;
begin
  perform set_config('request.jwt.claims',json_build_object('sub',p_uid,'email',p_email)::text,true);
  begin select public.accept_invite() into got; return 'accepted:'||got::text;
  exception when others then return 'error:'||sqlerrm; end;
end; $$;

create role plan95_dblink login password 'plan95-local-concurrency-only';
grant authenticated to plan95_dblink;

select extensions.dblink_connect('plan95_a','dbname=postgres user=plan95_dblink password=plan95-local-concurrency-only host=supabase_db_hemma-os port=5432');
select extensions.dblink_connect('plan95_b','dbname=postgres user=plan95_dblink password=plan95-local-concurrency-only host=supabase_db_hemma-os port=5432');
select extensions.dblink_send_query('plan95_a',
  $$select public.plan95_test_leave('95000000-0000-0000-0000-000000000001','leave-a.plan95@example.com')$$);
select extensions.dblink_send_query('plan95_b',
  $$select public.plan95_test_leave('95000000-0000-0000-0000-000000000002','leave-b.plan95@example.com')$$);
create temp table plan95_leave_results(result text);
insert into plan95_leave_results select result from extensions.dblink_get_result('plan95_a') as t(result text);
insert into plan95_leave_results select result from extensions.dblink_get_result('plan95_b') as t(result text);
do $$ begin
  if (select count(*) from public.household_members where household_id='95000000-0000-0000-0000-000000000010')<>1 then raise exception 'FAIL concurrent leave did not preserve one member'; end if;
  if (select count(*) from plan95_leave_results where result='left')<>1 then raise exception 'FAIL concurrent leave success count: %',(select json_agg(result) from plan95_leave_results); end if;
  if (select count(*) from plan95_leave_results where result like 'error:last member%')<>1 then raise exception 'FAIL concurrent leave rejection: %',(select json_agg(result) from plan95_leave_results); end if;
end; $$;

select extensions.dblink_disconnect('plan95_a');
select extensions.dblink_disconnect('plan95_b');
select extensions.dblink_connect('plan95_a','dbname=postgres user=plan95_dblink password=plan95-local-concurrency-only host=supabase_db_hemma-os port=5432');
select extensions.dblink_connect('plan95_b','dbname=postgres user=plan95_dblink password=plan95-local-concurrency-only host=supabase_db_hemma-os port=5432');

select extensions.dblink_send_query('plan95_a',
  $$select public.plan95_test_claim('95000000-0000-0000-0000-000000000003','claim-concurrent.plan95@example.com')$$);
select extensions.dblink_send_query('plan95_b',
  $$select public.plan95_test_accept('95000000-0000-0000-0000-000000000003','claim-concurrent.plan95@example.com')$$);
create temp table plan95_join_results(result text);
insert into plan95_join_results select result from extensions.dblink_get_result('plan95_a') as t(result text);
insert into plan95_join_results select result from extensions.dblink_get_result('plan95_b') as t(result text);
do $$ begin
  if (select count(*) from public.household_members where user_id='95000000-0000-0000-0000-000000000003' and household_id='95000000-0000-0000-0000-000000000020')<>1 then raise exception 'FAIL concurrent claim/accept membership'; end if;
  if exists(select 1 from public.household_invites where email='claim-concurrent.plan95@example.com') then raise exception 'FAIL concurrent claim/accept invite remains'; end if;
end; $$;

select extensions.dblink_disconnect('plan95_a');
select extensions.dblink_disconnect('plan95_b');
drop trigger plan95_delay_delete on public.household_members;
drop function public.plan95_test_delay_delete();
drop function public.plan95_test_leave(uuid,text);
drop function public.plan95_test_claim(uuid,text);
drop function public.plan95_test_accept(uuid,text);
drop role plan95_dblink;
delete from public.household_members where user_id in
  ('95000000-0000-0000-0000-000000000001','95000000-0000-0000-0000-000000000002','95000000-0000-0000-0000-000000000003');
delete from public.household_invites where email='claim-concurrent.plan95@example.com';
delete from public.households where id in
  ('95000000-0000-0000-0000-000000000010','95000000-0000-0000-0000-000000000020');
delete from auth.users where id in
  ('95000000-0000-0000-0000-000000000001','95000000-0000-0000-0000-000000000002','95000000-0000-0000-0000-000000000003');
drop extension dblink;

select 'ALL PASS — Plan 95 real concurrent sessions' as result;
