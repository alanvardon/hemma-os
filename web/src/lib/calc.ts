// Pure house-purchase math — ported from the vanilla calc.js + the recalc()
// body in app.js, now typed. `derive(inputs)` is the single source of truth:
// it returns every figure the UI renders, so React components stay dumb.

// ── Tunable statutory constants ─────────────────────────────────────
// These change with Swedish law (yearly indexing, reforms), so they're editable
// per scenario (with a global default) rather than hardcoded. Rates are stored
// as percentages so the settings UI is a direct number input.
export interface Constants {
  fastighetsavgiftCap: number // kr/yr — småhus cap (indexed to inkomstbasbeloppet)
  minDownPaymentPct: number // % — minimum kontantinsats (→ max LTV 100 − this)
  lagfartPct: number // % of purchase price — stamp duty
  pantbrevPct: number // % of the new mortgage-deed amount
  ranteavdrag: { thresholdKr: number; lowPct: number; highPct: number }
  amort: {
    highLtvPct: number // LTV above this → highLtvRatePct
    midLtvPct: number // LTV above this → midLtvRatePct
    highLtvRatePct: number
    midLtvRatePct: number
    incomeMultiple: number // loan above this × gross income → +incomeSurchargePct
    incomeSurchargePct: number
  }
}

// 2026 values, verified 2026-06-27. Fastighetsavgift småhus cap = 10 425 kr for
// income year 2026 (10 074 kr for 2025); lagfart 1.5%, pantbrev 2%; ränteavdrag
// 30% up to 100 000 kr then 21%; amorteringskrav 2% >70% LTV, 1% 50–70%, +1% if
// the loan exceeds 4.5× gross household income.
export const DEFAULT_CONSTANTS: Constants = {
  fastighetsavgiftCap: 10_425,
  minDownPaymentPct: 15,
  lagfartPct: 1.5,
  pantbrevPct: 2,
  ranteavdrag: { thresholdKr: 100_000, lowPct: 30, highPct: 21 },
  amort: { highLtvPct: 70, midLtvPct: 50, highLtvRatePct: 2, midLtvRatePct: 1, incomeMultiple: 4.5, incomeSurchargePct: 1 },
}

// ── Standalone pure functions (also used by charts / previews) ──────
export function lagfart(price: number, pct: number = DEFAULT_CONSTANTS.lagfartPct): number {
  return price * (pct / 100)
}

export function pantbrevCost(
  loan: number,
  existingPantbrev: number,
  pct: number = DEFAULT_CONSTANTS.pantbrevPct,
): number {
  return Math.max(0, loan - existingPantbrev) * (pct / 100)
}

export function ranteavdrag(
  annualInterest: number,
  cfg: Constants['ranteavdrag'] = DEFAULT_CONSTANTS.ranteavdrag,
): number {
  if (annualInterest <= cfg.thresholdKr) return annualInterest * (cfg.lowPct / 100)
  return cfg.thresholdKr * (cfg.lowPct / 100) + (annualInterest - cfg.thresholdKr) * (cfg.highPct / 100)
}

export interface MortgageComparisonLeg {
  balance: number
  rate: number
  interest: number
  amortization: number
  gross: number
  relief: number
  effective: number
}

/**
 * The mortgage-only monthly figures shared by current Bolånkoll and both
 * proposed-bank legs. Relief is monthly, while its brackets are evaluated on
 * annual interest so every leg uses the same Bostadskalkyl tax assumptions.
 */
export function mortgageComparisonLeg(
  balance: number,
  rate: number,
  regularAmortization: number,
  reliefConfig: Constants['ranteavdrag'] = DEFAULT_CONSTANTS.ranteavdrag,
): MortgageComparisonLeg {
  const annualInterest = balance * rate / 100
  const interest = annualInterest / 12
  const gross = interest + regularAmortization
  const relief = ranteavdrag(annualInterest, reliefConfig) / 12
  return {
    balance,
    rate,
    interest,
    amortization: regularAmortization,
    gross,
    relief,
    effective: gross - relief,
  }
}

export type MortgageComparisonCheaper = 'current' | 'a' | 'b' | 'equal'
export interface MortgageComparisonDelta {
  amount: number
  cheaper: MortgageComparisonCheaper
}

export interface MortgageComparisonDeltas {
  currentVsA: MortgageComparisonDelta
  currentVsB: MortgageComparisonDelta
  aVsB: MortgageComparisonDelta
}

