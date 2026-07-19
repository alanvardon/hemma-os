// mortgage.ts — pure math for Bolånekoll.
// TypeScript port of mortgagetracker.js lines 22-916. No DOM dependency.

// Re-exported so Bolanekoll keeps importing it alongside the mortgage math.
import { todayISO } from './date'
export { todayISO }

function r2(n: number): number { return Math.round((Number(n) || 0) * 100) / 100 }

// ── Types ──────────────────────────────────────────────────────────────────

export interface LoanPart {
  id: string; created_at: string; label: string; loan_number: string
  start_balance: number; start_date: string; archived: boolean
  // Plan 105 — an owner-DECLARED rak amortering (kr/mån) on this part, which
  // overrides the value derived from ledger history in the forecast. null =
  // "not declared → detect". A declared 0 explicitly pins the part interest-only.
  // Optionally effective-dated: applies only from *_start (inclusive) and, when
  // set, until *_end (inclusive). Dates are text (lexicographic ISO), matching
  // the rest of the schema. Real imported `amortization` rows still outrank it.
  planned_amortization?: number | null
  planned_amortization_start?: string | null
  planned_amortization_end?: string | null
  // Plan 103 — links the part to its Mortgage (→ Bank). Null on legacy rows.
  mortgage_id?: string | null
  // Plan 103 — the explicit origination anchor, split out of the overloaded
  // start_balance / start_date. original_balance is the part's amount when the
  // agreement was signed; original_date its origination date (per-part override
  // of the mortgage's start_date, for staggered draws). Null falls back to the
  // legacy start_balance / derivation.
  original_balance?: number | null
  original_date?: string | null
}

// Plan 103 — the household's bank (billing-convention profile lands in plan
// 104). A household may use several over time; a Mortgage links to exactly one.
export interface Bank {
  id: string; created_at: string; household_id?: string; label: string
  // Plan 104 — per-bank day-count-year profile. `year_basis` is the year the
  // bank divides by when accruing the listed rate (360 = faktisk/360, 365 =
  // the Swedish default); null = detect from the ledger. `year_basis_source`
  // is the provenance: only 'declared' (an owner-confirmed lock) short-circuits
  // the forecast learner — 'detected'/'suggested'/null fall back to detection.
  year_basis?: number | null
  year_basis_source?: string | null
  // Plan 104 (Phase 2) — the bank's billing cadence. 'month-end' = the bill
  // lands on each month's last day; 'fixed' = a fixed day-of-month; null =
  // detect from the ledger (isMonthEndBilling). Only a 'declared' billing_source
  // pins the cadence; null/detected/suggested fall back to detection.
  billing?: string | null
  billing_source?: string | null
  // Plan 109a — optional link to the shared read-only bank catalogue
  // (mortgage_bank_catalog). Null = private custom bank / legacy row. The
  // catalogue label is denormalised into `label` on attach, so rendering never
  // depends on a catalogue fetch.
  catalog_id?: string | null
}

// Plan 104 — the closed sets a bank profile clamps to. Kept beside the type so
// the normaliser and any future provenance UI share one source of truth.
export const YEAR_BASES = [360, 365] as const
export const YEAR_BASIS_SOURCES = ['detected', 'suggested', 'declared'] as const
export const BILLING_MODES = ['month-end', 'fixed'] as const
export const BILLING_SOURCES = YEAR_BASIS_SOURCES

// Normalise a Bank record: default the profile columns to null, clamp
// `year_basis` to exactly 360 | 365 (anything else → null → detection),
// `billing` to the allowed cadence set, and each `*_source` to the allowed
// provenance set (else null). A malformed profile therefore reads as "no lock"
// and the forecast falls back to detection, never to a garbage convention.
export function makeBank(b: Partial<Bank>): Omit<Bank, 'id' | 'created_at'> {
  const yb = Number(b.year_basis)
  const year_basis = yb === 360 ? 360 : yb === 365 ? 365 : null
  const inSet = (v: unknown, set: readonly string[]): string | null =>
    typeof v === 'string' && set.includes(v) ? v : null
  return {
    label: b.label || '', year_basis,
    year_basis_source: inSet(b.year_basis_source, YEAR_BASIS_SOURCES),
    billing: inSet(b.billing, BILLING_MODES),
    billing_source: inSet(b.billing_source, BILLING_SOURCES),
    catalog_id: typeof b.catalog_id === 'string' && b.catalog_id ? b.catalog_id : null,
  }
}

// Plan 103 — one bolån agreement, linked to exactly one Bank, holding many
// Lånedelar. "Change bank" creates a new Mortgage (a refinance is a new
// agreement); the old one is retained as history.
export interface Mortgage {
  id: string; created_at: string; household_id?: string
  bank_id: string | null; label: string; start_date: string | null; archived: boolean
  // Plan 109a — the agreement's explicit end state. The database keeps it
  // consistent with `archived` ((end_date is null) = (not archived)); '' is the
  // preserved "unknown legacy close date" marker on pre-109a archived rows.
  end_date?: string | null
}

export type PaymentKind = 'interest' | 'amortization' | 'payment' | 'down_payment' | 'loan' | 'fee' | 'other'
export type Owner = 'a' | 'b'
export type PaidBy = Owner | 'joint'

export interface RatePeriod {
  id: string; created_at: string; loan_part_id: string | null
  start_date: string; end_date: string | null; rate: number | null
  rate_type: 'rörlig' | 'bunden'
}

export interface Payment {
  id: string; created_at: string; loan_part_id: string | null
  date: string; kind: PaymentKind; description: string; amount: number
  balance_after: number | null; paid_by: PaidBy; source: string
  // Marks an extra amortering ("insats") — purely a label; debt & amortised
  // already move via the ledger, so this never changes any math.
  is_insats?: boolean
  // Per-owner funding of THIS one payment, when a single line was co-funded in
  // unequal amounts. When set, it overrides paid_by for contribution attribution.
  paid_split?: { a: number; b: number } | null
  // Plan 109a — agreement provenance. Part-linked rows derive it from their
  // loan part in the database (a mismatching supplied value is rejected); new
  // partless down payments require it; legacy rows keep null until repaired.
  mortgage_id?: string | null
}

export interface Valuation {
  id: string; created_at: string; date: string; value: number; note: string
  // Flags this valuation as the original purchase price (köpeskilling) — the
  // anchor for cost-basis equity. At most one valuation carries it.
  is_purchase?: boolean
}

export interface Contribution {
  id: string; created_at: string; owner: PaidBy; date: string; amount: number; note: string
}

// Legacy contribution rows are retained in their old table for audit, but the
// application consumes one canonical mortgage_payments row. The reserved
// prefix is shared with the SQL data migration, making conversion deterministic
// across cloud, cache and backup imports.
export const LEGACY_CONTRIBUTION_PAYMENT_PREFIX = 'legacy-contribution:'

export function legacyContributionPayment(contribution: Partial<Contribution>): Payment | null {
  const id = typeof contribution.id === 'string' ? contribution.id.trim() : ''
  const amount = Number(contribution.amount)
  const owner = contribution.owner
  if (!id || !validLedgerDate(contribution.date) || !isFinite(amount) || amount <= 0 || (owner !== 'a' && owner !== 'b' && owner !== 'joint')) return null
  const canonicalId = LEGACY_CONTRIBUTION_PAYMENT_PREFIX + id
  return {
    id: canonicalId,
    created_at: typeof contribution.created_at === 'string' ? contribution.created_at : '',
    loan_part_id: null,
    date: contribution.date,
    kind: 'down_payment',
    description: typeof contribution.note === 'string' ? contribution.note : '',
    amount: r2(amount),
    balance_after: null,
    paid_by: owner,
    source: canonicalId,
    is_insats: true,
    paid_split: null,
  }
}

export interface MortgageSettings {
  property_name: string; owner_a_name: string; owner_b_name: string
  my_ownership_pct: number; i_am: Owner; currency: string; ranteavdrag: boolean
  household_income_yearly: number | null; import_presets: Record<string, ColNameMapping>
  track_contributions: boolean
  // A household-wide, explicitly hypothetical interest-rate assumption for the
  // what-if card. Null means follow the live blended mortgage rate.
  what_if_rate_pct: number | null
}

export interface CsvResult { delimiter: string; headers: string[]; rows: string[][] }

export interface ColMapping {
  date: number | null; specification: number | null; amount: number | null
  balance: number | null; loan_number: number | null
}

export interface ColNameMapping {
  date: string | null; specification: string | null; amount: string | null
  balance: string | null; loan_number: string | null
}

// ── Settings ───────────────────────────────────────────────────────────────

export function defaultSettings(): MortgageSettings {
  return {
    property_name: '', owner_a_name: 'Alex', owner_b_name: 'Sam',
    my_ownership_pct: 50, i_am: 'a', currency: 'SEK', ranteavdrag: true,
    household_income_yearly: null, import_presets: {}, track_contributions: false,
    what_if_rate_pct: null,
  }
}

export function otherOwner(p: Owner): Owner { return p === 'a' ? 'b' : 'a' }

// ── CSV parsing ────────────────────────────────────────────────────────────

function detectDelimiter(text: string): string {
  const line = String(text || '').split(/\r?\n/)[0] || ''
  let best = ',', bestCount = -1
  for (const d of [',', ';', '\t']) {
    const n = line.split(d).length - 1
    if (n > bestCount) { bestCount = n; best = d }
  }
  return best
}

export function parseCsv(text: string | null, opts?: { delimiter?: string }): CsvResult {
  if (text == null) return { delimiter: ',', headers: [], rows: [] }
  let s = String(text)
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1)
  const delim = opts?.delimiter || detectDelimiter(s)
  const all: string[][] = []
  let field = '', row: string[] = [], inQ = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++ } else inQ = false }
      else field += c
      continue
    }
    if (c === '"') inQ = true
    else if (c === delim) { row.push(field); field = '' }
    else if (c === '\r') { /* swallow */ }
    else if (c === '\n') { row.push(field); all.push(row); field = ''; row = [] }
    else field += c
  }
  row.push(field); all.push(row)
  const rows = all.filter(r => !(r.length === 1 && r[0].trim() === ''))
  return { delimiter: delim, headers: rows.length ? rows[0] : [], rows: rows.slice(1) }
}

export function parseAmount(raw: string | null | undefined): number {
  if (raw == null) return NaN
  let s = String(raw).trim()
  if (!s) return NaN
  let neg = false
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1) }
  s = s.replace(/−/g, '-')
  if (s.indexOf('-') !== -1) neg = true
  s = s.replace(/[^0-9.,]/g, '')
  if (!s) return NaN
  const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.')
  const dec = lc > ld ? ',' : (ld > -1 ? '.' : '')
  if (dec) { s = s.split(dec === ',' ? '.' : ',').join('').replace(dec, '.') }
  const n = parseFloat(s)
  return isNaN(n) ? NaN : (neg ? -n : n)
}

export function autoMapColumns(headers: string[]): ColMapping {
  const H = (headers || []).map(h => String(h ?? '').toLowerCase().trim())
  function find(re: RegExp, avoid?: RegExp): number | null {
    for (let i = 0; i < H.length; i++)
      if (re.test(H[i]) && !(avoid && avoid.test(H[i]))) return i
    return null
  }
  return {
    date: find(/(date|datum|bokf|transaktionsdat|betald|betalningsdag)/),
    specification: find(/(specifikation|transaktionstyp|\btyp\b|type|kind|slag|text|beskriv|händelse|handelse)/),
    amount: find(/(belopp|amount|summa|transaktionsbelopp|debet|kredit)/, /(saldo|balance)/),
    balance: find(/(saldo|kvar|restskuld|aktuell skuld|balance|återstå|aterstå)/),
    loan_number: find(/(lånenummer|lanenummer|lånenr|lanenr|kontonummer|account)/),
  }
}

// The bank's per-part "Betalning" line is the TOTAL debited for the part —
// ränta included — so it stays kind 'payment' (an account movement, never
// principal). The part's amortering is derived downstream as the paired
// difference betalning − ränta within the month; classifying betalning as
// amortization would invent principal on interest-only parts whose betalning
// merely equals the ränta.
export function classifyKind(text: string | null | undefined): PaymentKind {
  const s = String(text ?? '').toLowerCase()
  if (/ränta|ranta|interest/.test(s)) return 'interest'
  if (/amorter|amort|principal|avbetal/.test(s)) return 'amortization'
  if (/betalning|payment|inbet|överför|overfor|insättning|insattning/.test(s)) return 'payment'
  if (/\blån\b|\blan\b|utbetalning|disburs|loan|uttag|nyutl/.test(s)) return 'loan'
  if (/avgift|fee|aviavgift/.test(s)) return 'fee'
  return 'other'
}

export function normPaidBy(v: unknown): PaidBy {
  return v === 'a' ? 'a' : v === 'b' ? 'b' : 'joint'
}

// A declared amortering is a non-negative krona amount or null. Empty string,
// null/undefined, NaN and negative values all normalise to null ("not declared
// → detect"); 0 is a valid declaration (interest-only) and is preserved.
function normPlannedAmortization(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return isFinite(n) && n >= 0 ? r2(n) : null
}

export function makeLoanPart(p: Partial<LoanPart>): Omit<LoanPart, 'id' | 'created_at'> {
  // original_balance is the origination anchor: clamp to ≥ 0, and ignore a
  // NaN/negative value (falls back to start_balance / derivation downstream).
  const ob = Number(p.original_balance)
  const original_balance = (p.original_balance == null || !isFinite(ob) || ob < 0) ? null : r2(ob)
  return {
    label: p.label || '', loan_number: p.loan_number || '',
    start_balance: r2(Number(p.start_balance) || 0),
    start_date: p.start_date || '', archived: !!p.archived,
    planned_amortization: normPlannedAmortization(p.planned_amortization),
    planned_amortization_start: (p.planned_amortization_start == null || p.planned_amortization_start === '') ? null : String(p.planned_amortization_start),
    planned_amortization_end: (p.planned_amortization_end == null || p.planned_amortization_end === '') ? null : String(p.planned_amortization_end),
    mortgage_id: p.mortgage_id || null,
    original_balance,
    original_date: p.original_date || null,
  }
}

