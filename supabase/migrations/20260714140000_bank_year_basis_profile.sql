-- Plan 104 (Phase 1) — Bank profile: the declared year-basis lock.
-- Adds the per-bank day-count-year profile columns to mortgage_banks and lets
-- them ride through the optimistic-concurrency sync allowlist. Additive +
-- idempotent (safe to re-run):
--   * year_basis        int  — 360 | 365 | null (null = detect from the ledger)
--   * year_basis_source text — 'detected' | 'suggested' | 'declared' | null
--     (only a 'declared' value short-circuits the forecast's learner; null/
--     detected/suggested fall back to detection).
-- No new table, so no revision column / trigger / table inventory changes:
-- mortgage_banks already joined the sync system in plan 103 (revision column,
-- set_sync_revision trigger, revoked client writes). No RLS change. No backfill
-- (year_basis stays null = detect), so no guarded-table trigger toggling is
-- needed — the reject_deleted_* guard only lives on the plan-98 original tables,
-- not on mortgage_banks.

-- ── Profile columns ──────────────────────────────────────────────────────────
alter table public.mortgage_banks
  add column if not exists year_basis        int,
  add column if not exists year_basis_source text;

-- ── Extend the sync column allowlist ─────────────────────────────────────────
-- mortgage_banks is a sync-participant table: sync_apply_rows HARD-REJECTS any
-- row carrying a key not in private.sync_allowed_row_keys('mortgage_banks')
-- (errcode 22023). The two new columns must be listed here or their writes are
-- refused at runtime (mock-based store tests never catch this — the mock doesn't
-- enforce the allowlist). Re-declared VERBATIM from the latest definition
-- (20260714130000_mortgage_domain_model): every other resource is byte-identical;
-- ONLY the mortgage_banks array gains 'year_basis','year_basis_source'.
create or replace function private.sync_allowed_row_keys(p_resource text)
returns text[] language sql immutable set search_path to '' as $$
  select case p_resource
    when 'scenarios' then array['id','created_at','name','saved_at','inputs','constants']
    when 'salary_submissions' then array['id','created_at','month','person_a_name','income_a','person_b_name','income_b','transfer_from','transfer_to','transfer_amount','equal_share','note','income_items']
    when 'monthend_items' then array['id','created_at','date_purchased','description','enter_amount','split','amount','fronted_by','owed_by','paid','pending','payment_id','note','personal_items','personal_a','personal_b']
    when 'monthend_payments' then array['id','created_at','item_ids','from_person','to_person','amount','period_label','note']
    when 'mortgage_loan_parts' then array['id','created_at','label','loan_number','start_balance','start_date','archived','mortgage_id','original_balance','original_date','planned_amortization','planned_amortization_start','planned_amortization_end']
    when 'mortgage_rate_periods' then array['id','created_at','loan_part_id','start_date','end_date','rate','rate_type']
    when 'mortgage_payments' then array['id','created_at','loan_part_id','date','kind','description','amount','balance_after','paid_by','source','is_insats','paid_split']
    when 'mortgage_valuations' then array['id','created_at','date','value','note','is_purchase']
    when 'mortgage_contributions' then array['id','created_at','owner','date','amount','note']
    when 'mortgage_banks' then array['id','created_at','label','year_basis','year_basis_source']
    when 'mortgages' then array['id','created_at','bank_id','label','start_date','archived']
    when 'house_items' then array['id','created_at','type','title','category','date','cost','vendor','interval_years','remind_days','notes']
  end
$$;
revoke all on function private.sync_allowed_row_keys(text) from public, anon, authenticated;
