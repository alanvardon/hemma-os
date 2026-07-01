// manadsavslut.ts — Månadsavslut (household month-end close): the PURE core.
// TypeScript port of manadsavslut.js — CSV parsing, column auto-mapping, owed-share
// math, netting/settlement, month helpers and spend analytics. No DOM/storage.
// People are two keys 'a' / 'b' with editable names; every shared item is a
// directed debt: debtor (owed_by) owes creditor (fronted_by) the amount.

export type Person = 'a' | 'b'
export type Treatment = 'split' | 'full' | 'pending' | 'exclude'

export interface MonthEndSettings {
  person_a_name: string
  person_b_name: string
  currency: string
  default_split: boolean
}

// One personal line-item carved out of a transaction before the split. The
// `person` IS the owner; `amount` is their personal portion; `note` is optional.
export interface PersonalEntry { person: Person; amount: number; note: string }

export interface Item {
  id: string
  created_at: string
  date_purchased: string
  description: string
  enter_amount: number
  split: boolean
  amount: number
  fronted_by: Person
  owed_by: Person
  paid: boolean
  // "ask later": split-vs-full is undecided; excluded from settlement until resolved.
  pending: boolean
  payment_id: string | null
  note: string
  // Personal carve-out: an itemised list of amounts within this transaction that
  // are personal to one person, taken out BEFORE the 50/50 split. The line stays
  // whole (enter_amount is untouched); the entries only shift the owed share.
  // personal_a / personal_b are DERIVED per-person sums (cached on save) so the
  // split math + the open-list toggle can stay unchanged; personal_items is the
  // source of truth.
  personal_items: PersonalEntry[]
  personal_a: number
  personal_b: number
  source: string
}

export interface Payment {
  id: string
  created_at: string
  item_ids: string[]
  from_person: Person | null
  to_person: Person | null
  amount: number
  period_label: string
  note: string
}

export interface CsvResult { delimiter: string; headers: string[]; rows: string[][] }
export interface ColMapping { date_purchased: number | null; description: number | null; enter_amount: number | null }

export function defaultSettings(): MonthEndSettings {
  return { person_a_name: 'Alex', person_b_name: 'Sam', currency: 'SEK', default_split: true }
}

export function otherPerson(p: Person): Person { return p === 'a' ? 'b' : 'a' }

// ── CSV parsing ──────────────────────────────────────────────────────────────

export function detectDelimiter(text: string | null): string {
  const firstLine = String(text || '').split(/\r?\n/)[0] || ''
  const candidates = [',', ';', '\t']
  let best = ',', bestCount = -1
  candidates.forEach(d => {
    const count = firstLine.split(d).length - 1
    if (count > bestCount) { bestCount = count; best = d }
  })
  return best
}

export function parseCsv(text: string | null, opts?: { delimiter?: string }): CsvResult {
  if (text == null) return { delimiter: ',', headers: [], rows: [] }
  let s = String(text)
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1) // strip BOM
  const delim = opts?.delimiter || detectDelimiter(s)

  let all: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else { field += c }
      continue
    }
    if (c === '"') { inQuotes = true }
    else if (c === delim) { row.push(field); field = '' }
    else if (c === '\r') { /* swallow; the \n closes the row */ }
    else if (c === '\n') { row.push(field); all.push(row); field = ''; row = [] }
    else { field += c }
  }
  row.push(field)
  all.push(row)
  all = all.filter(r => !(r.length === 1 && r[0].trim() === ''))

  return { delimiter: delim, headers: all.length ? all[0] : [], rows: all.slice(1) }
}

// Locale-robust money parser → number, or NaN for blank/garbage.
export function parseAmount(raw: string | number | null | undefined): number {
  if (raw == null) return NaN
  let s = String(raw).trim()
  if (!s) return NaN
  let neg = false
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1) }
  s = s.replace(/−/g, '-')
  if (s.indexOf('-') !== -1) neg = true
  s = s.replace(/[^0-9.,]/g, '')
  if (!s) return NaN
  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')
  const decSep = lastComma > lastDot ? ',' : (lastDot > -1 ? '.' : '')
  if (decSep) {
    const thouSep = decSep === ',' ? '.' : ','
    s = s.split(thouSep).join('').replace(decSep, '.')
  }
  const n = parseFloat(s)
  if (isNaN(n)) return NaN
  return neg ? -n : n
}

// ── Column auto-mapping ──────────────────────────────────────────────────────

