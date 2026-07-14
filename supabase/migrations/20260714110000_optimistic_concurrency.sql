-- Plan 98: server-issued revisions and authenticated optimistic-concurrency RPCs.
-- Direct client mutations are revoked below; all mutable household data passes
-- through these household-derived, receipt-backed entry points.

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'tool_state', 'scenarios', 'salary_submissions', 'monthend_items',
    'monthend_payments', 'mortgage_loan_parts', 'mortgage_rate_periods',
    'mortgage_payments', 'mortgage_valuations', 'mortgage_contributions',
    'house_items'
  ] loop
    execute pg_catalog.format(
      'alter table public.%I add column if not exists revision bigint not null default 1',
      table_name
    );
    if not exists (
      select 1 from pg_catalog.pg_constraint c
      join pg_catalog.pg_class r on r.oid = c.conrelid
      join pg_catalog.pg_namespace n on n.oid = r.relnamespace
      where n.nspname = 'public' and r.relname = table_name
        and c.conname = table_name || '_revision_safe'
    ) then
      execute pg_catalog.format(
        'alter table public.%I add constraint %I check (revision between 1 and 9007199254740991)',
        table_name, table_name || '_revision_safe'
      );
    end if;
  end loop;
end;
$$;

create or replace function private.set_sync_revision()
returns trigger language plpgsql set search_path to '' as $$
begin
  if tg_op = 'INSERT' then
    new.revision := 1;
  else
    if old.revision >= 9007199254740991 then
      raise exception using errcode = '22003', message = 'sync revision exhausted';
    end if;
    new.revision := old.revision + 1;
    new.updated_at := pg_catalog.clock_timestamp();
  end if;
  return new;
end;
$$;
revoke all on function private.set_sync_revision() from public, anon, authenticated;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'tool_state', 'scenarios', 'salary_submissions', 'monthend_items',
    'monthend_payments', 'mortgage_loan_parts', 'mortgage_rate_periods',
    'mortgage_payments', 'mortgage_valuations', 'mortgage_contributions',
    'house_items'
  ] loop
    execute pg_catalog.format('drop trigger if exists set_updated_at on public.%I', table_name);
    execute pg_catalog.format('drop trigger if exists set_sync_revision on public.%I', table_name);
    execute pg_catalog.format(
      'create trigger set_sync_revision before insert or update on public.%I '
      'for each row execute function private.set_sync_revision()', table_name
    );
  end loop;
end;
$$;

create table if not exists private.sync_operation_receipts (
  household_id uuid not null references public.households(id) on delete cascade,
  operation_id text not null,
  actor_user_id uuid not null,
  request_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (household_id, operation_id),
  constraint sync_operation_receipts_operation_id_valid
    check (length(operation_id) between 1 and 200 and operation_id !~ '[[:cntrl:]]'),
  constraint sync_operation_receipts_hash_valid
    check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint sync_operation_receipts_response_valid
    check (response->>'status' = 'applied' and jsonb_typeof(response->'revisions') = 'object')
);
alter table private.sync_operation_receipts owner to postgres;
revoke all on table private.sync_operation_receipts from public, anon, authenticated;

create or replace function private.sync_validate_operation_id(p_operation_id text)
returns void language plpgsql immutable set search_path to '' as $$
begin
  if p_operation_id is null or length(p_operation_id) not between 1 and 200
     or p_operation_id ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'invalid sync operation id';
  end if;
end;
$$;

create or replace function private.sync_request_hash(p_request jsonb)
returns text language sql immutable set search_path to '' as $$
  select pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_request::text, 'UTF8'), 'sha256'),
    'hex'
  )
$$;

create or replace function private.sync_receipt(
  p_household uuid, p_user uuid, p_operation_id text, p_request_hash text
) returns jsonb language plpgsql set search_path to '' as $$
declare saved private.sync_operation_receipts%rowtype;
begin
  perform private.sync_validate_operation_id(p_operation_id);
  perform private.lock_sync_entity(p_household, 'sync-operation', p_operation_id);
  select * into saved from private.sync_operation_receipts
    where household_id = p_household and operation_id = p_operation_id;
  if not found then return null; end if;
  if saved.actor_user_id <> p_user or saved.request_hash <> p_request_hash then
    raise exception using errcode = '22023', message = 'sync operation id was reused';
  end if;
  return saved.response;
end;
$$;

create or replace function private.store_sync_receipt(
  p_household uuid, p_user uuid, p_operation_id text,
  p_request_hash text, p_response jsonb
) returns void language plpgsql set search_path to '' as $$
begin
  if p_response->>'status' <> 'applied'
     or pg_catalog.jsonb_typeof(p_response->'revisions') <> 'object' then
    raise exception using errcode = '22023', message = 'invalid sync receipt response';
  end if;
  insert into private.sync_operation_receipts(
    household_id, operation_id, actor_user_id, request_hash, response
  ) values (p_household, p_operation_id, p_user, p_request_hash, p_response);
end;
$$;

revoke all on function private.sync_validate_operation_id(text) from public, anon, authenticated;
revoke all on function private.sync_request_hash(jsonb) from public, anon, authenticated;
revoke all on function private.sync_receipt(uuid,uuid,text,text) from public, anon, authenticated;
revoke all on function private.store_sync_receipt(uuid,uuid,text,text,jsonb) from public, anon, authenticated;

create or replace function private.sync_table_for_resource(p_resource text)
returns text language sql immutable set search_path to '' as $$
  select case p_resource
    when 'scenarios' then 'scenarios'
    when 'salary_submissions' then 'salary_submissions'
    when 'monthend_items' then 'monthend_items'
    when 'monthend_payments' then 'monthend_payments'
    when 'mortgage_loan_parts' then 'mortgage_loan_parts'
    when 'mortgage_rate_periods' then 'mortgage_rate_periods'
    when 'mortgage_payments' then 'mortgage_payments'
    when 'mortgage_valuations' then 'mortgage_valuations'
    when 'mortgage_contributions' then 'mortgage_contributions'
    when 'house_items' then 'house_items'
  end
