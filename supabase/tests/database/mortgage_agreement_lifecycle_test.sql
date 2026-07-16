-- Plan 109a Stage 1 — mortgage agreement lifecycle schema and RPC contract.
-- Covers: the shared bank catalogue security contract, the catalogue attach
-- mapping, the mortgages end-state (end_date/archived CHECK + one-active
-- partial unique index + date ordering), the payment-provenance backfill and
-- trigger, the sync allowlist additions (plan-84 guard), and the atomic
-- bank-change / revert RPC pair including idempotent replay and refusal rules.
-- All data is fictional. Runs inside one rolled-back transaction.

begin;

create extension if not exists pgtap with schema extensions;

select plan(65);

-- ── Fixtures: two fictional households ───────────────────────────────────────
insert into auth.users(id, email) values
  ('71000000-0000-0000-0000-000000000001', 'agreement-a@example.invalid'),
  ('71000000-0000-0000-0000-000000000002', 'agreement-b@example.invalid');
insert into public.households(id, name) values
  ('72000000-0000-0000-0000-000000000001', 'Agreement fixture A'),
  ('72000000-0000-0000-0000-000000000002', 'Agreement fixture B');
insert into public.household_members(household_id, user_id, role) values
  ('72000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', 'owner'),
  ('72000000-0000-0000-0000-000000000002', '71000000-0000-0000-0000-000000000002', 'owner');

-- ── 1. Shared catalogue: security contract ───────────────────────────────────
select ok(
  (select c.relrowsecurity from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'mortgage_bank_catalog'),
  'the bank catalogue has row-level security enabled'
);
select ok(
  (select label = 'Danske' and year_basis is null and billing is null
    from public.mortgage_bank_catalog where slug = 'danske'),
  'the conservative Danske seed exists with unverified conventions left null'
);
select ok(
  not exists (
    select 1 from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'mortgage_bank_catalog'
      and a.attname = 'household_id' and a.attnum > 0 and not a.attisdropped
  ),
  'the catalogue carries no household id or household-derived evidence'
);
select ok(
  has_table_privilege('authenticated', 'public.mortgage_bank_catalog', 'select')
  and not has_table_privilege('anon', 'public.mortgage_bank_catalog', 'select'),
  'catalogue rows are readable by authenticated clients only'
);
select ok(
  not has_table_privilege('authenticated', 'public.mortgage_bank_catalog', 'insert')
  and not has_table_privilege('authenticated', 'public.mortgage_bank_catalog', 'update')
  and not has_table_privilege('authenticated', 'public.mortgage_bank_catalog', 'delete')
  and not has_table_privilege('anon', 'public.mortgage_bank_catalog', 'insert')
  and not has_table_privilege('anon', 'public.mortgage_bank_catalog', 'update')
  and not has_table_privilege('anon', 'public.mortgage_bank_catalog', 'delete'),
  'household clients receive no catalogue write grant'
);

-- ── 2. Catalogue attach mapping (explicit reviewed mapping) ──────────────────
insert into public.mortgage_banks (id, household_id, label, year_basis, year_basis_source, billing, billing_source) values
  ('bank-danske', '72000000-0000-0000-0000-000000000001', 'Danske', 360, 'detected', 'month-end', 'declared'),
  ('bank-custom', '72000000-0000-0000-0000-000000000001', 'Sparbanken Fiktiv', null, null, null, null),
  ('bank-nya',    '72000000-0000-0000-0000-000000000001', 'Nya Banken', null, null, null, null);

select private.mortgage_attach_catalog_banks();

select ok(
  (select catalog_id = 'catalog-danske' and label = 'Danske'
    from public.mortgage_banks where id = 'bank-danske'),
  'the existing Danske profile is attached to its catalogue row without a label change'
);
select ok(
  (select year_basis = 360 and year_basis_source = 'detected'
      and billing = 'month-end' and billing_source = 'declared'
    from public.mortgage_banks where id = 'bank-danske'),
  'private declared/detected convention values are preserved exactly on attach'
);
select ok(
  (select bool_and(catalog_id is null) from public.mortgage_banks
    where id in ('bank-custom', 'bank-nya')),
  'unmatched banks stay private custom banks with no catalogue link'
);
select private.mortgage_attach_catalog_banks();
select is(
  (select revision from public.mortgage_banks where id = 'bank-danske'),
  2::bigint,
  'the attach mapping is idempotent: a rerun does not rewrite an attached row'
);

