-- Plan 149 (Stage 1) — Vindsplanen plan variants. A household can now hold
-- several attic_plans rows and delete one, so attic_plans joins the durable
-- delete contract exactly as house_items does (plans 97/98):
--   * the reject_tombstoned_row guard trigger, so a stale client cannot
--     resurrect a deleted plan id through sync_apply_rows;
--   * an 'attic_plans' arm (plus the house_items-style uuid id pre-check) in
--     public.sync_delete_rows, which records the tombstone and deletes the
--     row scoped to the caller's household;
--   * an 'attic_plans' arm in the retired public.delete_household_rows, for
--     parity with house_items. It stays revoked from every client role.
-- This supersedes the first two bullets of section 4 in
-- 20261125100000_attic_plans.sql. Deleting the household's last plan is
-- allowed at DB level; the UI never offers it. RLS and grants on attic_plans
-- are unchanged (reads via hh_all, no direct client insert/update/delete).
-- Plan-84 landmine: both functions are re-declared from their LATEST applied
-- text; only the attic_plans lines are added, every other line is identical.
-- Idempotent (safe to re-run).

-- ── 1. Tombstone guard (as 20260714100000 did for house_items) ──────────────
-- Creating a trigger writes no rows, so existing plans are untouched.
create or replace trigger reject_deleted_attic_plans before insert or update on public.attic_plans
for each row execute function private.reject_tombstoned_row('attic_plans');

-- ── 2. public.sync_delete_rows ──────────────────────────────────────────────
-- Copied from 20260714110000_optimistic_concurrency.sql (latest and only
-- definition). ADDED: the 'attic_plans' uuid id pre-check (mirrors the
-- house_items one) and the 'attic_plans' delete arm.
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
  if p_resource = 'attic_plans' then
    begin perform id::uuid from pg_catalog.unnest(p_ids) id;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'invalid attic plan id';
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
    when 'attic_plans' then delete from public.attic_plans where household_id = hid and id::text = any(p_ids);
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

-- ── 3. public.delete_household_rows (retired) ───────────────────────────────
-- Copied from 20260714100000_durable_delete_tombstones.sql (latest
-- definition; 20260714110000 only revoked its execute grant). ADDED: the
-- 'attic_plans' arm. create or replace keeps the existing ACL; the
-- 20260714110000 execute revoke is re-asserted below and no grant is made.
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
    when 'attic_plans' then delete from public.attic_plans where household_id = hid and id::text = any(p_ids);
  end case;
end;
$$;

alter function public.delete_household_rows(text, text[]) owner to postgres;
revoke execute on function public.delete_household_rows(text,text[])
  from public, anon, authenticated;