$$;

create or replace function private.sync_allowed_row_keys(p_resource text)
returns text[] language sql immutable set search_path to '' as $$
  select case p_resource
    when 'scenarios' then array['id','created_at','name','saved_at','inputs','constants']
    when 'salary_submissions' then array['id','created_at','month','person_a_name','income_a','person_b_name','income_b','transfer_from','transfer_to','transfer_amount','equal_share','note','income_items']
    when 'monthend_items' then array['id','created_at','date_purchased','description','enter_amount','split','amount','fronted_by','owed_by','paid','pending','payment_id','note','personal_items','personal_a','personal_b']
    when 'monthend_payments' then array['id','created_at','item_ids','from_person','to_person','amount','period_label','note']
    when 'mortgage_loan_parts' then array['id','created_at','label','loan_number','start_balance','start_date','archived']
    when 'mortgage_rate_periods' then array['id','created_at','loan_part_id','start_date','end_date','rate','rate_type']
    when 'mortgage_payments' then array['id','created_at','loan_part_id','date','kind','description','amount','balance_after','paid_by','source','is_insats','paid_split']
    when 'mortgage_valuations' then array['id','created_at','date','value','note','is_purchase']
    when 'mortgage_contributions' then array['id','created_at','owner','date','amount','note']
    when 'house_items' then array['id','created_at','type','title','category','date','cost','vendor','interval_years','remind_days','notes']
  end
$$;

create or replace function private.sync_validate_expected_revisions(
  p_expected jsonb, p_keys text[]
) returns void language plpgsql immutable set search_path to '' as $$
declare key text; value jsonb;
begin
  if p_expected is null or p_keys is null or cardinality(p_keys) = 0
     or pg_catalog.jsonb_typeof(p_expected) <> 'object'
     or cardinality(p_keys) <> (select count(*) from pg_catalog.jsonb_object_keys(p_expected))
     or exists (
       select 1 from pg_catalog.jsonb_object_keys(p_expected) supplied
       where not (supplied = any(p_keys))
     ) then
    raise exception using errcode = '22023', message = 'invalid expected revision set';
  end if;
  foreach key in array p_keys loop
    value := p_expected->key;
    if value is null or (
      pg_catalog.jsonb_typeof(value) <> 'null' and (
        pg_catalog.jsonb_typeof(value) <> 'number'
        or value::text !~ '^[0-9]+$'
        or value::numeric not between 1 and 9007199254740991
      )
    ) then
      raise exception using errcode = '22023', message = 'invalid expected revision';
    end if;
  end loop;
end;
$$;

create or replace function private.sync_current_row_revision(
  p_household uuid, p_resource text, p_id text
) returns bigint language plpgsql stable set search_path to '' as $$
declare table_name text := private.sync_table_for_resource(p_resource); result bigint;
begin
  if table_name is null then
    raise exception using errcode = '22023', message = 'unsupported sync resource';
  end if;
  execute pg_catalog.format(
    'select revision from public.%I where household_id = $1 and id::text = $2', table_name
  ) into result using p_household, p_id;
  return result;
end;
$$;

create or replace function private.sync_any_row_exists(p_resource text, p_id text)
returns boolean language plpgsql stable set search_path to '' as $$
declare table_name text := private.sync_table_for_resource(p_resource); result boolean;
begin
  if table_name is null then
    raise exception using errcode = '22023', message = 'unsupported sync resource';
  end if;
  execute pg_catalog.format(
    'select exists(select 1 from public.%I where id::text = $1)', table_name
  ) into result using p_id;
  return result;
end;
$$;

create or replace function private.sync_apply_one_row(
  p_household uuid, p_resource text, p_row jsonb, p_expected_revision bigint
) returns bigint language plpgsql set search_path to '' as $$
declare
  table_name text := private.sync_table_for_resource(p_resource);
  insert_keys text[];
  update_keys text[];
  columns_sql text;
  values_sql text;
  assignments_sql text;
  result bigint;
begin
  select pg_catalog.array_agg(key order by key) into insert_keys
    from pg_catalog.jsonb_object_keys(p_row) key;
  select pg_catalog.array_agg(key order by key) into update_keys
    from pg_catalog.unnest(insert_keys) key where key not in ('id','created_at');
  select pg_catalog.string_agg(pg_catalog.format('%I', key), ', ') into columns_sql
    from pg_catalog.unnest(insert_keys) key;
  select pg_catalog.string_agg(pg_catalog.format('r.%I', key), ', ') into values_sql
    from pg_catalog.unnest(insert_keys) key;

  if p_expected_revision is null then
    execute pg_catalog.format(
      'insert into public.%I (household_id, %s) '
      'select $1, %s from pg_catalog.jsonb_populate_record(null::public.%I, $2) r '
      'returning revision',
      table_name, columns_sql, values_sql, table_name
    ) into result using p_household, p_row;
  else
    if coalesce(cardinality(update_keys), 0) = 0 then
      execute pg_catalog.format(
        'update public.%I set id = id where household_id = $1 and id::text = $2 '
        'and revision = $3 returning revision', table_name
      ) into result using p_household, p_row->>'id', p_expected_revision;
    else
      select pg_catalog.string_agg(pg_catalog.format('%1$I = r.%1$I', key), ', ')
        into assignments_sql from pg_catalog.unnest(update_keys) key;
      execute pg_catalog.format(
        'update public.%I t set %s '
        'from pg_catalog.jsonb_populate_record(null::public.%I, $2) r '
        'where t.household_id = $1 and t.id::text = $3 and t.revision = $4 '
        'returning t.revision',
        table_name, assignments_sql, table_name
      ) into result using p_household, p_row, p_row->>'id', p_expected_revision;
    end if;
  end if;
  return result;
end;
$$;

