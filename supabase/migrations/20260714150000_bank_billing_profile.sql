-- Plan 104 (Phase 2) — Bank profile: the billing-cadence pin + the learner.
-- Adds the per-bank billing-convention columns to mortgage_banks and lets them
-- ride through the optimistic-concurrency sync allowlist. Additive + idempotent:
--   * billing        text — 'month-end' | 'fixed' | null (null = detect)
--   * billing_source text — 'detected' | 'suggested' | 'declared' | null
--     (only a 'declared' value pins the cadence over isMonthEndBilling; null/
--     detected/suggested fall back to detection).
-- No new table, so no revision column / trigger / table-inventory changes:
-- mortgage_banks already joined the sync system in plan 103. No RLS change. No
-- backfill (columns stay null = detect), so no guarded-table trigger toggling.

-- ── Profile columns ──────────────────────────────────────────────────────────
alter table public.mortgage_banks
  add column if not exists billing        text,
  add column if not exists billing_source text;

-- ── Extend the sync column allowlist ─────────────────────────────────────────
-- sync_apply_rows HARD-REJECTS any row carrying a key not in
-- private.sync_allowed_row_keys('mortgage_banks') (errcode 22023) — mock-based
-- store tests never catch this. Re-declared VERBATIM from the latest definition
-- (20260714140000_bank_year_basis_profile); every other resource is byte-
-- identical; ONLY the mortgage_banks array gains 'billing','billing_source'.
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
    when 'mortgage_banks' then array['id','created_at','label','year_basis','year_basis_source','billing','billing_source']
    when 'mortgages' then array['id','created_at','bank_id','label','start_date','archived']
    when 'house_items' then array['id','created_at','type','title','category','date','cost','vendor','interval_years','remind_days','notes']
  end
$$;
revoke all on function private.sync_allowed_row_keys(text) from public, anon, authenticated;
