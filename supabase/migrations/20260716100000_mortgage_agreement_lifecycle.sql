-- Plan 109a (Stage 1) — Mortgage agreement lifecycle: shared bank catalogue,
-- agreement end state, payment→agreement provenance, and the atomic
-- bank-change / revert RPC pair. Purely additive groundwork; zero UI change.
--
-- Lifecycle model (plan 109, confirmed 2026-07-16): an agreement spans the
-- lifetime of the bank relationship; a villkorsändringsdag expires a rate
-- period (binding), never a loan part or an agreement; a same-bank restructure
-- archives/creates parts within the same agreement; ONLY a bank change closes
-- an agreement. Nothing here forces a new agreement for a re-fixing.
--
-- Idempotent / repeatable: every DDL step is guarded; the two data steps live
-- in retained private helper functions that are safe to rerun (and are
-- re-invoked by supabase/tests/database/mortgage_agreement_lifecycle_test.sql).

-- ── 1. Shared mortgage_bank_catalog ──────────────────────────────────────────
-- Global read-only reference data: stable bank identity plus deliberately
-- curated convention defaults. Null convention values mean "unverified /
-- unknown"; a non-null value must carry provenance in conventions_source /
-- conventions_verified_at (reviewed migrations only — never client writes,
-- never one household's detected conventions promoted to a global default).
create table if not exists public.mortgage_bank_catalog (
  id                       text primary key default gen_random_uuid()::text,
  slug                     text not null unique,
  label                    text not null,
  created_at               timestamptz not null default now(),
  -- curated convention parameters (null = unknown/unverified)
  year_basis               int  check (year_basis in (360, 365)),
  billing                  text check (billing in ('month-end', 'fixed')),
  -- provenance/version metadata: distinguishes a known catalogue default from
  -- an unknown value. Bump conventions_version on any curated value change.
  conventions_version      int not null default 1,
  conventions_source       text,
  conventions_verified_at  timestamptz
);
alter table public.mortgage_bank_catalog enable row level security;
drop policy if exists catalog_read on public.mortgage_bank_catalog;
create policy catalog_read on public.mortgage_bank_catalog
  for select to authenticated using (true);
-- Supabase default privileges grant broadly on new public tables; the
-- catalogue contract is authenticated SELECT only, no household writes.
revoke all on table public.mortgage_bank_catalog from public, anon, authenticated;
grant select on table public.mortgage_bank_catalog to authenticated;
grant all on table public.mortgage_bank_catalog to service_role;

-- Conservative seed: the one known existing bank identity (the plan-103 seed
-- is literally 'Danske'). The catalogue label deliberately matches the seeded
-- household label byte-for-byte so the attach below denormalises to an
-- identical value (zero user-visible change). Convention facts stay null
-- until verified against authoritative bank documentation; a later reviewed
-- migration may retitle or fill them.
insert into public.mortgage_bank_catalog (id, slug, label)
values ('catalog-danske', 'danske', 'Danske')
on conflict (slug) do nothing;

-- ── 2. mortgage_banks: nullable catalogue link ───────────────────────────────
alter table public.mortgage_banks
  add column if not exists catalog_id text references public.mortgage_bank_catalog(id);

-- Explicit reviewed mapping (no fuzzy matching): only the plan-103 seed label
-- 'Danske' attaches to its catalogue row. `label = c.label` encodes the
-- denormalise-on-attach contract (offline loads and catalogue-fetch failures
-- still render a correct bank name); the values are identical by construction,
-- so existing private year_basis/billing/source values are preserved exactly.
-- Unmatched rows stay private custom banks. Retained + idempotent so the
-- database tests can exercise it against fixture data.
create or replace function private.mortgage_attach_catalog_banks()
returns void language plpgsql set search_path to '' as $$
begin
  update public.mortgage_banks b
  set catalog_id = c.id,
      label      = c.label
  from public.mortgage_bank_catalog c
  where c.slug = 'danske'
    and b.catalog_id is null
    and b.label = 'Danske';
end;
$$;
revoke all on function private.mortgage_attach_catalog_banks() from public, anon, authenticated;
select private.mortgage_attach_catalog_banks();

-- ── 3. mortgages: explicit end state ─────────────────────────────────────────
-- end_date and archived encode the same closed/active state; the CHECK keeps
-- them consistent forever. Dates are text in the bolanekoll baseline
-- (lexicographic ISO ordering; legacy rows may carry ''), so '' is treated as
-- "unknown legacy date" and exempted from the ordering check.
alter table public.mortgages add column if not exists end_date text;

-- Backfill: active rows keep end_date = null; any pre-existing archived row
-- (none are expected in real data) gets the unknown-legacy marker '' so the
-- consistency CHECK can be created. Never invents a close date.
update public.mortgages set end_date = '' where archived and end_date is null;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'mortgages_end_state_consistent') then
    alter table public.mortgages add constraint mortgages_end_state_consistent
      check ((end_date is null) = (not archived));
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'mortgages_dates_ordered') then
    alter table public.mortgages add constraint mortgages_dates_ordered
      check (start_date is null or end_date is null
             or start_date = '' or end_date = ''
             or start_date <= end_date);
  end if;