revoke all on function private.sync_table_for_resource(text) from public, anon, authenticated;
revoke all on function private.sync_allowed_row_keys(text) from public, anon, authenticated;
revoke all on function private.sync_validate_expected_revisions(jsonb,text[]) from public, anon, authenticated;
revoke all on function private.sync_current_row_revision(uuid,text,text) from public, anon, authenticated;
revoke all on function private.sync_any_row_exists(text,text) from public, anon, authenticated;
revoke all on function private.sync_apply_one_row(uuid,text,jsonb,bigint) from public, anon, authenticated;

create or replace function public.sync_apply_rows(
  p_operation_id text,
  p_resource text,
  p_rows jsonb,
  p_expected_revisions jsonb,
  p_seed boolean default false
) returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  hid uuid := (select private.current_household());
  actor uuid := (select auth.uid());
  request_hash text;
  prior jsonb;
  response jsonb;
  revisions jsonb := '{}'::jsonb;
  current_revisions jsonb := '{}'::jsonb;
  expected_keys text[];
  allowed_keys text[] := private.sync_allowed_row_keys(p_resource);
  row_value jsonb;
  row_id text;
  key text;
  current_revision bigint;
  new_revision bigint;
  parent_id text;
  current_paid boolean;
  current_payment_id text;
  conflict boolean := false;
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;
  if hid is null then raise exception using errcode = '42501', message = 'no household'; end if;
  if allowed_keys is null then
    raise exception using errcode = '22023', message = 'unsupported sync resource';
  end if;
  if p_rows is null or pg_catalog.jsonb_typeof(p_rows) <> 'array'
     or pg_catalog.jsonb_array_length(p_rows) not between 1 and 1000
     or pg_catalog.octet_length(p_rows::text) > 5242880
     or p_seed is null then
    raise exception using errcode = '22023', message = 'invalid row payload';
  end if;
  if p_resource = 'monthend_payments' and not p_seed then
    raise exception using errcode = '22023', message = 'settlement payments require the settlement RPC';
  end if;

  for row_value in select value from pg_catalog.jsonb_array_elements(p_rows) loop
    if pg_catalog.jsonb_typeof(row_value) <> 'object'
       or pg_catalog.jsonb_typeof(row_value->'id') <> 'string'
       or length(row_value->>'id') not between 1 and 512
       or (row_value->>'id') ~ '[[:cntrl:]]'
       or exists (
         select 1 from pg_catalog.jsonb_object_keys(row_value) supplied
         where not (supplied = any(allowed_keys))
       ) then
      raise exception using errcode = '22023', message = 'invalid row payload';
    end if;
    if p_resource = 'house_items' then
      begin perform (row_value->>'id')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode = '22023', message = 'invalid house item id';
      end;
    end if;
    if p_resource in ('mortgage_payments', 'mortgage_rate_periods')
       and row_value ? 'loan_part_id'
       and pg_catalog.jsonb_typeof(row_value->'loan_part_id') not in ('string', 'null') then
      raise exception using errcode = '22023', message = 'invalid mortgage parent id';
    end if;
  end loop;

  select coalesce(pg_catalog.array_agg(p_resource || ':' || id order by id), '{}'::text[]) into expected_keys
  from (
    select value->>'id' as id from pg_catalog.jsonb_array_elements(p_rows)
    group by value->>'id' having count(*) = 1
  ) unique_ids;
  if cardinality(expected_keys) <> pg_catalog.jsonb_array_length(p_rows) then
    raise exception using errcode = '22023', message = 'duplicate row id';
  end if;
  perform private.sync_validate_expected_revisions(p_expected_revisions, expected_keys);

  request_hash := private.sync_request_hash(pg_catalog.jsonb_build_object(
    'rpc', 'sync_apply_rows', 'resource', p_resource, 'rows', p_rows,
    'expected', p_expected_revisions, 'seed', p_seed
  ));
  prior := private.sync_receipt(hid, actor, p_operation_id, request_hash);
  if prior is not null then return prior; end if;

  -- Child mutations follow the same parent-before-child lock order as the
  -- Plan-97 mortgage cascade, including both old and proposed parents.
  if p_resource in ('mortgage_payments', 'mortgage_rate_periods') then
    for parent_id in
      select distinct candidate from (
        select value->>'loan_part_id' as candidate
          from pg_catalog.jsonb_array_elements(p_rows)
          where value ? 'loan_part_id' and pg_catalog.jsonb_typeof(value->'loan_part_id') = 'string'
        union all
        select case p_resource
          when 'mortgage_payments' then (
            select loan_part_id from public.mortgage_payments
            where household_id = hid and id = ids.id
          )
          else (
            select loan_part_id from public.mortgage_rate_periods
            where household_id = hid and id = ids.id
          )
        end
        from (select value->>'id' id from pg_catalog.jsonb_array_elements(p_rows)) ids
      ) parents where candidate is not null and candidate <> '' order by candidate
    loop
      perform private.lock_sync_entity(hid, 'mortgage_loan_parts', parent_id);
    end loop;
    for parent_id in
      select distinct value->>'loan_part_id'
      from pg_catalog.jsonb_array_elements(p_rows)
      where value ? 'loan_part_id'
        and pg_catalog.jsonb_typeof(value->'loan_part_id') = 'string'
      order by value->>'loan_part_id'
    loop
      if parent_id = '' or not exists (
        select 1 from public.mortgage_loan_parts
        where household_id = hid and id = parent_id
      ) then
        if parent_id <> ''
           and private.sync_tombstone_exists(hid, 'mortgage_loan_parts', parent_id) then
          raise exception using errcode = '23503', message = 'deleted mortgage loan part cannot receive children';
        end if;
        raise exception using errcode = '22023', message = 'mortgage parent is not in caller household';
      end if;
    end loop;
  end if;

  for row_id in
    select value->>'id' from pg_catalog.jsonb_array_elements(p_rows) order by value->>'id'
  loop
    -- The nil-household lock serializes globally unique primary keys without
    -- weakening Plan-97's household tombstone lock.
    perform private.lock_sync_entity('00000000-0000-0000-0000-000000000000', p_resource, row_id);
    perform private.lock_sync_entity(hid, p_resource, row_id);
  end loop;

  for row_value in select value from pg_catalog.jsonb_array_elements(p_rows) order by value->>'id' loop
    row_id := row_value->>'id';
    key := p_resource || ':' || row_id;
    current_revision := private.sync_current_row_revision(hid, p_resource, row_id);
    current_revisions := current_revisions || pg_catalog.jsonb_build_object(key, pg_catalog.to_jsonb(current_revision));
    if p_resource = 'monthend_items' and not p_seed then
      select item.paid, item.payment_id into current_paid, current_payment_id
        from public.monthend_items item
        where item.household_id = hid and item.id = row_id;
      if current_revision is null then
        if (row_value ? 'paid' and coalesce((row_value->>'paid')::boolean, false))
           or (row_value ? 'payment_id' and row_value->>'payment_id' is not null) then
          raise exception using errcode = '22023', message = 'settlement fields are server managed';
        end if;
      elsif (row_value ? 'paid'
          and (row_value->>'paid')::boolean is distinct from current_paid)
         or (row_value ? 'payment_id'
          and row_value->>'payment_id' is distinct from current_payment_id) then
        raise exception using errcode = '22023', message = 'settlement fields are server managed';
      end if;
    end if;
    if not p_seed and (
      case when pg_catalog.jsonb_typeof(p_expected_revisions->key) = 'null' then null
           else (p_expected_revisions->>key)::bigint end
    ) is distinct from current_revision then
      conflict := true;
    end if;
    if current_revision is null and private.sync_any_row_exists(p_resource, row_id) then
      conflict := true;
    end if;
    if current_revision is null and private.sync_tombstone_exists(hid, p_resource, row_id) then
      if p_seed then
        revisions := revisions || pg_catalog.jsonb_build_object(key, null);
      else
        conflict := true;
      end if;
    end if;
  end loop;

  if conflict then
    return pg_catalog.jsonb_build_object('status', 'conflict', 'revisions', current_revisions);
  end if;

  for row_value in select value from pg_catalog.jsonb_array_elements(p_rows) order by value->>'id' loop
    row_id := row_value->>'id';
    key := p_resource || ':' || row_id;
    current_revision := private.sync_current_row_revision(hid, p_resource, row_id);
    if p_seed and (current_revision is not null
      or private.sync_tombstone_exists(hid, p_resource, row_id)
      or private.sync_any_row_exists(p_resource, row_id)) then
      revisions := revisions || pg_catalog.jsonb_build_object(key, pg_catalog.to_jsonb(current_revision));
      continue;
    end if;
    new_revision := private.sync_apply_one_row(
      hid, p_resource, row_value,
      case when p_seed then null else (p_expected_revisions->>key)::bigint end
    );
    if new_revision is null then
      raise exception using errcode = '40001', message = 'row changed during sync mutation';
    end if;
    revisions := revisions || pg_catalog.jsonb_build_object(key, new_revision);
  end loop;

  response := pg_catalog.jsonb_build_object('status', 'applied', 'revisions', revisions);
  perform private.store_sync_receipt(hid, actor, p_operation_id, request_hash, response);
  return response;