-- ── 3. Agreement end state: CHECK + one-active index ─────────────────────────
insert into public.mortgages (id, household_id, bank_id, label, start_date, archived, end_date) values
  ('m-old', '72000000-0000-0000-0000-000000000001', 'bank-danske', 'Bolån', '2024-01-01', false, null),
  ('m-b1',  '72000000-0000-0000-0000-000000000002', null, 'Bolån B', '2024-01-01', false, null),
  ('m-b2',  '72000000-0000-0000-0000-000000000002', null, 'Bolån B gammalt', '2020-01-01', true, '2023-12-31');

select throws_ok(
  $$insert into public.mortgages (id, household_id, label, start_date, archived, end_date)
    values ('m-bad-active', '72000000-0000-0000-0000-000000000002', 'X', '2024-01-01', false, '2025-01-01')$$,
  '23514', null, 'an active agreement cannot carry an end date'
);
select throws_ok(
  $$insert into public.mortgages (id, household_id, label, start_date, archived, end_date)
    values ('m-bad-archived', '72000000-0000-0000-0000-000000000002', 'X', '2024-01-01', true, null)$$,
  '23514', null, 'an archived agreement must carry an end date'
);
select throws_ok(
  $$insert into public.mortgages (id, household_id, label, start_date, archived, end_date)
    values ('m-bad-dates', '72000000-0000-0000-0000-000000000002', 'X', '2025-06-01', true, '2024-01-01')$$,
  '23514', null, 'an agreement cannot end before it starts'
);
select lives_ok(
  $$insert into public.mortgages (id, household_id, label, start_date, archived, end_date)
    values ('m-b-legacy', '72000000-0000-0000-0000-000000000002', 'Legacy', '2024-05-01', true, '')$$,
  'a legacy empty-string close date remains representable on archived rows'
);
select throws_ok(
  $$insert into public.mortgages (id, household_id, label, start_date, archived, end_date)
    values ('m-second-active', '72000000-0000-0000-0000-000000000001', 'Andra', '2025-01-01', false, null)$$,
  '23505', null, 'at most one active agreement per household is enforced in the database'
);
select ok(
  (select count(*) = 2 from public.mortgages where not archived),
  'each household keeps its own single active agreement'
);

-- ── 4. Payment provenance backfill ───────────────────────────────────────────
insert into public.mortgage_loan_parts (id, household_id, mortgage_id, label, start_balance, start_date) values
  ('part-old', '72000000-0000-0000-0000-000000000001', 'm-old', 'Del gammal', 2000000, '2024-01-01'),
  ('part-b',   '72000000-0000-0000-0000-000000000002', 'm-b1', 'Del B', 1000000, '2024-01-01');
insert into public.mortgage_rate_periods (id, household_id, loan_part_id, start_date, rate) values
  ('rp-old', '72000000-0000-0000-0000-000000000001', 'part-old', '2024-01-01', 3.5);

-- Legacy-shaped rows predate the provenance trigger; simulate them with the
-- trigger disabled, exactly as they existed before this migration ran.
alter table public.mortgage_payments disable trigger enforce_mortgage_payment_provenance;
insert into public.mortgage_payments (id, household_id, loan_part_id, date, kind, amount) values
  ('pay-old',     '72000000-0000-0000-0000-000000000001', 'part-old', '2024-02-27', 'interest', 4200),
  ('dp-legacy-a', '72000000-0000-0000-0000-000000000001', null, '2024-01-01', 'down_payment', 500000),
  ('dp-legacy-b', '72000000-0000-0000-0000-000000000002', null, '2024-01-01', 'down_payment', 300000);
alter table public.mortgage_payments enable trigger enforce_mortgage_payment_provenance;

select private.mortgage_backfill_payment_provenance();

select is(
  (select mortgage_id from public.mortgage_payments where id = 'pay-old'),
  'm-old', 'a part-linked payment is backfilled through its loan part'
);
select is(
  (select mortgage_id from public.mortgage_payments where id = 'dp-legacy-a'),
  'm-old', 'a partless down payment is assigned when exactly one agreement exists'
);
select ok(
  (select mortgage_id is null from public.mortgage_payments where id = 'dp-legacy-b'),
  'an ambiguous partless down payment stays explicitly unassigned'
);
select private.mortgage_backfill_payment_provenance();
select is(
  (select revision from public.mortgage_payments where id = 'pay-old'),
  2::bigint, 'the provenance backfill is idempotent'
);