export function makeRatePeriod(p: Partial<RatePeriod>): Omit<RatePeriod, 'id' | 'created_at'> {
  return {
    loan_part_id: p.loan_part_id || null,
    start_date: p.start_date || '',
    end_date: (p.end_date == null || p.end_date === '') ? null : String(p.end_date),
    rate: (p.rate == null || (p.rate as unknown) === '') ? null : Number(p.rate),
    rate_type: p.rate_type === 'bunden' ? 'bunden' : 'rörlig',
  }
}

export function makePayment(p: Partial<Payment> & { specification?: string }): Omit<Payment, 'id' | 'created_at'> {
  const kind = p.kind || classifyKind(p.description || p.specification || '')
  const bal = p.balance_after
  const isJoint = kind === 'payment' || kind === 'interest'
  const isDownPayment = kind === 'down_payment'
  return {
    loan_part_id: isDownPayment ? null : (p.loan_part_id || null), date: p.date || '', kind,
    description: p.description || '', amount: r2(Math.abs(Number(p.amount) || 0)),
    balance_after: (bal == null || (bal as unknown) === '') ? null : r2(Math.abs(Number(bal) || 0)),
    paid_by: isJoint ? 'joint' : normPaidBy(p.paid_by), source: p.source || 'manual', is_insats: isDownPayment || !!p.is_insats,
    paid_split: isJoint ? null : p.paid_split ? { a: r2(Math.abs(Number(p.paid_split.a) || 0)), b: r2(Math.abs(Number(p.paid_split.b) || 0)) } : null,
  }
}

// ── Duplicate detection ────────────────────────────────────────────────────

function paymentFingerprint(p: Partial<Payment>): string {
  return String(p.date ?? '').trim() + '|' + (p.loan_part_id || '') + '|' +
    (p.kind || '') + '|' + r2(Number(p.amount) || 0)
}

export function flagDuplicates(existing: Partial<Payment>[], candidates: Partial<Payment>[]): boolean[] {
  const counts: Record<string, number> = {}
  for (const p of existing || []) {
    if (!p) continue
    const k = paymentFingerprint(p)
    counts[k] = (counts[k] || 0) + 1
  }
  return (candidates || []).map(c => {
    if (!c) return false
    const k = paymentFingerprint(c)
    if (counts[k] > 0) { counts[k]--; return true }
    return false
  })
}

export function assignPaymentsToPart(
  loanNumbers: (string | null | undefined)[],
  parts: LoanPart[],
  opts?: { selectedPartId?: string | null; auto?: boolean }
): Array<{ loan_part_id: string | null; matched: boolean }> {
  const fallback = opts?.selectedPartId || null
  const byNumber: Record<string, string> = {}
  for (const p of parts || [])
    if (p?.loan_number) byNumber[p.loan_number.toLowerCase().replace(/[\s-]/g, '')] = p.id
  return (loanNumbers || []).map(raw => {
    if (opts?.auto && raw != null && String(raw).trim()) {
      const hit = byNumber[String(raw).toLowerCase().replace(/[\s-]/g, '')]
      if (hit) return { loan_part_id: hit, matched: true }
    }
    return { loan_part_id: fallback, matched: false }
  })
}

// ── Mortgage math ──────────────────────────────────────────────────────────

export type BalanceWarning = 'missing-interest' | 'interest-exceeds-payment' | 'conflicting-saldo'

export interface BalanceResolution {
  balance: number
  /** Principal applied after the active Saldo/origination anchor. */
  principalPaid: number
  anchor: { date: string; balance: number; source: 'saldo' | 'origination' }
  quality: 'observed' | 'estimated'
  warnings: BalanceWarning[]
}

function validLedgerDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return false
  const y = Number(m[1]), month = Number(m[2]), day = Number(m[3])
  const date = new Date(Date.UTC(y, month - 1, day))
  return date.getUTCFullYear() === y && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function positiveLedgerAmount(value: unknown): number | null {
  const amount = Number(value)
  return isFinite(amount) && amount > 0 ? r2(amount) : null
}

interface InferredPaymentPrincipal {
  principal: number
  missingInterest: boolean
  interestExceedsPayment: boolean
}

/**
 * Infer Betalning principal per loan part and calendar month. This is shared by
 * the balance resolver and ownership attribution so they can never disagree on
 * how much of the bank debit was principal.
 */
function inferredPaymentPrincipal(payments: Payment[]): InferredPaymentPrincipal {
  const groups = new Map<string, { payment: number; interest: number; interestRows: number }>()
  for (const row of payments || []) {
    if (!row?.loan_part_id || !validLedgerDate(row.date)) continue
    if (row.kind !== 'payment' && row.kind !== 'interest') continue
    const key = row.loan_part_id + '|' + monthKey(row.date)
    const group = groups.get(key) ?? { payment: 0, interest: 0, interestRows: 0 }
    if (row.kind === 'payment') {
      const amount = positiveLedgerAmount(row.amount)
      if (amount == null) continue
      group.payment += amount
    } else {
      const amount = Number(row.amount)
      if (!isFinite(amount) || amount < 0) continue
      // A recorded zero-interest month is still an observed Ränta row and
      // deliberately clears the missing-interest estimate.
      group.interest += r2(amount)
      group.interestRows++
    }
    groups.set(key, group)
  }

  let principal = 0, missingInterest = false, interestExceedsPayment = false
  for (const group of groups.values()) {
    if (group.payment <= 0) continue
    if (group.interestRows === 0) {
      principal += group.payment
      missingInterest = true
    } else if (group.interest > group.payment) {
      interestExceedsPayment = true
    } else {
      principal += group.payment - group.interest
    }
  }
  return { principal: r2(principal), missingInterest, interestExceedsPayment }
}

/**
 * Resolve one loan part from a single chronological principal ledger.
 *
 * Saldo is a post-transaction snapshot: the latest valid one at/before `asOf`
 * becomes the anchor. A prediction explicitly accepted into Betalningar is an
 * authoritative ledger row despite retaining source:'predicted' for later
 * reconciliation. A separately recorded amortering created after that accepted
 * anchor remains additive even when its transaction date is earlier. Without
 * Saldo, the explicit origination/start balance is the anchor.
 */
export function resolvePartBalance(part: LoanPart, payments: Payment[], asOf?: string): BalanceResolution {
  const originalBalanceRaw = part?.original_balance
  const originalBalance = originalBalanceRaw != null && isFinite(Number(originalBalanceRaw)) && Number(originalBalanceRaw) >= 0
    ? r2(Number(originalBalanceRaw))
    : isFinite(Number(part?.start_balance)) && Number(part?.start_balance) >= 0
      ? r2(Number(part.start_balance))
      : 0
  const originalDate = validLedgerDate(part?.original_date) ? part.original_date!
    : validLedgerDate(part?.start_date) ? part.start_date : ''

  const mine = (payments || []).filter(row =>
    row?.loan_part_id === part?.id && validLedgerDate(row.date) && (!asOf || row.date <= asOf))
  const saldos = mine.filter(row => {
    if (row.balance_after == null) return false
    const balance = Number(row.balance_after)
    return isFinite(balance) && balance >= 0
  })

  let anchor: BalanceResolution['anchor'] = {
    date: originalDate,
    balance: originalBalance,
    source: 'origination',
  }
  let anchorCreatedAt = ''
  let conflictingSaldo = false
  if (saldos.length) {
    const date = saldos.reduce((latest, row) => row.date > latest ? row.date : latest, '')
    const balances = saldos.filter(row => row.date === date).map(row => r2(Number(row.balance_after)))
    anchor = { date, balance: Math.min(...balances), source: 'saldo' }
    anchorCreatedAt = saldos
      .filter(row => row.date === date && r2(Number(row.balance_after)) === anchor.balance)
      .reduce((latest, row) => row.created_at > latest ? row.created_at : latest, '')
    conflictingSaldo = new Set(balances).size > 1
  }

  const later = mine.filter(row => row.date > anchor.date || (
    row.kind === 'amortization' && row.balance_after == null && (
      (row.date === anchor.date && row.is_insats === true) ||
      (!!anchorCreatedAt && row.created_at > anchorCreatedAt)
    )
  ))
  const explicitPrincipal = later.reduce((sum, row) => {
    if (row.kind !== 'amortization') return sum
    return sum + (positiveLedgerAmount(row.amount) ?? 0)
  }, 0)
  const inferred = inferredPaymentPrincipal(later)
  const attemptedPrincipal = r2(explicitPrincipal + inferred.principal)
  const principalPaid = Math.min(anchor.balance, attemptedPrincipal)

  const warnings: BalanceWarning[] = []
  if (inferred.missingInterest) warnings.push('missing-interest')
  if (inferred.interestExceedsPayment) warnings.push('interest-exceeds-payment')
  if (conflictingSaldo) warnings.push('conflicting-saldo')
  return {
    balance: Math.max(0, r2(anchor.balance - attemptedPrincipal)),
    principalPaid: r2(principalPaid),
    anchor,
    quality: warnings.length ? 'estimated' : 'observed',
    warnings,
  }
}

export function partBalance(part: LoanPart, payments: Payment[]): number {
  return part ? resolvePartBalance(part, payments).balance : 0
}

function partOriginal(part: LoanPart, payments: Payment[]): number {
  // Origination anchor — the part's amount when the agreement was signed (plan
  // 103). Prefer the explicit original_balance; fall back to the legacy
  // start_balance, then to the loan-row / earliest-Saldo derivation.
  if (Number(part?.original_balance) > 0) return r2(Number(part.original_balance))
  if (Number(part?.start_balance) > 0) return r2(Number(part.start_balance))
  const mine = payments.filter(p => p?.loan_part_id === part?.id && p.source !== 'predicted')
  const loans = mine.filter(p => p.kind === 'loan')
  if (loans.length) return r2(Math.max(...loans.map(p => Number(p.amount) || 0)))
  const wb = mine.filter(p => p.balance_after != null)
  if (wb.length) {
    const earliest = wb.reduce((mn: string | null, p) => {
      const d = String(p.date); return mn == null || d < mn ? d : mn
    }, null) as string
    return r2(Math.max(...wb.filter(p => String(p.date) === earliest).map(p => Number(p.balance_after) || 0)))
  }
  return partBalance(part, payments)
}

function partAmortized(part: LoanPart, payments: Payment[]): number {
  return Math.max(0, r2(partOriginal(part, payments) - partBalance(part, payments)))
}

export function totalBalance(parts: LoanPart[], payments: Payment[]): number {
  return r2(parts.filter(p => p && !p.archived).reduce((s, p) => s + partBalance(p, payments), 0))
}
export function totalAmortized(parts: LoanPart[], payments: Payment[]): number {
  return r2(parts.filter(p => p && !p.archived).reduce((s, p) => s + partAmortized(p, payments), 0))
}

export function totalInterest(payments: Payment[], opts?: { loan_part_id?: string; from?: string; to?: string }): number {
  return r2(payments.filter(p => p?.kind === 'interest' &&
    !(opts?.loan_part_id && p.loan_part_id !== opts.loan_part_id) &&
    !(opts?.from && p.date && p.date < opts.from) &&
    !(opts?.to && p.date && p.date > opts.to)
  ).reduce((s, p) => s + (Number(p.amount) || 0), 0))
}

export function ranteavdrag(annual: number): number {
  const n = Number(annual) || 0
  if (n <= 0) return 0
  return r2(Math.min(n, 100000) * 0.30 + Math.max(0, n - 100000) * 0.21)
}

export function propertyValue(valuations: Valuation[], asOf?: string): number {
  let best: Valuation | null = null
  for (const v of valuations || []) {
    if (!v?.date) continue
    if (asOf && v.date > asOf) continue
    if (!best || v.date > best.date) best = v
  }
  return best ? (Number(best.value) || 0) : 0
}

export function equity(value: number, balance: number): number { return r2(value - balance) }
export function loanToValue(balance: number, value: number): number {
  if (!value) return 0
  return r2(balance / value * 100)
}

// ── Cost-basis equity (köpeskilling, not market value) ───────────────────────
// "Market equity" above uses the latest valuation, so it includes paper gains.
// Cost-basis equity is valuation-independent: how much of the home you've
// actually funded, measured against the original purchase price.

// The single valuation flagged as the original purchase price, if any.
export function purchaseValuation(valuations: Valuation[]): Valuation | null {
  for (const v of valuations || []) if (v?.is_purchase) return v
  return null
}
export function purchasePrice(valuations: Valuation[]): number {
  const v = purchaseValuation(valuations)
  return v ? (Number(v.value) || 0) : 0
}

// Cost-basis equity = purchase price − current debt  (≡ deposit + amortised).
// Extra payments need no special handling: they lower the debt, so this rises.
export function costBasisEquity(price: number, balance: number): number {
  if (!price) return 0
  return r2(price - balance)
}
// Share of the home funded so far, as a % of the original purchase price.
export function costBasisOwnedPct(price: number, balance: number): number {
  if (!price) return 0
  return r2((price - balance) / price * 100)
}
// Implied kontantinsats = purchase price − the original loans. A sanity figure;
// can read low if a part's start balance is mid-loan rather than at purchase.
export function derivedDeposit(price: number, parts: LoanPart[], payments: Payment[]): number {
  if (!price) return 0
  const orig = (parts || []).filter(p => p && !p.archived).reduce((s, p) => s + partOriginal(p, payments), 0)
  return r2(price - orig)
}
export interface OwnerCapitalSplit { a: number; b: number; a_pct: number; b_pct: number }

