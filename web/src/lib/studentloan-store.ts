/* studentloan-store.ts — persistence for the UK Student Loan tracker (plan 17).
   The whole inputs object persists as one row in the shared tool_state table
   (tool = 'studentloan'), with a scoped cache and durable operation outbox.
   The persistence skeleton (cache, first-login import, load/save) lives in
   ./tool-store (createToolStateStore); only the `_merge` sanitizer and the key
   strings are tool-specific — same pattern as konsult-store.ts /
   lonevaxling-store.ts. */

import { defaultStudentLoanInputs, type StudentLoanInputs } from './studentloan'
import { createToolStateStore } from './tool-store'

export const STORAGE_KEY = 'bostadskalkyl_studentloan_v1'

// Merge the saved fields into a fresh defaults object — guards against schema
// drift / bad data. Returns null when nothing valid is present. Runs on cloud,
// cache and legacy blobs alike (idempotent). Unlike Konsult/Löneväxling this
// blob has a boolean flag and an optional number, so each key is merged
// explicitly rather than via a single numeric-only loop.
function _merge(saved: unknown): StudentLoanInputs | null {
  if (!saved || typeof saved !== 'object') return null
  const s = saved as Record<string, unknown>
  const d = defaultStudentLoanInputs()

  const num = (key: keyof StudentLoanInputs): number | undefined | null => {
    const v = s[key]
    if (v === undefined) return undefined // absent legacy field → current default
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  }

  const required = (key: keyof StudentLoanInputs): number | null => num(key) ?? null
  const numberKeys: (keyof StudentLoanInputs)[] = ['balance_gbp', 'interest_rate', 'rate_stress', 'first_due_year', 'current_year', 'income_sek', 'fx_sek_per_gbp', 'salary_growth_pct', 'se_threshold_gbp', 'opportunity_rate_pct']
  if (numberKeys.some((key) => num(key) === null)
    || (s.slc_monthly_gbp !== undefined && num('slc_monthly_gbp') === null)
    || (s.hold_threshold_flat !== undefined && typeof s.hold_threshold_flat !== 'boolean')) return null

  d.balance_gbp = required('balance_gbp') ?? d.balance_gbp
  d.interest_rate = num('interest_rate') ?? d.interest_rate
  d.rate_stress = num('rate_stress') ?? d.rate_stress
  d.first_due_year = num('first_due_year') ?? d.first_due_year
  d.current_year = num('current_year') ?? d.current_year
  d.income_sek = num('income_sek') ?? d.income_sek
  d.fx_sek_per_gbp = num('fx_sek_per_gbp') ?? d.fx_sek_per_gbp
  d.salary_growth_pct = num('salary_growth_pct') ?? d.salary_growth_pct
  d.se_threshold_gbp = num('se_threshold_gbp') ?? d.se_threshold_gbp
  d.opportunity_rate_pct = num('opportunity_rate_pct') ?? d.opportunity_rate_pct
  if (typeof s.hold_threshold_flat === 'boolean') d.hold_threshold_flat = s.hold_threshold_flat
  // Optional: only set when the saved blob has a genuine finite number —
  // otherwise stays undefined (the "no SLC letter figure entered" state).
  d.slc_monthly_gbp = num('slc_monthly_gbp') ?? undefined

  return d
}

const store = createToolStateStore<StudentLoanInputs>({
  tool: 'studentloan',
  storageKey: STORAGE_KEY,
  cacheKey: 'bostadskalkyl_studentloan_cache_v1',
  importFlag: 'bostadskalkyl_studentloan_supabase_imported',
  merge: _merge,
})

// Read the persisted inputs. null = nothing stored yet (caller keeps defaults).
export const load = store.load
// Persist the whole inputs blob. Rejects on a cloud write failure — the caller
// surfaces that via reportPersistenceError (see studentloan-store's callers).
export const save = store.save