export function autoMapColumns(headers: string[]): ColMapping {
  const H = (headers || []).map(h => String(h == null ? '' : h).toLowerCase().trim())
  function find(re: RegExp): number | null {
    for (let i = 0; i < H.length; i++) { if (re.test(H[i])) return i }
    return null
  }
  return {
    date_purchased: find(/(date|datum|köpdatum|kopdatum|purchase|transaktionsdat|bokf)/),
    description: find(/(desc|beskriv|text|narrativ|merchant|butik|mottagare|referen|namn|specifikation|titel)/),
    enter_amount: find(/(amount|belopp|summa|\bsum\b|debit|värde|varde|transaktionsbelopp|kostnad|pris)/),
  }
}

// ── Item math ────────────────────────────────────────────────────────────────

// Owed share with personal carve-outs. Under Split, personal items are removed
// before the 50/50, then the non-payer's own personal is added back to what they
// owe: owed = round2(shared_base/2) + round2(personal_[owed_by]). "Owes all"
// (split=false) ignores personal — the other already owes the whole line.
// With personal = 0 this is a plain 50/50 split of the whole line.
export function computeOwed(enterAmount: number, split: boolean, frontedBy: Person, personalA = 0, personalB = 0): number {
  const enter = Number(enterAmount)
  if (!isFinite(enter)) return 0
  if (!split) return r2(enter)
  const pa = Number(personalA) || 0, pb = Number(personalB) || 0
  const base = enter - pa - pb
  const ownedByOther = otherPerson(frontedBy) === 'a' ? pa : pb
  return r2(base / 2) + r2(ownedByOther)
}

// Per-person totals from a personal-entry list — the derived personal_a / personal_b.
export function personalSums(entries: PersonalEntry[] | null | undefined): { a: number; b: number } {
  let a = 0, b = 0
  ;(entries || []).forEach(e => {
    if (!e) return
    const amt = Number(e.amount) || 0
    if (e.person === 'b') b += amt; else a += amt
  })
  return { a: r2(a), b: r2(b) }
}

// Normalize a raw personal-entry list (clamp person, coerce amount, default note).
export function normalizePersonalEntries(raw: unknown): PersonalEntry[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(e => e && typeof e === 'object')
    .map(e => {
      const r = e as Record<string, unknown>
      return { person: (r.person === 'b' ? 'b' : 'a') as Person, amount: Number(r.amount) || 0, note: String(r.note == null ? '' : r.note) }
    })
    .filter(e => e.amount > 0)
}

export function classifyToItemFields(classification: Treatment | string, frontedBy: Person): { split: boolean; owed_by: Person; pending?: boolean } | null {
  if (classification === 'split') return { split: true, owed_by: otherPerson(frontedBy) }
  if (classification === 'full') return { split: false, owed_by: otherPerson(frontedBy) }
  // 'pending' = decision deferred ("ask later"): an item is still created so it's not
  // lost, with a provisional 50/50 split, but pending keeps it out of the math.
  if (classification === 'pending') return { split: true, owed_by: otherPerson(frontedBy), pending: true }
  return null
}

export type ItemDraft = Partial<Omit<Item, 'fronted_by' | 'owed_by'>> & { fronted_by?: Person; owed_by?: Person }

export function makeItem(partial: ItemDraft): Omit<Item, 'id' | 'created_at'> {
  partial = partial || {}
  const enter = Number(partial.enter_amount) || 0
  const split = partial.split === undefined ? true : !!partial.split
  const fronted: Person = partial.fronted_by === 'b' ? 'b' : 'a'
  // personal_items is the source of truth; the per-person sums are derived from it.
  const entries = normalizePersonalEntries(partial.personal_items)
  const sums = personalSums(entries)
  return {
    date_purchased: partial.date_purchased || '',
    description: partial.description || '',
    enter_amount: enter,
    split,
    amount: partial.amount === undefined ? computeOwed(enter, split, fronted, sums.a, sums.b) : Number(partial.amount),
    fronted_by: fronted,
    owed_by: partial.owed_by || otherPerson(fronted),
    paid: !!partial.paid,
    pending: !!partial.pending,
    payment_id: partial.payment_id || null,
    note: partial.note || '',
    personal_items: entries,
    personal_a: sums.a,
    personal_b: sums.b,
    source: partial.source || 'manual',
  }
}

// ── Import: sign inference & duplicate spotting ──────────────────────────────

export function inferSpendSign(amounts: number[]): number {
  let pos = 0, neg = 0
  ;(amounts || []).forEach(raw => {
    const n = Number(raw)
    if (!isFinite(n) || n === 0) return
    if (n > 0) pos++; else neg++
  })
  return neg > pos ? -1 : 1
}

