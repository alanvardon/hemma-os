-- Plan 98 real two-session optimistic-lock and receipt proof. LOCAL DATABASE ONLY.

create extension if not exists dblink with schema extensions;

drop trigger if exists plan98_delay_scenario on public.scenarios;
drop trigger if exists plan98_delay_ledger on public.tool_state;
drop function if exists public.plan98_delay_scenario();
drop function if exists public.plan98_delay_ledger();
drop function if exists public.plan98_apply_scenario(text,text,text,bigint);
drop function if exists public.plan98_delete_parent(text);
drop function if exists public.plan98_insert_child(text);
drop role if exists plan98_dblink;

delete from public.scenarios where id in ('plan98-stale','plan98-receipt');
delete from public.mortgage_payments where id = 'plan98-child';
delete from public.mortgage_loan_parts where id = 'plan98-parent';
delete from private.sync_operation_receipts
  where household_id = '98000000-0000-0000-0000-000000000010';
delete from public.tool_state
  where household_id = '98000000-0000-0000-0000-000000000010'
    and tool = 'sync-tombstones-v1';
delete from public.household_members
  where user_id = '98000000-0000-0000-0000-000000000001';
delete from public.households where id = '98000000-0000-0000-0000-000000000010';
delete from auth.users where id = '98000000-0000-0000-0000-000000000001';

insert into auth.users(id,email,aud,role) values
  ('98000000-0000-0000-0000-000000000001','concurrency.plan98@example.invalid','authenticated','authenticated');
insert into public.households(id,name) values
  ('98000000-0000-0000-0000-000000000010','Plan 98 concurrency');
insert into public.household_members(household_id,user_id,role) values
  ('98000000-0000-0000-0000-000000000010','98000000-0000-0000-0000-000000000001','owner');
insert into public.scenarios(id,household_id,name) values
  ('plan98-stale','98000000-0000-0000-0000-000000000010','base');
insert into public.mortgage_loan_parts(id,household_id,label) values
  ('plan98-parent','98000000-0000-0000-0000-000000000010','race parent');

create function public.plan98_delay_scenario() returns trigger language plpgsql as $$
begin
  if new.id in ('plan98-stale','plan98-receipt') then perform pg_sleep(0.75); end if;
  return new;
end; $$;
create trigger plan98_delay_scenario after insert or update on public.scenarios
for each row execute function public.plan98_delay_scenario();

create function public.plan98_delay_ledger() returns trigger language plpgsql as $$
begin
  if new.tool = 'sync-tombstones-v1'
     and coalesce((new.data #> '{resources,mortgage_loan_parts}') ? 'plan98-parent', false)
  then perform pg_sleep(0.75); end if;
  return new;
end; $$;
create trigger plan98_delay_ledger after insert or update on public.tool_state
for each row execute function public.plan98_delay_ledger();

create function public.plan98_apply_scenario(
  p_operation text, p_id text, p_name text, p_expected bigint
) returns text language plpgsql security definer set search_path to '' as $$
declare result jsonb;
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    '{"sub":"98000000-0000-0000-0000-000000000001","role":"authenticated","email":"concurrency.plan98@example.invalid"}',
    true
  );
  begin
    result := public.sync_apply_rows(
      p_operation, 'scenarios',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',p_id,'name',p_name)),
      pg_catalog.jsonb_build_object('scenarios:' || p_id, pg_catalog.to_jsonb(p_expected)),
      false
    );
    return result::text;
  exception when others then return 'error:' || sqlstate || ':' || sqlerrm;
  end;
end; $$;

create function public.plan98_delete_parent(p_operation text)
returns text language plpgsql security definer set search_path to '' as $$
declare result jsonb;
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    '{"sub":"98000000-0000-0000-0000-000000000001","role":"authenticated","email":"concurrency.plan98@example.invalid"}',
    true
  );
  begin
    result := public.sync_delete_mortgage_loan_part(
      p_operation, 'plan98-parent', '{"mortgage_loan_parts:plan98-parent":1}'::jsonb
    );
    return result::text;
  exception when others then return 'error:' || sqlstate || ':' || sqlerrm;
  end;
end; $$;

create function public.plan98_insert_child(p_operation text)
returns text language plpgsql security definer set search_path to '' as $$
declare result jsonb;
begin
  perform pg_catalog.set_config(
    'request.jwt.claims',
    '{"sub":"98000000-0000-0000-0000-000000000001","role":"authenticated","email":"concurrency.plan98@example.invalid"}',
    true
  );
  begin
    result := public.sync_apply_rows(
      p_operation, 'mortgage_payments',
      '[{"id":"plan98-child","loan_part_id":"plan98-parent"}]',
      '{"mortgage_payments:plan98-child":null}', false
    );
    return result::text;
  exception when others then return 'error:' || sqlstate || ':' || sqlerrm;
  end;
end; $$;

create role plan98_dblink login password 'plan98-local-concurrency-only';
grant execute on function public.plan98_apply_scenario(text,text,text,bigint),
  public.plan98_delete_parent(text), public.plan98_insert_child(text)
to plan98_dblink;

create temp table plan98_results(label text primary key, result text);

select extensions.dblink_connect(
  'plan98_a',
  'dbname=postgres user=plan98_dblink password=plan98-local-concurrency-only host=supabase_db_hemma-os port=5432'
);
select extensions.dblink_connect(
  'plan98_b',
  'dbname=postgres user=plan98_dblink password=plan98-local-concurrency-only host=supabase_db_hemma-os port=5432'
);