/**
 * Direct capital accounts.
 *
 * Attributed payments remain with the person who funded them. Any equity for
 * which the ledger has no attributable source (legacy opening equity, joint
 * value growth, or an incomplete history) follows the configured ownership
 * target. A new personal amortering therefore adds to that owner without
 * redistributing capital already earned by the other owner.
 */
function directCapitalSplit(totalEquity: number, payments: Payment[], contributions: Contribution[], s: Partial<MortgageSettings>): OwnerCapitalSplit {
  const known = contributionSplit(payments, contributions, s)
  const target = ownerPercents(s)
  if (!totalEquity) return { a: 0, b: 0, a_pct: target.a, b_pct: target.b }
  const residual = r2(totalEquity - known.total)
  const a = r2(known.a + residual * target.a / 100)
  const b = r2(totalEquity - a)
  return {
    a, b,
    a_pct: totalEquity ? r2(a / totalEquity * 100) : target.a,
    b_pct: totalEquity ? r2(b / totalEquity * 100) : target.b,
  }
}

export function costBasisSplit(price: number, balance: number, payments: Payment[], contributions: Contribution[], s: Partial<MortgageSettings>): { a: number; b: number; a_pct: number; b_pct: number } {
  return directCapitalSplit(costBasisEquity(price, balance), payments, contributions, s)
}

export function marketEquitySplit(value: number, balance: number, payments: Payment[], contributions: Contribution[], s: Partial<MortgageSettings>): OwnerCapitalSplit {
  return directCapitalSplit(equity(value, balance), payments, contributions, s)
}
// Payments flagged as insatser (extra amorteringar) — for the Insatser card.
export function insatsPayments(payments: Payment[]): Payment[] {
  return (payments || []).filter(p => p?.is_insats)
}

function clamp(pct: number, dflt = 50): number {
  const p = Number(pct); return isFinite(p) ? Math.max(0, Math.min(100, p)) : dflt
}

function ownerPercents(s: Partial<MortgageSettings>): { a: number; b: number } {
  const me = s.i_am === 'b' ? 'b' : 'a', pct = clamp(s.my_ownership_pct ?? 50)
  const res = { a: 0, b: 0 }
  res[me] = pct; res[otherOwner(me)] = r2(100 - pct)
  return res
}

// ── Month helpers ──────────────────────────────────────────────────────────

export function monthKey(d: string | null | undefined): string {
  const s = String(d ?? '').trim()
  let m = /(\d{4})[-/](\d{2})/.exec(s)
  if (m) return m[1] + '-' + m[2]
  m = /(\d{2})[./](\d{2})[./](\d{4})/.exec(s)
  return m ? m[3] + '-' + m[2] : ''
}

export function monthLabel(mk: string): string {
  if (!mk) return 'Utan datum'
  const m = /^(\d{4})-(\d{2})$/.exec(mk)
  if (!m) return mk
  try {
    const s = new Date(+m[1], +m[2] - 1, 1).toLocaleDateString('sv-SE', { month: 'long', year: 'numeric' })
    return s[0].toUpperCase() + s.slice(1)
  } catch { return mk }
}

function enumMonths(a: string, b: string): string[] {
  const out: string[] = []
  let y = +a.slice(0, 4), mo = +a.slice(5, 7), g = 0
  const ey = +b.slice(0, 4), em = +b.slice(5, 7)
  while ((y < ey || (y === ey && mo <= em)) && g < 1200) {
    out.push(y + '-' + String(mo).padStart(2, '0')); mo++; if (mo > 12) { mo = 1; y++ }; g++
  }
  return out
}

function mRange(parts: LoanPart[], payments: Payment[]): string[] {
  const keys = [
    ...parts.map(p => {
      const date = p?.original_date || p?.start_date
      return validLedgerDate(date) ? monthKey(date) : ''
    }),
    ...payments.map(p => p?.source !== 'predicted' && validLedgerDate(p?.date) ? monthKey(p.date) : ''),
  ].filter(Boolean).sort() as string[]
  return keys.length ? enumMonths(keys[0], keys[keys.length - 1]) : []
}

function partBalAsOfMk(part: LoanPart, payments: Payment[], mk: string): number {
  // Day 31 is a deliberate lexical month-end sentinel; the resolver validates
  // ledger row dates, not this inclusive upper bound.
  return resolvePartBalance(part, payments, mk + '-31').balance
}

export function balanceTimeline(parts: LoanPart[], payments: Payment[]) {
  const active = parts.filter(p => p && !p.archived)
  return mRange(active, payments).map(mk => ({
    month: mk, label: monthLabel(mk),
    balance: r2(active.reduce((s, p) => s + partBalAsOfMk(p, payments, mk), 0)),
  }))
}

export interface ETEntry {
  month: string; label: string; value: number; balance: number; bank: number
  equity: number; my_equity: number; a_equity: number; b_equity: number; partner_equity: number
}

export function equityTimeline(
  parts: LoanPart[], payments: Payment[], valuations: Valuation[], s: Partial<MortgageSettings>, contributions: Contribution[] = []
): ETEntry[] {
  return balanceTimeline(parts, payments).map(row => {
    const monthEnd = row.month + '-31'
    const value = propertyValue(valuations, monthEnd)
    const eq = r2(value - row.balance)
    const split = marketEquitySplit(
      value,
      row.balance,
      payments.filter(payment => payment.date <= monthEnd),
      contributions.filter(contribution => contribution.date <= monthEnd),
      s,
    )
    return {
      month: row.month, label: row.label, value, balance: row.balance, bank: row.balance,
      equity: eq,
      my_equity: s.i_am === 'b' ? split.b : split.a,
      a_equity: split.a,
      b_equity: split.b,
      partner_equity: s.i_am === 'b' ? split.a : split.b,
    }
  })
}

// ── Date helpers ───────────────────────────────────────────────────────────

function daysBetween(a: string, b: string): number | null {
  const da = new Date(a + 'T00:00:00'), db = new Date(b + 'T00:00:00')
  if (isNaN(da.getTime()) || isNaN(db.getTime())) return null
  return Math.round((db.getTime() - da.getTime()) / 86400000)
}

// ── Balance as-of date ─────────────────────────────────────────────────────

function partBalanceAsOf(part: LoanPart, payments: Payment[], asOf?: string): number {
  return part ? resolvePartBalance(part, payments, asOf).balance : 0
}

function totalBalanceAsOf(parts: LoanPart[], payments: Payment[], asOf?: string): number {
  return r2(parts.filter(p => p && !p.archived).reduce((s, p) => s + partBalanceAsOf(p, payments, asOf), 0))
}

// ── Equity bridge ──────────────────────────────────────────────────────────

export function equityBridge(parts: LoanPart[], payments: Payment[], valuations: Valuation[], from: string, to: string) {
  const bf = totalBalanceAsOf(parts, payments, from), bt = totalBalanceAsOf(parts, payments, to)
  const vf = propertyValue(valuations, from), vt = propertyValue(valuations, to)
  return {
    from, to, start_value: r2(vf), end_value: r2(vt), start_balance: bf, end_balance: bt,
    start_equity: r2(vf - bf), end_equity: r2(vt - bt),
    amortization_gain: r2(bf - bt), appreciation_gain: r2(vt - vf), total_gain: r2((vt - bt) - (vf - bf)),
  }
}

// ── Projection ─────────────────────────────────────────────────────────────

export function monthlyAmortizationRate(parts: LoanPart[], payments: Payment[]): number {
  const tl = balanceTimeline(parts, payments)
  if (tl.length < 2) return 0
  const drop = tl[0].balance - tl[tl.length - 1].balance
  return drop > 0 ? r2(drop / (tl.length - 1)) : 0
}

// Plan 105 — the owner-declared rak amortering (kr/mån) effective on `part` at
// `asOf`, or null when nothing is declared (→ fall back to detection). Defends
// against unnormalised cloud rows: a non-finite or negative stored value is
// treated as "not declared". A declared 0 is authoritative and returned as 0.
// The optional start/end bound the plan: before start, or after end, it does
// not apply (null), so a future-dated change never rewrites the current charge.
export function effectiveDeclaredAmortization(part: LoanPart | null | undefined, asOf?: string): number | null {
  const raw = part?.planned_amortization
  if (raw == null || (raw as unknown) === '') return null
  const v = Number(raw)
  if (!isFinite(v) || v < 0) return null
  if (asOf != null) {
    const s = part?.planned_amortization_start
    const e = part?.planned_amortization_end
    if (s && asOf < s) return null
    if (e && asOf > e) return null
  }
  return r2(v)
}

// Plan 105 — the summed declared amortering across the active parts, or null
// when NO part declares one (so the aggregate projection falls back to the
// existing timeline detection and undeclared behaviour is byte-for-byte
// unchanged). Parts without a declaration contribute nothing; the household's
// interest-only flats declare 0 and correctly add nothing.
export function declaredMonthlyAmortization(parts: LoanPart[], asOf?: string): number | null {
  const active = (parts || []).filter(p => p && !p.archived)
  const declared = active.map(p => effectiveDeclaredAmortization(p, asOf))
  if (!declared.some(v => v != null)) return null
  return r2(declared.reduce((s: number, v) => s + (v ?? 0), 0))
}

function projectBalance(
  parts: LoanPart[], payments: Payment[],
  opts?: { startBalance?: number; monthlyAmortization?: number; extraMonthly?: number; maxMonths?: number }
) {
  const balance = opts?.startBalance ?? totalBalance(parts, payments)
  const base = opts?.monthlyAmortization ?? declaredMonthlyAmortization(parts, todayISO()) ?? monthlyAmortizationRate(parts, payments)
  const per = r2((Number(base) || 0) + (Number(opts?.extraMonthly) || 0))
  const horizon = opts?.maxMonths || 1200
  if (per <= 0) return { flat: true, per_month: per, months: null as number | null, start_balance: r2(balance), schedule: [] as Array<{ month_index: number; balance: number }> }
  const sched: Array<{ month_index: number; balance: number }> = []
  let b = balance, m = 0
  while (b > 0 && m < horizon) { b = r2(b - per); m++; if (b < 0) b = 0; sched.push({ month_index: m, balance: b }) }
  return { flat: false, per_month: per, months: b <= 0 ? m : null as number | null, start_balance: r2(balance), schedule: sched }
}

export function projectMilestones(parts: LoanPart[], payments: Payment[], valuations: Valuation[], _s: Partial<MortgageSettings>, opts?: Parameters<typeof projectBalance>[2]) {
  const value = propertyValue(valuations), proj = projectBalance(parts, payments, opts)
  function toL(tgt: number): number | null {
    if (!value) return null
    if (proj.start_balance <= value * tgt / 100) return 0
    if (proj.flat) return null
    return proj.schedule.find(s => s.balance <= value * tgt / 100)?.month_index ?? null
  }
  return { flat: proj.flat, per_month: proj.per_month, payoff_months: proj.flat ? null : proj.months, ltv70_months: toL(70), ltv50_months: toL(50), current_ltv: loanToValue(proj.start_balance, value) }
}

// ── Monthly cost ───────────────────────────────────────────────────────────

export function monthlyCost(payments: Payment[], opts?: { ranteavdrag?: boolean }) {
  const withDed = opts?.ranteavdrag !== false
  const byMk: Record<string, { interest: number; amortization: number }> = {}
  for (const p of payments || []) {
    const mk = monthKey(p?.date); if (!mk) continue
    if (!byMk[mk]) byMk[mk] = { interest: 0, amortization: 0 }
    if (p.kind === 'interest') byMk[mk].interest += Number(p.amount) || 0
    else if (p.kind === 'amortization') byMk[mk].amortization += Number(p.amount) || 0
  }
  return Object.keys(byMk).sort().map(mk => {
    const { interest, amortization } = byMk[mk]
    const gross = r2(interest + amortization), ded = withDed ? ranteavdrag(interest) : 0
    return { month: mk, label: monthLabel(mk), interest: r2(interest), amortization: r2(amortization), gross, deduction: ded, net: r2(gross - ded) }
  })
}

// ── Rate what-if ─────────────────────────────────────────────────────────────
// "What would I pay per month at rate X instead of today's blended rate?"
// Both legs are COMPUTED with the same formula (balance × rate/100 / 12 + the
// observed monthly amortization) so the delta is a pure rate effect — this is a
// hypothetical applied to the whole balance, not a forecast (bunden lock-ins
// are deliberately ignored; see plan 82).
export interface RateWhatIf {
  balance: number
  amortization: number   // observed monthly amortization (rate-independent)
  base_rate: number      // today's blended rate, %
  rate: number           // the hypothetical rate, %
  now: { interest: number; gross: number; deduction: number; net: number }
  hyp: { interest: number; gross: number; deduction: number; net: number }
  delta_month: number    // hyp.gross − now.gross (signed)
  delta_year: number     // delta_month × 12
  // Whole-household total per month, when the Hushållsbudget shared-cost sum
  // (joint costs only — individual costs and savings excluded) is passed in.
  // `now` is those shared costs exactly as budgeted; the household's mortgage
  // line is a manual entry the user owns, so it is left untouched. `hyp` layers
  // ONLY the pure rate effect (delta_month) on top, so the household total
  // shifts with the rate without double-counting or editing the budget.
  // null when no budget / no shared costs.
  household: { now: number; hyp: number } | null
}

export function rateWhatIf(balance: number, baseRate: number, rate: number, amortization: number, householdCosts?: number): RateWhatIf | null {
  const b = Number(balance) || 0, br = Number(baseRate) || 0
  const r = Number(rate) || 0, am = Math.max(0, Number(amortization) || 0)
  if (b <= 0 || br <= 0 || r < 0) return null
  // Deduction applies the annual-bracket ranteavdrag() to a MONTHLY interest
  // figure — same convention as monthlyCost() so the two never disagree.
  const leg = (pct: number) => {
    const interest = r2(b * pct / 100 / 12)
    const deduction = ranteavdrag(interest)
    return { interest, gross: r2(interest + am), deduction, net: r2(interest + am - deduction) }
  }
  const now = leg(br), hyp = leg(r)
  const delta_month = r2(hyp.gross - now.gross)
  const hc = Math.max(0, Number(householdCosts) || 0)
  const household = hc > 0 ? { now: r2(hc), hyp: r2(hc + delta_month) } : null
  return {
    balance: b, amortization: am, base_rate: br, rate: r, now, hyp,
    delta_month, delta_year: r2(delta_month * 12), household,
  }
}