function itemFingerprint(it: Partial<Item> | null): string {
  it = it || {}
  const date = String(it.date_purchased == null ? '' : it.date_purchased).trim()
  const desc = String(it.description == null ? '' : it.description).trim().toLowerCase().replace(/\s+/g, ' ')
  const amt = Math.round((Number(it.enter_amount) || 0) * 100) / 100
  const card = it.fronted_by === 'b' ? 'b' : 'a'
  return date + '|' + desc + '|' + amt + '|' + card
}

export function flagDuplicates(existing: (Partial<Item> | null)[], candidates: (Partial<Item> | null)[]): boolean[] {
  const counts: Record<string, number> = {}
  ;(existing || []).forEach(it => {
    if (!it) return
    const k = itemFingerprint(it)
    counts[k] = (counts[k] || 0) + 1
  })
  return (candidates || []).map(c => {
    if (!c) return false
    const k = itemFingerprint(c)
    if (counts[k] > 0) { counts[k]--; return true }
    return false
  })
}

// ── Netting & settlement ─────────────────────────────────────────────────────

export interface Transfer { from: Person | null; to: Person | null; amount: number }

export function netBalance(items: Partial<Item>[]): Transfer {
  const net: Record<Person, number> = { a: 0, b: 0 }
  ;(items || []).forEach(it => {
    if (!it) return
    const amt = Number(it.amount)
    if (!isFinite(amt) || amt === 0) return
    const creditor = it.fronted_by, debtor = it.owed_by
    if (!creditor || !debtor || creditor === debtor) return
    net[creditor] += amt
    net[debtor] -= amt
  })
  const a = Math.round(net.a * 100) / 100
  if (a > 0) return { from: 'b', to: 'a', amount: a }
  if (a < 0) return { from: 'a', to: 'b', amount: Math.round(-a * 100) / 100 }
  return { from: null, to: null, amount: 0 }
}

export function buildSettlement(items: Item[], opts?: { period_label?: string; note?: string }): Omit<Payment, 'id' | 'created_at'> {
  opts = opts || {}
  const unpaid = (items || []).filter(it => it && !it.paid && !it.pending)
  const bal = netBalance(unpaid)
  return {
    from_person: bal.from,
    to_person: bal.to,
    amount: bal.amount,
    item_ids: unpaid.map(it => it.id).filter(Boolean),
    period_label: opts.period_label || '',
    note: opts.note || '',
  }
}

// ── Month helpers ────────────────────────────────────────────────────────────

export function monthKey(dateStr: string | null | undefined): string {
  const s = String(dateStr == null ? '' : dateStr).trim()
  const mm = (x: string) => (x.length < 2 ? '0' + x : x)
  let m = /(\d{4})[-/](\d{1,2})/.exec(s)
  if (m && +m[2] >= 1 && +m[2] <= 12) return m[1] + '-' + mm(m[2])
  m = /(\d{1,2})[./](\d{1,2})[./](\d{4})/.exec(s)
  if (m && +m[2] >= 1 && +m[2] <= 12) return m[3] + '-' + mm(m[2])
  return ''
}

export function monthLabel(mk: string): string {
  if (!mk) return 'Utan datum · No date'
  const m = /^(\d{4})-(\d{2})$/.exec(mk)
  if (!m) return mk
  try {
    const s = new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString('sv-SE', { month: 'long', year: 'numeric' })
    return s.charAt(0).toUpperCase() + s.slice(1)
  } catch { return mk }
}

export function monthsWithOpenItems(items: Item[]): string[] {
  const set: Record<string, boolean> = {}
  ;(items || []).forEach(it => { if (it && !it.paid) set[monthKey(it.date_purchased)] = true })
  return Object.keys(set).sort((a, b) => {
    if (a === '') return 1; if (b === '') return -1; return b.localeCompare(a)
  })
}

export function itemsForMonth(items: Item[], mk: string): Item[] {
  return (items || []).filter(it => it && monthKey(it.date_purchased) === mk)
}

// ── Spending categories & analytics ──────────────────────────────────────────

