-- Plan 97: make acknowledged row deletions durable against stale client replay.

create or replace function private.sync_resource_allowed(p_resource text)
returns boolean language sql immutable set search_path to '' as $$
  select p_resource = any (array[
    'scenarios', 'salary_submissions', 'monthend_items', 'monthend_payments',
    'mortgage_loan_parts', 'mortgage_rate_periods', 'mortgage_payments',
    'mortgage_valuations', 'mortgage_contributions', 'house_items'
  ]::text[])
$$;

create or replace function private.lock_sync_entity(p_household uuid, p_resource text, p_id text)
returns void language sql volatile set search_path to '' as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_household::text || chr(31) || p_resource || chr(31) || p_id, 0
  ))
$$;

create or replace function private.record_sync_tombstones(
  p_household uuid, p_resource text, p_ids text[]
) returns void language plpgsql security definer set search_path to '' as $$
declare additions jsonb;
begin
  if not private.sync_resource_allowed(p_resource) then
    raise exception using errcode = '22023', message = 'unsupported sync resource';
  end if;
  if p_household is null or p_ids is null
     or exists (select 1 from unnest(p_ids) id where id is null or id = '') then
    raise exception using errcode = '22023', message = 'invalid tombstone input';
  end if;
  if cardinality(p_ids) = 0 then return; end if;

  perform private.lock_sync_entity(p_household, p_resource, id)
  from (select distinct unnest(p_ids) as id) ids order by id;

  select jsonb_object_agg(id, to_jsonb(clock_timestamp())) into additions
  from (select distinct unnest(p_ids) as id) ids;

  insert into public.tool_state(household_id, tool, data)
  values (
    p_household, 'sync-tombstones-v1',
    jsonb_build_object('version', 1, 'resources', jsonb_build_object(p_resource, additions))
  )
  on conflict (household_id, tool) do update set data = jsonb_build_object(
    'version', 1,
    'resources',
      coalesce(public.tool_state.data->'resources', '{}'::jsonb)
      || jsonb_build_object(
        p_resource,
        coalesce(public.tool_state.data #> array['resources', p_resource], '{}'::jsonb)
        || additions
      )
  );
end;
$$;

create or replace function private.sync_tombstone_exists(
  p_household uuid, p_resource text, p_id text
) returns boolean language sql stable security definer set search_path to '' as $$
  select coalesce((select (data #> array['resources', p_resource]) ? p_id
    from public.tool_state
    where household_id = p_household and tool = 'sync-tombstones-v1'), false)
$$;

create or replace function private.reject_tombstoned_row()
returns trigger language plpgsql security definer set search_path to '' as $$
declare
  hid uuid;
  parent_id text;
begin
  if tg_op = 'UPDATE' and new.id::text <> old.id::text then
    raise exception using errcode = '22023', message = 'sync entity ids are immutable';
  end if;
  if (session_user = 'postgres' and current_setting('role', true) in ('none', 'postgres'))
     or (select auth.role()) = 'service_role' then
    hid := new.household_id;
  else
    hid := (select private.current_household());
    if (select auth.uid()) is null or hid is null or new.household_id <> hid then
      raise exception using errcode = '42501', message = 'household write denied';
    end if;
  end if;
  if tg_argv[0] in ('mortgage_payments', 'mortgage_rate_periods') then
    if tg_op = 'UPDATE' then
      for parent_id in
        select distinct id from (values (old.loan_part_id::text), (new.loan_part_id::text)) parents(id)
        where id is not null order by id
      loop
        perform private.lock_sync_entity(hid, 'mortgage_loan_parts', parent_id);
      end loop;
    elsif new.loan_part_id is not null then
      perform private.lock_sync_entity(hid, 'mortgage_loan_parts', new.loan_part_id::text);
    end if;
    if new.loan_part_id is not null then
      if private.sync_tombstone_exists(hid, 'mortgage_loan_parts', new.loan_part_id::text) then
        raise exception using errcode = '23503', message = 'deleted mortgage loan part cannot receive children';
      end if;
    end if;
  end if;
  perform private.lock_sync_entity(hid, tg_argv[0], new.id::text);
  if private.sync_tombstone_exists(hid, tg_argv[0], new.id::text) then
    raise exception using errcode = '23505', message = 'deleted id cannot be reused';
  end if;
  return new;
end;
$$;

create or replace function private.protect_sync_tombstone_ledger()
returns trigger language plpgsql set search_path to '' as $$
begin
  if current_user <> 'postgres' and (
    (tg_op = 'INSERT' and new.tool = 'sync-tombstones-v1')
    or (tg_op = 'UPDATE' and (old.tool = 'sync-tombstones-v1' or new.tool = 'sync-tombstones-v1'))
    or (tg_op = 'DELETE' and old.tool = 'sync-tombstones-v1')
  ) then
    raise exception using errcode = '42501', message = 'sync tombstones are server managed';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.sync_resource_allowed(text) from public, anon, authenticated;
revoke all on function private.lock_sync_entity(uuid, text, text) from public, anon, authenticated;
revoke all on function private.record_sync_tombstones(uuid, text, text[]) from public, anon, authenticated;
revoke all on function private.sync_tombstone_exists(uuid, text, text) from public, anon, authenticated;
revoke all on function private.reject_tombstoned_row() from public, anon, authenticated;
revoke all on function private.protect_sync_tombstone_ledger() from public, anon, authenticated;

create or replace trigger protect_sync_tombstone_ledger
before insert or update or delete on public.tool_state
for each row execute function private.protect_sync_tombstone_ledger();

create or replace trigger reject_deleted_scenarios before insert or update on public.scenarios
for each row execute function private.reject_tombstoned_row('scenarios');
create or replace trigger reject_deleted_salary_submissions before insert or update on public.salary_submissions
for each row execute function private.reject_tombstoned_row('salary_submissions');
create or replace trigger reject_deleted_monthend_items before insert or update on public.monthend_items
for each row execute function private.reject_tombstoned_row('monthend_items');
create or replace trigger reject_deleted_monthend_payments before insert or update on public.monthend_payments
for each row execute function private.reject_tombstoned_row('monthend_payments');
create or replace trigger reject_deleted_mortgage_loan_parts before insert or update on public.mortgage_loan_parts
for each row execute function private.reject_tombstoned_row('mortgage_loan_parts');
create or replace trigger reject_deleted_mortgage_rate_periods before insert or update on public.mortgage_rate_periods
for each row execute function private.reject_tombstoned_row('mortgage_rate_periods');
create or replace trigger reject_deleted_mortgage_payments before insert or update on public.mortgage_payments
for each row execute function private.reject_tombstoned_row('mortgage_payments');
create or replace trigger reject_deleted_mortgage_valuations before insert or update on public.mortgage_valuations
for each row execute function private.reject_tombstoned_row('mortgage_valuations');
create or replace trigger reject_deleted_mortgage_contributions before insert or update on public.mortgage_contributions
for each row execute function private.reject_tombstoned_row('mortgage_contributions');
create or replace trigger reject_deleted_house_items before insert or update on public.house_items
for each row execute function private.reject_tombstoned_row('house_items');

-- All client deletions must pass through a tombstone-writing RPC. Existing
-- table grants predate the durable-delete contract and included DELETE.
revoke delete on public.scenarios, public.salary_submissions,
  public.monthend_items, public.monthend_payments,
  public.mortgage_loan_parts, public.mortgage_rate_periods,
  public.mortgage_payments, public.mortgage_valuations,
  public.mortgage_contributions, public.house_items
from anon, authenticated;
revoke truncate, references, trigger on public.scenarios, public.salary_submissions,
  public.monthend_items, public.monthend_payments,
  public.mortgage_loan_parts, public.mortgage_rate_periods,
  public.mortgage_payments, public.mortgage_valuations,
  public.mortgage_contributions, public.house_items, public.tool_state
from anon, authenticated;

create or replace function public.delete_household_rows(p_resource text, p_ids text[])
returns void language plpgsql security definer set search_path to '' as $$
declare hid uuid := (select private.current_household());
begin
  if (select auth.uid()) is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if hid is null then raise exception using errcode = '42501', message = 'no household'; end if;
  if not private.sync_resource_allowed(p_resource) then
    raise exception using errcode = '22023', message = 'unsupported sync resource';
  end if;
  if p_ids is null or exists (select 1 from unnest(p_ids) id where id is null or id = '') then
    raise exception using errcode = '22023', message = 'invalid delete ids';
  end if;

  if p_resource = 'mortgage_loan_parts' then
    perform public.delete_mortgage_loan_part(id)
    from (select distinct unnest(p_ids) as id) ids order by id;
    return;
  elsif p_resource = 'monthend_payments' then
    perform public.unsettle_payment(id)
    from (select distinct unnest(p_ids) as id) ids order by id;
    return;
  end if;

  perform private.record_sync_tombstones(hid, p_resource, p_ids);
  case p_resource
    when 'scenarios' then delete from public.scenarios where household_id = hid and id = any(p_ids);
    when 'salary_submissions' then delete from public.salary_submissions where household_id = hid and id = any(p_ids);
    when 'monthend_items' then delete from public.monthend_items where household_id = hid and id = any(p_ids);
    when 'mortgage_rate_periods' then delete from public.mortgage_rate_periods where household_id = hid and id = any(p_ids);
    when 'mortgage_payments' then delete from public.mortgage_payments where household_id = hid and id = any(p_ids);
    when 'mortgage_valuations' then delete from public.mortgage_valuations where household_id = hid and id = any(p_ids);
    when 'mortgage_contributions' then delete from public.mortgage_contributions where household_id = hid and id = any(p_ids);
    when 'house_items' then delete from public.house_items where household_id = hid and id::text = any(p_ids);
  end case;
end;
$$;

alter function public.delete_household_rows(text, text[]) owner to postgres;
revoke all on function public.delete_household_rows(text, text[]) from public, anon;
grant execute on function public.delete_household_rows(text, text[]) to authenticated;

create or replace function public.unsettle_payment(p_id text)
returns void language plpgsql security definer set search_path to '' as $$
declare hid uuid := (select private.current_household());
begin
  if (select auth.uid()) is null then raise exception using errcode = '42501', message = 'authentication required'; end if;
  if hid is null then raise exception using errcode = '42501', message = 'no household'; end if;
  if p_id is null or p_id = '' then raise exception using errcode = '22023', message = 'invalid payment id'; end if;

  perform private.record_sync_tombstones(hid, 'monthend_payments', array[p_id]);
  update public.monthend_items set paid = false, payment_id = null
    where household_id = hid and payment_id = p_id;
  delete from public.monthend_payments where household_id = hid and id = p_id;
end;
$$;
alter function public.unsettle_payment(text) owner to postgres;
revoke all on function public.unsettle_payment(text) from public, anon;
grant execute on function public.unsettle_payment(text) to authenticated;

create or replace function public.delete_mortgage_loan_part(p_loan_part_id text)
returns void language plpgsql security definer set search_path to '' as $$
declare
  hid uuid := (select private.current_household());
  payment_ids text[];
  period_ids text[];
begin
  if (select auth.uid()) is null then raise exception using errcode = '42501', message = 'authentication required'; end if;
  if hid is null then raise exception using errcode = '42501', message = 'no household'; end if;
  if p_loan_part_id is null or p_loan_part_id = '' then raise exception using errcode = '22023', message = 'invalid loan part id'; end if;

  perform private.lock_sync_entity(hid, 'mortgage_loan_parts', p_loan_part_id);
  perform 1 from public.mortgage_loan_parts
    where household_id = hid and id = p_loan_part_id for update;
  if not found then
    if private.sync_tombstone_exists(hid, 'mortgage_loan_parts', p_loan_part_id) then return; end if;
    raise exception using errcode = 'P0002', message = 'mortgage loan part not found';
  end if;

  select coalesce(array_agg(id order by id), '{}'::text[]) into payment_ids
    from public.mortgage_payments where household_id = hid and loan_part_id = p_loan_part_id;
  select coalesce(array_agg(id order by id), '{}'::text[]) into period_ids
    from public.mortgage_rate_periods where household_id = hid and loan_part_id = p_loan_part_id;

  perform private.record_sync_tombstones(hid, 'mortgage_payments', payment_ids);
  perform private.record_sync_tombstones(hid, 'mortgage_rate_periods', period_ids);
  perform private.record_sync_tombstones(hid, 'mortgage_loan_parts', array[p_loan_part_id]);

  delete from public.mortgage_payments where household_id = hid and loan_part_id = p_loan_part_id;
  delete from public.mortgage_rate_periods where household_id = hid and loan_part_id = p_loan_part_id;
  delete from public.mortgage_loan_parts where household_id = hid and id = p_loan_part_id;
end;
$$;
alter function public.delete_mortgage_loan_part(text) owner to postgres;
revoke all on function public.delete_mortgage_loan_part(text) from public, anon;
grant execute on function public.delete_mortgage_loan_part(text) to authenticated;
