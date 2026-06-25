const PBB_2026 = 59200
const IBB_2026 = 83400
const STATE_TAX_SKIKTGRANS = 643000
const STATE_TAX_RATE = 0.2
const EMPLOYER_FEE = 31.42
const SARSKILD_LONESKATT = 24.26

export const PENSION_CEILING_YR = 8.07 * IBB_2026
export const SGI_CEILING_YR = 10 * PBB_2026
export const DEFAULT_UPLIFT =
  ((1 + EMPLOYER_FEE / 100) / (1 + SARSKILD_LONESKATT / 100) - 1) * 100 // ≈ 5.76

export interface LonevaxlingInputs {
  grossSalaryMonthly: number
  sacrificeMonthly: number
  upliftPct: number
  withdrawalTaxPct: number
  municipalTaxPct: number
}

export interface LonevaxlingFlags {
  notEligible: boolean
  overSacrificed: boolean
  belowSgi: boolean
  belowBrytpunkt: boolean
  withdrawalNotBelowMarginal: boolean
}

export interface LonevaxlingResult {
  grossSalary: number
  sacrifice: number
  cashAfter: number
  netGivenUp: number
  taxSavedNow: number
  marginalRateNow: number
  premiumToPension: number
  upliftAmount: number
  netPensionValue: number
  netBenefit: number
  withdrawalRate: number
  leverage: number
  leveragePct: number
  eligible: boolean
  ceilingMonthly: number
  sgiCeilingMonthly: number
  brytpunktMonthly: number
  maxSafeSacrifice: number
  suggestedSacrifice: number
  flags: LonevaxlingFlags
}

export function defaultInputs(): LonevaxlingInputs {
  return {
    grossSalaryMonthly: 65000,
    sacrificeMonthly: 5000,
    upliftPct: 5.76,
    withdrawalTaxPct: 32,
    municipalTaxPct: 32.38,
  }
}

function grundavdrag(income: number): number {
  const ff = Math.max(0, income)
  let g: number
  if (ff <= 0.99 * PBB_2026) g = 0.423 * PBB_2026
  else if (ff <= 2.72 * PBB_2026) g = 0.423 * PBB_2026 + 0.2 * (ff - 0.99 * PBB_2026)
  else if (ff <= 3.11 * PBB_2026) g = 0.77 * PBB_2026
  else if (ff <= 7.88 * PBB_2026) g = 0.77 * PBB_2026 - 0.1 * (ff - 3.11 * PBB_2026)
  else g = 0.293 * PBB_2026
  return Math.ceil(g / 100) * 100
}

function jobbskatteavdrag(arbetsinkomst: number, ga: number, kommunalRate: number): number {
  const ai = Math.max(0, arbetsinkomst)
  const PLATEAU = 3.027
  let base: number
  if (ai <= 0.91 * PBB_2026) {
    base = ai
  } else if (ai <= 3.24 * PBB_2026) {
    base = 0.91 * PBB_2026 + 0.3874 * (ai - 0.91 * PBB_2026)
  } else if (ai <= 8.08 * PBB_2026) {
    const b2end = 0.91 * PBB_2026 + 0.3874 * (3.24 - 0.91) * PBB_2026
    const slope = (PLATEAU * PBB_2026 - b2end) / ((8.08 - 3.24) * PBB_2026)
    base = b2end + slope * (ai - 3.24 * PBB_2026)
  } else if (ai <= 13.54 * PBB_2026) {
    base = PLATEAU * PBB_2026
  } else {
    base = PLATEAU * PBB_2026 - 0.03 * (ai - 13.54 * PBB_2026)
  }
  return Math.max(0, (base - ga) * kommunalRate)
}

function netEmploymentSalary(grossAnnual: number, kommunalRate: number): { net: number } {
  const gross = Math.max(0, grossAnnual)
  const ga = grundavdrag(gross)
  const taxable = Math.max(0, gross - ga)
  const municipalTax = taxable * kommunalRate
  const stateTax = Math.max(0, taxable - STATE_TAX_SKIKTGRANS) * STATE_TAX_RATE
  const jsaRaw = jobbskatteavdrag(gross, ga, kommunalRate)
  const workTaxCredit = Math.min(jsaRaw, municipalTax + stateTax)
  return { net: gross - municipalTax - stateTax + workTaxCredit }
}

export function computeLonevaxling(input?: Partial<LonevaxlingInputs>): LonevaxlingResult {
  const d = { ...defaultInputs(), ...input }
  const kommunalRate = d.municipalTaxPct / 100

  const grossMo = Math.max(0, d.grossSalaryMonthly)
  const grossYr = grossMo * 12
  const sacrificeMo = Math.max(0, d.sacrificeMonthly)
  const sacrificeYr = Math.min(sacrificeMo * 12, grossYr)
  const cashAfterYr = grossYr - sacrificeYr
  const cashAfterMo = cashAfterYr / 12

  const before = netEmploymentSalary(grossYr, kommunalRate)
  const after = netEmploymentSalary(cashAfterYr, kommunalRate)
  const takeHomeReduction = before.net - after.net
  const taxSavedNow = sacrificeYr - takeHomeReduction
  const marginalRateNow = sacrificeYr > 0 ? taxSavedNow / sacrificeYr : 0

  const upliftPct = d.upliftPct
  const premiumToPension = sacrificeYr * (1 + upliftPct / 100)
  const upliftAmount = premiumToPension - sacrificeYr
  const withdrawalRate = d.withdrawalTaxPct / 100
  const netPensionValue = premiumToPension * (1 - withdrawalRate)
  const leverage = takeHomeReduction > 0 ? netPensionValue / takeHomeReduction : 0
  const netBenefit = sacrificeYr > 0 ? netPensionValue - takeHomeReduction : 0

  const ceilingMo = PENSION_CEILING_YR / 12
  const sgiCeilingMo = SGI_CEILING_YR / 12
  const brytpunktYr = STATE_TAX_SKIKTGRANS + grundavdrag(STATE_TAX_SKIKTGRANS)
  const brytpunktMo = brytpunktYr / 12

  const eligible = grossMo > ceilingMo
  const maxSafeSacrifice = Math.max(0, grossMo - ceilingMo)

  const EPS = 1e-6
  const flags: LonevaxlingFlags = {
    notEligible: !eligible,
    overSacrificed: eligible && cashAfterMo < ceilingMo - EPS,
    belowSgi: sacrificeYr > 0 && cashAfterMo < sgiCeilingMo - EPS,
    belowBrytpunkt: sacrificeYr > 0 && cashAfterMo < brytpunktMo - EPS,
    withdrawalNotBelowMarginal: sacrificeYr > 0 && withdrawalRate >= marginalRateNow - 1e-9,
  }

  return {
    grossSalary: grossYr,
    sacrifice: sacrificeYr,
    cashAfter: cashAfterYr,
    netGivenUp: takeHomeReduction,
    taxSavedNow,
    marginalRateNow,
    premiumToPension,
    upliftAmount,
    netPensionValue,
    netBenefit,
    withdrawalRate,
    leverage,
    leveragePct: (leverage - 1) * 100,
    eligible,
    ceilingMonthly: ceilingMo,
    sgiCeilingMonthly: sgiCeilingMo,
    brytpunktMonthly: brytpunktMo,
    maxSafeSacrifice,
    suggestedSacrifice: maxSafeSacrifice,
    flags,
  }
}