end;
$$;
alter function public.sync_apply_rows(text,text,jsonb,jsonb,boolean) owner to postgres;
revoke all on function public.sync_apply_rows(text,text,jsonb,jsonb,boolean) from public, anon;
grant execute on function public.sync_apply_rows(text,text,jsonb,jsonb,boolean) to authenticated;

create or replace function private.sync_tool_allowed(p_tool text)
returns boolean language sql immutable set search_path to '' as $$
  select p_tool = any(array[
    'konsultkalkyl', 'lonevaxling', 'studentloan', 'hushallsbudget',
    'manadsavslut-settings', 'bolanekoll-settings',
    'bostadskalkyl-global-constants', 'bostadskalkyl-drift-items',
    'bostadskalkyl-savings-items'
  ]::text[])
$$;
revoke all on function private.sync_tool_allowed(text) from public, anon, authenticated;

create or replace function public.sync_apply_tool_state(
  p_operation_id text,
  p_tool text,
  p_data jsonb,
  p_expected_revision bigint,
  p_seed boolean default false
) returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  hid uuid := (select private.current_household());
  actor uuid := (select auth.uid());
  request_hash text;
  prior jsonb;
  response jsonb;
  current_revision bigint;
  new_revision bigint;
  key text;
begin
  if actor is null then raise exception using errcode = '42501', message = 'authentication required'; end if;
  if hid is null then raise exception using errcode = '42501', message = 'no household'; end if;
  if not private.sync_tool_allowed(p_tool) or p_seed is null
     or (p_expected_revision is not null and p_expected_revision not between 1 and 9007199254740991)
     or pg_catalog.octet_length(coalesce(p_data, 'null'::jsonb)::text) > 1048576 then
    raise exception using errcode = '22023', message = 'invalid tool state mutation';
  end if;
  p_data := coalesce(p_data, 'null'::jsonb);
  if (p_tool in ('bostadskalkyl-drift-items', 'bostadskalkyl-savings-items')
      and pg_catalog.jsonb_typeof(p_data) <> 'array')
     or (p_tool = 'bostadskalkyl-global-constants'
      and pg_catalog.jsonb_typeof(p_data) not in ('object', 'null'))
     or (p_tool not like 'bostadskalkyl-%'
      and pg_catalog.jsonb_typeof(p_data) <> 'object') then
    raise exception using errcode = '22023', message = 'invalid tool state data';
  end if;
  key := 'tool_state:' || p_tool;
  request_hash := private.sync_request_hash(pg_catalog.jsonb_build_object(
    'rpc', 'sync_apply_tool_state', 'tool', p_tool, 'data', p_data,
    'expected', p_expected_revision, 'seed', p_seed
  ));
  prior := private.sync_receipt(hid, actor, p_operation_id, request_hash);
  if prior is not null then return prior; end if;

  perform private.lock_sync_entity(hid, 'tool_state', p_tool);
  select revision into current_revision from public.tool_state
    where household_id = hid and tool = p_tool;
  if not p_seed and p_expected_revision is distinct from current_revision then
    return pg_catalog.jsonb_build_object(
      'status', 'conflict', 'revisions',
      pg_catalog.jsonb_build_object(key, pg_catalog.to_jsonb(current_revision))
    );
  end if;
  if p_seed and current_revision is not null then
    new_revision := current_revision;
  elsif current_revision is null then
    insert into public.tool_state(household_id, tool, data)
      values (hid, p_tool, p_data) returning revision into new_revision;
  else
    update public.tool_state set data = p_data
      where household_id = hid and tool = p_tool and revision = p_expected_revision
      returning revision into new_revision;
  end if;
  if new_revision is null then
    raise exception using errcode = '40001', message = 'tool state changed during sync mutation';
  end if;
  response := pg_catalog.jsonb_build_object(
    'status', 'applied', 'revisions', pg_catalog.jsonb_build_object(key, new_revision)
  );
  perform private.store_sync_receipt(hid, actor, p_operation_id, request_hash, response);
  return response;