end;
$$;

-- At most one active agreement per household, enforced in the database with NO
-- data escape hatch: if malformed data holds several active agreements for one
-- household, this CREATE INDEX fails loudly and the deploy stops until the
-- data is repaired by hand — that failure IS the repair surface
-- (owner-confirmed 2026-07-16). The migration must not silently pick a winner.
create unique index if not exists mortgages_one_active_per_household
  on public.mortgages (household_id) where (not archived);

-- mortgages becomes a tombstone-carrying resource (the revert RPC durably
-- deletes an agreement), so it joins the plan-97 reject-tombstoned guard like
-- its sibling tables. Created AFTER the backfill above so a hosted `db push`
-- role never trips the guard on the one-time end_date backfill.
create or replace trigger reject_deleted_mortgages
before insert or update on public.mortgages
for each row execute function private.reject_tombstoned_row('mortgages');

-- ── 4. mortgage_payments: agreement provenance ───────────────────────────────
-- Nullable mortgage_id — bank identity is reached through the agreement; no
-- bank_id is ever added to payment rows (it would permit contradictory
-- records). Household safety of the link is enforced by the trigger below.
alter table public.mortgage_payments
  add column if not exists mortgage_id text references public.mortgages(id);

-- Backfill provenance. Part-linked rows derive through their loan part;
-- legacy partless down payments are assigned only when the household has
-- exactly ONE agreement in total (unambiguous original agreement), otherwise
-- they stay explicitly unassigned — never guess between multiple agreements
-- (109c ships the explicit repair choice). Retained + idempotent for tests.
create or replace function private.mortgage_backfill_payment_provenance()
returns void language plpgsql set search_path to '' as $$
begin
  update public.mortgage_payments p
  set mortgage_id = lp.mortgage_id
  from public.mortgage_loan_parts lp
  where p.loan_part_id = lp.id
    and p.household_id = lp.household_id
    and p.mortgage_id is null
    and lp.mortgage_id is not null;

  update public.mortgage_payments p
  set mortgage_id = only_agreement.mortgage_id
  from (
    select household_id, min(id) as mortgage_id
    from public.mortgages
    group by household_id
    having count(*) = 1
  ) only_agreement
  where p.household_id = only_agreement.household_id
    and (p.loan_part_id is null or p.loan_part_id = '')
    and p.kind = 'down_payment'
    and p.mortgage_id is null;
end;
$$;
revoke all on function private.mortgage_backfill_payment_provenance() from public, anon, authenticated;

-- The plan-97 guard's superuser bypass does not match the hosted `db push`
-- role (see the plan-103 note), so it is toggled off for this one-time
-- admin backfill exactly as plan 103 did. The whole migration is one
-- transaction, so a failure rolls the toggle back too.
alter table public.mortgage_payments disable trigger reject_deleted_mortgage_payments;
select private.mortgage_backfill_payment_provenance();
alter table public.mortgage_payments enable trigger reject_deleted_mortgage_payments;

