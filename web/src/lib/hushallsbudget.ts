/* hushallsbudget.ts — Hushållsbudget: the household pot.
   Two adults pool every income into one pot, split it equally back,
   then pay joint costs 50/50 and individual costs from their own share.
   Pure core ported 1:1 from the vanilla budget.js (the math section that was
   exported for node tests); no DOM, no storage — the React route owns those. */

// Rows are grouped by owner: 'joint' (split 50/50), 'a' or 'b' (one person).
export type Owner = 'a' | 'b' | 'joint'

export interface Row {
  id: string
  label: string
  amount: number
  owner: Owner
  category?: string
}

export interface Category {
  id: string
  name: string
}

export interface BudgetState {
  version: number
  people: string[]
  categories: Category[]
  incomes: Row[]
  costs: Row[]
  savings: Row[]
  seq: number
  catSeq: number
}

export interface PersonResult {
  ownIncome: number
  potNet: number
  jointCostShare: number
  ownCosts: number
  jointSavingsShare: number
  ownSavings: number
  leftover: number
}

export interface Transfer {
  amount: number
  from: Owner
  to: Owner
}

export interface JointCategory {
  id: string
  name: string
  amount: number
}

export interface BudgetResult {
  incomeA: number
  incomeB: number
  incomeJoint: number
  totalIncome: number
  equalShare: number
  costsJoint: number
  costsA: number
  costsB: number
  totalCosts: number
  jointCategories: JointCategory[]
  savingsJoint: number
  savingsA: number
  savingsB: number
  totalSavings: number
  personA: PersonResult
  personB: PersonResult
  transfer: Transfer
  surplus: number
  savingsRate: number
}

