-- Plan 105 — declared amortering plan. Adds an owner-DECLARED rak amortering
-- (kr/mån) to mortgage_loan_parts so the forecast can trust the declaration
-- over the value derived from ledger history. All three columns are nullable
-- (null = "not declared → detect"; a declared 0 pins the part interest-only).
-- Dates are text, lexicographically sortable, matching the rest of the schema
-- (Decision 8 in 20260705160000_bolanekoll_tables.sql). No RLS change — the
-- table is already household-scoped via the hh_all policy. Additive and
-- idempotent (add column if not exists), so `supabase db reset` is safe.
alter table public.mortgage_loan_parts
  add column if not exists planned_amortization       numeric,
  add column if not exists planned_amortization_start text,
  add column if not exists planned_amortization_end   text;

-- Plan 98's optimistic-concurrency RPC (sync_apply_rows) REJECTS any row whose
-- keys are not in private.sync_allowed_row_keys — so the three new columns must
-- be added to the mortgage_loan_parts allowlist or a declared amortering write
-- fails with "invalid row payload" at runtime (a gap the mock-based store tests
-- cannot see). Re-declared verbatim from 20260714110000_optimistic_concurrency
-- (the latest definition) with only the mortgage_loan_parts array extended; all
-- other resources are unchanged. `create or replace` preserves existing
-- privileges; the revoke is repeated to keep the intent explicit.
create or replace function private.sync_allowed_row_keys(p_resource text)
returns text[] language sql immutable set search_path to '' as $$
  select case p_resource
    when 'scenarios' then array['id','created_at','name','saved_at','inputs','constants']
    when 'salary_submissions' then array['id','created_at','month','person_a_name','income_a','person_b_name','income_b','transfer_from','transfer_to','transfer_amount','equal_share','note','income_items']
    when 'monthend_items' then array['id','created_at','date_purchased','description','enter_amount','split','amount','fronted_by','owed_by','paid','pending','payment_id','note','personal_items','personal_a','personal_b']
    when 'monthend_payments' then array['id','created_at','item_ids','from_person','to_person','amount','period_label','note']
    when 'mortgage_loan_parts' then array['id','created_at','label','loan_number','start_balance','start_date','archived','planned_amortization','planned_amortization_start','planned_amortization_end']
    when 'mortgage_rate_periods' then array['id','created_at','loan_part_id','start_date','end_date','rate','rate_type']
    when 'mortgage_payments' then array['id','created_at','loan_part_id','date','kind','description','amount','balance_after','paid_by','source','is_insats','paid_split']
    when 'mortgage_valuations' then array['id','created_at','date','value','note','is_purchase']
    when 'mortgage_contributions' then array['id','created_at','owner','date','amount','note']
    when 'house_items' then array['id','created_at','type','title','category','date','cost','vendor','interval_years','remind_days','notes']
  end
$$;
revoke all on function private.sync_allowed_row_keys(text) from public, anon, authenticated;