-- Provenance rules enforced in the database, not only the store: direct client
-- writes are revoked and all rows flow through the generic sync_apply_rows,
-- which validates the column allowlist but carries no per-table semantics — a
-- stale client could otherwise persist contradictory provenance.
--   * part-linked row: derive mortgage_id from the part; reject a mismatch.
--   * NEW partless down_payment: require mortgage_id (legacy null rows stay
--     readable and writable; only clearing an assigned value is refused).
--     The reserved 'legacy-contribution:' id prefix (plan 107 backup/import
--     converter) is exempt so legacy JSON backups still round-trip.
--   * any supplied mortgage_id must belong to the row's household.
-- Admin/service connections bypass only the require-on-insert rule (matching
-- the plan-97 guard's bypass) so reviewed data repairs stay possible; the
-- mismatch and household rules always apply.
create or replace function private.enforce_mortgage_payment_provenance()
returns trigger language plpgsql security definer set search_path to '' as $$
declare
  is_admin boolean :=
    (session_user = 'postgres' and current_setting('role', true) in ('none', 'postgres'))
    or (select auth.role()) = 'service_role';
  part_mortgage_id text;
  part_household uuid;
  mortgage_household uuid;
begin
  if new.loan_part_id is not null and new.loan_part_id <> '' then
    select lp.mortgage_id, lp.household_id into part_mortgage_id, part_household
    from public.mortgage_loan_parts lp where lp.id = new.loan_part_id;
    if found and part_household = new.household_id then
      if new.mortgage_id is null then
        new.mortgage_id := part_mortgage_id; -- may stay null for legacy parts
      elsif part_mortgage_id is null or new.mortgage_id <> part_mortgage_id then
        raise exception using errcode = '22023', message = 'mortgage provenance mismatch';
      end if;
    end if;
    -- an unknown/foreign parent is rejected by the sync RPC's own parent
    -- checks; legacy dangling part ids stay readable and writable here.
  elsif new.kind = 'down_payment' and new.mortgage_id is null and not is_admin then
    if tg_op = 'INSERT' and new.id !~ '^legacy-contribution:' then
      raise exception using errcode = '22023', message = 'down payment requires a mortgage agreement';
    end if;
    if tg_op = 'UPDATE' and old.mortgage_id is not null then
      raise exception using errcode = '22023', message = 'down payment requires a mortgage agreement';
    end if;
  end if;

  if new.mortgage_id is not null then
    select m.household_id into mortgage_household
    from public.mortgages m where m.id = new.mortgage_id;
    if not found or mortgage_household <> new.household_id then
      raise exception using errcode = '22023', message = 'mortgage agreement is not in caller household';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_mortgage_payment_provenance() from public, anon, authenticated;

create or replace trigger enforce_mortgage_payment_provenance
before insert or update on public.mortgage_payments
for each row execute function private.enforce_mortgage_payment_provenance();

-- ── 5. Shared validation helper ──────────────────────────────────────────────
create or replace function private.mortgage_valid_iso_date(value text)
returns boolean language plpgsql immutable set search_path to '' as $$
begin
  return value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    and pg_catalog.to_char(value::date, 'YYYY-MM-DD') = value;
exception when others then
  return false;
end;
$$;
revoke all on function private.mortgage_valid_iso_date(text) from public, anon, authenticated;

-- ── 6. Atomic bank-change RPC ────────────────────────────────────────────────
-- Only a bank change closes an agreement. One household-scoped transaction:
-- lock + verify the active agreement's revision, validate the effective date /
-- bank / proposed parts, archive the old agreement (BEFORE inserting — the
-- one-active index forbids the reverse order), insert the new agreement and
-- its parts with clean origination anchors, return the full payload for cache
-- patching. The client-generated new-agreement id is the idempotence key: a
-- timed-out successful call replayed under a NEW operation id finds the
-- agreement already created and the old one archived on the matching effective
-- date, and returns the existing payload as success instead of a spurious
-- revision mismatch (the receipt system already answers same-operation-id
-- replays). Part payload contract (per plan-109 decision 4 — copies are
-- drafts, not history): {id, label, balance, planned_amortization?}; the RPC
-- sets start/original balance+date from the balance and effective date,
-- clears loan_number, and copies no rates, numbers or history.
create or replace function public.sync_change_mortgage_bank(
  p_operation_id text,
  p_old_mortgage_id text,
  p_expected_old_revision bigint,
  p_new_mortgage jsonb,
  p_new_parts jsonb,
  p_effective_date text
) returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  hid uuid := (select private.current_household());
  actor uuid := (select auth.uid());
  request_hash text;
  prior jsonb;
  response jsonb;
  revisions jsonb := '{}'::jsonb;
  parts_json jsonb := '[]'::jsonb;
  new_id text;
  new_label text;
  new_bank_id text;
  part jsonb;
  part_ids text[];
  lock_id text;
  old_row public.mortgages%rowtype;
  new_row public.mortgages%rowtype;
  part_row public.mortgage_loan_parts%rowtype;
begin
  if actor is null then raise exception using errcode = '42501', message = 'authentication required'; end if;
  if hid is null then raise exception using errcode = '42501', message = 'no household'; end if;
  if p_old_mortgage_id is null or length(p_old_mortgage_id) not between 1 and 512
     or p_old_mortgage_id ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'invalid mortgage id';
  end if;
  if p_expected_old_revision is null
     or p_expected_old_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'invalid expected revision';
  end if;
  if not private.mortgage_valid_iso_date(p_effective_date) then
    raise exception using errcode = '22023', message = 'invalid effective date';
  end if;
  if p_new_mortgage is null or pg_catalog.jsonb_typeof(p_new_mortgage) <> 'object'
     or pg_catalog.jsonb_typeof(p_new_mortgage->'id') <> 'string'
     or length(p_new_mortgage->>'id') not between 1 and 512
     or (p_new_mortgage->>'id') ~ '[[:cntrl:]]'
     or pg_catalog.jsonb_typeof(p_new_mortgage->'label') <> 'string'
     or length(p_new_mortgage->>'label') > 512
     or (p_new_mortgage->>'label') ~ '[[:cntrl:]]'
     or pg_catalog.jsonb_typeof(p_new_mortgage->'bank_id') <> 'string'
     or length(p_new_mortgage->>'bank_id') not between 1 and 512
     or (p_new_mortgage->>'bank_id') ~ '[[:cntrl:]]'
     or exists (
       select 1 from pg_catalog.jsonb_object_keys(p_new_mortgage) supplied
       where not (supplied = any(array['id','label','bank_id']::text[]))
     )
     or (p_new_mortgage->>'id') = p_old_mortgage_id then
    raise exception using errcode = '22023', message = 'invalid mortgage payload';
  end if;
  new_id := p_new_mortgage->>'id';
  new_label := p_new_mortgage->>'label';
  new_bank_id := p_new_mortgage->>'bank_id';
  if p_new_parts is null or pg_catalog.jsonb_typeof(p_new_parts) <> 'array'
     or pg_catalog.jsonb_array_length(p_new_parts) > 100 then
    raise exception using errcode = '22023', message = 'invalid loan part payload';
  end if;
  for part in select value from pg_catalog.jsonb_array_elements(p_new_parts) loop
    if pg_catalog.jsonb_typeof(part) <> 'object'
       or pg_catalog.jsonb_typeof(part->'id') <> 'string'
       or length(part->>'id') not between 1 and 512
       or (part->>'id') ~ '[[:cntrl:]]'
       or (part->>'id') in (new_id, p_old_mortgage_id)
       or pg_catalog.jsonb_typeof(part->'label') <> 'string'
       or length(part->>'label') > 512
       or (part->>'label') ~ '[[:cntrl:]]'
       or pg_catalog.jsonb_typeof(part->'balance') <> 'number'
       or (part->>'balance')::numeric < 0
       or (part ? 'planned_amortization'
           and pg_catalog.jsonb_typeof(part->'planned_amortization') not in ('number', 'null'))
       or (pg_catalog.jsonb_typeof(part->'planned_amortization') = 'number'
           and (part->>'planned_amortization')::numeric < 0)
       or exists (
         select 1 from pg_catalog.jsonb_object_keys(part) supplied
         where not (supplied = any(array['id','label','balance','planned_amortization']::text[]))
       ) then
      raise exception using errcode = '22023', message = 'invalid loan part payload';
    end if;
  end loop;
  select coalesce(pg_catalog.array_agg(value->>'id' order by value->>'id'), '{}'::text[])
    into part_ids from pg_catalog.jsonb_array_elements(p_new_parts);
  if (select count(distinct id) from pg_catalog.unnest(part_ids) id) <> cardinality(part_ids) then
    raise exception using errcode = '22023', message = 'invalid loan part payload';
  end if;

  request_hash := private.sync_request_hash(pg_catalog.jsonb_build_object(
    'rpc', 'sync_change_mortgage_bank', 'old', p_old_mortgage_id,
    'expected', p_expected_old_revision, 'mortgage', p_new_mortgage,
    'parts', p_new_parts, 'effective', p_effective_date
  ));
  prior := private.sync_receipt(hid, actor, p_operation_id, request_hash);
  if prior is not null then return prior; end if;

  -- Parent-before-child lock order, ids sorted within each resource.
  for lock_id in
    select id from pg_catalog.unnest(array[p_old_mortgage_id, new_id]) id order by id
  loop
    perform private.lock_sync_entity('00000000-0000-0000-0000-000000000000', 'mortgages', lock_id);
    perform private.lock_sync_entity(hid, 'mortgages', lock_id);
  end loop;
  for lock_id in select id from pg_catalog.unnest(part_ids) id order by id loop
    perform private.lock_sync_entity('00000000-0000-0000-0000-000000000000', 'mortgage_loan_parts', lock_id);
    perform private.lock_sync_entity(hid, 'mortgage_loan_parts', lock_id);
  end loop;

  -- Idempotent replay: the client-generated agreement id doubles as the
  -- idempotence key. A completed operation replayed under a new operation id
  -- returns the already-created payload as success.
  select * into new_row from public.mortgages where household_id = hid and id = new_id;
  if found then
    select * into old_row from public.mortgages where household_id = hid and id = p_old_mortgage_id;
    if new_row.archived
       or new_row.bank_id is distinct from new_bank_id
       or new_row.start_date is distinct from p_effective_date
       or old_row.id is null
       or not old_row.archived
       or old_row.end_date is distinct from p_effective_date then
      raise exception using errcode = '22023', message = 'bank change replay mismatch';
    end if;
    for part_row in
      select * from public.mortgage_loan_parts
      where household_id = hid and mortgage_id = new_id order by id
    loop
      parts_json := parts_json || (pg_catalog.to_jsonb(part_row) - 'household_id');
      revisions := revisions || pg_catalog.jsonb_build_object(
        'mortgage_loan_parts:' || part_row.id, part_row.revision);
    end loop;
    revisions := revisions
      || pg_catalog.jsonb_build_object('mortgages:' || old_row.id, old_row.revision)
      || pg_catalog.jsonb_build_object('mortgages:' || new_row.id, new_row.revision);
    response := pg_catalog.jsonb_build_object(
      'status', 'applied',
      'mortgage', pg_catalog.to_jsonb(new_row) - 'household_id',
      'old_mortgage', pg_catalog.to_jsonb(old_row) - 'household_id',
      'parts', parts_json,
      'revisions', revisions);
    perform private.store_sync_receipt(hid, actor, p_operation_id, request_hash, response);
    return response;
  end if;
  if private.sync_tombstone_exists(hid, 'mortgages', new_id)
     or private.sync_any_row_exists('mortgages', new_id) then
    raise exception using errcode = '22023', message = 'mortgage id is not available';
  end if;

  -- Lock and verify the active agreement's expected revision.
  select * into old_row from public.mortgages
    where household_id = hid and id = p_old_mortgage_id for update;
  if not found or old_row.archived or old_row.revision <> p_expected_old_revision then
    return pg_catalog.jsonb_build_object(
      'status', 'conflict',
      'revisions', pg_catalog.jsonb_build_object(
        'mortgages:' || p_old_mortgage_id,
        case when old_row.id is null then null else pg_catalog.to_jsonb(old_row.revision) end));
  end if;
  if old_row.start_date is not null and old_row.start_date <> ''
     and p_effective_date < old_row.start_date then
    raise exception using errcode = '22023', message = 'effective date precedes agreement start';
  end if;
  if not exists (
    select 1 from public.mortgage_banks
    where household_id = hid and id = new_bank_id
  ) then
    raise exception using errcode = '22023', message = 'bank is not in caller household';
  end if;
  for lock_id in select id from pg_catalog.unnest(part_ids) id order by id loop
    if private.sync_tombstone_exists(hid, 'mortgage_loan_parts', lock_id) then
      raise exception using errcode = '22023', message = 'loan part id is not available';
    end if;
    -- live-row collisions are left to the primary key so a mid-transaction
    -- failure provably rolls the archive back with everything else.
  end loop;

  -- Archive the old agreement BEFORE inserting the new one (one-active index).
  update public.mortgages
    set archived = true, end_date = p_effective_date
    where household_id = hid and id = p_old_mortgage_id
      and revision = p_expected_old_revision
    returning * into old_row;
  if old_row.id is null then
    raise exception using errcode = '40001', message = 'row changed during sync mutation';
  end if;

  insert into public.mortgages (id, household_id, bank_id, label, start_date, archived, end_date)
    values (new_id, hid, new_bank_id, new_label, p_effective_date, false, null)
    returning * into new_row;

  for part in
    select value from pg_catalog.jsonb_array_elements(p_new_parts) order by value->>'id'
  loop
    insert into public.mortgage_loan_parts (
      id, household_id, mortgage_id, label, loan_number,
      start_balance, start_date, archived,
      original_balance, original_date,
      planned_amortization, planned_amortization_start, planned_amortization_end
    ) values (
      part->>'id', hid, new_id, part->>'label', '',
      (part->>'balance')::numeric, p_effective_date, false,
      (part->>'balance')::numeric, p_effective_date,
      case when pg_catalog.jsonb_typeof(part->'planned_amortization') = 'number'
        then (part->>'planned_amortization')::numeric end,
      case when pg_catalog.jsonb_typeof(part->'planned_amortization') = 'number'
        then p_effective_date end,
      null
    ) returning * into part_row;
    parts_json := parts_json || (pg_catalog.to_jsonb(part_row) - 'household_id');
    revisions := revisions || pg_catalog.jsonb_build_object(
      'mortgage_loan_parts:' || part_row.id, part_row.revision);
  end loop;

  revisions := revisions
    || pg_catalog.jsonb_build_object('mortgages:' || old_row.id, old_row.revision)
    || pg_catalog.jsonb_build_object('mortgages:' || new_row.id, new_row.revision);
  response := pg_catalog.jsonb_build_object(
    'status', 'applied',
    'mortgage', pg_catalog.to_jsonb(new_row) - 'household_id',
    'old_mortgage', pg_catalog.to_jsonb(old_row) - 'household_id',
    'parts', parts_json,
    'revisions', revisions);
  perform private.store_sync_receipt(hid, actor, p_operation_id, request_hash, response);
  return response;
end;
$$;
alter function public.sync_change_mortgage_bank(text,text,bigint,jsonb,jsonb,text) owner to postgres;
revoke all on function public.sync_change_mortgage_bank(text,text,bigint,jsonb,jsonb,text) from public, anon;
grant execute on function public.sync_change_mortgage_bank(text,text,bigint,jsonb,jsonb,text) to authenticated;

-- ── 7. Atomic revert RPC (Ångra bankbyte) ────────────────────────────────────
-- Mirror of the bank change: verify the target is the household's active
-- agreement with an unambiguous predecessor (the archived agreement closed on
-- the target's start date), refuse if ANY payment or rate period references
-- the target or its parts, then — under an exact revision match covering the
-- target, its parts and the predecessor — tombstone-delete the target and its
-- parts and reactivate the predecessor. Partial reverts are impossible: one
-- transaction, any failure rolls everything back.
create or replace function public.sync_revert_mortgage_bank_change(
  p_operation_id text,
  p_mortgage_id text,
  p_expected_revisions jsonb
) returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  hid uuid := (select private.current_household());
  actor uuid := (select auth.uid());
  request_hash text;
  prior jsonb;
  response jsonb;
  target public.mortgages%rowtype;
  previous public.mortgages%rowtype;
  previous_count int;
  part_ids text[];
  child_id text;
  current_revisions jsonb := '{}'::jsonb;
  revisions jsonb := '{}'::jsonb;
  supplied_keys text[];
begin
  if actor is null then raise exception using errcode = '42501', message = 'authentication required'; end if;
  if hid is null then raise exception using errcode = '42501', message = 'no household'; end if;
  if p_mortgage_id is null or length(p_mortgage_id) not between 1 and 512
     or p_mortgage_id ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'invalid mortgage id';
  end if;
  if p_expected_revisions is null or pg_catalog.jsonb_typeof(p_expected_revisions) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid expected revision set';
  end if;
  select pg_catalog.array_agg(key order by key) into supplied_keys
    from pg_catalog.jsonb_object_keys(p_expected_revisions) key;
  perform private.sync_validate_expected_revisions(p_expected_revisions, supplied_keys);
  request_hash := private.sync_request_hash(pg_catalog.jsonb_build_object(
    'rpc', 'sync_revert_mortgage_bank_change', 'id', p_mortgage_id,
    'expected', p_expected_revisions
  ));
  prior := private.sync_receipt(hid, actor, p_operation_id, request_hash);
  if prior is not null then return prior; end if;

  perform private.lock_sync_entity('00000000-0000-0000-0000-000000000000', 'mortgages', p_mortgage_id);
  perform private.lock_sync_entity(hid, 'mortgages', p_mortgage_id);
  select * into target from public.mortgages
    where household_id = hid and id = p_mortgage_id for update;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'conflict', 'revisions',
      pg_catalog.jsonb_build_object('mortgages:' || p_mortgage_id, null));
  end if;
  if target.archived then
    raise exception using errcode = '22023', message = 'mortgage agreement is not active';
  end if;

  -- The predecessor is the archived agreement whose end_date equals the
  -- target's start date (the bank change stamps both from the effective
  -- date). Anything but exactly one match is ambiguous and refused.
  select count(*) into previous_count from public.mortgages
    where household_id = hid and archived and end_date = target.start_date;
  if previous_count <> 1 then
    raise exception using errcode = '22023', message = 'no unambiguous previous agreement';
  end if;
  select * into previous from public.mortgages
    where household_id = hid and archived and end_date = target.start_date
    for update;
  perform private.lock_sync_entity('00000000-0000-0000-0000-000000000000', 'mortgages', previous.id);
  perform private.lock_sync_entity(hid, 'mortgages', previous.id);

  select coalesce(pg_catalog.array_agg(id order by id), '{}'::text[]) into part_ids
    from public.mortgage_loan_parts
    where household_id = hid and mortgage_id = p_mortgage_id;
  for child_id in select id from pg_catalog.unnest(part_ids) id order by id loop
    perform private.lock_sync_entity('00000000-0000-0000-0000-000000000000', 'mortgage_loan_parts', child_id);
    perform private.lock_sync_entity(hid, 'mortgage_loan_parts', child_id);
  end loop;

  -- Refuse when any transaction references the target or its parts.
  if exists (
       select 1 from public.mortgage_payments
       where household_id = hid
         and (mortgage_id = p_mortgage_id
              or (loan_part_id is not null and loan_part_id = any(part_ids)))
     )
     or exists (
       select 1 from public.mortgage_rate_periods
       where household_id = hid and loan_part_id = any(part_ids)
     ) then
    raise exception using errcode = '22023', message = 'mortgage agreement has recorded transactions';
  end if;

  current_revisions := pg_catalog.jsonb_build_object(
    'mortgages:' || target.id, target.revision,
    'mortgages:' || previous.id, previous.revision);
  for child_id in select id from pg_catalog.unnest(part_ids) id order by id loop
    current_revisions := current_revisions || pg_catalog.jsonb_build_object(
      'mortgage_loan_parts:' || child_id,
      private.sync_current_row_revision(hid, 'mortgage_loan_parts', child_id));
  end loop;
  if p_expected_revisions is distinct from current_revisions then
    return pg_catalog.jsonb_build_object('status', 'conflict', 'revisions', current_revisions);
  end if;

  perform private.record_sync_tombstones(hid, 'mortgage_loan_parts', part_ids);
  perform private.record_sync_tombstones(hid, 'mortgages', array[p_mortgage_id]);
  delete from public.mortgage_loan_parts
    where household_id = hid and mortgage_id = p_mortgage_id;
  delete from public.mortgages where household_id = hid and id = p_mortgage_id;
  -- Reactivate the predecessor AFTER the delete (one-active index).
  update public.mortgages set archived = false, end_date = null
    where household_id = hid and id = previous.id
    returning * into previous;

  revisions := pg_catalog.jsonb_build_object(
    'mortgages:' || p_mortgage_id, null,
    'mortgages:' || previous.id, previous.revision);
  for child_id in select id from pg_catalog.unnest(part_ids) id loop
    revisions := revisions || pg_catalog.jsonb_build_object('mortgage_loan_parts:' || child_id, null);
  end loop;
  response := pg_catalog.jsonb_build_object(
    'status', 'applied',
    'mortgage', pg_catalog.to_jsonb(previous) - 'household_id',
    'revisions', revisions);
  perform private.store_sync_receipt(hid, actor, p_operation_id, request_hash, response);
  return response;
