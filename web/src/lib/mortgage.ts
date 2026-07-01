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
}

export type PaymentKind = 'interest' | 'amortization' | 'payment' | 'loan' | 'fee' | 'other'
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

export interface MortgageSettings {
  property_name: string; owner_a_name: string; owner_b_name: string
  my_ownership_pct: number; i_am: Owner; currency: string; ranteavdrag: boolean
  household_income_yearly: number | null; import_presets: Record<string, ColNameMapping>
  track_contributions: boolean
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

export function makeLoanPart(p: Partial<LoanPart>): Omit<LoanPart, 'id' | 'created_at'> {
  return {
    label: p.label || '', loan_number: p.loan_number || '',
    start_balance: r2(Number(p.start_balance) || 0),
    start_date: p.start_date || '', archived: !!p.archived,
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
  return {
    loan_part_id: p.loan_part_id || null, date: p.date || '', kind,
    description: p.description || '', amount: r2(Math.abs(Number(p.amount) || 0)),
    balance_after: (bal == null || (bal as unknown) === '') ? null : r2(Math.abs(Number(bal) || 0)),
    paid_by: normPaidBy(p.paid_by), source: p.source || 'manual', is_insats: !!p.is_insats,
    paid_split: p.paid_split ? { a: r2(Math.abs(Number(p.paid_split.a) || 0)), b: r2(Math.abs(Number(p.paid_split.b) || 0)) } : null,
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

export function partBalance(part: LoanPart, payments: Payment[]): number {
  if (!part) return 0
  const mine = payments.filter(p => p?.loan_part_id === part.id)
  const withBal = mine.filter(p => p.balance_after != null)
  if (withBal.length) {
    const latest = withBal.reduce((mx, p) => String(p.date) > mx ? String(p.date) : mx, '')
    const same = withBal.filter(p => String(p.date) === latest)
    return Math.max(0, r2(same.reduce((mn: number | null, p) => {
      const b = Number(p.balance_after); return mn == null || b < mn ? b : mn
    }, null) as number))
  }
  const start = Number(part.start_balance) || 0, sd = part.start_date
  return Math.max(0, r2(start - mine.filter(p => p.kind === 'amortization' && !(sd && p.date < sd))
    .reduce((s, p) => s + (Number(p.amount) || 0), 0)))
}

function partOriginal(part: LoanPart, payments: Payment[]): number {
  if (Number(part?.start_balance) > 0) return r2(Number(part.start_balance))
  const mine = payments.filter(p => p?.loan_part_id === part?.id)
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
// Per-owner split of cost-basis equity, using the funded percentages from
// contributionSplit (deposit contributions + amortering by paid_by) applied to
// the cost-basis total, so the two halves always sum to the headline.
export function costBasisSplit(price: number, balance: number, payments: Payment[], contributions: Contribution[], s: Partial<MortgageSettings>): { a: number; b: number; a_pct: number; b_pct: number } {
  const eq = costBasisEquity(price, balance)
  const cs = contributionSplit(payments, contributions, s)
  const a = r2(eq * (cs.a_pct || 50) / 100)
  return { a, b: r2(eq - a), a_pct: cs.a_pct, b_pct: cs.b_pct }
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

function monthKey(d: string | null | undefined): string {
  const s = String(d ?? '').trim()
  let m = /(\d{4})[-/](\d{2})/.exec(s)
  if (m) return m[1] + '-' + m[2]
  m = /(\d{2})[./](\d{2})[./](\d{4})/.exec(s)
  return m ? m[3] + '-' + m[2] : ''
}

function monthLabel(mk: string): string {
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
    ...parts.map(p => monthKey(p?.start_date)),
    ...payments.map(p => monthKey(p?.date)),
  ].filter(Boolean).sort() as string[]
  return keys.length ? enumMonths(keys[0], keys[keys.length - 1]) : []
}

function partBalAsOfMk(part: LoanPart, payments: Payment[], mk: string): number {
  const mine = payments.filter(p => p?.loan_part_id === part.id)
  const wb = mine.filter(p => p.balance_after != null && monthKey(p.date) <= mk)
  if (wb.length) {
    const lm = wb.reduce((mx, p) => { const k = monthKey(p.date); return k > mx ? k : mx }, '')
    const inM = wb.filter(p => monthKey(p.date) === lm)
    const ld = inM.reduce((mx, p) => String(p.date) > mx ? String(p.date) : mx, '')
    const sd = inM.filter(p => String(p.date) === ld)
    return Math.max(0, r2(sd.reduce((mn: number | null, p) => {
      const b = Number(p.balance_after); return mn == null || b < mn ? b : mn
    }, null) as number))
  }
  const start = Number(part.start_balance) || 0
  return Math.max(0, r2(start - mine.filter(p =>
    p.kind === 'amortization' && monthKey(p.date) <= mk && !(part.start_date && p.date < part.start_date)
  ).reduce((s, p) => s + (Number(p.amount) || 0), 0)))
}

function balanceTimeline(parts: LoanPart[], payments: Payment[]) {
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
  parts: LoanPart[], payments: Payment[], valuations: Valuation[], s: Partial<MortgageSettings>
): ETEntry[] {
  const pct = clamp(s.my_ownership_pct ?? 50), me = s.i_am === 'b' ? 'b' : 'a'
  return balanceTimeline(parts, payments).map(row => {
    const value = propertyValue(valuations, row.month + '-31')
    const eq = r2(value - row.balance), mine = r2(eq * pct / 100), partner = r2(eq - mine)
    return {
      month: row.month, label: row.label, value, balance: row.balance, bank: row.balance,
      equity: eq, my_equity: mine,
      a_equity: me === 'a' ? mine : partner, b_equity: me === 'a' ? partner : mine, partner_equity: partner,
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
  if (!part) return 0
  const mine = payments.filter(p => p?.loan_part_id === part.id && !(asOf && p.date && p.date > asOf))
  const wb = mine.filter(p => p.balance_after != null && p.date)
  if (wb.length) {
    const ld = wb.reduce((mx, p) => String(p.date) > mx ? String(p.date) : mx, '')
    const sd = wb.filter(p => String(p.date) === ld)
    return Math.max(0, r2(sd.reduce((mn: number | null, p) => {
      const b = Number(p.balance_after); return mn == null || b < mn ? b : mn
    }, null) as number))
  }
  const start = Number(part.start_balance) || 0
  return Math.max(0, r2(start - mine.filter(p =>
    p.kind === 'amortization' && !(part.start_date && p.date < part.start_date)
  ).reduce((s, p) => s + (Number(p.amount) || 0), 0)))
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

function projectBalance(
  parts: LoanPart[], payments: Payment[],
  opts?: { startBalance?: number; monthlyAmortization?: number; extraMonthly?: number; maxMonths?: number }
) {
  const balance = opts?.startBalance ?? totalBalance(parts, payments)
  const base = opts?.monthlyAmortization ?? monthlyAmortizationRate(parts, payments)
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

// ── Rate periods ───────────────────────────────────────────────────────────

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

export function reconcileBalance(parts: LoanPart[], payments: Payment[]) {
  function edge(rows: Payment[], newest: boolean): number | null {
    if (!rows.length) return null
    const e = rows.reduce((acc: string | null, x) => acc == null ? String(x.date) : (newest ? (x.date > acc ? x.date : acc) : (x.date < acc ? x.date : acc)), null) as string
    return rows.filter(x => x.date === e).reduce((mn: number | null, x) => { const b = Number(x.balance_after) || 0; return mn == null || b < mn ? b : mn }, null)
  }
  return parts.filter(p => p && !p.archived).map(p => {
    const mine = payments.filter(x => x?.loan_part_id === p.id)
    const wb = mine.filter(x => x.balance_after != null && x.date)
    const scoped = (p.start_date ? wb.filter(x => x.date >= p.start_date) : wb) || wb
    const hasStart = Number(p.start_balance) > 0
    const current = wb.length ? (edge(wb, true) != null ? r2(edge(wb, true)!) : null) : null
    const startSaldo = (scoped.length ? scoped : wb).length ? (edge(scoped.length ? scoped : wb, false) != null ? r2(edge(scoped.length ? scoped : wb, false)!) : null) : null
    const drift = hasStart && startSaldo != null ? r2(Number(p.start_balance) - startSaldo) : null
    return { loan_part_id: p.id, label: p.label, current, start_balance: hasStart ? r2(Number(p.start_balance)) : null, start_saldo: startSaldo, drift }
  })
}

// ── Contributions ──────────────────────────────────────────────────────────

export function contributionSplit(payments: Payment[], contributions: Contribution[], s: Partial<MortgageSettings>) {
  const tot = { a: 0, b: 0, joint: 0 }
  for (const c of contributions || []) if (c) tot[normPaidBy(c.owner)] += Number(c.amount) || 0
  for (const p of payments || []) {
    if (p?.kind !== 'amortization') continue
    // An explicit per-payment allocation (a co-funded insats) wins over paid_by.
    if (p.paid_split && ((Number(p.paid_split.a) || 0) || (Number(p.paid_split.b) || 0))) {
      tot.a += Number(p.paid_split.a) || 0
      tot.b += Number(p.paid_split.b) || 0
    } else {
      tot[normPaidBy(p.paid_by)] += Number(p.amount) || 0
    }
  }
  const pct = ownerPercents(s), aJ = r2(tot.joint * (pct.a || 50) / 100)
  const aT = r2(tot.a + aJ), bT = r2(tot.b + (tot.joint - aJ)), sum = r2(aT + bT)
  return { a: aT, b: bT, joint: r2(tot.joint), total: sum, a_pct: sum > 0 ? r2(aT / sum * 100) : (pct.a || 50), b_pct: sum > 0 ? r2(bT / sum * 100) : (pct.b || 50) }
}

export function settlement(payments: Payment[], contributions: Contribution[], s: Partial<MortgageSettings>) {
  const split = contributionSplit(payments, contributions, s)
  const pct = ownerPercents(s), tA = r2(split.total * (pct.a || 50) / 100), aO = r2(split.a - tA)
  return { a_contributed: split.a, b_contributed: split.b, total: split.total, target_a: tA, a_over: aO, owes: aO > 0.005 ? 'b' as Owner : (aO < -0.005 ? 'a' as Owner : null), amount: r2(Math.abs(aO)) }
}