// ── Rate periods ───────────────────────────────────────────────────────────

// Steady-state monthly figures synced into Hushållsbudget. Interest uses the
// same balance × rate/100 / 12 convention as rateWhatIf; amortization is the
// observed monthly balance reduction.
export function mortgageMonthlyFigures(parts: LoanPart[], periods: RatePeriod[], payments: Payment[]): { ranta: number; amortering: number } | null {
  const balance = totalBalance(parts, payments)
  const blended = weightedAvgRate(parts, periods, payments)
  if (balance <= 0 || blended <= 0) return null
  return {
    ranta: r2(balance * blended / 100 / 12),
    amortering: monthlyAmortizationRate(parts, payments),
  }
}

export function effectiveRatePeriod(part: LoanPart, periods: RatePeriod[], asOf?: string): RatePeriod | null {
  const mine = periods.filter(r => r?.loan_part_id === part?.id && r.rate != null)
  if (!mine.length) return null
  if (asOf) {
    const cov = mine.filter(r => (!r.start_date || r.start_date <= asOf) && (r.end_date == null || asOf <= r.end_date))
    if (cov.length) { cov.sort((a, b) => a.start_date.localeCompare(b.start_date)); return cov[cov.length - 1] }
  }
  const s = mine.slice().sort((a, b) => a.start_date.localeCompare(b.start_date))
  return s[s.length - 1]
}

export type StrictRatePeriodCoverage = 'unconfigured' | 'covered' | 'outside-known-terms'

// Whether a proposed charge date is strictly inside this part's configured
// rate periods. Unlike effectiveRatePeriod(), this never falls back to the
// latest or a future period: a gap and a date after the final end_date are
// outside known terms. No usable part-linked period (non-null rate) remains a
// separate state so derived-rate forecasts keep their existing behaviour.
export function strictRatePeriodCoverage(
  part: LoanPart,
  periods: RatePeriod[],
  chargeDate: string,
): StrictRatePeriodCoverage {
  const mine = (periods || []).filter(r => r?.loan_part_id === part?.id && r.rate != null)
  if (!mine.length) return 'unconfigured'
  return mine.some(r =>
    (!r.start_date || r.start_date <= chargeDate) &&
    (r.end_date == null || chargeDate <= r.end_date))
    ? 'covered'
    : 'outside-known-terms'
}

function effectiveRate(part: LoanPart, periods: RatePeriod[], asOf?: string): number | null {
  const p = effectiveRatePeriod(part, periods, asOf); return p ? Number(p.rate) : null
}

export function bindingStatus(part: LoanPart, periods: RatePeriod[], asOf?: string) {
  const p = effectiveRatePeriod(part, periods, asOf)
  if (!p || !p.end_date) return { bound: false, until: null, days_left: null, expired: false }
  const days = daysBetween(asOf || todayISO(), p.end_date)
  return { bound: true, until: p.end_date, days_left: days, expired: days != null && days < 0 }
}

// Lånedelar grouped by the villkorsändringsdag (end_date) they share, so parts
// that reprice on the same day sit together — even at different rates (e.g. a
// few bunden tranches and a rörlig one all lapsing the same date). A part whose
// effective period has no end_date falls into a single catch-all group. Archived
// parts are excluded — they'd skew the balance/share aggregates. `rate` is the
// balance-weighted average across the group's members; `rate_type` is the shared
// type when uniform, else null (mixed).
export interface LoanPartGroup {
  key: string; end_date: string | null; rate: number | null; rate_type: 'rörlig' | 'bunden' | null
  parts: LoanPart[]; total_balance: number; share_pct: number
  days_left: number | null; expired: boolean; is_singleton: boolean; is_catchall: boolean
}

export function groupLoanParts(parts: LoanPart[], periods: RatePeriod[], payments: Payment[], asOf?: string): LoanPartGroup[] {
  const active = (parts || []).filter(p => p && !p.archived)
  const grandTotal = totalBalance(active, payments)
  type Bucket = { end_date: string | null; parts: LoanPart[]; is_catchall: boolean }
  const byKey = new Map<string, Bucket>()
  for (const part of active) {
    const period = effectiveRatePeriod(part, periods)
    const complete = !!period && period.end_date != null
    const key = complete ? period!.end_date! : '__catchall__'
    let bucket = byKey.get(key)
    if (!bucket) {
      bucket = { end_date: complete ? period!.end_date : null, parts: [], is_catchall: !complete }
      byKey.set(key, bucket)
    }
    bucket.parts.push(part)
  }
  const groups: LoanPartGroup[] = Array.from(byKey.entries()).map(([key, b]) => {
    const total_balance = r2(b.parts.reduce((s, p) => s + partBalance(p, payments), 0))
    const share_pct = grandTotal > 0 ? r2(total_balance / grandTotal * 100) : 0
    let days_left: number | null = null, expired = false
    let rate: number | null = null, rate_type: 'rörlig' | 'bunden' | null = null
    if (!b.is_catchall) {
      const bs = bindingStatus(b.parts[0], periods, asOf)
      days_left = bs.days_left; expired = bs.expired
      const types = new Set(b.parts.map(p => effectiveRatePeriod(p, periods)?.rate_type).filter(Boolean) as ('rörlig' | 'bunden')[])
      rate_type = types.size === 1 ? [...types][0] : null
      const wa = weightedAvgRate(b.parts, periods, payments)
      rate = wa > 0 ? wa : null
    }
    return {
      key, end_date: b.end_date, rate, rate_type,
      parts: b.parts, total_balance, share_pct, days_left, expired,
      is_singleton: b.parts.length === 1, is_catchall: b.is_catchall,
    }
  })
  groups.sort((a, b) => {
    if (a.is_catchall !== b.is_catchall) return a.is_catchall ? 1 : -1
    if (a.is_catchall) return 0
    if (a.end_date !== b.end_date) return (a.end_date || '') < (b.end_date || '') ? -1 : 1
    return b.total_balance - a.total_balance
  })
  return groups
}

export function weightedAvgRate(parts: LoanPart[], periods: RatePeriod[], payments: Payment[], asOf?: string): number {
  let num = 0, den = 0
  for (const p of parts.filter(p => p && !p.archived)) {
    const bal = asOf ? partBalanceAsOf(p, payments, asOf) : partBalance(p, payments)
    const rate = effectiveRate(p, periods, asOf)
    if (rate == null || bal <= 0) continue
    num += rate * bal; den += bal
  }
  return den > 0 ? r2(num / den) : 0
}

export function derivedRate(part: LoanPart, payments: Payment[], opts?: { trailing?: number }): number | null {
  const trail = opts?.trailing || 3
  const ints = payments.filter(p => p?.loan_part_id === part?.id && p.kind === 'interest' && p.date && Math.abs(Number(p.amount)) > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
  if (ints.length < 2) return null
  const ps: Array<{ rate: number; days: number }> = []
  for (let i = 1; i < ints.length; i++) {
    const n = daysBetween(ints[i - 1].date, ints[i].date)
    if (!n || n <= 0) continue
    const bal = partBalanceAsOf(part, payments, ints[i - 1].date)
    if (bal <= 0) continue
    ps.push({ rate: Math.abs(Number(ints[i].amount)) / bal * 365 / n, days: n })
  }
  if (!ps.length) return null
  const use = ps.slice(-trail)
  let num = 0, den = 0
  for (const p of use) { num += p.rate * p.days; den += p.days }
  return den > 0 ? r2(num / den * 100) : null
}

// Which year the bank divides by when accruing the LISTED rate: the Swedish
// convention is saldo × ränta × dagar/365, but Danske accrues over a 360-day
// bankår (faktisk/360), which runs every charge 365/360 ≈ +1,4 % over the /365
// arithmetic — at 1,2 Mkr × 3,93 % that's 4 061 kr vs 4 005 for a 31-day month.
//
// The charged rentedagar are NOT the elapsed days between postings: a /360 bank
// prices ~360 days per 365-day year (the household ledger charged 359 across
// 364), so a rate-level fit of Σcharge/Σ(saldo × elapsed days) lands BETWEEN
// the two hypotheses and flips with the value-date noise of the window. What
// does discriminate is the integer-day property: on a /360 bank every charge is
// a whole number of days × saldo × ränta/360 (131,00 kr/day on the household's
// parts — exact), while under /365 the implied day counts land ~0.4 off a whole
// number, and vice versa for a genuine /365 bank. Score each basis by that
// distance over the trailing charges; flip to 360 only on decisive evidence
// (near-exact under /360 AND a clear miss under /365 — a history billed at some
// other rate misses under both and stays on the Swedish default).
function interestYearBasis(part: LoanPart, real: Payment[], intRows: Payment[], listed: number): 360 | 365 {
  const t = intRows.slice(-7)                     // ≤ 6 trailing charges ≈ half a year,
  let err360 = 0, err365 = 0, used = 0            // short enough to sit inside one rate period
  for (let i = 1; i < t.length; i++) {
    const bal = partBalanceAsOf(part, real, String(t[i - 1].date))  // accrual balance: after the PREVIOUS posting
    const amt = Math.abs(Number(t[i].amount))
    if (bal <= 0 || !(amt > 0)) continue
    const d360 = amt / (bal * listed / 100 / 360) // implied rentedagar under each basis
    const d365 = amt / (bal * listed / 100 / 365)
    if (d360 < 1) continue                        // sub-day charge: integer distance is meaningless
    err360 += Math.abs(d360 - Math.round(d360))
    err365 += Math.abs(d365 - Math.round(d365))
    used++
  }
  return used >= 3 && err360 < 0.05 * used && err365 > 0.2 * used ? 360 : 365
}

// ── Expected next charge (plan 23) ─────────────────────────────────────────
// Forecast + reconcile for the near-identical monthly Ränta/Amortering entry:
// arithmetic (balance × rate × days/year-basis) on stored data, never rate
// forecasting.

export interface ExpectedCharge {
  loan_part_id: string
  next_date: string           // day-of-month pattern from history, NOT last+median-gap
  days: number                // daysBetween(last interest date, next_date)
  period_months: number       // charge cadence: 1 (monthly) or 3 (kvartalsvis)
  charge_day: number          // the UNCLAMPED billing day — day 31 stays 31 even when next_date clamped to the 30th
  balance: number             // partBalanceAsOf(part, payments, last interest date)
  original_balance: number    // the loan's ORIGINAL size — amorteringskravets 1/2/3 % is a share of this, not of the current balance
  rate: number | null         // the rate the prediction actually uses (%)
  rate_source: 'derived' | 'listed' | null
  rate_type: 'rörlig' | 'bunden' | null
  interest: number            // balance × rate/100 × days/365
  amortization: number        // observed monthly amortization × period (0 for interest-only)
  amortization_source: 'real' | 'declared' | 'paired' | 'timeline' | null
                              // which source the amortering came from: a real
                              // ledger row, the owner's declared plan (plan 105),
                              // the paired betalning − ränta diff, or the balance
                              // timeline. Lets the UI label declared vs detected.
  gross: number               // interest + amortization
  betalning: number | null    // the bank's per-part TOTAL debit (ränta + amortering) when the
                              // ledger has kind-'payment' betalning rows; null for manual ledgers
  charge_basis: 'days' | 'monthly'  // 'monthly' = flat 30/360 billing: ränta predicted from the
                                    // last charge (balance-scaled), never from day-count arithmetic
  year_basis: 360 | 365       // the year the bank divides by when accruing the LISTED rate —
                              // 365 (Swedish convention) or a 360-day bankår (Danske). Only
                              // fitted for a locked bunden part; the derived rate absorbs the
                              // convention by construction, so everything else stays 365.
  confidence: 'exact' | 'assumed' | 'unknown'
  calibration_gap: number | null  // listed rate − derived rate (pp); diagnostic only
}

// next_date arithmetic: banks charge on a fixed day-of-month, so raw gaps
// alternate 28/30/31 days — adding a median gap to the last date would drift
// off the real charge day and corrupt `days`. Period months + charge day
// instead, clamped to month end (the 31st in a 30-day month → the 30th).
function addMonthsAtDay(fromDate: string, months: number, day: number): string {
  let y = +fromDate.slice(0, 4), m = +fromDate.slice(5, 7) + months
  while (m > 12) { m -= 12; y++ }
  const dim = new Date(y, m, 0).getDate()
  return y + '-' + String(m).padStart(2, '0') + '-' + String(Math.min(day, dim)).padStart(2, '0')
}

// Mode of day-of-month across the part's interest rows; ties → most recent wins.
function chargeDayMode(sortedDates: string[]): number {
  const count: Record<number, number> = {}, lastSeen: Record<number, number> = {}
  sortedDates.forEach((d, i) => {
    const day = +d.slice(8, 10)
    count[day] = (count[day] || 0) + 1
    lastSeen[day] = i
  })
  let best = +sortedDates[sortedDates.length - 1].slice(8, 10)
  for (const k of Object.keys(count)) {
    const day = +k
    if (count[day] > count[best] || (count[day] === count[best] && lastSeen[day] > lastSeen[best])) best = day
  }
  return best
}

// The last day of a date's own month (1-indexed month, matching addMonthsAtDay).
function lastDayOfMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate()
}