end;
$$;
alter function public.sync_apply_tool_state(text,text,jsonb,bigint,boolean) owner to postgres;
revoke all on function public.sync_apply_tool_state(text,text,jsonb,bigint,boolean) from public, anon;
grant execute on function public.sync_apply_tool_state(text,text,jsonb,bigint,boolean) to authenticated;

create or replace function public.sync_delete_rows(
  p_operation_id text,
  p_resource text,
  p_ids text[],
  p_expected_revisions jsonb
) returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  hid uuid := (select private.current_household());
  actor uuid := (select auth.uid());
  request_hash text;
  prior jsonb;
  response jsonb;
  current_revisions jsonb := '{}'::jsonb;
  revisions jsonb := '{}'::jsonb;
  expected_keys text[];
  row_id text;
  key text;
  current_revision bigint;
  conflict boolean := false;
begin
  if actor is null then raise exception using errcode = '42501', message = 'authentication required'; end if;
  if hid is null then raise exception using errcode = '42501', message = 'no household'; end if;
  if private.sync_table_for_resource(p_resource) is null
     or p_resource in ('monthend_payments', 'mortgage_loan_parts') then
    raise exception using errcode = '22023', message = 'unsupported generic delete resource';
  end if;
  if p_ids is null or cardinality(p_ids) not between 1 and 1000
     or exists (select 1 from pg_catalog.unnest(p_ids) id
       where id is null or length(id) not between 1 and 512 or id ~ '[[:cntrl:]]')
     or (select count(distinct id) from pg_catalog.unnest(p_ids) id) <> cardinality(p_ids) then
    raise exception using errcode = '22023', message = 'invalid delete ids';
  end if;
  if p_resource = 'house_items' then
    begin perform id::uuid from pg_catalog.unnest(p_ids) id;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'invalid house item id';
    end;
  end if;
  select pg_catalog.array_agg(p_resource || ':' || id order by id) into expected_keys
    from pg_catalog.unnest(p_ids) id;
  perform private.sync_validate_expected_revisions(p_expected_revisions, expected_keys);
  request_hash := private.sync_request_hash(pg_catalog.jsonb_build_object(
    'rpc', 'sync_delete_rows', 'resource', p_resource,
    'ids', pg_catalog.to_jsonb(p_ids), 'expected', p_expected_revisions
  ));
  prior := private.sync_receipt(hid, actor, p_operation_id, request_hash);
  if prior is not null then return prior; end if;

  for row_id in select id from pg_catalog.unnest(p_ids) id order by id loop
    perform private.lock_sync_entity('00000000-0000-0000-0000-000000000000', p_resource, row_id);
    perform private.lock_sync_entity(hid, p_resource, row_id);
  end loop;
  for row_id in select id from pg_catalog.unnest(p_ids) id order by id loop
    key := p_resource || ':' || row_id;
    current_revision := private.sync_current_row_revision(hid, p_resource, row_id);
    current_revisions := current_revisions || pg_catalog.jsonb_build_object(key, current_revision);
    if (
      case when pg_catalog.jsonb_typeof(p_expected_revisions->key) = 'null' then null
           else (p_expected_revisions->>key)::bigint end
    ) is distinct from current_revision then
      conflict := true;
    end if;
  end loop;
  if conflict then
    return pg_catalog.jsonb_build_object('status', 'conflict', 'revisions', current_revisions);
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
    else raise exception using errcode = '22023', message = 'unsupported generic delete resource';
  end case;
  for row_id in select id from pg_catalog.unnest(p_ids) id loop
    revisions := revisions || pg_catalog.jsonb_build_object(p_resource || ':' || row_id, null);
  end loop;
  response := pg_catalog.jsonb_build_object('status', 'applied', 'revisions', revisions);
  perform private.store_sync_receipt(hid, actor, p_operation_id, request_hash, response);
  return response;
end;
$$;
alter function public.sync_delete_rows(text,text,text[],jsonb) owner to postgres;
revoke all on function public.sync_delete_rows(text,text,text[],jsonb) from public, anon;
grant execute on function public.sync_delete_rows(text,text,text[],jsonb) to authenticated;

create or replace function public.sync_settle_items(
  p_operation_id text,
  p_payment jsonb,
  p_expected_revisions jsonb
) returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  hid uuid := (select private.current_household());
  actor uuid := (select auth.uid());
  request_hash text;
  prior jsonb;
  response jsonb;
  payment_id text;
  item_ids text[];
  item_id text;
  key text;
  expected_keys text[];
  current_revisions jsonb := '{}'::jsonb;
  revisions jsonb := '{}'::jsonb;
  current_revision bigint;
  new_revision bigint;
  conflict boolean := false;