end;
$$;
alter function public.sync_revert_mortgage_bank_change(text,text,jsonb) owner to postgres;
revoke all on function public.sync_revert_mortgage_bank_change(text,text,jsonb) from public, anon;
grant execute on function public.sync_revert_mortgage_bank_change(text,text,jsonb) to authenticated;

-- ── 8. Sync system redeclarations ────────────────────────────────────────────
-- mortgages joins the tombstone-carrying resources (the revert RPC durably
-- deletes agreements). Re-declared from the latest definition
-- (20260714100000_durable_delete_tombstones); ONLY 'mortgages' is added.
-- Note: sync_delete_rows' delete CASE deliberately has no 'mortgages' arm, so
-- generic client deletes of agreements still fail closed.
create or replace function private.sync_resource_allowed(p_resource text)
returns boolean language sql immutable set search_path to '' as $$
  select p_resource = any (array[
    'scenarios', 'salary_submissions', 'monthend_items', 'monthend_payments',
    'mortgage_loan_parts', 'mortgage_rate_periods', 'mortgage_payments',
    'mortgage_valuations', 'mortgage_contributions', 'house_items',
    'mortgages'
  ]::text[])
$$;
revoke all on function private.sync_resource_allowed(text) from public, anon, authenticated;

-- Plan-84 landmine: these two functions must be re-declared starting from the
-- LATEST applied text or a later `supabase db reset` silently drops newer
-- keys. sync_table_for_resource is re-declared VERBATIM from
-- 20260714130000_mortgage_domain_model (its latest definition); no resource
-- changes (the catalogue is read-only and never a sync resource).
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
    when 'mortgage_banks' then 'mortgage_banks'
    when 'mortgages' then 'mortgages'
    when 'house_items' then 'house_items'
  end