-- A second (archived, historical) agreement in household A for mismatch tests.
insert into public.mortgages (id, household_id, label, start_date, archived, end_date)
  values ('m-old-prev', '72000000-0000-0000-0000-000000000001', 'Historiskt', '2020-01-01', true, '2023-12-31');

-- ── 5. Provenance trigger through the sync write path ────────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"71000000-0000-0000-0000-000000000001","role":"authenticated","email":"agreement-a@example.invalid"}', true);

select is((public.sync_apply_rows(
  'op-derive', 'mortgage_payments',
  '[{"id":"pay-derive","loan_part_id":"part-old","kind":"interest","date":"2026-01-27","amount":4100}]',
  '{"mortgage_payments:pay-derive":null}', false
)->>'status'), 'applied', 'a part-linked payment without mortgage_id is accepted');
select is(
  (select mortgage_id from public.mortgage_payments where id = 'pay-derive'),
  'm-old', 'the trigger derives mortgage_id from the loan part'
);
select is((public.sync_apply_rows(
  'op-match', 'mortgage_payments',
  '[{"id":"pay-match","loan_part_id":"part-old","mortgage_id":"m-old","kind":"amortization","date":"2026-01-27","amount":3000}]',
  '{"mortgage_payments:pay-match":null}', false
)->>'status'), 'applied', 'a matching supplied mortgage_id is accepted');
select throws_ok(
  $$select public.sync_apply_rows(
    'op-mismatch', 'mortgage_payments',
    '[{"id":"pay-mm","loan_part_id":"part-old","mortgage_id":"m-old-prev","kind":"interest","date":"2026-01-27","amount":1}]',
    '{"mortgage_payments:pay-mm":null}', false
  )$$,
  '22023', 'mortgage provenance mismatch',
  'a mortgage_id contradicting the loan part is rejected'
);
select throws_ok(
  $$select public.sync_apply_rows(
    'op-dp-bare', 'mortgage_payments',
    '[{"id":"dp-new-bad","kind":"down_payment","date":"2026-02-01","amount":100000,"is_insats":true}]',
    '{"mortgage_payments:dp-new-bad":null}', false
  )$$,
  '22023', 'down payment requires a mortgage agreement',
  'a new partless down payment must name its agreement'
);
select is((public.sync_apply_rows(
  'op-dp-ok', 'mortgage_payments',
  '[{"id":"dp-new-ok","kind":"down_payment","mortgage_id":"m-old","date":"2026-02-01","amount":100000,"is_insats":true}]',
  '{"mortgage_payments:dp-new-ok":null}', false
)->>'status'), 'applied', 'a new down payment carrying its agreement is accepted');
select throws_ok(
  $$select public.sync_apply_rows(
    'op-dp-foreign', 'mortgage_payments',
    '[{"id":"dp-foreign","kind":"down_payment","mortgage_id":"m-b1","date":"2026-02-01","amount":1,"is_insats":true}]',
    '{"mortgage_payments:dp-foreign":null}', false
  )$$,
  '22023', 'mortgage agreement is not in caller household',
  'payment provenance cannot point at another household agreement'
);
select throws_ok(
  $$select public.sync_apply_rows(
    'op-dp-clear', 'mortgage_payments',
    '[{"id":"dp-legacy-a","mortgage_id":null}]',
    '{"mortgage_payments:dp-legacy-a":2}', false
  )$$,
  '22023', 'down payment requires a mortgage agreement',
  'assigned down-payment provenance cannot be cleared back to null'
);

-- Legacy null rows stay writable (household B, unassigned legacy row).
select set_config('request.jwt.claims',
  '{"sub":"71000000-0000-0000-0000-000000000002","role":"authenticated","email":"agreement-b@example.invalid"}', true);
select is((public.sync_apply_rows(
  'op-legacy-edit', 'mortgage_payments',
  '[{"id":"dp-legacy-b","description":"uppdaterad anteckning"}]',
  '{"mortgage_payments:dp-legacy-b":1}', false
)->>'status'), 'applied', 'a legacy unassigned down payment remains writable');
select set_config('request.jwt.claims',
  '{"sub":"71000000-0000-0000-0000-000000000001","role":"authenticated","email":"agreement-a@example.invalid"}', true);

