-- Plan 97 real two-session serialization proof. LOCAL DATABASE ONLY.

create extension if not exists dblink with schema extensions;

drop trigger if exists plan97_delay_ledger on public.tool_state;
drop trigger if exists plan97_delay_scenario_write on public.scenarios;
drop function if exists public.plan97_delay_ledger();
drop function if exists public.plan97_delay_scenario_write();
drop function if exists public.plan97_delete(text,text);
drop function if exists public.plan97_upsert_scenario(text,text);
drop function if exists public.plan97_insert_payment(text,text,text);
drop function if exists public.plan97_delete_part(text,text);
drop role if exists plan97_dblink;
delete from public.scenarios where id in ('race-delete','race-upsert');
delete from public.mortgage_payments where id = 'race-child';
delete from public.mortgage_loan_parts where id = 'race-parent';
delete from public.tool_state where household_id = '97000000-0000-0000-0000-000000000010' and tool = 'sync-tombstones-v1';
delete from public.household_members where user_id = '97000000-0000-0000-0000-000000000001';
delete from public.households where id = '97000000-0000-0000-0000-000000000010';
delete from auth.users where id = '97000000-0000-0000-0000-000000000001';

insert into auth.users(id,email,aud,role) values
  ('97000000-0000-0000-0000-000000000001','concurrency.plan97@example.invalid','authenticated','authenticated');
insert into public.households(id,name) values
  ('97000000-0000-0000-0000-000000000010','Plan 97 concurrency');
insert into public.household_members(household_id,user_id,role) values
  ('97000000-0000-0000-0000-000000000010','97000000-0000-0000-0000-000000000001','owner');
insert into public.scenarios(id,household_id) values
  ('race-delete','97000000-0000-0000-0000-000000000010');
insert into public.mortgage_loan_parts(id,household_id) values
  ('race-parent','97000000-0000-0000-0000-000000000010');