begin
  if actor is null then raise exception using errcode = '42501', message = 'authentication required'; end if;
  if hid is null then raise exception using errcode = '42501', message = 'no household'; end if;
  if p_payment is null or pg_catalog.jsonb_typeof(p_payment) <> 'object'
     or pg_catalog.jsonb_typeof(p_payment->'id') <> 'string'
     or length(p_payment->>'id') not between 1 and 512
     or pg_catalog.jsonb_typeof(p_payment->'item_ids') <> 'array'
     or pg_catalog.jsonb_array_length(p_payment->'item_ids') not between 1 and 1000
     or exists (
       select 1 from pg_catalog.jsonb_array_elements(p_payment->'item_ids') item
       where pg_catalog.jsonb_typeof(item) <> 'string'
     )
     or pg_catalog.octet_length(p_payment::text) > 1048576
     or exists (
       select 1 from pg_catalog.jsonb_object_keys(p_payment) supplied
       where not (supplied = any(array[
         'id','created_at','item_ids','from_person','to_person','amount','period_label','note'
       ]::text[]))
     ) then
    raise exception using errcode = '22023', message = 'invalid settlement payload';
  end if;
  payment_id := p_payment->>'id';
  select pg_catalog.array_agg(value order by value) into item_ids
    from pg_catalog.jsonb_array_elements_text(p_payment->'item_ids') value;
  if exists (select 1 from pg_catalog.unnest(item_ids) id
       where id = '' or length(id) > 512 or id ~ '[[:cntrl:]]')
     or (select count(distinct id) from pg_catalog.unnest(item_ids) id) <> cardinality(item_ids) then
    raise exception using errcode = '22023', message = 'invalid settlement item ids';
  end if;
  expected_keys := array['monthend_payments:' || payment_id]
    || (select pg_catalog.array_agg('monthend_items:' || id order by id)
        from pg_catalog.unnest(item_ids) id);
  perform private.sync_validate_expected_revisions(p_expected_revisions, expected_keys);
  if pg_catalog.jsonb_typeof(p_expected_revisions->('monthend_payments:' || payment_id)) <> 'null' then
    raise exception using errcode = '22023', message = 'settlement payment must be new';
  end if;
  request_hash := private.sync_request_hash(pg_catalog.jsonb_build_object(
    'rpc', 'sync_settle_items', 'payment', p_payment, 'expected', p_expected_revisions
  ));
  prior := private.sync_receipt(hid, actor, p_operation_id, request_hash);
  if prior is not null then return prior; end if;

  perform private.lock_sync_entity('00000000-0000-0000-0000-000000000000', 'monthend_payments', payment_id);
  perform private.lock_sync_entity(hid, 'monthend_payments', payment_id);
  for item_id in select id from pg_catalog.unnest(item_ids) id order by id loop
    perform private.lock_sync_entity('00000000-0000-0000-0000-000000000000', 'monthend_items', item_id);
    perform private.lock_sync_entity(hid, 'monthend_items', item_id);
  end loop;

  current_revision := private.sync_current_row_revision(hid, 'monthend_payments', payment_id);
  current_revisions := current_revisions || pg_catalog.jsonb_build_object(
    'monthend_payments:' || payment_id, current_revision
  );
  if current_revision is not null or private.sync_any_row_exists('monthend_payments', payment_id)
     or private.sync_tombstone_exists(hid, 'monthend_payments', payment_id) then
    conflict := true;
  end if;
  for item_id in select id from pg_catalog.unnest(item_ids) id order by id loop
    key := 'monthend_items:' || item_id;
    current_revision := private.sync_current_row_revision(hid, 'monthend_items', item_id);
    current_revisions := current_revisions || pg_catalog.jsonb_build_object(key, current_revision);
    if current_revision is null or (
      case when pg_catalog.jsonb_typeof(p_expected_revisions->key) = 'null' then null
           else (p_expected_revisions->>key)::bigint end
    ) is distinct from current_revision then conflict := true; end if;
  end loop;
  if conflict then
    return pg_catalog.jsonb_build_object('status', 'conflict', 'revisions', current_revisions);
  end if;

  insert into public.monthend_payments(
    id, household_id, created_at, item_ids, from_person, to_person,
    amount, period_label, note
  ) values (
    payment_id, hid,
    coalesce((p_payment->>'created_at')::timestamptz, pg_catalog.clock_timestamp()),
    p_payment->'item_ids', p_payment->>'from_person', p_payment->>'to_person',
    coalesce((p_payment->>'amount')::numeric, 0),
    coalesce(p_payment->>'period_label', ''), coalesce(p_payment->>'note', '')
  ) returning revision into new_revision;
  revisions := revisions || pg_catalog.jsonb_build_object(
    'monthend_payments:' || payment_id, new_revision
  );
  for item_id in select id from pg_catalog.unnest(item_ids) id order by id loop
    update public.monthend_items set paid = true, payment_id = p_payment->>'id'
      where household_id = hid and id = item_id
      returning revision into new_revision;
    revisions := revisions || pg_catalog.jsonb_build_object('monthend_items:' || item_id, new_revision);
  end loop;
  response := pg_catalog.jsonb_build_object('status', 'applied', 'revisions', revisions);
  perform private.store_sync_receipt(hid, actor, p_operation_id, request_hash, response);
  return response;
end;
$$;
alter function public.sync_settle_items(text,jsonb,jsonb) owner to postgres;
revoke all on function public.sync_settle_items(text,jsonb,jsonb) from public, anon;
grant execute on function public.sync_settle_items(text,jsonb,jsonb) to authenticated;

create or replace function public.sync_unsettle_payment(
  p_operation_id text,
  p_id text,
  p_expected_revisions jsonb
) returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  hid uuid := (select private.current_household());
  actor uuid := (select auth.uid());
  request_hash text;
  prior jsonb;
  response jsonb;
  payment_revision bigint;
  payment_items jsonb;
  settlement_item_ids text[] := '{}'::text[];
  item_id text;
  current_revision bigint;
  new_revision bigint;
  current_revisions jsonb := '{}'::jsonb;
  revisions jsonb := '{}'::jsonb;
  supplied_keys text[];
  row_payment_id text;