-- ── 6. Sync allowlist additions (plan-84 landmine guard) ─────────────────────
select is((public.sync_apply_rows(
  'op-scratch', 'mortgages',
  '[{"id":"m-scratch","label":"Skrot","start_date":"2024-01-01","archived":true,"end_date":"2024-06-01"}]',
  '{"mortgages:m-scratch":null}', false
)->>'status'), 'applied', 'the mortgages allowlist accepts end_date');
select is((public.sync_apply_rows(
  'op-bank-attach', 'mortgage_banks',
  '[{"id":"bank-custom","label":"Sparbanken Fiktiv","catalog_id":"catalog-danske"}]',
  '{"mortgage_banks:bank-custom":1}', false
)->>'status'), 'applied', 'the mortgage_banks allowlist accepts catalog_id');

reset role;
select ok(
  private.sync_allowed_row_keys('mortgage_banks')
    @> array['label','year_basis','year_basis_source','billing','billing_source','catalog_id']
  and private.sync_allowed_row_keys('mortgages') @> array['bank_id','start_date','archived','end_date']
  and private.sync_allowed_row_keys('mortgage_payments') @> array['loan_part_id','mortgage_id','paid_split']
  and private.sync_allowed_row_keys('mortgage_loan_parts') @> array['planned_amortization','original_balance'],
  'the redeclared allowlist keeps every newer key and gains the three new columns'
);
select ok(
  private.sync_table_for_resource('mortgage_banks') = 'mortgage_banks'
  and private.sync_table_for_resource('mortgages') = 'mortgages'
  and private.sync_table_for_resource('house_items') = 'house_items',
  'the redeclared resource map keeps every registered resource'
);
set local role authenticated;

-- ── 7. Atomic bank-change RPC ────────────────────────────────────────────────
select is((public.sync_change_mortgage_bank(
  'op-stale', 'm-old', 999,
  '{"id":"m-new","label":"Bolån Nya","bank_id":"bank-nya"}',
  '[{"id":"part-new1","label":"Del 1","balance":1500000,"planned_amortization":3000}]',
  '2026-07-01'
)->>'status'), 'conflict', 'a stale expected revision is a conflict, not a partial switch');
select ok(
  (select not archived and end_date is null from public.mortgages where id = 'm-old')
  and not exists (select 1 from public.mortgages where id = 'm-new'),
  'a conflicting bank change leaves the old agreement active and creates nothing'
);
select throws_ok(
  $$select public.sync_change_mortgage_bank(
    'op-neg', 'm-old', 1,
    '{"id":"m-new","label":"Bolån Nya","bank_id":"bank-nya"}',
    '[{"id":"part-new1","label":"Del 1","balance":-5}]',
    '2026-07-01'
  )$$,
  '22023', 'invalid loan part payload', 'a negative opening balance is rejected'
);
select throws_ok(
  $$select public.sync_change_mortgage_bank(
    'op-badbank', 'm-old', 1,
    '{"id":"m-new","label":"Bolån Nya","bank_id":"bank-ghost"}',
    '[{"id":"part-new1","label":"Del 1","balance":100}]',
    '2026-07-01'
  )$$,
  '22023', 'bank is not in caller household', 'the selected bank profile must belong to the household'
);
select throws_ok(
  $$select public.sync_change_mortgage_bank(
    'op-baddate', 'm-old', 1,
    '{"id":"m-new","label":"Bolån Nya","bank_id":"bank-nya"}',
    '[]', '2026-13-40'
  )$$,
  '22023', 'invalid effective date', 'a malformed effective date is rejected'
);
select throws_ok(
  $$select public.sync_change_mortgage_bank(
    'op-early', 'm-old', 1,
    '{"id":"m-new","label":"Bolån Nya","bank_id":"bank-nya"}',
    '[]', '2023-01-01'
  )$$,
  '22023', 'effective date precedes agreement start', 'the change cannot predate the old agreement'
);
select throws_ok(
  $$select public.sync_change_mortgage_bank(
    'op-collide', 'm-old', 1,
    '{"id":"m-new","label":"Bolån Nya","bank_id":"bank-nya"}',
    '[{"id":"part-old","label":"Krock","balance":100}]',
    '2026-07-01'
  )$$,
  '23505', null, 'a colliding proposed part id fails after the archive step'
);
select ok(
  (select not archived and end_date is null and revision = 1 from public.mortgages where id = 'm-old')
  and not exists (select 1 from public.mortgages where id = 'm-new'),
  'a mid-transaction failure rolls the archive back completely'
);