// Does the bank bill on the LAST day of the month (Danske) rather than a fixed
// day-of-month? Month-end charges surface in the ledger as dates clustered at
// month boundaries: the 28th–31st, OR the 1st–3rd of the next month when
// month-end fell on a weekend and rolled to the next banking day. A fixed
// mid-month day (the 15th, the 27th) never clusters there; a bank that bills on
// the 1st sits only at the START edge — so we also require at least two genuine
// late-month dates to tell month-end apart from a 1st-of-month biller.
function isMonthEndBilling(sortedDates: string[]): boolean {
  if (sortedDates.length < 3) return false
  let late = 0, boundary = 0
  for (const d of sortedDates) {
    const y = +d.slice(0, 4), m = +d.slice(5, 7), day = +d.slice(8, 10)
    if (day >= lastDayOfMonth(y, m) - 2) { late++; boundary++ } // 28th–31st
    else if (day <= 3) boundary++                               // rolled month-end
  }
  return boundary / sortedDates.length >= 0.7 && late >= 2
}

// The month-end a charge BELONGS to. A late-month date is its own month's end;
// an early-month date (≤ 3, a weekend-rolled charge) belongs to the PREVIOUS
// month's end — so the next charge is one month on from there, never a
// double-counted 60-day jump.
function logicalMonthEnd(dateStr: string): string {
  let y = +dateStr.slice(0, 4), m = +dateStr.slice(5, 7)
  const day = +dateStr.slice(8, 10)
  if (day <= 3) { m -= 1; if (m < 1) { m = 12; y -= 1 } }
  return y + '-' + String(m).padStart(2, '0') + '-' + String(lastDayOfMonth(y, m)).padStart(2, '0')
}

// Median gap between interest rows, snapped to whole months: monthly (≤ 45
// days) or kvartalsvis. Cold start (< 2 rows) assumes monthly.
function chargePeriodMonths(sortedDates: string[]): number {
  const gaps: number[] = []
  for (let i = 1; i < sortedDates.length; i++) {
    const g = daysBetween(sortedDates[i - 1], sortedDates[i])
    if (g != null && g > 0) gaps.push(g)
  }
  if (!gaps.length) return 1
  gaps.sort((a, b) => a - b)
  const mid = gaps.length >> 1
  const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2
  return median <= 45 ? 1 : 3
}

// Plan 104 — optional entity context threaded into the forecast so it can read
// the part's bank profile (part → mortgage → bank) and pool the year-basis
// learner across all of that bank's parts. Backward-compatible: when omitted,
// profileYearBasis returns null and the bank-pooled learner is not engaged, so
// the forecast is byte-for-byte identical to before (single-part detection only).
export interface ForecastOpts { banks?: Bank[]; mortgages?: Mortgage[]; parts?: LoanPart[] }

// The declared day-count year for a part's bank, or null when there is no
// declared lock. ONLY a `year_basis_source === 'declared'` value short-circuits
// the learner; 'detected'/'suggested'/null do NOT override in Phase 1 (they are
// still surfaced as provenance, but detection stays authoritative until the
// owner confirms). A missing bank / mortgage link also yields null → detection.
export function profileYearBasis(part: LoanPart | null | undefined, mortgages: Mortgage[], banks: Bank[]): 360 | 365 | null {
  const bank = bankForPart(part, mortgages, banks)
  if (!bank || bank.year_basis_source !== 'declared') return null
  return bank.year_basis === 360 ? 360 : bank.year_basis === 365 ? 365 : null
}

// Plan 104 (Phase 2) — the declared billing cadence for a part's bank, or null
// when there is no declared pin. Only a 'declared' billing_source overrides
// isMonthEndBilling; null/detected/suggested fall back to ledger detection.
export function profileBilling(part: LoanPart | null | undefined, mortgages: Mortgage[], banks: Bank[]): 'month-end' | 'fixed' | null {
  const bank = bankForPart(part, mortgages, banks)
  if (!bank || bank.billing_source !== 'declared') return null
  return bank.billing === 'month-end' ? 'month-end' : bank.billing === 'fixed' ? 'fixed' : null
}

export interface LearnedBasis { basis: 360 | 365; confident: boolean; used: number; windows: number }

// Plan 104 (Phase 2) — window-scoped, bank-pooled year-basis learner. The old
// trailing-6 detector (interestYearBasis) scores the last ≤6 charges regardless
// of rate period; under a rolling 3-month bunden those straddle two listed rates,
// both the /360 and /365 scores blow up, and it reverts to the 365 default —
// re-introducing the ~1,4 % undershoot every quarter. This scores integer-day-ness
// WITHIN each rate period (inside one window the listed rate is constant, so a
// faktisk/360 bank's charge ÷ (saldo × listed/360) is a whole number of days) and
// POOLS the evidence across every bunden window of every part on the bank. A pair
// whose accrual straddles a villkorsändring (prev + current charge in different
// periods) is skipped, so a mixed-rate boundary never corrupts a score. Reuses
// interestYearBasis's decision thresholds on the pooled evidence. Pure.
export function learnYearBasis(bankParts: LoanPart[], periods: RatePeriod[], payments: Payment[]): LearnedBasis {
  const real = (payments || []).filter(p => p?.source !== 'predicted')
  let err360 = 0, err365 = 0, used = 0
  const windows = new Set<string>()
  for (const part of bankParts || []) {
    if (!part) continue
    const intRows = real
      .filter(p => p?.loan_part_id === part.id && p.kind === 'interest' && p.date && Math.abs(Number(p.amount)) > 0)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    for (let i = 1; i < intRows.length; i++) {
      const prevDate = String(intRows[i - 1].date), date = String(intRows[i].date)
      // Whole accrual must sit inside ONE bunden period (constant listed rate).
      const rp = effectiveRatePeriod(part, periods, date)
      const rpPrev = effectiveRatePeriod(part, periods, prevDate)
      if (!rp || rp.rate_type !== 'bunden' || !rpPrev || rpPrev.id !== rp.id) continue
      const listed = rp.rate == null ? null : Number(rp.rate)
      if (listed == null || !(listed > 0)) continue
      const bal = partBalanceAsOf(part, real, prevDate)
      const amt = Math.abs(Number(intRows[i].amount))
      if (bal <= 0 || !(amt > 0)) continue
      const d360 = amt / (bal * listed / 100 / 360)
      const d365 = amt / (bal * listed / 100 / 365)
      if (d360 < 1) continue // sub-day charge: integer distance is meaningless
      err360 += Math.abs(d360 - Math.round(d360))
      err365 += Math.abs(d365 - Math.round(d365))
      used++; windows.add(rp.id)
    }
  }
  const clear360 = used >= 3 && err360 < 0.05 * used && err365 > 0.2 * used
  const basis: 360 | 365 = clear360 ? 360 : 365
  // Suggest (cross the confidence gate) only on a clear 360 signal pooled from
  // ≥ 2 windows — one thin quarter is not enough to lock a convention, and 365
  // is the default (no lock to suggest).
  const confident = clear360 && windows.size >= 2
  return { basis, confident, used, windows: windows.size }
}

// The parts sharing `part`'s bank (for pooling the learner). Falls back to just
// `part` when there is no bank context or the part has no resolvable bank.
function sameBankParts(part: LoanPart, opts?: ForecastOpts): LoanPart[] {
  const all = opts?.parts
  if (!all || !all.length) return [part]
  const bank = bankForPart(part, opts?.mortgages ?? [], opts?.banks ?? [])
  if (!bank) return [part]
  const pooled = all.filter(p => p && bankForPart(p, opts?.mortgages ?? [], opts?.banks ?? [])?.id === bank.id)
  return pooled.length ? pooled : [part]
}

// The year-basis used for a locked-bunden charge: a declared lock wins; else the
// bank-pooled learner IF entity context is present; else null so expectedCharge
// falls back to the classic single-part detector (keeping no-context callers —
// every existing #305 golden — byte-for-byte identical).
function forecastYearBasis(part: LoanPart, periods: RatePeriod[], real: Payment[], opts?: ForecastOpts): 360 | 365 | null {
  const declared = profileYearBasis(part, opts?.mortgages ?? [], opts?.banks ?? [])
  if (declared != null) return declared
  if (!opts?.parts || !opts.parts.length) return null // no bank context → classic detector
  return learnYearBasis(sameBankParts(part, opts), periods, real).basis
}

// Plan 104 (Phase 2) — the suggest→confirm payload for a bank's Bankvillkor UI.
// Runs the learner across the bank's parts and reports each field's provisional
// value plus whether the pooled evidence crossed the confidence gate (→ offer a
// "Lås detta?"). Billing is only ever suggested as 'month-end' when the ledger
// reads clearly month-end across the bank's parts.
export interface BankProfileSuggestion {
  year_basis: { value: 360 | 365; confident: boolean }
  billing: { value: 'month-end' | 'fixed'; confident: boolean }
}
export function suggestBankProfile(parts: LoanPart[], periods: RatePeriod[], payments: Payment[]): BankProfileSuggestion {
  const learned = learnYearBasis(parts || [], periods, payments)
  const real = (payments || []).filter(p => p?.source !== 'predicted')
  const ints = (parts || []).flatMap(p => real
    .filter(r => r?.loan_part_id === p?.id && r.kind === 'interest' && r.date)
    .map(r => String(r.date))).sort((a, b) => a.localeCompare(b))
  const monthEnd = isMonthEndBilling(ints)
  return {
    year_basis: { value: learned.basis, confident: learned.confident },
    // Cadence is a lower-stakes convention; suggest it whenever there is a
    // month-end-shaped history to confirm (≥ 4 dated charges), never 'fixed'
    // (fixed is the unremarkable default that needs no lock).
    billing: { value: monthEnd ? 'month-end' : 'fixed', confident: monthEnd && ints.length >= 4 },
  }
}

// Plan 104 (Phase 2) — drift safety valve: a declared lock must not hide a real
// change. Returns the mismatch when the learner now confidently disagrees with a
// declared value, so the UI can surface the #298-style stale banner. null when
// there is no declared lock, or the fresh evidence still agrees / is inconclusive.
export interface ProfileDrift { field: 'year_basis'; declared: 360 | 365; learned: 360 | 365 }
export function bankProfileDrift(bank: Bank | null | undefined, parts: LoanPart[], periods: RatePeriod[], payments: Payment[]): ProfileDrift | null {
  if (!bank || bank.year_basis_source !== 'declared') return null
  const declared = bank.year_basis === 360 ? 360 : bank.year_basis === 365 ? 365 : null
  if (declared == null) return null
  const learned = learnYearBasis(parts || [], periods, payments)
  if (learned.confident && learned.basis !== declared) return { field: 'year_basis', declared, learned: learned.basis }
  return null
}

// ── Effective bank profile (plan 109b) ───────────────────────────────────────
// Resolves the convention values the UI presents (and 109c wires into the
// forecast context) with the owner-confirmed precedence (2026-07-16):
//
//   1. household-declared lock        (the owner's stated contract fact)
//   2. confident household detection  (the household's own ledger is direct
//                                      evidence of the actual contract)
//   3. curated catalogue value        (a generic default for the bank)
//   4. generic fallback               (365 / fixed — the Swedish conventions)
//
// CONFIDENCE THRESHOLD — a financial-correctness parameter, anchored on the
// plan-104 promotion criterion (the same rule that offers "Lås detta?"):
//   • year_basis: `learnYearBasis` — confident only on a clear /360 signal
//     pooled from ≥ 2 bunden rate-period windows with ≥ 3 usable charge pairs,
//     where the implied rentedagar are near-integral under /360
//     (err360 < 0.05·n) AND clearly not under /365 (err365 > 0.2·n). 365 is
//     the null-hypothesis default and is never itself "confident".
//   • billing: `suggestBankProfile` — confident only for 'month-end', when
//     ≥ 70 % of ≥ 4 dated charges cluster at a month boundary with ≥ 2
//     genuinely late-month dates. 'fixed' is the unremarkable default and has
//     no promotable criterion, so a fixed-day reading never outranks a lock
//     or catalogue value.
// Detection is recomputed fresh from the ledger on every resolution; a stored
// 'detected'/'suggested' provenance value never short-circuits (plan-104
// phase-1 rule: only 'declared' locks).
//
// A conflict between a lock/catalogue value and fresh confident evidence is
// returned as typed DRIFT — the resolution never silently rewrites either
// profile. Profiles carry parameters, not algorithms: no `if (bank === ...)`.

// The shared read-only catalogue row (mortgage_bank_catalog, plan 109a) as the
// domain layer consumes it. Nullable curated parameters; unknown facts stay null.
export interface CatalogBank {
  id: string
  slug?: string
  label: string
  year_basis?: number | null
  billing?: string | null
}

export type ConventionSource = 'declared' | 'detected' | 'catalog' | 'default'
export interface EffectiveConvention<T> { value: T; source: ConventionSource }

type ConventionValue = 360 | 365 | 'month-end' | 'fixed'
export interface ConventionDriftWarning {
  field: 'year_basis' | 'billing'
  /** Which profile the confident ledger evidence contradicts. */
  against: 'declared' | 'catalog'
  /** The value that profile holds. */
  held: ConventionValue
  /** What the household's own ledger confidently reads. */
  observed: ConventionValue
  /** The value the resolution actually uses (the lock when against 'declared'; the detection when against 'catalog'). */
  effective: ConventionValue
}

export interface EffectiveBankProfile {
  year_basis: EffectiveConvention<360 | 365>
  billing: EffectiveConvention<'month-end' | 'fixed'>
  drift: ConventionDriftWarning[]
}