create function public.plan97_delay_ledger() returns trigger language plpgsql as $$
begin
  if new.tool = 'sync-tombstones-v1' and (
    coalesce((new.data #> '{resources,scenarios}') ? 'race-delete', false)
    or coalesce((new.data #> '{resources,mortgage_loan_parts}') ? 'race-parent', false)
  ) then perform pg_sleep(0.75); end if;
  return new;
end; $$;
create trigger plan97_delay_ledger after insert or update on public.tool_state
for each row execute function public.plan97_delay_ledger();

create function public.plan97_delay_scenario_write() returns trigger language plpgsql as $$
begin
  if new.id = 'race-upsert' then perform pg_sleep(0.75); end if;
  return new;
end; $$;
create trigger plan97_delay_scenario_write after insert or update on public.scenarios
for each row execute function public.plan97_delay_scenario_write();

create function public.plan97_delete(p_resource text,p_id text) returns text
language plpgsql security definer set search_path to '' as $$
begin
  perform set_config('request.jwt.claims','{"sub":"97000000-0000-0000-0000-000000000001","role":"authenticated","email":"concurrency.plan97@example.invalid"}',true);
  begin perform public.delete_household_rows(p_resource,array[p_id]); return 'deleted';
  exception when others then return 'error:'||sqlstate||':'||sqlerrm; end;
end; $$;
create function public.plan97_upsert_scenario(p_id text,p_name text) returns text
language plpgsql security definer set search_path to '' as $$
begin
  perform set_config('request.jwt.claims','{"sub":"97000000-0000-0000-0000-000000000001","role":"authenticated","email":"concurrency.plan97@example.invalid"}',true);
  begin insert into public.scenarios(id,name) values(p_id,p_name)
    on conflict(id) do update set name=excluded.name; return 'upserted';
  exception when others then return 'error:'||sqlstate||':'||sqlerrm; end;
end; $$;
create function public.plan97_insert_payment(p_id text,p_part text,p_note text) returns text
language plpgsql security definer set search_path to '' as $$
begin
  perform set_config('request.jwt.claims','{"sub":"97000000-0000-0000-0000-000000000001","role":"authenticated","email":"concurrency.plan97@example.invalid"}',true);
  begin insert into public.mortgage_payments(id,loan_part_id,description) values(p_id,p_part,p_note); return 'inserted';
  exception when others then return 'error:'||sqlstate||':'||sqlerrm; end;
end; $$;
create function public.plan97_delete_part(p_id text,p_unused text) returns text
language plpgsql security definer set search_path to '' as $$
begin
  perform set_config('request.jwt.claims','{"sub":"97000000-0000-0000-0000-000000000001","role":"authenticated","email":"concurrency.plan97@example.invalid"}',true);
  begin perform public.delete_mortgage_loan_part(p_id); return 'deleted';
  exception when others then return 'error:'||sqlstate||':'||sqlerrm; end;
end; $$;

create role plan97_dblink login password 'plan97-local-concurrency-only';
grant execute on function public.plan97_delete(text,text), public.plan97_upsert_scenario(text,text),
  public.plan97_insert_payment(text,text,text), public.plan97_delete_part(text,text) to plan97_dblink;

select extensions.dblink_connect('plan97_a','dbname=postgres user=plan97_dblink password=plan97-local-concurrency-only host=supabase_db_hemma-os port=5432');
select extensions.dblink_connect('plan97_b','dbname=postgres user=plan97_dblink password=plan97-local-concurrency-only host=supabase_db_hemma-os port=5432');

select extensions.dblink_send_query('plan97_a', $$select public.plan97_delete('scenarios','race-delete')$$);
select pg_sleep(0.1);
select extensions.dblink_send_query('plan97_b', $$select public.plan97_upsert_scenario('race-delete','stale replay')$$);
create temp table plan97_results(label text,result text);
insert into plan97_results select 'delete-first-delete',result from extensions.dblink_get_result('plan97_a') as t(result text);
insert into plan97_results select 'delete-first-upsert',result from extensions.dblink_get_result('plan97_b') as t(result text);
do $$ begin
  if (select result from plan97_results where label='delete-first-delete') is distinct from 'deleted' then raise exception 'FAIL delete-first delete'; end if;
  if coalesce((select result from plan97_results where label='delete-first-upsert'),'') not like 'error:23505:%' then raise exception 'FAIL stale upsert was not rejected: %',(select result from plan97_results where label='delete-first-upsert'); end if;
  if exists(select 1 from public.scenarios where id='race-delete') then raise exception 'FAIL race-delete row survived'; end if;
end; $$;

select extensions.dblink_disconnect('plan97_a');
select extensions.dblink_disconnect('plan97_b');
select extensions.dblink_connect('plan97_a','dbname=postgres user=plan97_dblink password=plan97-local-concurrency-only host=supabase_db_hemma-os port=5432');
select extensions.dblink_connect('plan97_b','dbname=postgres user=plan97_dblink password=plan97-local-concurrency-only host=supabase_db_hemma-os port=5432');

select extensions.dblink_send_query('plan97_a', $$select public.plan97_upsert_scenario('race-upsert','first writer')$$);
select pg_sleep(0.1);
select extensions.dblink_send_query('plan97_b', $$select public.plan97_delete('scenarios','race-upsert')$$);
insert into plan97_results select 'upsert-first-upsert',result from extensions.dblink_get_result('plan97_a') as t(result text);
insert into plan97_results select 'upsert-first-delete',result from extensions.dblink_get_result('plan97_b') as t(result text);
do $$ begin
  if (select result from plan97_results where label='upsert-first-upsert') is distinct from 'upserted' then raise exception 'FAIL upsert-first upsert'; end if;
  if (select result from plan97_results where label='upsert-first-delete') is distinct from 'deleted' then raise exception 'FAIL upsert-first delete'; end if;
  if exists(select 1 from public.scenarios where id='race-upsert') then raise exception 'FAIL upsert-first final row survived'; end if;
end; $$;

select extensions.dblink_disconnect('plan97_a');
select extensions.dblink_disconnect('plan97_b');
select extensions.dblink_connect('plan97_a','dbname=postgres user=plan97_dblink password=plan97-local-concurrency-only host=supabase_db_hemma-os port=5432');
select extensions.dblink_connect('plan97_b','dbname=postgres user=plan97_dblink password=plan97-local-concurrency-only host=supabase_db_hemma-os port=5432');

select extensions.dblink_send_query('plan97_a', $$select public.plan97_delete_part('race-parent','')$$);
select pg_sleep(0.1);
select extensions.dblink_send_query('plan97_b', $$select public.plan97_insert_payment('race-child','race-parent','stale child')$$);
insert into plan97_results select 'cascade-delete',result from extensions.dblink_get_result('plan97_a') as t(result text);
insert into plan97_results select 'cascade-child',result from extensions.dblink_get_result('plan97_b') as t(result text);
do $$ begin
  if (select result from plan97_results where label='cascade-delete') is distinct from 'deleted' then raise exception 'FAIL cascade delete'; end if;
  if coalesce((select result from plan97_results where label='cascade-child'),'') not like 'error:23503:%' then raise exception 'FAIL stale child was not rejected: %',(select result from plan97_results where label='cascade-child'); end if;
  if exists(select 1 from public.mortgage_payments where id='race-child') then raise exception 'FAIL stale child survived'; end if;
end; $$;

select extensions.dblink_disconnect('plan97_a');
select extensions.dblink_disconnect('plan97_b');
drop trigger plan97_delay_ledger on public.tool_state;
drop trigger plan97_delay_scenario_write on public.scenarios;
drop function public.plan97_delay_ledger();
drop function public.plan97_delay_scenario_write();
drop function public.plan97_delete(text,text);
drop function public.plan97_upsert_scenario(text,text);
drop function public.plan97_insert_payment(text,text,text);
drop function public.plan97_delete_part(text,text);
drop role plan97_dblink;
delete from public.scenarios where id in ('race-delete','race-upsert');
delete from public.mortgage_payments where id='race-child';
delete from public.mortgage_loan_parts where id='race-parent';
delete from public.tool_state where household_id='97000000-0000-0000-0000-000000000010' and tool='sync-tombstones-v1';
delete from public.household_members where user_id='97000000-0000-0000-0000-000000000001';
delete from public.households where id='97000000-0000-0000-0000-000000000010';
delete from auth.users where id='97000000-0000-0000-0000-000000000001';
drop extension dblink;

select 'ALL PASS — Plan 97 durable delete concurrency' as result;