select is((public.sync_change_mortgage_bank(
  'op-change', 'm-old', 1,
  '{"id":"m-new","label":"Bolån Nya","bank_id":"bank-nya"}',
  '[{"id":"part-new1","label":"Del 1","balance":1500000,"planned_amortization":3000},{"id":"part-new2","label":"Del 2","balance":500000}]',
  '2026-07-01'
)->>'status'), 'applied', 'the atomic bank change succeeds');
reset role;
select ok(
  (select not archived and end_date is null and start_date = '2026-07-01' and bank_id = 'bank-nya'
    from public.mortgages where id = 'm-new')
  and (select archived and end_date = '2026-07-01' from public.mortgages where id = 'm-old'),
  'the new agreement is active and the old one is archived on the effective date'
);
select ok(
  (select start_balance = 1500000 and original_balance = 1500000
      and start_date = '2026-07-01' and original_date = '2026-07-01'
      and loan_number = '' and planned_amortization = 3000
      and planned_amortization_start = '2026-07-01' and planned_amortization_end is null
    from public.mortgage_loan_parts where id = 'part-new1')
  and (select planned_amortization is null and start_balance = 500000
    from public.mortgage_loan_parts where id = 'part-new2'),
  'new parts carry clean origination anchors and copy no history'
);
select is(
  (select count(*) from public.mortgages
    where household_id = '72000000-0000-0000-0000-000000000001' and not archived),
  1::bigint, 'exactly one active agreement exists after the change'
);
set local role authenticated;
select ok(
  (public.sync_change_mortgage_bank(
    'op-change', 'm-old', 1,
    '{"id":"m-new","label":"Bolån Nya","bank_id":"bank-nya"}',
    '[{"id":"part-new1","label":"Del 1","balance":1500000,"planned_amortization":3000},{"id":"part-new2","label":"Del 2","balance":500000}]',
    '2026-07-01'
  )) ->> 'status' = 'applied',
  'replaying the same operation id returns the stored receipt'
);
select is((public.sync_change_mortgage_bank(
  'op-change-retry', 'm-old', 1,
  '{"id":"m-new","label":"Bolån Nya","bank_id":"bank-nya"}',
  '[{"id":"part-new1","label":"Del 1","balance":1500000,"planned_amortization":3000},{"id":"part-new2","label":"Del 2","balance":500000}]',
  '2026-07-01'
)->>'status'), 'applied', 'a timed-out retry keyed on the client-generated id succeeds without error');
select ok(
  (select count(*) = 1 from public.mortgages where id = 'm-new')
  and (select count(*) = 2 from public.mortgage_loan_parts where mortgage_id = 'm-new'),
  'idempotent replay creates no duplicate agreement or parts'
);