// One field's precedence walk. A drift entry is appended when confident
// evidence contradicts the winning lock, or the catalogue value the detection
// outranked — the two "would have used a different number" cases the owner
// must see (plan 109 adversarial review, 2026-07-16).
function resolveConvention<T extends ConventionValue>(
  field: ConventionDriftWarning['field'],
  declared: T | null, detected: T | null, catalogValue: T | null, fallback: T,
  drift: ConventionDriftWarning[],
): EffectiveConvention<T> {
  if (declared != null) {
    if (detected != null && detected !== declared)
      drift.push({ field, against: 'declared', held: declared, observed: detected, effective: declared })
    return { value: declared, source: 'declared' }
  }
  if (detected != null) {
    if (catalogValue != null && catalogValue !== detected)
      drift.push({ field, against: 'catalog', held: catalogValue, observed: detected, effective: detected })
    return { value: detected, source: 'detected' }
  }
  if (catalogValue != null) return { value: catalogValue, source: 'catalog' }
  return { value: fallback, source: 'default' }
}

// `parts` are the bank's parts (pool the ledger evidence across them, exactly
// as suggestBankProfile does). Malformed lock/catalogue values (a year_basis
// of 400, a billing of 'weird') are void — they fall through the precedence
// rather than becoming a garbage convention.
export function effectiveBankProfile(
  bank: Bank | null | undefined,
  catalog: CatalogBank | null | undefined,
  parts: LoanPart[], periods: RatePeriod[], payments: Payment[],
): EffectiveBankProfile {
  const suggestion = suggestBankProfile(parts || [], periods || [], payments || [])
  const drift: ConventionDriftWarning[] = []
  const asYearBasis = (v: unknown): 360 | 365 | null => v === 360 ? 360 : v === 365 ? 365 : null
  const asBilling = (v: unknown): 'month-end' | 'fixed' | null =>
    v === 'month-end' ? 'month-end' : v === 'fixed' ? 'fixed' : null
  return {
    year_basis: resolveConvention('year_basis',
      bank?.year_basis_source === 'declared' ? asYearBasis(bank.year_basis) : null,
      suggestion.year_basis.confident ? suggestion.year_basis.value : null,
      asYearBasis(catalog?.year_basis), 365, drift),
    billing: resolveConvention('billing',
      bank?.billing_source === 'declared' ? asBilling(bank.billing) : null,
      suggestion.billing.confident ? suggestion.billing.value : null,
      asBilling(catalog?.billing), 'fixed', drift),
    drift,
  }
}

export function expectedCharge(part: LoanPart, periods: RatePeriod[], payments: Payment[], opts?: ForecastOpts): ExpectedCharge | null {
  if (!part) return null
  // Calibrate on REAL rows only — the bank stays ground truth. Including a
  // logged prediction would advance next_date past it and feed the derived
  // rate its own output; excluding it keeps the forecast fixed until a real
  // import supersedes the predicted row.
  const real = payments.filter(p => p?.source !== 'predicted')
  const intRows = real.filter(p => p?.loan_part_id === part.id && p.kind === 'interest' && p.date && Math.abs(Number(p.amount)) > 0)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
  const ints = intRows.map(p => String(p.date))
  // Nothing to compute from: neither an interest row nor a rate period.
  if (!ints.length && !effectiveRatePeriod(part, periods)) return null

  const lastDate = ints.length ? ints[ints.length - 1] : todayISO()
  const period_months = chargePeriodMonths(ints)
  let chargeDay: number
  let next_date: string
  let days: number
  // A declared billing pin (plan 104 Phase 2) overrides ledger detection of the
  // cadence; otherwise detect month-end billing from the history as before.
  const billingPin = profileBilling(part, opts?.mortgages ?? [], opts?.banks ?? [])
  const monthEndBilling = billingPin ? billingPin === 'month-end' : isMonthEndBilling(ints)
  if (monthEndBilling) {
    // Bill lands on each month's last day (charge_day 31 makes addMonthsAtDay
    // clamp to the real length: Jul→31, Sep→30, Feb→28/29). Anchor on the last
    // charge's LOGICAL month-end so a weekend-rolled date (e.g. 1 Jun for May's
    // charge) advances one true month, not two.
    chargeDay = 31
    next_date = addMonthsAtDay(logicalMonthEnd(lastDate), period_months, chargeDay)
    days = daysBetween(lastDate, next_date) ?? 0
  } else {
    chargeDay = ints.length ? chargeDayMode(ints) : +lastDate.slice(8, 10)
    next_date = addMonthsAtDay(lastDate, period_months, chargeDay)
    days = daysBetween(lastDate, next_date) ?? 0
    // A moved fixed billing day (e.g. the bank shifting the charge from the 27th
    // to the 1st) leaves the all-history day-mode stale: it still points at the
    // old day, roughly a full month PAST the true next charge, so a monthly
    // cadence balloons to ~56 days. On a days/365 bank that inflates the ränta
    // by exactly that ratio (the 7 565-vs-4 061 kr prod bug). A genuine monthly
    // interval is 28–31 days; > 45 means the mode disagrees with where the bank
    // now bills, so anchor to the most recent bill's own day — one month out is
    // 28–31 days, so this always resolves in a single step.
    if (period_months === 1 && days > 45) {
      chargeDay = +lastDate.slice(8, 10)
      next_date = addMonthsAtDay(lastDate, period_months, chargeDay)
      days = daysBetween(lastDate, next_date) ?? 0
    }
  }
  const balance = partBalanceAsOf(part, real, lastDate)

  const bs = bindingStatus(part, periods, next_date)

  // Rate selection. A part locked into a bunden rate: the contractual (listed)
  // rate IS ground truth for the binding period, so use it directly. The
  // auto-derived rate only estimates it and lags a step behind any recent
  // change or a low-billed month still inside the averaging window (a uniform
  // ~2 % undershoot on the household's parts). Otherwise predict with the
  // trailing derived rate — it encodes what the bank actually bills, incl. its
  // day-count convention (predicting listed on a 360-day-basis rörlig part would
  // flag drift every single month); listed is the thin-history fallback. The
  // gap between the two stays as a diagnostic.
  const derived = derivedRate(part, real)
  const listed = effectiveRate(part, periods, next_date)
  const lockedBunden = bs.bound && !bs.expired && listed != null
  const rate = lockedBunden ? listed : (derived ?? listed ?? null)
  const rate_source: ExpectedCharge['rate_source'] =
    lockedBunden ? 'listed' : derived != null ? 'derived' : listed != null ? 'listed' : null
  const rate_type = effectiveRatePeriod(part, periods, next_date)?.rate_type ?? null
  // The listed rate needs the bank's own day-count year; the derived rate
  // already encodes it (reverse-engineered on the /365 fiction), so only the
  // locked-bunden path fits a basis.
  // A declared bank profile is authoritative for the locked-bunden path (plan
  // 104): use it when present. Else, when entity context is supplied, the
  // window-scoped bank-pooled learner (robust across a rolling villkorsändring);
  // else the classic single-part trailing detector, so no-context callers (every
  // existing #305 golden) stay byte-for-byte identical. Never pin a basis on the
  // derived-rate path — it self-calibrates on the /365 fiction.
  const year_basis: ExpectedCharge['year_basis'] =
    lockedBunden
      ? (forecastYearBasis(part, periods, real, opts) ?? interestYearBasis(part, real, intRows, listed))
      : 365

  const confidence: ExpectedCharge['confidence'] =
    bs.bound && !bs.expired ? 'exact' : rate_source === 'derived' ? 'assumed' : 'unknown'

  // Amortering, in priority order:
  // 1. Explicit real amortering rows — manual ledgers. Median of the trailing
  //    3 (one-off insatser excluded — they don't repeat). Real recorded history
  //    stays ground truth and outranks even a declared plan.
  // 2. The owner-DECLARED plan (plan 105): a fixed rak amortering the owner
  //    stated for this part, effective at next_date. When present (INCLUDING 0)
  //    it is authoritative and the paired/timeline branches below are skipped —
  //    so the forecast is correct immediately, not ~3 months late.
  // 3. The bank's statement shape: per part a Ränta row and a "Betalning" row
  //    that is the TOTAL debited (ränta included). Amortering is the paired
  //    difference betalning − ränta within the month — 0 on an interest-only
  //    part, whose betalning simply equals the ränta. Median of the trailing
  //    3 paired months so a one-off transfer can't skew it.
  // 4. The balance-timeline drop — last resort; it dilutes the charge across
  //    months outside the history and underestimates.
  const amorts = real.filter(p => p?.loan_part_id === part.id && p.kind === 'amortization'
    && !p.is_insats && Math.abs(Number(p.amount)) > 0 && p.date)
    .sort((a, b) => a.date.localeCompare(b.date)).slice(-3)
    .map(p => Math.abs(Number(p.amount))).sort((a, b) => a - b)
  const byMonth = new Map<string, { interest: number; betalning: number; hasBetalning: boolean }>()
  for (const p of real) {
    if (p?.loan_part_id !== part.id || !p.date) continue
    const mk = monthKey(p.date)
    if (!mk) continue
    const m = byMonth.get(mk) || { interest: 0, betalning: 0, hasBetalning: false }
    if (p.kind === 'interest') m.interest += Math.abs(Number(p.amount) || 0)
    else if (p.kind === 'payment') { m.betalning += Math.abs(Number(p.amount) || 0); m.hasBetalning = true }
    byMonth.set(mk, m)
  }
  const hasBetalning = [...byMonth.values()].some(m => m.hasBetalning)
  const paired = [...byMonth.entries()]
    .filter(([, m]) => m.hasBetalning && m.interest > 0)
    .sort((a, b) => a[0].localeCompare(b[0])).slice(-3)
    .map(([, m]) => Math.max(0, m.betalning - m.interest)).sort((a, b) => a - b)
  // The declared plan, resolved at next_date and expressed per charge (× the
  // cadence, so a kvartalsvis part gets three months of the monthly figure).
  const declaredMonthly = effectiveDeclaredAmortization(part, next_date)
  const amortization = amorts.length ? r2(amorts[amorts.length >> 1])
    : declaredMonthly != null ? r2(declaredMonthly * period_months)
    : paired.length ? r2(paired[paired.length >> 1])
    : r2(monthlyAmortizationRate([part], real) * period_months)
  const amortization_source: ExpectedCharge['amortization_source'] =
    amorts.length ? 'real'
    : declaredMonthly != null ? 'declared'
    : paired.length ? 'paired'
    : 'timeline'

  // Flat-monthly billing (Danske-style 30/360): the ränta is balance × rate/12
  // every month — it does NOT scale with the interval's day count, so two
  // trailing intervals with different day counts carry (near-)identical
  // charges. Predict from the LAST CHARGE, scaled only by the balance step
  // from amorteringen. This is immune both to the ±3 % day-count wobble and
  // to charge-day noise in the ledger (mixed billing days once stretched a
  // 30-day month into a 56-day interval and inflated the ränta by 86 %).
  // Charges that DO track the day count keep the classic days/365 model.
  const basis = chargeBasis(intRows)
  const lastCharge = intRows.length ? Math.abs(Number(intRows[intRows.length - 1].amount)) : 0
  let interest: number
  let rateUsed = rate
  if (basis === 'monthly' && lastCharge > 0) {
    // The last charge accrued on the balance BEFORE this month's amortering.
    interest = balance > 0 ? r2(lastCharge * balance / (balance + amortization)) : r2(lastCharge)
    // Sats shows the bank's nominal monthly-basis rate, not a 365-day fiction.
    if (balance + amortization > 0) rateUsed = r2(lastCharge * (12 / period_months) * 100 / (balance + amortization))
  } else {
    interest = rate != null && days > 0 && balance > 0 ? r2(balance * rate / 100 * days / year_basis) : 0
  }

  return {
    loan_part_id: part.id, next_date, days, period_months, charge_day: chargeDay, balance,
    original_balance: partOriginal(part, real),
    rate: rateUsed, rate_source, rate_type, interest, amortization, amortization_source,
    gross: r2(interest + amortization),
    // A part with betalning history predicts the bank's total row; a ledger
    // without one renders the legacy separate amortering line instead. A declared
    // amortering on a part with betalning history keeps the bank's total-debit
    // shape (betalning = interest + declared), even when no paired month exists yet.
    betalning: (paired.length || (declaredMonthly != null && hasBetalning)) ? r2(interest + amortization) : null,
    charge_basis: basis, year_basis,
    confidence, calibration_gap: derived != null && listed != null && rateUsed != null ? r2(listed - rateUsed) : null,
  }
}

// Which quantity the bank holds constant across an interval: 'days' (charge ∝
// day count, the classic actual/365 model) or 'monthly' (flat charge per
// month, 30/360). Decided on the NEWEST pair of trailing intervals with
// differing day counts: if the charges differ far less than the day counts do,
// the bank bills flat months. A rate change breaks the flatness for one
// import, falling back to the days model until the next charge confirms.
function chargeBasis(intRows: Payment[]): ExpectedCharge['charge_basis'] {
  const t = intRows.slice(-4)
  const iv: Array<{ d: number; c: number }> = []
  for (let i = 1; i < t.length; i++) {
    const d = daysBetween(String(t[i - 1].date), String(t[i].date))
    const c = Math.abs(Number(t[i].amount))
    if (d != null && d > 0 && c > 0) iv.push({ d, c })
  }
  for (let j = iv.length - 1; j > 0; j--)
    for (let i = j - 1; i >= 0; i--)
      if (iv[i].d !== iv[j].d)
        return Math.abs(iv[j].c / iv[i].c - 1) < Math.abs(iv[j].d / iv[i].d - 1) / 2 ? 'monthly' : 'days'
  return 'days'
}