/** Signed gross-payment deltas: first leg minus second leg. */
export function mortgageComparisonDeltas(
  current: MortgageComparisonLeg,
  bankA: MortgageComparisonLeg,
  bankB: MortgageComparisonLeg,
): MortgageComparisonDeltas {
  const compare = (
    first: MortgageComparisonLeg,
    second: MortgageComparisonLeg,
    firstName: Exclude<MortgageComparisonCheaper, 'equal'>,
    secondName: Exclude<MortgageComparisonCheaper, 'equal'>,
  ): MortgageComparisonDelta => {
    const amount = first.gross - second.gross
    return { amount, cheaper: amount < 0 ? firstName : amount > 0 ? secondName : 'equal' }
  }
  return {
    currentVsA: compare(current, bankA, 'current', 'a'),
    currentVsB: compare(current, bankB, 'current', 'b'),
    aVsB: compare(bankA, bankB, 'a', 'b'),
  }
}

export function fastighetsavgiftCap(
  propertyTax: number,
  cap: number = DEFAULT_CONSTANTS.fastighetsavgiftCap,
): number {
  return Math.min(propertyTax, cap)
}

/** Statutory minimum amortisation rate (%) from LTV + the 4.5×-income surcharge. */
export function requiredAmortRate(
  ltvPct: number,
  loanAmount: number,
  grossAnnualIncome: number,
  c: Constants = DEFAULT_CONSTANTS,
): number {
  let rate = ltvPct > c.amort.highLtvPct ? c.amort.highLtvRatePct : ltvPct > c.amort.midLtvPct ? c.amort.midLtvRatePct : 0
  if (grossAnnualIncome > 0 && loanAmount > c.amort.incomeMultiple * grossAnnualIncome) {
    rate += c.amort.incomeSurchargePct
  }
  return rate
}

export function equityPct(loanAmount: number, price: number): number {
  if (price === 0) return 0
  return (loanAmount / price) * 100
}

export interface AmortPoint {
  year: number
  balance: number
}
export interface LumpPayment {
  year: number
  amount: number
}

export function buildAmortSchedule(
  startBalance: number,
  annualAmortRate: number,
  lumpPayments: LumpPayment[] = [],
  termCap = 200,
): AmortPoint[] {
  const yearlyAmort = startBalance * (annualAmortRate / 100)
  let balance = startBalance
  const points: AmortPoint[] = [{ year: 0, balance }]
  let year = 0
  while (balance > 0 && year < termCap) {
    year++
    const lump = lumpPayments
      .filter((p) => p.year === year)
      .reduce((s, p) => s + p.amount, 0)
    balance = Math.max(0, balance - yearlyAmort - lump)
    points.push({ year, balance })
    if (balance === 0) break
  }
  return points
}

// ── The input model + derived figures ──────────────────────────────
export interface Inputs {
  // Section 1 — selling the current property
  salePrice: number
  currentMortgage: number
  agentCost: number
  movingCost: number
  currentTerm: number // remaining years (used by the amort chart, Phase 5)
  currentAmortRate: number // % (used by the amort chart, Phase 5)
  // Section 2 — buying the new property
  newPrice: number
  deposit: number
  existingPantbrev: number
  // Section 3 — monthly costs
  amortRate: number
  propertyTax: number
  driftkostnad: number
  interestRateA: number
  interestRateB: number
  bankAName: string
  bankBName: string
  // Toggles
  ranteavdrag: boolean // include tax relief in the affordability figure
  affordThreshold: number // monthly cost as % of gross salary
  grossAnnualIncome: number // household gross income — drives the amort 4.5× rule
}

export interface BankFigures {
  interest: number // monthly
  amort: number // monthly
  tax: number // monthly
  drift: number // monthly
  total: number // monthly total
  annualInterest: number
  relief: number // annual ränteavdrag
  effective: number // total − relief/12
  mortgage: MortgageComparisonLeg // mortgage-only comparison, excluding tax/drift
}

export interface Figures {
  // Section 1
  totalTakeaway: number
  netProceeds: number
  // Section 2
  loanAmount: number
  lagfart: number
  newPantbrevNeeded: number
  pantbrevCost: number
  totalUpfront: number
  cashBalance: number
  ltv: number // loan / price, %
  equityShare: number // 100 − ltv, %
  depositPct: number
  // Monthly
  monthlyAmort: number
  taxMonthly: number
  bankA: BankFigures
  bankB: BankFigures
  bankDiff: number // bankA.total − bankB.total
  totalMonthly: number // = bankA.total
  relief: number // = bankA.relief (annual)
  effectiveMonthly: number // = bankA.effective
  // Affordability
  reqSalaryMonthly: number
  requiredAmortRate: number // statutory minimum amortisation rate (%)
  // Equity projection
  equity: { y5: number; y10: number; y20: number }
}