-- Both sessions loaded revision 1. Exactly one update can advance it to 2.
select extensions.dblink_send_query(
  'plan98_a', $$select public.plan98_apply_scenario('race-stale-a','plan98-stale','winner',1)$$
);
select pg_sleep(0.1);
select extensions.dblink_send_query(
  'plan98_b', $$select public.plan98_apply_scenario('race-stale-b','plan98-stale','stale',1)$$
);
insert into plan98_results select 'stale-a', result
  from extensions.dblink_get_result('plan98_a') as t(result text);
insert into plan98_results select 'stale-b', result
  from extensions.dblink_get_result('plan98_b') as t(result text);
do $$ begin
  if ((select result from plan98_results where label='stale-a')::jsonb->>'status') <> 'applied'
  then raise exception 'FAIL first revision writer: %', (select result from plan98_results where label='stale-a'); end if;
  if ((select result from plan98_results where label='stale-b')::jsonb->>'status') <> 'conflict'
  then raise exception 'FAIL stale revision writer: %', (select result from plan98_results where label='stale-b'); end if;
  if not exists(select 1 from public.scenarios where id='plan98-stale' and name='winner' and revision=2)
  then raise exception 'FAIL stale-write final row'; end if;
end; $$;

select extensions.dblink_disconnect('plan98_a');
select extensions.dblink_disconnect('plan98_b');
select extensions.dblink_connect(
  'plan98_a',
  'dbname=postgres user=plan98_dblink password=plan98-local-concurrency-only host=supabase_db_hemma-os port=5432'
);
select extensions.dblink_connect(
  'plan98_b',
  'dbname=postgres user=plan98_dblink password=plan98-local-concurrency-only host=supabase_db_hemma-os port=5432'
);

-- Two identical deliveries of one operation serialize on the receipt key and
-- both receive the same acknowledgement without a duplicate mutation.
select extensions.dblink_send_query(
  'plan98_a', $$select public.plan98_apply_scenario('race-same-receipt','plan98-receipt','once',null)$$
);
select pg_sleep(0.1);
select extensions.dblink_send_query(
  'plan98_b', $$select public.plan98_apply_scenario('race-same-receipt','plan98-receipt','once',null)$$
);
insert into plan98_results select 'receipt-a', result
  from extensions.dblink_get_result('plan98_a') as t(result text);
insert into plan98_results select 'receipt-b', result
  from extensions.dblink_get_result('plan98_b') as t(result text);
do $$ begin
  if (select result from plan98_results where label='receipt-a')
     is distinct from (select result from plan98_results where label='receipt-b')
  then raise exception 'FAIL concurrent receipt responses differ'; end if;
  if ((select result from plan98_results where label='receipt-a')::jsonb #>> '{revisions,scenarios:plan98-receipt}') <> '1'
  then raise exception 'FAIL concurrent receipt revision'; end if;
  if (select count(*) from public.scenarios where id='plan98-receipt' and revision=1) <> 1
  then raise exception 'FAIL concurrent receipt duplicated mutation'; end if;
end; $$;

select extensions.dblink_disconnect('plan98_a');
select extensions.dblink_disconnect('plan98_b');
select extensions.dblink_connect(
  'plan98_a',
  'dbname=postgres user=plan98_dblink password=plan98-local-concurrency-only host=supabase_db_hemma-os port=5432'
);
select extensions.dblink_connect(
  'plan98_b',
  'dbname=postgres user=plan98_dblink password=plan98-local-concurrency-only host=supabase_db_hemma-os port=5432'
);

-- Cascade wins the parent lock first. A stale child insert must then be rejected
-- by the authoritative Plan-97 parent tombstone.
select extensions.dblink_send_query(
  'plan98_a', $$select public.plan98_delete_parent('race-cascade')$$
);
select pg_sleep(0.1);
select extensions.dblink_send_query(
  'plan98_b', $$select public.plan98_insert_child('race-child')$$
);
insert into plan98_results select 'cascade', result
  from extensions.dblink_get_result('plan98_a') as t(result text);
insert into plan98_results select 'child', result
  from extensions.dblink_get_result('plan98_b') as t(result text);
do $$ begin
  if ((select result from plan98_results where label='cascade')::jsonb->>'status') <> 'applied'
  then raise exception 'FAIL cascade result: %', (select result from plan98_results where label='cascade'); end if;
  if coalesce((select result from plan98_results where label='child'),'') not like 'error:23503:%'
  then raise exception 'FAIL stale child result: %', (select result from plan98_results where label='child'); end if;
  if exists(select 1 from public.mortgage_loan_parts where id='plan98-parent')
     or exists(select 1 from public.mortgage_payments where id='plan98-child')
  then raise exception 'FAIL cascade/child final state'; end if;
end; $$;

select extensions.dblink_disconnect('plan98_a');
select extensions.dblink_disconnect('plan98_b');
drop trigger plan98_delay_scenario on public.scenarios;
drop trigger plan98_delay_ledger on public.tool_state;
drop function public.plan98_delay_scenario();
drop function public.plan98_delay_ledger();
drop function public.plan98_apply_scenario(text,text,text,bigint);
drop function public.plan98_delete_parent(text);
drop function public.plan98_insert_child(text);
drop role plan98_dblink;
delete from public.scenarios where id in ('plan98-stale','plan98-receipt');
delete from public.mortgage_payments where id = 'plan98-child';
delete from public.mortgage_loan_parts where id = 'plan98-parent';
delete from private.sync_operation_receipts
  where household_id = '98000000-0000-0000-0000-000000000010';
delete from public.tool_state
  where household_id = '98000000-0000-0000-0000-000000000010'
    and tool = 'sync-tombstones-v1';
delete from public.household_members
  where user_id = '98000000-0000-0000-0000-000000000001';
delete from public.households where id = '98000000-0000-0000-0000-000000000010';
delete from auth.users where id = '98000000-0000-0000-0000-000000000001';
drop extension dblink;

select 'ALL PASS — Plan 98 optimistic concurrency' as result;