// The next charge NOT yet in the ledger: expectedCharge rolled forward past
// months whose interest is already covered (predicted or real), so logging a
// month makes the block advance to the following one instead of going quiet.
// Each roll holds the rate flat, steps the balance down by the predicted
// amortering, and reprices the actual day count of the new interval.
export function pendingCharge(part: LoanPart, periods: RatePeriod[], payments: Payment[], opts?: ForecastOpts): ExpectedCharge | null {
  const c = expectedCharge(part, periods, payments, opts)
  if (!c) return null
  if (strictRatePeriodCoverage(part, periods, c.next_date) === 'outside-known-terms') return null
  // A month only rolls once EVERY expected transaction is covered — the ränta
  // and its companion row: the bank's betalning (kind payment) when the part
  // has one, else the legacy amortering line. Logging just one of the two
  // keeps the month visible so the other stays loggable.
  const covered = (x: ExpectedCharge) =>
    hasChargeInMonth(payments, x.loan_part_id, x.next_date, 'interest') &&
    (x.betalning != null
      ? (x.betalning <= 0 || hasChargeInMonth(payments, x.loan_part_id, x.next_date, 'payment'))
      : (x.amortization <= 0 || hasChargeInMonth(payments, x.loan_part_id, x.next_date, 'amortization')))
  let out = c
  for (let i = 0; i < 24 && covered(out); i++) {
    const next = rollChargeOnce(part, periods, out)
    if (strictRatePeriodCoverage(part, periods, next.next_date) === 'outside-known-terms') return null
    out = next
  }
  return out
}

// One roll step: advance next_date by the cadence, step the balance down by
// the predicted amortering, and reprice — the actual day count of the new
// interval on the days basis, the balance ratio on the flat-monthly basis.
function rollChargeOnce(part: LoanPart, periods: RatePeriod[], out: ExpectedCharge): ExpectedCharge {
  const next_date = addMonthsAtDay(out.next_date, out.period_months, out.charge_day)
  const days = daysBetween(out.next_date, next_date) ?? 0
  // Plan 105: a declared plan can change the amortering across a roll boundary
  // (a future start date, or a dated step-down). Re-resolve it at the new
  // next_date — same pattern as the binding check below; when present it drives
  // the amortering and the balance step-down, else the prior amount holds flat.
  const declaredMonthly = effectiveDeclaredAmortization(part, next_date)
  const amortization = declaredMonthly != null ? r2(declaredMonthly * out.period_months) : out.amortization
  const amortization_source = declaredMonthly != null ? 'declared' : out.amortization_source
  const balance = Math.max(0, r2(out.balance - amortization))
  const interest = out.charge_basis === 'monthly'
    ? (out.balance > 0 ? r2(out.interest * balance / out.balance) : out.interest)
    : out.rate != null && days > 0 && balance > 0 ? r2(balance * out.rate / 100 * days / out.year_basis) : 0
  const bs = bindingStatus(part, periods, next_date)
  return {
    ...out, next_date, days, balance, interest, amortization, amortization_source,
    gross: r2(interest + amortization),
    betalning: out.betalning != null ? r2(interest + amortization) : null,
    // A binding can lapse mid-roll: exact only while it still holds.
    confidence: bs.bound && !bs.expired ? 'exact' : out.rate_source === 'derived' ? 'assumed' : 'unknown',
  }
}

// The pending charge plus the avier after it: months ahead projected with the
// rate held flat and the balance stepping down by the amortering each period.
// [0] is pendingCharge (loggable); the rest are a read-only preview. Stops
// early when the loan is paid off — a 0 kr avi is noise, not information —
// and at the last strictly covered rate-period date. A successor continues
// the preview only on dates it covers; gaps and dates after the last known
// period are never shown.
export function pendingChargeSeries(part: LoanPart, periods: RatePeriod[], payments: Payment[], months = 12, opts?: ForecastOpts): ExpectedCharge[] {
  const first = pendingCharge(part, periods, payments, opts)
  if (!first) return []
  const out = [first]
  const n = Math.max(1, Math.round(months / first.period_months))
  for (let i = 1; i < n; i++) {
    const next = rollChargeOnce(part, periods, out[out.length - 1])
    if (next.balance <= 0) break
    if (strictRatePeriodCoverage(part, periods, next.next_date) === 'outside-known-terms') break
    out.push(next)
  }
  return out
}

// Logged förväntad rows carry the amounts the model produced AT LOGGING TIME;
// when the model improves they go stale, and by design nothing rewrites them
// on visit (real imports supersede them). This surfaces the drift so the UI
// can offer an explicit one-click refresh: each stale row is returned with the
// CURRENT forecast's amount and post-charge saldo for its part + month + kind.
// Rows inside the reconcile tolerance, real rows, and past months are left
// alone; months after the base forecast are compared against the rolled charge.
export function stalePredictedRows(parts: LoanPart[], periods: RatePeriod[], payments: Payment[], opts?: ForecastOpts):
  Array<{ payment: Payment; amount: number; balance_after: number }> {
  const out: Array<{ payment: Payment; amount: number; balance_after: number }> = []
  const preds = (payments || []).filter(p => p?.source === 'predicted' && p.loan_part_id && monthKey(p.date))
  if (!preds.length) return out
  for (const part of (parts || []).filter(p => p && !p.archived)) {
    const mine = preds.filter(p => p.loan_part_id === part.id)
    if (!mine.length) continue
    const lastMk = mine.map(p => monthKey(p.date) as string).sort()[mine.length - 1]
    let c = expectedCharge(part, periods, payments, opts)
    for (let i = 0; c && i < 24; i++, c = rollChargeOnce(part, periods, c)) {
      const mk = monthKey(c.next_date)
      if (!mk || mk > lastMk) break
      for (const p of mine) {
        if (monthKey(p.date) !== mk) continue
        const expected = p.kind === 'interest' ? c.interest
          : p.kind === 'payment' ? (c.betalning ?? c.gross)
          : p.kind === 'amortization' ? c.amortization : null
        if (expected == null || expected <= 0) continue
        if (reconcileCharge(expected, Number(p.amount) || 0).ok) continue
        out.push({ payment: p, amount: expected, balance_after: r2(Math.max(0, c.balance - c.amortization)) })
      }
    }
  }
  return out
}

export function expectedCharges(parts: LoanPart[], periods: RatePeriod[], payments: Payment[], opts?: ForecastOpts):
  { rows: ExpectedCharge[]; total_interest: number; total_gross: number } {
  const rows = (parts || []).filter(p => p && !p.archived)
    .map(p => expectedCharge(p, periods, payments, opts))
    .filter((r): r is ExpectedCharge => r != null)
  return {
    rows,
    total_interest: r2(rows.reduce((s, r) => s + r.interest, 0)),
    total_gross: r2(rows.reduce((s, r) => s + r.gross, 0)),
  }
}

// Forward annual view for ränteavdrag planning: rolls expectedCharge forward,
// holding balance and rate flat. Caveat: a flat balance slightly overstates
// interest for an amortizing part — acceptable because the household's parts
// are interest-only and the figure is labelled an estimate.
export function forecastInterest(parts: LoanPart[], periods: RatePeriod[], payments: Payment[], months = 12):
  { interest: number; deduction: number; net: number; assumed: boolean } {
  const { rows } = expectedCharges(parts, periods, payments)
  const interest = r2(rows.reduce((s, r) => s + r.interest * (months / r.period_months), 0))
  const deduction = ranteavdrag(interest)
  return { interest, deduction, net: r2(interest - deduction), assumed: rows.some(r => r.confidence !== 'exact') }
}

// Expected vs actual, tolerance max(50 kr, 1 %): inside it a real import
// silently supersedes the predicted row; outside it the drift IS the alarm
// (rate reset, fee, extra amortering).
export function reconcileCharge(expected: ExpectedCharge | number, actualInterest: number):
  { expected: number; actual: number; drift: number; ok: boolean } {
  const exp = r2(typeof expected === 'number' ? expected : expected.interest)
  const actual = r2(Math.abs(Number(actualInterest) || 0))
  const drift = r2(actual - exp)
  return { expected: exp, actual, drift, ok: Math.abs(drift) <= Math.max(50, exp * 0.01) + 1e-9 }
}

// Pairs each incoming ränta/betalning/amortering draft with an existing
// source:'predicted' row of the SAME kind on the same loan_part_id + month.
// Deliberately NOT flagDuplicates: its fingerprint includes the exact date,
// and the import triage feeds it blank candidate dates, so that path can
// never collide with a dated predicted row.
const SUPERSEDABLE: ReadonlySet<PaymentKind> = new Set(['interest', 'amortization', 'payment'])
export function matchPredictedRows(payments: Payment[], drafts: Array<Partial<Payment>>):
  Array<{ draftIndex: number; predicted: Payment; recon: ReturnType<typeof reconcileCharge> }> {
  const preds = (payments || []).filter(p =>
    p?.source === 'predicted' && SUPERSEDABLE.has(p.kind) && p.loan_part_id && monthKey(p.date))
  const used = new Set<string>()
  const out: Array<{ draftIndex: number; predicted: Payment; recon: ReturnType<typeof reconcileCharge> }> = []
  ;(drafts || []).forEach((d, i) => {
    if (!d || !d.kind || !SUPERSEDABLE.has(d.kind) || !d.loan_part_id || !monthKey(d.date)) return
    const hit = preds.find(p => !used.has(p.id) && p.kind === d.kind && p.loan_part_id === d.loan_part_id && monthKey(p.date) === monthKey(d.date))
    if (!hit) return
    used.add(hit.id)
    out.push({ draftIndex: i, predicted: hit, recon: reconcileCharge(hit.amount, Number(d.amount) || 0) })
  })
  return out
}

// Double-log guard for confirm-to-log: a row of that kind (predicted or real)
// already covering the part + month means the charge is accounted for.
export function hasChargeInMonth(payments: Payment[], loanPartId: string | null, date: string, kind: PaymentKind = 'interest'): boolean {
  const mk = monthKey(date)
  if (!mk || !loanPartId) return false
  return (payments || []).some(p =>
    p?.kind === kind && p.loan_part_id === loanPartId && monthKey(p.date) === mk)
}

// ── Amorteringskrav ────────────────────────────────────────────────────────

export function amorteringskravStatus(parts: LoanPart[], payments: Payment[], valuations: Valuation[], s: Partial<MortgageSettings>) {
  const bal = totalBalance(parts, payments), val = propertyValue(valuations)
  const ltv = loanToValue(bal, val), income = Number(s.household_income_yearly) || 0
  const dti = income > 0 ? r2(bal / income) : 0
  let req = 0; if (ltv > 70) req = 2; else if (ltv > 50) req = 1; if (income > 0 && dti > 4.5) req += 1
  const reqA = r2(bal * req / 100), actA = r2(monthlyAmortizationRate(parts, payments) * 12)
  return { ltv, dti, required_pct: req, required_annual: reqA, actual_annual: actA, meets: actA + 0.5 >= reqA, exempt: req === 0, has_income: income > 0, has_value: val > 0 }
}

// ── Import presets ─────────────────────────────────────────────────────────

export function headerSignature(headers: string[]): string {
  return headers.map(h => String(h ?? '').toLowerCase().trim()).filter(Boolean).sort().join('|')
}

export function mappingToNames(headers: string[], m: Partial<ColMapping>): ColNameMapping {
  const nm = (i: number | null | undefined) => (i == null || headers[i] == null) ? null : String(headers[i])
  return { date: nm(m.date), specification: nm(m.specification), amount: nm(m.amount), balance: nm(m.balance), loan_number: nm(m.loan_number) }
}

export function applyPreset(headers: string[], names: Partial<ColNameMapping>): ColMapping {
  const lower = headers.map(h => String(h ?? '').toLowerCase().trim())
  const idx = (n: string | null | undefined) => {
    if (n == null) return null; const i = lower.indexOf(String(n).toLowerCase().trim()); return i < 0 ? null : i
  }
  return { date: idx(names.date), specification: idx(names.specification), amount: idx(names.amount), balance: idx(names.balance), loan_number: idx(names.loan_number) }
}

// ── CSV export ─────────────────────────────────────────────────────────────