begin
  if actor is null then raise exception using errcode = '42501', message = 'authentication required'; end if;
  if hid is null then raise exception using errcode = '42501', message = 'no household'; end if;
  if p_id is null or length(p_id) not between 1 and 512 or p_id ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'invalid payment id';
  end if;
  if p_expected_revisions is null or pg_catalog.jsonb_typeof(p_expected_revisions) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid expected revision set';
  end if;
  select pg_catalog.array_agg(key order by key) into supplied_keys
    from pg_catalog.jsonb_object_keys(p_expected_revisions) key;
  perform private.sync_validate_expected_revisions(p_expected_revisions, supplied_keys);
  request_hash := private.sync_request_hash(pg_catalog.jsonb_build_object(
    'rpc', 'sync_unsettle_payment', 'id', p_id, 'expected', p_expected_revisions
  ));
  prior := private.sync_receipt(hid, actor, p_operation_id, request_hash);
  if prior is not null then return prior; end if;

  perform private.lock_sync_entity('00000000-0000-0000-0000-000000000000', 'monthend_payments', p_id);
  perform private.lock_sync_entity(hid, 'monthend_payments', p_id);
  select p.revision, p.item_ids into payment_revision, payment_items
    from public.monthend_payments p where p.household_id = hid and p.id = p_id;
  current_revisions := pg_catalog.jsonb_build_object('monthend_payments:' || p_id, payment_revision);
  if payment_revision is null then
    return pg_catalog.jsonb_build_object('status', 'conflict', 'revisions', current_revisions);
  end if;
  if pg_catalog.jsonb_typeof(payment_items) <> 'array' then
    raise exception using errcode = '22023', message = 'stored settlement item ids are invalid';
  end if;
  select coalesce(pg_catalog.array_agg(value order by value), '{}'::text[]) into settlement_item_ids
    from pg_catalog.jsonb_array_elements_text(payment_items) value;
  if (select count(distinct id) from pg_catalog.unnest(settlement_item_ids) id) <> cardinality(settlement_item_ids) then
    raise exception using errcode = '22023', message = 'stored settlement item ids are invalid';
  end if;
  for item_id in select id from pg_catalog.unnest(settlement_item_ids) id order by id loop
    perform private.lock_sync_entity('00000000-0000-0000-0000-000000000000', 'monthend_items', item_id);
    perform private.lock_sync_entity(hid, 'monthend_items', item_id);
  end loop;
  for item_id in select id from pg_catalog.unnest(settlement_item_ids) id order by id loop
    select revision, payment_id into current_revision, row_payment_id
      from public.monthend_items where household_id = hid and id = item_id;
    current_revisions := current_revisions || pg_catalog.jsonb_build_object(
      'monthend_items:' || item_id, current_revision
    );
    if current_revision is null or row_payment_id is distinct from p_id then
      return pg_catalog.jsonb_build_object('status', 'conflict', 'revisions', current_revisions);
    end if;
  end loop;
  if p_expected_revisions is distinct from current_revisions then
    return pg_catalog.jsonb_build_object('status', 'conflict', 'revisions', current_revisions);
  end if;

  perform private.record_sync_tombstones(hid, 'monthend_payments', array[p_id]);
  for item_id in select id from pg_catalog.unnest(settlement_item_ids) id order by id loop
    update public.monthend_items set paid = false, payment_id = null
      where household_id = hid and id = item_id
      returning revision into new_revision;
    revisions := revisions || pg_catalog.jsonb_build_object('monthend_items:' || item_id, new_revision);
  end loop;
  delete from public.monthend_payments where household_id = hid and id = p_id;
  revisions := revisions || pg_catalog.jsonb_build_object('monthend_payments:' || p_id, null);
  response := pg_catalog.jsonb_build_object('status', 'applied', 'revisions', revisions);
  perform private.store_sync_receipt(hid, actor, p_operation_id, request_hash, response);
  return response;
end;
$$;
alter function public.sync_unsettle_payment(text,text,jsonb) owner to postgres;
revoke all on function public.sync_unsettle_payment(text,text,jsonb) from public, anon;
grant execute on function public.sync_unsettle_payment(text,text,jsonb) to authenticated;

create or replace function public.sync_delete_mortgage_loan_part(
  p_operation_id text,
  p_loan_part_id text,
  p_expected_revisions jsonb
) returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  hid uuid := (select private.current_household());
  actor uuid := (select auth.uid());
  request_hash text;
  prior jsonb;
  response jsonb;
  parent_revision bigint;
  payment_ids text[] := '{}'::text[];
  period_ids text[] := '{}'::text[];
  child_id text;
  current_revision bigint;
  current_revisions jsonb := '{}'::jsonb;
  revisions jsonb := '{}'::jsonb;
  supplied_keys text[];
