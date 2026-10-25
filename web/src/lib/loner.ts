/* loner.ts — pure month/half model for the Löner tool (plan 139).

   A person's salary half lives in one of two places (plan 139 D1): a pending
   draft in salary_submission_drafts while the month waits for the other half,
   then the owner's `income_items` of the month's salary_submissions row once
   the month is complete. buildMonthViews hides that split behind one MonthView
   per month; replaceHalf edits a completed row (D4) by feeding both owners'
   items back through buildSubmission, so the transfer formula has one home.

   No React, Supabase or browser APIs. Full precision is kept everywhere —
   rounding is a display concern. */

import { buildSubmission, type IncomeItem, type OwnedIncomeItem, type SalarySubmission } from './hushallsbudget'
import type { SalaryDraft } from './salary-drafts-store'

export type Slot = 'a' | 'b'
export type HalfSource = 'email' | 'app' | 'complete'

export interface HalfView {
  slot: Slot
  items: IncomeItem[]
  total: number
  /** The half's own note while pending. Null for a complete half: a completed
      row has one month-level note (submission.note), not one per half. */
  note: string | null
  source: HalfSource
  /** The draft's exact server updated_at (pass back to saveHalf); null once complete. */
  draftUpdatedAt: string | null
}

export type MonthStatus = 'empty' | 'waiting' | 'zero_total' | 'complete'

export interface MonthView {
  month: string
  status: MonthStatus
  halves: Partial<Record<Slot, HalfView>>
  /** The month's row (newest by created_at when there are legacy duplicates). */
  submission: SalarySubmission | null
  /** Every row for this month, in input order: [] when pending, one row when
      complete, >1 only for legacy duplicate months (D6) — UI shows each row. */
  duplicates: SalarySubmission[]
}

const SLOTS: readonly Slot[] = ['a', 'b']

// A row's per-owner items. Rows read through salary-store are already
// migrated, but a legacy row without income_items is synthesised the same way
// salary-store's _migrate does (one 'Lön / Salary' item per person from the
// scalar totals), so editing one half never zeroes the other.
function ownedItems(row: SalarySubmission): OwnedIncomeItem[] {
  if (Array.isArray(row.income_items)) return row.income_items
  return [
    { owner: 'a', label: 'Lön / Salary', amount: row.income_a || 0 },
    { owner: 'b', label: 'Lön / Salary', amount: row.income_b || 0 },
  ]
}

function itemsOf(row: SalarySubmission, owner: Slot): IncomeItem[] {
  return ownedItems(row)
    .filter((item) => item.owner === owner)
    .map((item) => ({ label: item.label, amount: item.amount }))
}

function sum(items: IncomeItem[]): number {
  return items.reduce((total, item) => total + (item.amount || 0), 0)
}

function completeHalves(row: SalarySubmission): Partial<Record<Slot, HalfView>> {
  const halves: Partial<Record<Slot, HalfView>> = {}
  for (const slot of SLOTS) {
    halves[slot] = {
      slot,
      items: itemsOf(row, slot),
      // The stored scalar total is what the row's transfer was computed from.
      total: (slot === 'a' ? row.income_a : row.income_b) || 0,
      note: null,
      source: 'complete',
      draftUpdatedAt: null,
    }
  }
  return halves
}

function draftHalf(draft: SalaryDraft): HalfView {
  const items = draft.income_items.map((item) => ({ label: item.label, amount: item.amount }))
  return {
    slot: draft.slot,
    items,
    total: sum(items),
    note: draft.note,
    source: draft.submitted_via,
    draftUpdatedAt: draft.updated_at,
  }
}

/** Union of submission months and draft months, newest first, always including
    `current` (so this month always has a row with a CTA). A month that has a
    submission is 'complete' and its drafts are ignored (finalize/already_logged
    clears them). With both halves pending, a total ≤ 0 is 'zero_total' (the
    same rule as private.finalize_salary_month); otherwise the month is
    'waiting' — for the other half, or, if both somehow exist, for the next
    save to complete it. */
export function buildMonthViews(subs: SalarySubmission[], drafts: SalaryDraft[], current: string): MonthView[] {
  const subsByMonth = new Map<string, SalarySubmission[]>()
  for (const row of subs) {
    const list = subsByMonth.get(row.month)
    if (list) list.push(row); else subsByMonth.set(row.month, [row])
  }
  const draftsByMonth = new Map<string, SalaryDraft[]>()
  for (const draft of drafts) {
    const list = draftsByMonth.get(draft.month)
    if (list) list.push(draft); else draftsByMonth.set(draft.month, [draft])
  }

  const months = new Set<string>([current, ...subsByMonth.keys(), ...draftsByMonth.keys()])
  return [...months].sort((a, b) => b.localeCompare(a)).map((month): MonthView => {
    const rows = subsByMonth.get(month) ?? []
    if (rows.length) {
      // Newest first by created_at; ties keep input order (Array.sort is stable).
      const ordered = rows.slice().sort((x, y) => String(y.created_at || '').localeCompare(String(x.created_at || '')))
      return { month, status: 'complete', halves: completeHalves(ordered[0]), submission: ordered[0], duplicates: ordered }
    }
    const halves: Partial<Record<Slot, HalfView>> = {}
    for (const draft of draftsByMonth.get(month) ?? []) {
      if (!halves[draft.slot]) halves[draft.slot] = draftHalf(draft) // (household, month, slot) is unique server-side
    }
    const present = SLOTS.filter((slot) => halves[slot])
    let status: MonthStatus = 'empty'
    if (present.length === 1) status = 'waiting'
    else if (present.length === 2) status = (halves.a!.total + halves.b!.total) <= 0 ? 'zero_total' : 'waiting'
    return { month, status, halves, submission: null, duplicates: [] }
  })
}

/** D4: replace `owner`'s items in a completed row and recompute every derived
    field with buildSubmission's formulas. Keeps id, created_at, person_*_name
    and any other stored field; keeps the other owner's items in their stored
    order (A items first, then B). `note` becomes the row's (month-level) note —
    pass the row's current note to keep it; '' or null clears it. Blank-label +
    zero-amount items are dropped, as in buildSubmission. */
export function replaceHalf(row: SalarySubmission, owner: Slot, items: IncomeItem[], note: string | null): SalarySubmission {
  const incomesA = owner === 'a' ? items : itemsOf(row, 'a')
  const incomesB = owner === 'b' ? items : itemsOf(row, 'b')
  const built = buildSubmission({
    month: row.month,
    incomesA,
    incomesB,
    personAName: row.person_a_name,
    personBName: row.person_b_name,
    note: note ?? undefined,
  })
  return {
    ...row,
    income_a: built.income_a,
    income_b: built.income_b,
    income_items: built.income_items,
    transfer_amount: built.transfer_amount,
    transfer_from: built.transfer_from,
    transfer_to: built.transfer_to,
    equal_share: built.equal_share,
    note: built.note,
  }
}