$$;
revoke all on function private.sync_table_for_resource(text) from public, anon, authenticated;

-- sync_allowed_row_keys re-declared from the LATEST definition
-- (20260714150000_bank_billing_profile). Every other resource is
-- byte-identical; exactly three arrays gain one key each:
--   * mortgage_payments + 'mortgage_id' (agreement provenance)
--   * mortgages         + 'end_date'    (agreement end state)
--   * mortgage_banks    + 'catalog_id'  (catalogue link)
-- Missing any of these would make sync_apply_rows hard-reject every save that
-- carries the new column (errcode 22023).
create or replace function private.sync_allowed_row_keys(p_resource text)
returns text[] language sql immutable set search_path to '' as $$
  select case p_resource
    when 'scenarios' then array['id','created_at','name','saved_at','inputs','constants']
    when 'salary_submissions' then array['id','created_at','month','person_a_name','income_a','person_b_name','income_b','transfer_from','transfer_to','transfer_amount','equal_share','note','income_items']
    when 'monthend_items' then array['id','created_at','date_purchased','description','enter_amount','split','amount','fronted_by','owed_by','paid','pending','payment_id','note','personal_items','personal_a','personal_b']
    when 'monthend_payments' then array['id','created_at','item_ids','from_person','to_person','amount','period_label','note']
    when 'mortgage_loan_parts' then array['id','created_at','label','loan_number','start_balance','start_date','archived','mortgage_id','original_balance','original_date','planned_amortization','planned_amortization_start','planned_amortization_end']
    when 'mortgage_rate_periods' then array['id','created_at','loan_part_id','start_date','end_date','rate','rate_type']
    when 'mortgage_payments' then array['id','created_at','loan_part_id','date','kind','description','amount','balance_after','paid_by','source','is_insats','paid_split','mortgage_id']
    when 'mortgage_valuations' then array['id','created_at','date','value','note','is_purchase']
    when 'mortgage_contributions' then array['id','created_at','owner','date','amount','note']
    when 'mortgage_banks' then array['id','created_at','label','year_basis','year_basis_source','billing','billing_source','catalog_id']
    when 'mortgages' then array['id','created_at','bank_id','label','start_date','archived','end_date']
    when 'house_items' then array['id','created_at','type','title','category','date','cost','vendor','interval_years','remind_days','notes']
  end
$$;
revoke all on function private.sync_allowed_row_keys(text) from public, anon, authenticated;