function bankFigures(
  loanAmount: number,
  ratePct: number,
  monthlyAmort: number,
  taxMonthly: number,
  drift: number,
  ravCfg: Constants['ranteavdrag'] = DEFAULT_CONSTANTS.ranteavdrag,
): BankFigures {
  const mortgage = mortgageComparisonLeg(loanAmount, ratePct, monthlyAmort, ravCfg)
  const interest = (loanAmount * (ratePct / 100)) / 12
  const total = interest + monthlyAmort + taxMonthly + drift
  const annualInterest = interest * 12
  const relief = ranteavdrag(annualInterest, ravCfg)
  return {
    interest,
    amort: monthlyAmort,
    tax: taxMonthly,
    drift,
    total,
    annualInterest,
    relief,
    effective: total - relief / 12,
    mortgage,
  }
}

/** Consolidates the legacy recalc() into one pure function. */
export function derive(i: Inputs, c: Constants = DEFAULT_CONSTANTS): Figures {
  const totalTakeaway = i.salePrice - i.currentMortgage
  const netProceeds = totalTakeaway - i.agentCost - i.movingCost

  const loanAmount = i.newPrice - i.deposit
  const lagfartAmt = lagfart(i.newPrice, c.lagfartPct)
  const newPantbrevNeeded = Math.max(0, loanAmount - i.existingPantbrev)
  const pantbrevCostAmt = pantbrevCost(loanAmount, i.existingPantbrev, c.pantbrevPct)
  const totalUpfront = i.deposit + lagfartAmt + pantbrevCostAmt
  const cashBalance = netProceeds - totalUpfront

  const ltv = equityPct(loanAmount, i.newPrice)
  const equityShare = 100 - ltv
  const depositPct = i.newPrice > 0 ? (i.deposit / i.newPrice) * 100 : 0

  const monthlyAmort = (loanAmount * (i.amortRate / 100)) / 12
  const taxMonthly = i.propertyTax / 12

  const bankA = bankFigures(loanAmount, i.interestRateA, monthlyAmort, taxMonthly, i.driftkostnad, c.ranteavdrag)
  const bankB = bankFigures(loanAmount, i.interestRateB, monthlyAmort, taxMonthly, i.driftkostnad, c.ranteavdrag)
  const totalMonthly = bankA.total
  const relief = bankA.relief
  const effectiveMonthly = bankA.effective

  const monthlyBase = i.ranteavdrag ? effectiveMonthly : totalMonthly
  const reqSalaryMonthly = i.affordThreshold > 0 ? monthlyBase / (i.affordThreshold / 100) : 0

  const annualAmort = loanAmount * (i.amortRate / 100)
  const equityAt = (yr: number) => Math.min(i.deposit + annualAmort * yr, i.newPrice)

  return {
    totalTakeaway,
    netProceeds,
    loanAmount,
    lagfart: lagfartAmt,
    newPantbrevNeeded,
    pantbrevCost: pantbrevCostAmt,
    totalUpfront,
    cashBalance,
    ltv,
    equityShare,
    depositPct,
    monthlyAmort,
    taxMonthly,
    bankA,
    bankB,
    bankDiff: bankA.total - bankB.total,
    totalMonthly,
    relief,
    effectiveMonthly,
    reqSalaryMonthly,
    requiredAmortRate: requiredAmortRate(ltv, loanAmount, i.grossAnnualIncome, c),
    equity: { y5: equityAt(5), y10: equityAt(10), y20: equityAt(20) },
  }
}

export interface StressFigures {
  monthlyInterest: number
  total: number
  afterRelief: number
}

/** Interest-rate stress test at an arbitrary rate (the slider, Phase 2/5). */
export function stressAt(i: Inputs, ratePct: number, c: Constants = DEFAULT_CONSTANTS): StressFigures {
  const loanAmount = i.newPrice - i.deposit
  const monthlyAmort = (loanAmount * (i.amortRate / 100)) / 12
  const taxMonthly = i.propertyTax / 12
  const monthlyInterest = (loanAmount * (ratePct / 100)) / 12
  const total = monthlyInterest + monthlyAmort + taxMonthly + i.driftkostnad
  const annual = loanAmount * (ratePct / 100)
  return { monthlyInterest, total, afterRelief: total - ranteavdrag(annual, c.ranteavdrag) / 12 }
}

// Default scenario — mirrors the value="" attributes in bostadskalkyl.html,
// reused as the initial form state (Phase 2) and by the golden test.
export const DEFAULT_INPUTS: Inputs = {
  salePrice: 4_500_000,
  currentMortgage: 2_000_000,
  agentCost: 120_000,
  movingCost: 20_000,
  currentTerm: 48,
  currentAmortRate: 2,
  newPrice: 6_500_000,
  deposit: 650_000,
  existingPantbrev: 2_000_000,
  amortRate: 2,
  propertyTax: 9_725,
  driftkostnad: 3_000,
  interestRateA: 3.5,
  interestRateB: 3.9,
  bankAName: 'Bank A',
  bankBName: 'Bank B',
  ranteavdrag: false,
  affordThreshold: 30,
  grossAnnualIncome: 0,
}