begin
  if actor is null then raise exception using errcode = '42501', message = 'authentication required'; end if;
  if hid is null then raise exception using errcode = '42501', message = 'no household'; end if;
  if p_loan_part_id is null or length(p_loan_part_id) not between 1 and 512
     or p_loan_part_id ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'invalid loan part id';
  end if;
  if p_expected_revisions is null or pg_catalog.jsonb_typeof(p_expected_revisions) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid expected revision set';
  end if;
  select pg_catalog.array_agg(key order by key) into supplied_keys
    from pg_catalog.jsonb_object_keys(p_expected_revisions) key;
  perform private.sync_validate_expected_revisions(p_expected_revisions, supplied_keys);
  request_hash := private.sync_request_hash(pg_catalog.jsonb_build_object(
    'rpc', 'sync_delete_mortgage_loan_part', 'id', p_loan_part_id,
    'expected', p_expected_revisions
  ));
  prior := private.sync_receipt(hid, actor, p_operation_id, request_hash);
  if prior is not null then return prior; end if;

  perform private.lock_sync_entity('00000000-0000-0000-0000-000000000000', 'mortgage_loan_parts', p_loan_part_id);
  perform private.lock_sync_entity(hid, 'mortgage_loan_parts', p_loan_part_id);
  select revision into parent_revision from public.mortgage_loan_parts
    where household_id = hid and id = p_loan_part_id;
  current_revisions := pg_catalog.jsonb_build_object(
    'mortgage_loan_parts:' || p_loan_part_id, parent_revision
  );
  if parent_revision is null then
    return pg_catalog.jsonb_build_object('status', 'conflict', 'revisions', current_revisions);
  end if;

  select coalesce(pg_catalog.array_agg(id order by id), '{}'::text[]) into payment_ids
    from public.mortgage_payments
    where household_id = hid and loan_part_id = p_loan_part_id;
  select coalesce(pg_catalog.array_agg(id order by id), '{}'::text[]) into period_ids
    from public.mortgage_rate_periods
    where household_id = hid and loan_part_id = p_loan_part_id;
  for child_id in select id from pg_catalog.unnest(payment_ids) id order by id loop
    perform private.lock_sync_entity('00000000-0000-0000-0000-000000000000', 'mortgage_payments', child_id);
    perform private.lock_sync_entity(hid, 'mortgage_payments', child_id);
  end loop;
  for child_id in select id from pg_catalog.unnest(period_ids) id order by id loop
    perform private.lock_sync_entity('00000000-0000-0000-0000-000000000000', 'mortgage_rate_periods', child_id);
    perform private.lock_sync_entity(hid, 'mortgage_rate_periods', child_id);
  end loop;
  for child_id in select id from pg_catalog.unnest(payment_ids) id order by id loop
    current_revision := private.sync_current_row_revision(hid, 'mortgage_payments', child_id);
    current_revisions := current_revisions || pg_catalog.jsonb_build_object(
      'mortgage_payments:' || child_id, current_revision
    );
  end loop;
  for child_id in select id from pg_catalog.unnest(period_ids) id order by id loop
    current_revision := private.sync_current_row_revision(hid, 'mortgage_rate_periods', child_id);
    current_revisions := current_revisions || pg_catalog.jsonb_build_object(
      'mortgage_rate_periods:' || child_id, current_revision
    );
  end loop;
  if p_expected_revisions is distinct from current_revisions then
    return pg_catalog.jsonb_build_object('status', 'conflict', 'revisions', current_revisions);
  end if;

  perform private.record_sync_tombstones(hid, 'mortgage_payments', payment_ids);
  perform private.record_sync_tombstones(hid, 'mortgage_rate_periods', period_ids);
  perform private.record_sync_tombstones(hid, 'mortgage_loan_parts', array[p_loan_part_id]);
  delete from public.mortgage_payments
    where household_id = hid and loan_part_id = p_loan_part_id;
  delete from public.mortgage_rate_periods
    where household_id = hid and loan_part_id = p_loan_part_id;
  delete from public.mortgage_loan_parts
    where household_id = hid and id = p_loan_part_id;
  revisions := pg_catalog.jsonb_build_object('mortgage_loan_parts:' || p_loan_part_id, null);
  for child_id in select id from pg_catalog.unnest(payment_ids) id loop
    revisions := revisions || pg_catalog.jsonb_build_object('mortgage_payments:' || child_id, null);
  end loop;
  for child_id in select id from pg_catalog.unnest(period_ids) id loop
    revisions := revisions || pg_catalog.jsonb_build_object('mortgage_rate_periods:' || child_id, null);
  end loop;
  response := pg_catalog.jsonb_build_object('status', 'applied', 'revisions', revisions);
  perform private.store_sync_receipt(hid, actor, p_operation_id, request_hash, response);
  return response;
end;
$$;
alter function public.sync_delete_mortgage_loan_part(text,text,jsonb) owner to postgres;
revoke all on function public.sync_delete_mortgage_loan_part(text,text,jsonb) from public, anon;
grant execute on function public.sync_delete_mortgage_loan_part(text,text,jsonb) to authenticated;

-- Split independently edited Bostadskalkyl preference slices. The former
-- combined row is retained as migration history and is no longer writable by
-- application RPCs. The helper makes the data step directly testable and safe
-- to rerun without overwriting an already edited split row.
create or replace function private.migrate_bostadskalkyl_preferences()
returns void language plpgsql set search_path to '' as $$
begin
  insert into public.tool_state(household_id, tool, data)
  select household_id, 'bostadskalkyl-global-constants',
    coalesce(data->'globalConstants', 'null'::jsonb)
  from public.tool_state where tool = 'bostadskalkyl-prefs'
  on conflict (household_id, tool) do nothing;

  insert into public.tool_state(household_id, tool, data)
  select household_id, 'bostadskalkyl-drift-items',
    case when pg_catalog.jsonb_typeof(data->'driftItems') = 'array'
      then data->'driftItems' else '[]'::jsonb end
  from public.tool_state where tool = 'bostadskalkyl-prefs'
  on conflict (household_id, tool) do nothing;

  insert into public.tool_state(household_id, tool, data)
  select household_id, 'bostadskalkyl-savings-items',
    case when pg_catalog.jsonb_typeof(data->'savingsItems') = 'array'
      then data->'savingsItems' else '[]'::jsonb end
  from public.tool_state where tool = 'bostadskalkyl-prefs'
  on conflict (household_id, tool) do nothing;
end;
$$;
revoke all on function private.migrate_bostadskalkyl_preferences()
  from public, anon, authenticated;
select private.migrate_bostadskalkyl_preferences();

-- A stale client must fail closed instead of bypassing the revision contract.
revoke insert, update, delete on
  public.tool_state, public.scenarios, public.salary_submissions,
  public.monthend_items, public.monthend_payments,
  public.mortgage_loan_parts, public.mortgage_rate_periods,
  public.mortgage_payments, public.mortgage_valuations,
  public.mortgage_contributions, public.house_items
from anon, authenticated;

-- Retire mutation entry points that have no expected revision or operation
-- receipt. Their definitions remain only for migration history.
revoke execute on function public.settle_items(
  text,jsonb,text,text,numeric,text,text,timestamp with time zone
) from public, anon, authenticated;
revoke execute on function public.unsettle_payment(text)
  from public, anon, authenticated;
revoke execute on function public.delete_household_rows(text,text[])
  from public, anon, authenticated;
revoke execute on function public.delete_mortgage_loan_part(text)
  from public, anon, authenticated;
