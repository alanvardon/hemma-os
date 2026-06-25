export interface KonsultInputs {
  rate: number
  hoursPerWeek: number
  weeksPerYear: number
  holidayWeeks: number
  sickWeeks: number
  grossSalaryMonthly: number
  lonevaxlingMonthly: number
  otherCostMonthly: number
  employerFeePct: number
  sarskildLoneskattPct: number
  corporateTaxPct: number
  municipalTaxPct: number
  dividendAllowance: number
  dividendTaxPct: number
}

export interface KonsultResult {
  billableWeeks: number
  billableHours: number
  revenue: number
  grossSalary: number
  lonevaxling: number
  cashSalary: number
  employerFee: number
  sarskildLoneskatt: number
  otherCost: number
  totalSalaryCost: number
  profitBeforeTax: number
  corporateTax: number
  profitAfterTax: number
  dividend: number
  dividendTax: number
  netDividend: number
  retainedProfit: number
  grundavdrag: number
  taxableIncome: number
  municipalTax: number
  stateTax: number
  workTaxCredit: number
  netSalary: number
  totalNetIncome: number
  totalTax: number
  takeHomeRate: number
  effectiveTaxRate: number
}

const PBB_2026 = 59200
const STATE_TAX_SKIKTGRANS = 643000
const STATE_TAX_RATE = 0.2

export function defaultInputs(): KonsultInputs {
  return {
    rate: 1000,
    hoursPerWeek: 40,
    weeksPerYear: 52,
    holidayWeeks: 6,
    sickWeeks: 6,
    grossSalaryMonthly: 62000,
    lonevaxlingMonthly: 8333,
    otherCostMonthly: 5000,
    employerFeePct: 31.42,
    sarskildLoneskattPct: 24.26,
    corporateTaxPct: 20.6,
    municipalTaxPct: 32.38,
    dividendAllowance: 322400,
    dividendTaxPct: 20,
  }
}

function grundavdragFn(income: number, pbb: number): number {
  const ff = Math.max(0, income)
  let g: number
  if (ff <= 0.99 * pbb) g = 0.423 * pbb
  else if (ff <= 2.72 * pbb) g = 0.423 * pbb + 0.2 * (ff - 0.99 * pbb)
  else if (ff <= 3.11 * pbb) g = 0.77 * pbb
  else if (ff <= 7.88 * pbb) g = 0.77 * pbb - 0.1 * (ff - 3.11 * pbb)
  else g = 0.293 * pbb
  return Math.ceil(g / 100) * 100
}

function jobbskatteavdragFn(
  arbetsinkomst: number,
  ga: number,
  kommunalRate: number,
  pbb: number,
): number {
  const ai = Math.max(0, arbetsinkomst)
  const PLATEAU = 3.027
  let base: number
  if (ai <= 0.91 * pbb) {
    base = ai
  } else if (ai <= 3.24 * pbb) {
    base = 0.91 * pbb + 0.3874 * (ai - 0.91 * pbb)
  } else if (ai <= 8.08 * pbb) {
    const b2end = 0.91 * pbb + 0.3874 * (3.24 - 0.91) * pbb
    const slope = (PLATEAU * pbb - b2end) / ((8.08 - 3.24) * pbb)
    base = b2end + slope * (ai - 3.24 * pbb)
  } else if (ai <= 13.54 * pbb) {
    base = PLATEAU * pbb
  } else {
    base = PLATEAU * pbb - 0.03 * (ai - 13.54 * pbb)
  }
  return Math.max(0, (base - ga) * kommunalRate)
}

export function computeContracting(input?: Partial<KonsultInputs>): KonsultResult {
  const d: KonsultInputs = { ...defaultInputs(), ...input }

  const billableWeeks = Math.max(0, d.weeksPerYear - d.holidayWeeks - d.sickWeeks)
  const billableHours = billableWeeks * d.hoursPerWeek
  const revenue = billableHours * d.rate

  const grossSalary = d.grossSalaryMonthly * 12
  const lonevaxling = Math.min(d.lonevaxlingMonthly * 12, grossSalary)
  const cashSalary = grossSalary - lonevaxling

  const employerFee = cashSalary * (d.employerFeePct / 100)
  const sarskildLoneskatt = lonevaxling * (d.sarskildLoneskattPct / 100)
  const otherCost = d.otherCostMonthly * 12
  const totalSalaryCost = cashSalary + employerFee + lonevaxling + sarskildLoneskatt

  const profitBeforeTax = revenue - totalSalaryCost - otherCost
  const corporateTax = Math.max(0, profitBeforeTax) * (d.corporateTaxPct / 100)
  const profitAfterTax = profitBeforeTax - corporateTax

  const dividend = Math.min(Math.max(0, profitAfterTax), d.dividendAllowance)
  const dividendTax = dividend * (d.dividendTaxPct / 100)
  const netDividend = dividend - dividendTax
  const retainedProfit = profitAfterTax - dividend

  const kommunalRate = d.municipalTaxPct / 100
  const ga = grundavdragFn(cashSalary, PBB_2026)
  const taxableIncome = Math.max(0, cashSalary - ga)
  const municipalTax = taxableIncome * kommunalRate
  const stateTax = Math.max(0, taxableIncome - STATE_TAX_SKIKTGRANS) * STATE_TAX_RATE
  const jsaRaw = jobbskatteavdragFn(cashSalary, ga, kommunalRate, PBB_2026)
  const workTaxCredit = Math.min(jsaRaw, municipalTax + stateTax)
  const netSalary = cashSalary - municipalTax - stateTax + workTaxCredit

  const totalNetIncome = netSalary + netDividend
  const totalTax =
    employerFee + sarskildLoneskatt + corporateTax + dividendTax + municipalTax + stateTax - workTaxCredit

  return {
    billableWeeks,
    billableHours,
    revenue,
    grossSalary,
    lonevaxling,
    cashSalary,
    employerFee,
    sarskildLoneskatt,
    otherCost,
    totalSalaryCost,
    profitBeforeTax,
    corporateTax,
    profitAfterTax,
    dividend,
    dividendTax,
    netDividend,
    retainedProfit,
    grundavdrag: ga,
    taxableIncome,
    municipalTax,
    stateTax,
    workTaxCredit,
    netSalary,
    totalNetIncome,
    totalTax,
    takeHomeRate: revenue > 0 ? totalNetIncome / revenue : 0,
    effectiveTaxRate: revenue > 0 ? totalTax / revenue : 0,
  }
}