-- ── 8. Atomic revert RPC ─────────────────────────────────────────────────────
select is((public.sync_apply_rows(
  'op-pay-new', 'mortgage_payments',
  '[{"id":"pay-new","loan_part_id":"part-new1","kind":"interest","date":"2026-07-27","amount":3100}]',
  '{"mortgage_payments:pay-new":null}', false
)->>'status'), 'applied', 'a payment lands on the new agreement');
select throws_ok(
  $$select public.sync_revert_mortgage_bank_change(
    'op-revert-blocked', 'm-new',
    '{"mortgages:m-new":1,"mortgages:m-old":2,"mortgage_loan_parts:part-new1":1,"mortgage_loan_parts:part-new2":1}'
  )$$,
  '22023', 'mortgage agreement has recorded transactions',
  'revert refuses while a payment references the new agreement'
);
select is((public.sync_delete_rows(
  'op-del-pay-new', 'mortgage_payments', array['pay-new'],
  '{"mortgage_payments:pay-new":1}'
)->>'status'), 'applied', 'the blocking payment is removed');
select is((public.sync_apply_rows(
  'op-rp-new', 'mortgage_rate_periods',
  '[{"id":"rp-new","loan_part_id":"part-new1","start_date":"2026-07-01","rate":2.9}]',
  '{"mortgage_rate_periods:rp-new":null}', false
)->>'status'), 'applied', 'a rate period lands on the new part');
select throws_ok(
  $$select public.sync_revert_mortgage_bank_change(
    'op-revert-blocked2', 'm-new',
    '{"mortgages:m-new":1,"mortgages:m-old":2,"mortgage_loan_parts:part-new1":1,"mortgage_loan_parts:part-new2":1}'
  )$$,
  '22023', 'mortgage agreement has recorded transactions',
  'revert refuses while a rate period references a new part'
);
select is((public.sync_delete_rows(
  'op-del-rp-new', 'mortgage_rate_periods', array['rp-new'],
  '{"mortgage_rate_periods:rp-new":1}'
)->>'status'), 'applied', 'the blocking rate period is removed');
select is((public.sync_revert_mortgage_bank_change(
  'op-revert-stale', 'm-new',
  '{"mortgages:m-new":9,"mortgages:m-old":2,"mortgage_loan_parts:part-new1":1,"mortgage_loan_parts:part-new2":1}'
)->>'status'), 'conflict', 'a stale revert is a conflict, not a partial restore');
select ok(
  exists (select 1 from public.mortgages where id = 'm-new')
  and (select archived from public.mortgages where id = 'm-old'),
  'a conflicting revert changes nothing'
);
select is((public.sync_revert_mortgage_bank_change(
  'op-revert', 'm-new',
  '{"mortgages:m-new":1,"mortgages:m-old":2,"mortgage_loan_parts:part-new1":1,"mortgage_loan_parts:part-new2":1}'
)->>'status'), 'applied', 'a pristine bank change is reverted atomically');
reset role;
select ok(
  (select not archived and end_date is null from public.mortgages where id = 'm-old')
  and not exists (select 1 from public.mortgages where id = 'm-new')
  and not exists (select 1 from public.mortgage_loan_parts where mortgage_id = 'm-new'),
  'the old agreement is reactivated and the pristine new one is fully removed'
);
select ok(
  (select (data #> '{resources,mortgages}') ? 'm-new'
      and (data #> '{resources,mortgage_loan_parts}') ? 'part-new1'
      and (data #> '{resources,mortgage_loan_parts}') ? 'part-new2'
    from public.tool_state
    where household_id = '72000000-0000-0000-0000-000000000001' and tool = 'sync-tombstones-v1'),
  'the reverted agreement and parts leave durable tombstones'
);
select ok(
  (select count(*) from public.mortgage_payments where id in ('pay-old','dp-legacy-a')) = 2
  and (select count(*) from public.mortgage_rate_periods where id = 'rp-old') = 1,
  'the old agreement history survives the change/revert round trip untouched'
);
set local role authenticated;
select is((public.sync_revert_mortgage_bank_change(
  'op-revert', 'm-new',
  '{"mortgages:m-new":1,"mortgages:m-old":2,"mortgage_loan_parts:part-new1":1,"mortgage_loan_parts:part-new2":1}'
)->>'status'), 'applied', 'a revert retry is acknowledged from its receipt');
select is((public.sync_apply_rows(
  'op-recreate-tombstoned', 'mortgages',
  '[{"id":"m-new","label":"Spöke","start_date":"2026-07-01","archived":true,"end_date":"2026-08-01"}]',
  '{"mortgages:m-new":null}', false
)->>'status'), 'conflict', 'a reverted agreement id cannot be reused by a stale client');
select throws_ok(
  $$select public.sync_revert_mortgage_bank_change(
    'op-revert-active-only', 'm-old-prev',
    '{"mortgages:m-old-prev":1}'
  )$$,
  '22023', 'mortgage agreement is not active', 'revert only targets the active agreement'
);

-- ── 9. Cross-household and grant boundaries ──────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"71000000-0000-0000-0000-000000000002","role":"authenticated","email":"agreement-b@example.invalid"}', true);
select is((public.sync_change_mortgage_bank(
  'op-foreign-change', 'm-old', 3,
  '{"id":"m-evil","label":"Kapat","bank_id":"bank-danske"}',
  '[]', '2026-07-02'
)->>'status'), 'conflict', 'another household cannot change bank on a foreign agreement');
reset role;
select ok(
  (select not archived from public.mortgages where id = 'm-old')
  and not exists (select 1 from public.mortgages where id = 'm-evil'),
  'the foreign bank-change attempt changes nothing'
);
select ok(
  has_function_privilege('authenticated', 'public.sync_change_mortgage_bank(text,text,bigint,jsonb,jsonb,text)', 'execute')
  and not has_function_privilege('anon', 'public.sync_change_mortgage_bank(text,text,bigint,jsonb,jsonb,text)', 'execute')
  and not has_function_privilege('public', 'public.sync_change_mortgage_bank(text,text,bigint,jsonb,jsonb,text)', 'execute')
  and has_function_privilege('authenticated', 'public.sync_revert_mortgage_bank_change(text,text,jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.sync_revert_mortgage_bank_change(text,text,jsonb)', 'execute')
  and not has_function_privilege('public', 'public.sync_revert_mortgage_bank_change(text,text,jsonb)', 'execute'),
  'only authenticated clients may execute the bank-change RPC pair'
);

select * from finish();
rollback;