export function paymentsToCsv(payments: Payment[], parts: LoanPart[]): string {
  const byId: Record<string, string> = {}
  for (const p of parts || []) if (p) byId[p.id] = p.label || ''
  const cell = (v: unknown) => { const s = String(v ?? ''); return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
  const rows = [['Date', 'Loan part', 'Type', 'Amount', 'Balance after', 'Paid by', 'Source']]
  for (const p of payments || [])
    if (p) rows.push([p.date, byId[p.loan_part_id || ''] || p.loan_part_id || '', p.kind, String(p.amount), p.balance_after != null ? String(p.balance_after) : '', p.paid_by, p.source])
  return rows.map(r => r.map(cell).join(';')).join('\n')
}

// ── Reconciliation ─────────────────────────────────────────────────────────

// Rebuilt on the clean origination anchor (plan 103). The check must NOT fire
// just because a loan is older than its imported ledger window: when the
// origination PREDATES the ledger's earliest Saldo, the gap is expected
// pre-import amortisation and no banner is warranted (the 192 000 false-alarm
// case). It fires only on genuine partial-import evidence:
//   - the origination sits within/after the ledger window (origination date not
//     before the earliest Saldo), and the anchor still can't be reconciled to
//     that opening Saldo by the amortisation actually logged between them.
// `start_balance` in the returned shape is the origination anchor (original_balance
// first, then legacy start_balance) so the existing UI copy keeps working.
export function reconcileBalance(parts: LoanPart[], payments: Payment[]) {
  function edgeDate(rows: Payment[], newest: boolean): string | null {
    if (!rows.length) return null
    return rows.reduce((acc: string | null, x) => acc == null ? String(x.date) : (newest ? (x.date > acc ? x.date : acc) : (x.date < acc ? x.date : acc)), null)
  }
  function saldoAt(rows: Payment[], date: string): number | null {
    const same = rows.filter(x => String(x.date) === date)
    if (!same.length) return null
    return same.reduce((mn: number | null, x) => { const b = Number(x.balance_after) || 0; return mn == null || b < mn ? b : mn }, null)
  }
  return parts.filter(p => p && !p.archived).map(p => {
    // Origination anchor + its date (per-part original_* first, legacy fallback).
    const anchorRaw = Number(p.original_balance) > 0 ? Number(p.original_balance)
      : Number(p.start_balance) > 0 ? Number(p.start_balance) : null
    const anchor = anchorRaw != null ? r2(anchorRaw) : null
    const origDate = String(p.original_date || p.start_date || '')

    const mine = payments.filter(x => x?.loan_part_id === p.id)
    const wb = mine.filter(x => x.balance_after != null && x.date)
    const newestDate = edgeDate(wb, true)
    const earliestDate = edgeDate(wb, false)
    const current = newestDate != null ? (saldoAt(wb, newestDate) != null ? r2(saldoAt(wb, newestDate)!) : null) : null
    const startSaldo = earliestDate != null ? (saldoAt(wb, earliestDate) != null ? r2(saldoAt(wb, earliestDate)!) : null) : null

    let drift: number | null = null
    if (anchor != null && startSaldo != null && earliestDate != null) {
      // Amortisation the ledger actually logged between origination and the
      // opening Saldo — the only reduction we can account for.
      const amortRows = mine.filter(x => x.kind === 'amortization' && x.date
        && (!origDate || x.date >= origDate) && x.date <= earliestDate)
      const loggedAmort = amortRows.reduce((s, x) => s + (Number(x.amount) || 0), 0)
      if (origDate && origDate < earliestDate && amortRows.length === 0) {
        // Origination strictly before the ledger opens and nothing logged in
        // between → the gap is expected pre-import amortisation we can't see, so
        // never a banner (the 192 000 false-alarm case, silenced by construction).
        drift = null
      } else {
        // Either the origination sits within/after the window (the two should
        // coincide), or there IS logged amortisation to reconcile forward: the
        // opening Saldo should equal the anchor less that logged amortisation.
        // Any residual is genuine partial-import / stale-figure evidence.
        drift = r2(anchor - loggedAmort - startSaldo)
      }
    }
    return { loan_part_id: p.id, label: p.label, current, start_balance: anchor, start_saldo: startSaldo, drift }
  })
}

// ── Bank / Mortgage resolvers (plan 103) ─────────────────────────────────────
// Pure lookups so the forecast and plan 104's profile lookup can reach a part's
// bank without threading ids through every call. Legacy rows lacking
// mortgage_id / bank resolve to null (an "unknown bank") without crashing.
export function mortgageForPart(part: LoanPart | null | undefined, mortgages: Mortgage[]): Mortgage | null {
  const id = part?.mortgage_id
  if (!id) return null
  return (mortgages || []).find(m => m?.id === id) ?? null
}
export function bankForPart(part: LoanPart | null | undefined, mortgages: Mortgage[], banks: Bank[]): Bank | null {
  const m = mortgageForPart(part, mortgages)
  if (!m?.bank_id) return null
  return (banks || []).find(b => b?.id === m.bank_id) ?? null
}

// ── Agreement scoping (plan 109b) ────────────────────────────────────────────
// An agreement spans the lifetime of one bank relationship (plan 109 lifecycle
// model): a villkorsändringsdag expires a RATE PERIOD, a same-bank restructure
// archives/creates PARTS within the agreement, and only a bank change closes
// an agreement. The bank-change RPC archives the AGREEMENT, not the old parts,
// so active scoping must go through the mortgage link — a part is out of the
// active picture because its agreement closed, not because its own archived
// flag flipped.

// The single active (unarchived) agreement, or null when none exists yet /
// only history remains. The database's partial unique index guarantees at
// most one.
export function activeMortgage(mortgages: Mortgage[]): Mortgage | null {
  return (mortgages || []).find(m => m && !m.archived) ?? null
}

// The parts attached to one agreement (archived parts included — history views
// and lifetime figures need them; active-debt callers layer the part-level
// archived filter via totalBalance et al.). A null/unknown agreement scopes to
// nothing: legacy unlinked rows are a repair state, never silently adopted.
export function partsForMortgage(parts: LoanPart[], mortgageId: string | null | undefined): LoanPart[] {
  if (!mortgageId) return []
  return (parts || []).filter(p => p?.mortgage_id === mortgageId)
}

// One agreement's ledger rows: part-linked rows through the agreement's parts;
// partless rows (down payments) through their own mortgage_id provenance
// (plan 109a). Used for archived-agreement history views and for scoping the
// active forecast so it can never consume an old agreement's transactions.
export function paymentsForMortgage(payments: Payment[], parts: LoanPart[], mortgageId: string | null | undefined): Payment[] {
  if (!mortgageId) return []
  const ids = new Set(partsForMortgage(parts, mortgageId).map(p => p.id))
  return (payments || []).filter(p => p != null &&
    (p.loan_part_id ? ids.has(p.loan_part_id) : p.mortgage_id === mortgageId))
}

// Lifetime amortised principal across the FULL agreement history: every part
// (archived and old-agreement parts included) contributes its own
// origination-to-resolved-balance reduction exactly once. Debt transfers
// contribute zero by construction — a refinance payoff is never recorded as
// amortisation, so the old part keeps its closing balance (orig − closing)
// while the new part starts at that same figure (opening − current). The old
// closing debt and the new opening debt therefore cancel instead of double
// counting (plan 109 decision 6).
export function lifetimeAmortized(parts: LoanPart[], payments: Payment[]): number {
  return r2((parts || []).filter(p => p != null).reduce((s, p) =>
    s + Math.max(0, r2(partOriginal(p, payments) - partBalance(p, payments))), 0))
}

// Typed "rate terms missing" signal: the active parts with NO effective rate
// period (no period carrying a rate at all — the state every part is in right
// after a bank change, since rates are deliberately not copied). The forecast
// already returns null for such a part rather than projecting 0 %; this gives
// the UI the explicit list for its Lägg till räntevillkor prompt (109c).
export interface MissingRateTerms { loan_part_id: string; label: string }
export function partsMissingRateTerms(parts: LoanPart[], periods: RatePeriod[]): MissingRateTerms[] {
  return (parts || []).filter(p => p && !p.archived && !effectiveRatePeriod(p, periods || []))
    .map(p => ({ loan_part_id: p.id, label: p.label }))
}

// ── Copy preview (plan 109b — agreement-agnostic; plan 109 decision 4) ───────
// Pure function from (parts, payments, effective date) to proposed part drafts
// plus warnings. It knows nothing about the destination agreement — the
// change-bank wizard and a future same-bank restructure flow reuse it
// unchanged.
//
// Copies ONLY: the label; the resolved outstanding balance at the effective
// date (plan-107 canonical resolver) as the opening/original balance; the
// planned monthly amortisation effective AT that date as an editable
// suggestion (its start date is reset to the effective date and its end date
// cleared by the consumer — an old plan's dates belong to the old contract).
// Never copies: loan/account numbers, old origination amounts/dates, rate
// periods/rates/binding types/condition-change dates, payments/fees/down
// payments/extra amortisations, forecast rows, historical IDs/revisions/
// timestamps — the draft shape cannot even express them.
//
// The resolver's observed/estimated quality and warnings are carried through:
// malformed or uncertain history is surfaced, never silently turned into a
// clean opening balance.

export type CopyPreviewWarning = 'invalid-effective-date'

export interface CopyPartDraft {
  /** Reference to the part the draft was derived from (display only — never persisted onto the new part). */
  source_part_id: string
  label: string
  /** Resolved outstanding balance at the effective date — the proposed opening/original balance. */
  balance: number
  balance_quality: BalanceResolution['quality']
  balance_source: BalanceResolution['anchor']['source']
  /** Editable suggestion (kr/mån); null = no plan effective at the date. */
  planned_amortization: number | null
  warnings: BalanceWarning[]
}

export interface CopyPreview {
  effective_date: string
  drafts: CopyPartDraft[]
  total_balance: number
  /** True when any draft balance is an estimate — the wizard must warn before confirm. */
  estimated: boolean
  warnings: CopyPreviewWarning[]
}

export function copyPartsPreview(parts: LoanPart[], payments: Payment[], effectiveDate: string): CopyPreview {
  // A malformed effective date cannot anchor a balance: refuse with a typed
  // warning rather than resolving against a garbage as-of bound.
  if (!validLedgerDate(effectiveDate)) {
    return { effective_date: String(effectiveDate ?? ''), drafts: [], total_balance: 0, estimated: false, warnings: ['invalid-effective-date'] }
  }
  const drafts = (parts || []).filter(p => p && !p.archived).map((part): CopyPartDraft => {
    const resolved = resolvePartBalance(part, payments || [], effectiveDate)
    return {
      source_part_id: part.id,
      label: part.label,
      balance: resolved.balance,
      balance_quality: resolved.quality,
      balance_source: resolved.anchor.source,
      planned_amortization: effectiveDeclaredAmortization(part, effectiveDate),
      warnings: resolved.warnings,
    }
  })
  return {
    effective_date: effectiveDate,
    drafts,
    total_balance: r2(drafts.reduce((s, d) => s + d.balance, 0)),
    estimated: drafts.some(d => d.balance_quality === 'estimated'),
    warnings: [],
  }
}

// ── Contributions ──────────────────────────────────────────────────────────

// An extra amortering is an `amortization` row flagged as an insats. A
// down_payment is also is_insats but is NOT an extra amortering and keeps its
// own attribution behavior.
export function isExtraAmortering(p: Payment | null | undefined): boolean {
  return !!p && p.kind === 'amortization' && p.is_insats === true
}

export interface ExtraAmorteringAllocation {
  a: number
  b: number
  // `explicit` when the row carries a valid two-person split; `derived` when a
  // legacy row has no valid split and the allocation is computed from the
  // configured ownership percentages (a computed marker for the UI to surface).
  provenance: 'explicit' | 'derived'
}

// Resolve the person-level capital allocation for one extra amortering
// (`kind:'amortization' && is_insats`), independent of who actually paid the
// bank (`paid_by`).
//
// - `explicit`: the row carries a VALID `paid_split` — both keys finite,
//   non-negative, and their öre-rounded sum equals the payment amount. A valid
//   100/0 split keeps both keys and permits one zero.
// - `derived`: no valid split → allocate by the configured ownership
//   percentages, giving the rounding remainder to the second person so
//   `a + b === amount` at öre precision.
//
// A malformed explicit split (non-finite, negative, or not summing to the
// amount) is treated as absent → falls back to `derived`. Guarding against
// persisting such a split lives in makePayment/the dialog; here, an invalid
// explicit split simply means "no explicit allocation → derive it".
export function extraAmorteringAllocation(payment: Payment, s: Partial<MortgageSettings>): ExtraAmorteringAllocation {
  const amount = r2(Number(payment?.amount) || 0)
  const split = payment?.paid_split
  if (split) {
    const a = Number(split.a), b = Number(split.b)
    if (isFinite(a) && isFinite(b) && a >= 0 && b >= 0 && r2(r2(a) + r2(b)) === amount) {
      return { a: r2(a), b: r2(b), provenance: 'explicit' }
    }
  }
  const pct = ownerPercents(s)
  const a = r2(amount * (pct.a || 0) / 100)
  const b = r2(amount - a)
  return { a, b, provenance: 'derived' }
}

export function contributionSplit(payments: Payment[], contributions: Contribution[], s: Partial<MortgageSettings>) {
  const tot = { a: 0, b: 0, joint: 0 }
  const canonicalLegacyIds = new Set((payments || []).map(p => p?.id).filter(Boolean))
  for (const c of contributions || []) {
    if (!c || canonicalLegacyIds.has(LEGACY_CONTRIBUTION_PAYMENT_PREFIX + c.id)) continue
    tot[normPaidBy(c.owner)] += Number(c.amount) || 0
  }
  for (const p of payments || []) {
    if (p?.source === 'predicted') continue
    if (p?.kind !== 'amortization' && p?.kind !== 'down_payment') continue
    // An extra amortering always splits between the two people, independent of
    // who paid the bank: an explicit reviewed split when present, otherwise a
    // deterministic split by the configured ownership percentages (a legacy
    // unsplit row is NO longer credited in full to its payer).
    if (isExtraAmortering(p)) {
      const alloc = extraAmorteringAllocation(p, s)
      tot.a += alloc.a
      tot.b += alloc.b
      continue
    }
    // An explicit per-payment allocation (a co-funded insats) wins over paid_by.
    if (p.paid_split && ((Number(p.paid_split.a) || 0) || (Number(p.paid_split.b) || 0))) {
      tot.a += Number(p.paid_split.a) || 0
      tot.b += Number(p.paid_split.b) || 0
    } else {
      tot[normPaidBy(p.paid_by)] += Number(p.amount) || 0
    }
  }
  // Betalning/Ränta rows have no reliable individual payer attribution. Their
  // inferred principal therefore enters the joint bucket and follows the
  // configured ownership-target split. Explicit amortering above remains
  // attributable via paid_by/paid_split.
  tot.joint += inferredPaymentPrincipal((payments || []).filter(p => p?.source !== 'predicted')).principal
  const pct = ownerPercents(s), aJ = r2(tot.joint * (pct.a || 50) / 100)
  const aT = r2(tot.a + aJ), bT = r2(tot.b + (tot.joint - aJ)), sum = r2(aT + bT)
  return { a: aT, b: bT, joint: r2(tot.joint), total: sum, a_pct: sum > 0 ? r2(aT / sum * 100) : (pct.a || 50), b_pct: sum > 0 ? r2(bT / sum * 100) : (pct.b || 50) }
}

export function settlement(payments: Payment[], contributions: Contribution[], s: Partial<MortgageSettings>) {
  const split = contributionSplit(payments, contributions, s)
  const pct = ownerPercents(s), tA = r2(split.total * (pct.a || 50) / 100), aO = r2(split.a - tA)
  return { a_contributed: split.a, b_contributed: split.b, total: split.total, target_a: tA, a_over: aO, owes: aO > 0.005 ? 'b' as Owner : (aO < -0.005 ? 'a' as Owner : null), amount: r2(Math.abs(aO)) }
}