// ── Formatting (ported from calc.js) ─────────────────────────────
export function formatWithSpaces(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

export function parseFormatted(str: string | number): number {
  return parseFloat(String(str).replace(/\s/g, '').replace(/,/g, '.')) || 0
}

// ── Defaults & computation ───────────────────────────────────────
export function defaultState(): BudgetState {
  let id = 0
  function row(label: string, amount: number, owner: Owner, category?: string): Row {
    const r: Row = { id: 'r' + (++id), label, amount, owner }
    if (category) r.category = category
    return r
  }
  const s: BudgetState = {
    version: 1,
    people: ['Alan', 'Partner'],
    // Categories group the JOINT costs (split 50/50). Individual costs aren't
    // categorised. Rows reference a category by id; drag-and-drop reassigns it.
    categories: [
      { id: 'c-boende', name: 'Boende' },
      { id: 'c-hushall', name: 'Mat & hushåll' },
      { id: 'c-transport', name: 'Transport' },
      { id: 'c-forsakring', name: 'Försäkring & barn' },
      { id: 'c-ovrigt', name: 'Övrigt' },
    ],
    incomes: [
      row('Lön / Salary', 46000, 'a'),
      row('Lön / Salary', 39000, 'b'),
    ],
    costs: [
      // Joint — grouped into categories
      row('Bolån (ränta & amortering)', 12775, 'joint', 'c-boende'),
      row('El / Electricity', 2101, 'joint', 'c-boende'),
      row('Vatten & avlopp', 231, 'joint', 'c-boende'),
      row('Fastighetsavgift', 397, 'joint', 'c-boende'),
      row('Matvaror & hushåll', 9700, 'joint', 'c-hushall'),
      row('Restaurang & takeaway', 3000, 'joint', 'c-hushall'),
      row('Bilkostnad / leasing', 3500, 'joint', 'c-transport'),
      row('Bränsle, parkering & SL', 2970, 'joint', 'c-transport'),
      row('Försäkringar (hem, bil, barn, liv)', 1455, 'joint', 'c-forsakring'),
      row('Förskola, fritids & aktiviteter', 3300, 'joint', 'c-forsakring'),
      row('Bredband & streaming', 413, 'joint', 'c-ovrigt'),
      row('Kläder, hälsa & presenter', 2700, 'joint', 'c-ovrigt'),
      row('Diverse / oförutsett', 2000, 'joint', 'c-ovrigt'),
      // Individual
      row('Mobil', 300, 'a'),
      row('Gym', 500, 'a'),
      row('Hobby', 700, 'a'),
      row('Mobil', 300, 'b'),
      row('Gym', 450, 'b'),
      row('Hobby', 600, 'b'),
    ],
    savings: [
      // Each person saves from their own take-home share
      row('Pension (eget)', 4000, 'a'),
      row('ISK / fondsparande', 3000, 'a'),
      row('Sparkonto / buffert', 1500, 'a'),
      row('Pension (eget)', 4000, 'b'),
      row('ISK / fondsparande', 3000, 'b'),
      row('Sparkonto / buffert', 1500, 'b'),
    ],
    seq: id,
    catSeq: 0,
  }
  return s
}

export function computeBudget(state: Partial<BudgetState> = {}): BudgetResult {
  const incomes = state.incomes || []
  const costs = state.costs || []
  const savings = state.savings || []

  function sum(rows: Row[], owner?: Owner): number {
    let t = 0
    for (let i = 0; i < rows.length; i++) {
      if (owner === undefined || rows[i].owner === owner) t += rows[i].amount || 0
    }
    return t
  }

  const incomeA = sum(incomes, 'a')
  const incomeB = sum(incomes, 'b')
  const incomeJoint = sum(incomes, 'joint')
  const totalIncome = incomeA + incomeB + incomeJoint
  const equalShare = totalIncome / 2

  const costsJoint = sum(costs, 'joint')
  const costsA = sum(costs, 'a')
  const costsB = sum(costs, 'b')
  const totalCosts = costsJoint + costsA + costsB

  // Break the joint costs down by category, in the user's category order.
  // Joint rows with no/unknown category collect into an "Övrigt" bucket.
  const cats = state.categories || []
  const catTotals: Record<string, number> = {}
  cats.forEach((c) => { catTotals[c.id] = 0 })
  let otherTotal = 0
  for (let ci = 0; ci < costs.length; ci++) {
    const cr = costs[ci]
    if (cr.owner !== 'joint') continue
    if (cr.category && Object.prototype.hasOwnProperty.call(catTotals, cr.category)) {
      catTotals[cr.category] += cr.amount || 0
    } else {
      otherTotal += cr.amount || 0
    }
  }
  const jointCategories: JointCategory[] = cats.map((c) => ({ id: c.id, name: c.name, amount: catTotals[c.id] }))
  if (otherTotal > 0) jointCategories.push({ id: '_other', name: 'Övrigt', amount: otherTotal })

  const savingsJoint = sum(savings, 'joint')
  const savingsA = sum(savings, 'a')
  const savingsB = sum(savings, 'b')
  const totalSavings = savingsJoint + savingsA + savingsB

  // The single person-to-person transfer that evens out the two salaries:
  // the higher earner sends the other half the gap. Joint income (barnbidrag
  // etc.) is shared 50/50 on top from the pot, so it doesn't change who pays
  // whom — only the final equalShare. transfer + each getting incomeJoint/2
  // lands both people on equalShare.
  const gap = incomeA - incomeB
  const transfer: Transfer = {
    amount: Math.abs(gap) / 2,
    from: gap >= 0 ? 'a' : 'b',
    to: gap >= 0 ? 'b' : 'a',
  }

  // potNet: what flows back to (positive) or stays in (negative) the pot
  // for this person once everyone has taken out the same equal share.
  function person(ownIncome: number, ownCosts: number, ownSavings: number): PersonResult {
    return {
      ownIncome,
      potNet: equalShare - ownIncome,
      jointCostShare: costsJoint / 2,
      ownCosts,
      jointSavingsShare: savingsJoint / 2,
      ownSavings,
      leftover: equalShare - costsJoint / 2 - ownCosts - savingsJoint / 2 - ownSavings,
    }
  }

  return {
    incomeA,
    incomeB,
    incomeJoint,
    totalIncome,
    equalShare,
    costsJoint,
    costsA,
    costsB,
    totalCosts,
    jointCategories,
    savingsJoint,
    savingsA,
    savingsB,
    totalSavings,
    personA: person(incomeA, costsA, savingsA),
    personB: person(incomeB, costsB, savingsB),
    transfer,
    surplus: totalIncome - totalCosts - totalSavings,
    savingsRate: totalIncome > 0 ? totalSavings / totalIncome : 0,
  }
}

// ── Salary submission record (Supabase-shaped) ───────────────────
export interface IncomeItem { label: string; amount: number }
export interface OwnedIncomeItem { owner: 'a' | 'b'; label: string; amount: number }

export interface SubmissionInput {
  month?: string
  incomesA?: IncomeItem[]
  incomesB?: IncomeItem[]
  incomeA?: number
  incomeB?: number
  personAName?: string
  personBName?: string
  note?: string
}

export interface SalarySubmission {
  month: string
  income_a: number
  income_b: number
  income_items: OwnedIncomeItem[]
  person_a_name: string
  person_b_name: string
  transfer_amount: number
  transfer_from: Owner
  transfer_to: Owner
  equal_share: number
  note: string | null
  id?: string
  created_at?: string
}

// Build a Supabase-shaped salary submission row from a month's incomes.
// Each person can have several income items (salary, barnbidrag, tax rebate…):
// pass incomesA / incomesB as arrays of { label, amount }. The scalar
// income_a / income_b totals are kept as clean summary columns and the per-item
// breakdown is emitted as income_items ([{ owner, label, amount }]) — jsonb today,
// a `salary_submission_incomes` child table after the Supabase move.
// Pure: reuses computeBudget for the settle-up transfer + equal share, so the
// math has a single home. id + created_at are stamped later by the data-access
// layer (the DB would default them). note defaults to null.
export function buildSubmission(input: SubmissionInput = {}): SalarySubmission {
  function items(arr: IncomeItem[] | undefined, scalar: number | undefined): IncomeItem[] {
    if (Array.isArray(arr)) {
      return arr
        .map((it) => ({ label: (it.label || '').trim(), amount: it.amount || 0 }))
        .filter((it) => it.label || it.amount)
    }
    // back-compat: a single scalar salary
    return typeof scalar === 'number' ? [{ label: 'Lön / Salary', amount: scalar }] : []
  }
  function total(list: IncomeItem[]): number {
    return list.reduce((t, it) => t + (it.amount || 0), 0)
  }

  const itemsA = items(input.incomesA, input.incomeA)
  const itemsB = items(input.incomesB, input.incomeB)
  const incomeA = total(itemsA)
  const incomeB = total(itemsB)
  const r = computeBudget({ incomes: [{ id: 'a', label: '', amount: incomeA, owner: 'a' }, { id: 'b', label: '', amount: incomeB, owner: 'b' }] })

  const income_items: OwnedIncomeItem[] = itemsA
    .map((it): OwnedIncomeItem => ({ owner: 'a', label: it.label, amount: it.amount }))
    .concat(itemsB.map((it): OwnedIncomeItem => ({ owner: 'b', label: it.label, amount: it.amount })))

  return {
    month: input.month || '',
    income_a: incomeA,
    income_b: incomeB,
    income_items,
    person_a_name: input.personAName || '',
    person_b_name: input.personBName || '',
    transfer_amount: r.transfer.amount,
    transfer_from: r.transfer.from,
    transfer_to: r.transfer.to,
    equal_share: r.equalShare,
    note: input.note ? input.note : null,
  }
}