interface Category { key: string; label: string; test: RegExp }
const CATEGORIES: Category[] = [
  { key: 'groceries', label: 'Groceries', test: /\b(ica|coop|hemköp|hemkop|willys|lidl|city ?gross|citygross|maxi|stormarknad|tempo|matdax|matöppet|matoppet|netto|mathem|linas|matkasse|matkassen|nära|nara|dagligvar|grocer|supermarket)\b/ },
  { key: 'dining', label: 'Dining & café', test: /(restaurang|restaurant|pizz|sushi|mcdonald|\bmax\b|burger|kebab|café|\bcafe\b|espresso|\bbar\b|\bpub\b|foodora|uber ?eats|wolt|bistro|brasserie|\bkök\b|o'?learys|vapiano|sibylla|waynes|barista|gateau)/ },
  { key: 'transport', label: 'Transport & fuel', test: /\b(sl|sj|västtrafik|vasttrafik|skånetrafik|skanetrafik|taxi|uber|bolt|circle ?k|okq8|preem|st1|shell|ingo|tanka|qstar|parker|parkster|easypark|sas|norwegian|flyg|pendel|hyrbil)\b/ },
  { key: 'health', label: 'Health & pharmacy', test: /(apotek|kronans|lloyds|hjärtat|hjartat|vårdcentral|vardcentral|tandläk|tandlak|optiker|\bgym\b|\bsats\b|nordic wellness|fitness24|friskis)/ },
  { key: 'subs', label: 'Subscriptions', test: /(spotify|netflix|\bhbo\b|disney|viaplay|youtube|storytel|audible|prime video|amazon prime|\bcmore\b|c more|tv4 play|dplay|apple\.com|itunes|google ?(one|play|storage)|microsoft|adobe|patreon)/ },
  { key: 'shopping', label: 'Shopping & retail', test: /(h&m|\bhm\b|zara|clas ohlson|ikea|åhlén|ahlen|elgiganten|mediamarkt|media markt|webhall|kjell|stadium|\bxxl\b|intersport|lindex|kappahl|dressmann|nelly|zalando|cdon|amazon|boozt|jollyroom|rusta|jula|biltema|dollarstore|lager 157|gina tricot|monki|weekday)/ },
  { key: 'home', label: 'Home & bills', test: /(\bhyra\b|vattenfall|\beon\b|e\.on|ellevio|telia|telenor|\btre\b|comviq|hallon|bredband|fortum|försäkring|forsakring|elnät|elnat|fjärrvärme|sophämtning|\bbrf\b)/ },
]

function categorize(description: string | null | undefined): string {
  const s = String(description == null ? '' : description).toLowerCase()
  for (let i = 0; i < CATEGORIES.length; i++) { if (CATEGORIES[i].test.test(s)) return CATEGORIES[i].key }
  return 'other'
}

function categoryLabel(key: string): string {
  for (let i = 0; i < CATEGORIES.length; i++) { if (CATEGORIES[i].key === key) return CATEGORIES[i].label }
  return 'Other'
}

function r2(n: number): number { return Math.round((Number(n) || 0) * 100) / 100 }

export interface CategorySpend { key: string; label: string; total: number; count: number }
export function spendByCategory(items: Item[]): CategorySpend[] {
  const map: Record<string, CategorySpend> = {}
  ;(items || []).forEach(it => {
    if (!it) return
    const amt = Number(it.enter_amount) || 0
    if (amt <= 0) return
    const key = categorize(it.description)
    if (!map[key]) map[key] = { key, label: categoryLabel(key), total: 0, count: 0 }
    map[key].total += amt; map[key].count++
  })
  return Object.keys(map).map(k => { map[k].total = r2(map[k].total); return map[k] })
    .sort((a, b) => b.total - a.total)
}

export interface MonthSpend { month: string; label: string; total: number; count: number }
export function grocerySpendByMonth(items: Item[]): MonthSpend[] {
  const map: Record<string, MonthSpend> = {}
  ;(items || []).forEach(it => {
    if (!it || categorize(it.description) !== 'groceries') return
    const amt = Number(it.enter_amount) || 0
    if (amt <= 0) return
    const mk = monthKey(it.date_purchased)
    if (!map[mk]) map[mk] = { month: mk, label: monthLabel(mk), total: 0, count: 0 }
    map[mk].total += amt; map[mk].count++
  })
  return Object.keys(map).map(k => { map[k].total = r2(map[k].total); return map[k] })
    .sort((a, b) => String(a.month).localeCompare(String(b.month)))
}

export function fillMonthGaps(rows: MonthSpend[]): MonthSpend[] {
  const dated = (rows || []).filter(r => r && /^\d{4}-\d{2}$/.test(r.month))
    .sort((a, b) => String(a.month).localeCompare(String(b.month)))
  if (dated.length < 2) return dated
  const byKey: Record<string, MonthSpend> = {}
  dated.forEach(r => { byKey[r.month] = r })
  let y = Number(dated[0].month.slice(0, 4)), mo = Number(dated[0].month.slice(5, 7))
  const endY = Number(dated[dated.length - 1].month.slice(0, 4)), endMo = Number(dated[dated.length - 1].month.slice(5, 7))
  const out: MonthSpend[] = []
  while (y < endY || (y === endY && mo <= endMo)) {
    const mk = y + '-' + (mo < 10 ? '0' : '') + mo
    out.push(byKey[mk] || { month: mk, label: monthLabel(mk), total: 0, count: 0 })
    mo++; if (mo > 12) { mo = 1; y++ }
  }
  return out
}
