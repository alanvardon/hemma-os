import { DEFAULT_CONSTANTS, DEFAULT_INPUTS, type Constants, type Inputs } from './calc'
import type { Bank, Contribution, LoanPart, Mortgage, MortgageSettings, Payment as MortgagePayment, RatePeriod, Valuation } from './mortgage'
import { BILLING_MODES, BILLING_SOURCES, defaultSettings as defaultMortgageSettings } from './mortgage'
import type { Item, MonthEndSettings, Payment as MonthEndPayment, PersonalEntry } from './manadsavslut'
import { defaultSettings as defaultMonthEndSettings } from './manadsavslut'
import type { SalarySubmission } from './hushallsbudget'

declare const persistenceBrand: unique symbol
type Brand<Value, Name extends string> = Value & { readonly [persistenceBrand]: Name }

export type ScenarioId = Brand<string, 'ScenarioId'>
export type ISODate = Brand<string, 'ISODate'>
export type ISODateTime = Brand<string, 'ISODateTime'>
export type YearMonth = Brand<string, 'YearMonth'>
export type LoanPartId = Brand<string, 'LoanPartId'>
export type PaymentId = Brand<string, 'PaymentId'>
export type ItemId = Brand<string, 'ItemId'>

export interface ParseIssue { path: string; reason: string }
export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: ParseIssue[] }
export interface RejectedRecord {
  record: string
  reason: string
  /** Optional structural path to the rejected field. Never contains record values. */
  path?: string
}

export interface PersistedScenario {
  id: ScenarioId
  name: string
  /** Empty is the intentionally preserved legacy "unknown" timestamp. */
  savedAt: ISODateTime | ISODate | ''
  inputs: Inputs
  constants?: Constants
}

export interface PersistedLineItem { id: ItemId; label: string; amount: number }
export interface BostadPrefs {
  globalConstants: Constants | null
  driftItems: PersistedLineItem[]
  savingsItems: PersistedLineItem[]
}
export interface BostadSession {
  inputs: Inputs
  activeScenarioId: ScenarioId | null
  isDirty: boolean
}

/** Shared narrow guard for JSON objects (arrays are intentionally excluded). */
export const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  !!raw && typeof raw === 'object' && !Array.isArray(raw)

/**
 * JSON values from a database or local cache cannot contain NaN/Infinity, but
 * hand-written backups can. Validate the entire value before a store narrows
 * it to its persisted row type; no malformed numeric may reach domain code.
 */
export function parseFiniteJson(raw: unknown, path = 'value'): ParseResult<unknown> {
  if (raw === null || typeof raw === 'string' || typeof raw === 'boolean') return success(raw)
  if (typeof raw === 'number') return Number.isFinite(raw) ? success(raw) : failure(path, 'must be a finite number')
  if (Array.isArray(raw)) {
    const values: unknown[] = []
    const issues: ParseIssue[] = []
    raw.forEach((entry, index) => {
      const parsed = parseFiniteJson(entry, `${path}[${index}]`)
      if (parsed.ok) values.push(valueOf(parsed)); else issues.push(...parsed.issues)
    })
    return issues.length ? { ok: false, issues } : success(values)
  }
  if (!isRecord(raw)) return failure(path, 'must be a JSON value')
  const value: Record<string, unknown> = {}
  const issues: ParseIssue[] = []
  Object.entries(raw).forEach(([key, entry]) => {
    const parsed = parseFiniteJson(entry, `${path}.${key}`)
    if (parsed.ok) value[key] = valueOf(parsed); else issues.push(...parsed.issues)
  })
  return issues.length ? { ok: false, issues } : success(value)
}

/** Passive row reads salvage valid JSON records and name every rejected row. */
export function salvageFiniteJsonRows(raw: unknown, name: string): { value: Record<string, unknown>[]; rejected: RejectedRecord[] } {
  if (!Array.isArray(raw)) return { value: [], rejected: [{ record: name, reason: 'must be an array' }] }
  const value: Record<string, unknown>[] = []
  const rejected: RejectedRecord[] = []
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) { rejected.push({ record: `${name} ${index + 1}`, reason: 'must be an object' }); return }
    const parsed = parseFiniteJson(entry, name)
    if (!parsed.ok) { rejected.push({ record: `${name} ${index + 1}`, reason: parsed.issues[0].reason }); return }
    value.push(valueOf(parsed) as Record<string, unknown>)
  })
  return { value, rejected }
}

export const success = <T>(value: T): ParseResult<T> => ({ ok: true, value })
export const failure = <T = never>(path: string, reason: string): ParseResult<T> => ({ ok: false, issues: [{ path, reason }] })
export function parseString(raw: unknown, path: string): ParseResult<string> {
  return typeof raw === 'string' ? success(raw) : failure(path, 'must be a string')
}
export function parseBoolean(raw: unknown, path: string): ParseResult<boolean> {
  return typeof raw === 'boolean' ? success(raw) : failure(path, 'must be a boolean')
}
export function parseFiniteNumber(raw: unknown, path: string): ParseResult<number> {
  return typeof raw === 'number' && Number.isFinite(raw) ? success(raw) : failure(path, 'must be a finite number')
}
export function parseEnum<const T extends readonly string[]>(raw: unknown, values: T, path: string): ParseResult<T[number]> {
  return typeof raw === 'string' && (values as readonly string[]).includes(raw)
    ? success(raw as T[number]) : failure(path, `must be one of ${values.join(', ')}`)
}
export function parseArray<T>(raw: unknown, path: string, parseEntry: (entry: unknown, index: number) => ParseResult<T>): ParseResult<T[]> {
  if (!Array.isArray(raw)) return failure(path, 'must be an array')
  const value: T[] = []
  const issues: ParseIssue[] = []
  raw.forEach((entry, index) => {
    const parsed = parseEntry(entry, index)
    if (parsed.ok) value.push(valueOf(parsed))
    else issues.push(...parsed.issues.map((issue) => ({ ...issue, path: `${path}[${index}].${issue.path}` })))
  })
  return issues.length ? { ok: false, issues } : success(value)
}
const combine = <T>(results: ParseResult<unknown>[], value: T): ParseResult<T> => {
  const issues = results.flatMap((result) => result.ok ? [] : result.issues)
  return issues.length ? { ok: false, issues } : success(value)
}

function parseOpaqueId<Name extends string>(raw: unknown, path: string): ParseResult<Brand<string, Name>> {
  if (typeof raw !== 'string' || raw.trim().length === 0) return failure(path, 'must be a non-empty string')
  return success(raw as Brand<string, Name>)
}

export const parseScenarioId = (raw: unknown): ParseResult<ScenarioId> => parseOpaqueId(raw, 'id')
export const parseLoanPartId = (raw: unknown): ParseResult<LoanPartId> => parseOpaqueId(raw, 'id')
export const parsePaymentId = (raw: unknown): ParseResult<PaymentId> => parseOpaqueId(raw, 'id')
export const parseItemId = (raw: unknown): ParseResult<ItemId> => parseOpaqueId(raw, 'id')

/** Constructors are only for ids the application has just generated itself. */
export const scenarioId = (raw: string): ScenarioId => raw as ScenarioId
export const loanPartId = (raw: string): LoanPartId => raw as LoanPartId
export const paymentId = (raw: string): PaymentId => raw as PaymentId
export const itemId = (raw: string): ItemId => raw as ItemId
export const isoDate = (raw: string): ISODate => raw as ISODate
export const isoDateTime = (raw: string): ISODateTime => raw as ISODateTime
export const yearMonth = (raw: string): YearMonth => raw as YearMonth

export function parseISODate(raw: unknown): ParseResult<ISODate> {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return failure('date', 'must be an ISO date')
  const [year, month, day] = raw.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return failure('date', 'must be a real calendar date')
  }
  return success(raw as ISODate)
}

/**
 * Compatibility boundary for Månadsavslut item dates only.
 * The historical CSV writer persisted exact zero-padded DD/MM/YYYY strings.
 * The owner confirmed these are day-first, so 01/02/2026 means 2026-02-01.
 * No other locale order, separator or padding is accepted.
 */
export function normalizeMonthEndItemDate(raw: unknown): ParseResult<ISODate | ''> {
  if (raw === '') return success('')
  const canonical = parseISODate(raw)
  if (canonical.ok) return canonical
  if (typeof raw !== 'string') return canonical
  const legacy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw)
  if (!legacy) return failure('date', 'must be an ISO date or zero-padded DD/MM/YYYY')
  return parseISODate(`${legacy[3]}-${legacy[2]}-${legacy[1]}`)
}

export function parseISODateTime(raw: unknown): ParseResult<ISODateTime> {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw) || Number.isNaN(Date.parse(raw))) {
    return failure('datetime', 'must be an ISO date-time')
  }
  const date = parseISODate(raw.slice(0, 10))
  if (!date.ok) return failure('datetime', 'must contain a real calendar date')
  return success(raw as ISODateTime)
}

export function parseYearMonth(raw: unknown): ParseResult<YearMonth> {
  if (typeof raw !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) return failure('month', 'must be YYYY-MM')
  return success(raw as YearMonth)
}

const cloneInputs = (): Inputs => ({ ...DEFAULT_INPUTS })
export function parseInputs(raw: unknown): ParseResult<Inputs> {
  if (!isRecord(raw)) return failure('inputs', 'must be an object')
  const next = cloneInputs()
  const issues: ParseIssue[] = []
  for (const key of Object.keys(DEFAULT_INPUTS) as (keyof Inputs)[]) {
    if (!(key in raw)) continue // Explicit legacy migration: only absent fields receive their current default.
    const value = raw[key]
    const expected = typeof DEFAULT_INPUTS[key]
    if (typeof value !== expected || (expected === 'number' && !Number.isFinite(value))) {
      issues.push({ path: `inputs.${key}`, reason: expected === 'number' ? 'must be a finite number' : `must be a ${expected}` })
      continue
    }
    ;(next as unknown as Record<string, unknown>)[key] = value
  }
  return issues.length ? { ok: false, issues } : success(next)
}

function parseNumberField(raw: Record<string, unknown>, key: string, fallback: number, path: string): ParseResult<number> {
  if (!(key in raw)) return success(fallback)
  const value = raw[key]
  return typeof value === 'number' && Number.isFinite(value)
    ? success(value)
    : failure(`${path}.${key}`, 'must be a finite number')
}

export function parseConstants(raw: unknown): ParseResult<Constants> {
  if (!isRecord(raw)) return failure('constants', 'must be an object')
  const numberKeys = ['fastighetsavgiftCap', 'minDownPaymentPct', 'lagfartPct', 'pantbrevPct'] as const
  const top = numberKeys.map((key) => parseNumberField(raw, key, DEFAULT_CONSTANTS[key], 'constants'))
  const ravRaw = raw.ranteavdrag
  const amortRaw = raw.amort
  const rav = ravRaw === undefined ? {} : isRecord(ravRaw) ? ravRaw : null
  const amort = amortRaw === undefined ? {} : isRecord(amortRaw) ? amortRaw : null
  if (!rav) return failure('constants.ranteavdrag', 'must be an object')
  if (!amort) return failure('constants.amort', 'must be an object')
  const ravKeys = ['thresholdKr', 'lowPct', 'highPct'] as const
  const amortKeys = ['highLtvPct', 'midLtvPct', 'highLtvRatePct', 'midLtvRatePct', 'incomeMultiple', 'incomeSurchargePct'] as const
  const nested = [
    ...ravKeys.map((key) => parseNumberField(rav, key, DEFAULT_CONSTANTS.ranteavdrag[key], 'constants.ranteavdrag')),
    ...amortKeys.map((key) => parseNumberField(amort, key, DEFAULT_CONSTANTS.amort[key], 'constants.amort')),
  ]
  const all = [...top, ...nested]
  const issues = all.flatMap((result) => result.ok ? [] : result.issues)
  if (issues.length) return { ok: false, issues }
  const values = all.map((result) => (result as { ok: true; value: number }).value)
  return success({
    fastighetsavgiftCap: values[0], minDownPaymentPct: values[1], lagfartPct: values[2], pantbrevPct: values[3],
    ranteavdrag: { thresholdKr: values[4], lowPct: values[5], highPct: values[6] },
    amort: { highLtvPct: values[7], midLtvPct: values[8], highLtvRatePct: values[9], midLtvRatePct: values[10], incomeMultiple: values[11], incomeSurchargePct: values[12] },
  })
}

function parseSavedAt(raw: unknown): ParseResult<PersistedScenario['savedAt']> {
  if (raw === '') return success('')
  const dateTime = parseISODateTime(raw)
  if (dateTime.ok) return dateTime
  const date = parseISODate(raw)
  return date.ok ? date : failure('savedAt', 'must be an ISO date-time, ISO date, or blank legacy value')
}

export function parseBostadScenario(raw: unknown): ParseResult<PersistedScenario> {
  if (!isRecord(raw)) return failure('scenario', 'must be an object')
  const id = parseScenarioId(raw.id)
  const name = typeof raw.name === 'string' ? success(raw.name) : failure<string>('name', 'must be a string')
  const savedAt = parseSavedAt(raw.savedAt ?? raw.saved_at ?? '')
  const inputs = parseInputs(raw.inputs)
  const constants = raw.constants === undefined || raw.constants === null ? success<Constants | undefined>(undefined) : parseConstants(raw.constants)
  const result = combine([id, name, savedAt, inputs, constants], {
    id: id.ok ? valueOf(id) : '' as ScenarioId,
    name: name.ok ? valueOf(name) : '',
    savedAt: savedAt.ok ? valueOf(savedAt) : '',
    inputs: inputs.ok ? valueOf(inputs) : cloneInputs(),
    constants: constants.ok ? valueOf(constants) : undefined,
  })
  return result
}

export function parseBostadScenarios(raw: unknown): ParseResult<PersistedScenario[]> {
  if (!Array.isArray(raw)) return failure('scenarios', 'must be an array')
  const scenarios: PersistedScenario[] = []
  const issues: ParseIssue[] = []
  const ids = new Set<string>()
  raw.forEach((entry, index) => {
    const parsed = parseBostadScenario(entry)
    if (!parsed.ok) { issues.push(...parsed.issues.map((issue) => ({ ...issue, path: `scenarios[${index}].${issue.path}` }))); return }
    if (ids.has(valueOf(parsed).id)) { issues.push({ path: `scenarios[${index}].id`, reason: 'duplicates an earlier scenario id' }); return }
    ids.add(valueOf(parsed).id)
    scenarios.push(valueOf(parsed))
  })
  return issues.length ? { ok: false, issues } : success(scenarios)
}

export function salvageBostadScenarios(raw: unknown): { value: PersistedScenario[]; rejected: RejectedRecord[] } {
  if (!Array.isArray(raw)) return { value: [], rejected: [{ record: 'scenario list', reason: 'must be an array' }] }
  const value: PersistedScenario[] = []
  const rejected: RejectedRecord[] = []
  const ids = new Set<string>()
  raw.forEach((entry, index) => {
    const parsed = parseBostadScenario(entry)
    const record = `scenario ${index + 1}`
    if (!parsed.ok) { rejected.push({ record, reason: parsed.issues[0].reason }); return }
    if (ids.has(valueOf(parsed).id)) { rejected.push({ record, reason: 'duplicates an earlier scenario id' }); return }
    ids.add(valueOf(parsed).id)
    value.push(valueOf(parsed))
  })
  return { value, rejected }
}

function parseLineItems(raw: unknown, path: string): ParseResult<PersistedLineItem[]> {
  if (!Array.isArray(raw)) return failure(path, 'must be an array')
  const values: PersistedLineItem[] = []
  const issues: ParseIssue[] = []
  const ids = new Set<string>()
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) { issues.push({ path: `${path}[${index}]`, reason: 'must be an object' }); return }
    const id = parseItemId(entry.id)
    const label = typeof entry.label === 'string' ? success(entry.label) : failure<string>('label', 'must be a string')
    const amount = typeof entry.amount === 'number' && Number.isFinite(entry.amount)
      ? success(entry.amount) : failure<number>('amount', 'must be a finite number')
    const parsed = combine([id, label, amount], {
      id: id.ok ? valueOf(id) : '' as ItemId, label: label.ok ? valueOf(label) : '', amount: amount.ok ? valueOf(amount) : 0,
    })
    if (!parsed.ok) { issues.push(...parsed.issues.map((issue) => ({ ...issue, path: `${path}[${index}].${issue.path}` }))); return }
    if (ids.has(valueOf(parsed).id)) { issues.push({ path: `${path}[${index}].id`, reason: 'duplicates an earlier item id' }); return }
    ids.add(valueOf(parsed).id)
    values.push(valueOf(parsed))
  })
  return issues.length ? { ok: false, issues } : success(values)
}

export function parseBostadPrefs(raw: unknown): ParseResult<BostadPrefs> {
  if (!isRecord(raw)) return failure('prefs', 'must be an object')
  const globalConstants = raw.globalConstants === null || raw.globalConstants === undefined
    ? success<Constants | null>(null) : parseConstants(raw.globalConstants)
  const driftItems = parseLineItems(raw.driftItems ?? [], 'driftItems')
  const savingsItems = parseLineItems(raw.savingsItems ?? [], 'savingsItems')
  return combine([globalConstants, driftItems, savingsItems], {
    globalConstants: globalConstants.ok ? valueOf(globalConstants) : null,
    driftItems: driftItems.ok ? valueOf(driftItems) : [],
    savingsItems: savingsItems.ok ? valueOf(savingsItems) : [],
  })
}

/** Passive cache/cloud reads retain good preference slices and items. */
export function salvageBostadPrefs(raw: unknown): { value: BostadPrefs; rejected: RejectedRecord[] } {
  if (!isRecord(raw)) return {
    value: { globalConstants: null, driftItems: [], savingsItems: [] },
    rejected: [{ record: 'preferences', reason: 'must be an object' }],
  }
  const rejected: RejectedRecord[] = []
  const constants = raw.globalConstants === null || raw.globalConstants === undefined
    ? success<Constants | null>(null) : parseConstants(raw.globalConstants)
  if (!constants.ok) rejected.push({ record: 'global constants', reason: constants.issues[0].reason })
  const salvageItems = (rawItems: unknown, name: string): PersistedLineItem[] => {
    if (!Array.isArray(rawItems)) { rejected.push({ record: name, reason: 'must be an array' }); return [] }
    const values: PersistedLineItem[] = []
    const ids = new Set<string>()
    rawItems.forEach((entry, index) => {
      const parsed = parseLineItems([entry], name)
      if (!parsed.ok) { rejected.push({ record: `${name} ${index + 1}`, reason: parsed.issues[0].reason }); return }
      const item = valueOf(parsed)[0]
      if (ids.has(item.id)) { rejected.push({ record: `${name} ${index + 1}`, reason: 'duplicates an earlier item id' }); return }
      ids.add(item.id)
      values.push(item)
    })
    return values
  }
  return {
    value: {
      globalConstants: constants.ok ? valueOf(constants) : null,
      driftItems: salvageItems(raw.driftItems ?? [], 'drift item'),
      savingsItems: salvageItems(raw.savingsItems ?? [], 'savings item'),
    },
    rejected,
  }
}

export function parseBostadSession(raw: unknown): ParseResult<BostadSession> {
  if (!isRecord(raw)) return failure('session', 'must be an object')
  const inputs = parseInputs(raw.inputs)
  const activeScenarioId = raw.activeScenarioId === null || raw.activeScenarioId === undefined
    ? success<ScenarioId | null>(null) : parseScenarioId(raw.activeScenarioId)
  const isDirty = typeof raw.isDirty === 'boolean' ? success(raw.isDirty) : failure<boolean>('isDirty', 'must be a boolean')
  return combine([inputs, activeScenarioId, isDirty], {
    inputs: inputs.ok ? valueOf(inputs) : cloneInputs(),
    activeScenarioId: activeScenarioId.ok ? valueOf(activeScenarioId) : null,
    isDirty: isDirty.ok ? valueOf(isDirty) : false,
  })
}

export function parseDriftYearly(raw: unknown): ParseResult<boolean> {
  if (raw === 'true') return success(true)
  if (raw === 'false' || raw === null) return success(false)
  return failure('driftYearly', 'must be true or false')
}

// ── Bolånekoll and Månadsavslut ────────────────────────────────────────────
// These two stores used to only reject non-finite JSON.  Keep the parsers here,
// rather than in their React/store callers, so imported files, cache envelopes,
// and database rows all get the same field-level contract.

const mortgageKinds = ['interest', 'amortization', 'payment', 'down_payment', 'loan', 'fee', 'other'] as const
const owners = ['a', 'b'] as const
const paidBy = ['a', 'b', 'joint'] as const
const rateTypes = ['rörlig', 'bunden'] as const

const issueList = (results: ParseResult<unknown>[]) => results.flatMap((result) => result.ok ? [] : result.issues)
/** Reads a result only after its sibling issue list was checked. */
const valueOf = <T>(result: ParseResult<T>): T => {
  if (!result.ok) throw new Error('Attempted to read an invalid persistence parse result')
  return (result as { ok: true; value: T }).value
}
const fieldValue = (result: unknown): unknown => (result as { value?: unknown }).value
const field = <T>(raw: Record<string, unknown>, key: string, fallback: T, parser: (value: unknown) => ParseResult<T>): ParseResult<T> =>
  raw[key] === undefined ? success(fallback) : parser(raw[key])
const nullable = <T>(raw: unknown, parser: (value: unknown) => ParseResult<T>): ParseResult<T | null> =>
  raw === null || raw === undefined ? success(null) : parser(raw)
const text = (value: unknown, path: string) => parseString(value, path)
const finite = (value: unknown, path: string) => parseFiniteNumber(value, path)
const boolean = (value: unknown, path: string) => parseBoolean(value, path)
const dateOrBlank = (value: unknown, path: string): ParseResult<ISODate | ''> => value === '' ? success('') : withPath(parseISODate(value), path)
const monthEndItemDate = (value: unknown, path: string): ParseResult<ISODate | ''> => withPath(normalizeMonthEndItemDate(value), path)
const datetime = (value: unknown, path: string): ParseResult<ISODateTime> => withPath(parseISODateTime(value), path)
const withPath = <T>(result: ParseResult<T>, path: string): ParseResult<T> => result.ok ? result : { ok: false, issues: result.issues.map((issue) => ({ ...issue, path })) }
const id = <T extends string>(value: unknown, path: string, parser: (value: unknown) => ParseResult<T>) => withPath(parser(value), path)

/** Branded records exist only after an untrusted persistence value is parsed. */
export type PersistedLoanPart = Omit<LoanPart, 'id' | 'created_at' | 'start_date'> & { id: LoanPartId; created_at: ISODateTime; start_date: ISODate | '' }
export type PersistedMortgagePayment = Omit<MortgagePayment, 'id' | 'created_at' | 'loan_part_id' | 'date'> & { id: PaymentId; created_at: ISODateTime; loan_part_id: LoanPartId | null; date: ISODate | '' }
export type PersistedRatePeriod = Omit<RatePeriod, 'created_at' | 'loan_part_id' | 'start_date' | 'end_date'> & { created_at: ISODateTime; loan_part_id: LoanPartId | null; start_date: ISODate | ''; end_date: ISODate | '' | null }
export type PersistedMonthEndItem = Omit<Item, 'id' | 'created_at' | 'date_purchased' | 'payment_id'> & { id: ItemId; created_at: ISODateTime; date_purchased: ISODate | ''; payment_id: PaymentId | null }
export type PersistedMonthEndPayment = Omit<MonthEndPayment, 'id' | 'created_at' | 'item_ids'> & { id: PaymentId; created_at: ISODateTime; item_ids: ItemId[] }
export type PersistedSalarySubmission = Omit<SalarySubmission, 'month' | 'created_at'> & { month: YearMonth; created_at?: ISODateTime }

function parseMortgageSettings(raw: unknown): ParseResult<MortgageSettings> {
  if (!isRecord(raw)) return failure('settings', 'must be an object')
  const defaults = defaultMortgageSettings()
  const property_name = field(raw, 'property_name', defaults.property_name, (v) => text(v, 'property_name'))
  const owner_a_name = field(raw, 'owner_a_name', defaults.owner_a_name, (v) => text(v, 'owner_a_name'))
  const owner_b_name = field(raw, 'owner_b_name', defaults.owner_b_name, (v) => text(v, 'owner_b_name'))
  const my_ownership_pct = field(raw, 'my_ownership_pct', defaults.my_ownership_pct, (v) => finite(v, 'my_ownership_pct'))
  const i_am = field(raw, 'i_am', defaults.i_am, (v) => parseEnum(v, owners, 'i_am'))
  const currency = field(raw, 'currency', defaults.currency, (v) => text(v, 'currency'))
  const ranteavdrag = field(raw, 'ranteavdrag', defaults.ranteavdrag, (v) => boolean(v, 'ranteavdrag'))
  const household_income_yearly = raw.household_income_yearly === undefined || raw.household_income_yearly === null
    ? success<number | null>(null) : finite(raw.household_income_yearly, 'household_income_yearly')
  const track_contributions = field(raw, 'track_contributions', defaults.track_contributions, (v) => boolean(v, 'track_contributions'))
  const what_if_rate_pct = raw.what_if_rate_pct === undefined || raw.what_if_rate_pct === null
    ? success<number | null>(null)
    : finite(raw.what_if_rate_pct, 'what_if_rate_pct')
  if (!isRecord(raw.import_presets ?? {})) return failure('settings.import_presets', 'must be an object')
  const import_presets: MortgageSettings['import_presets'] = {}
  const presetIssues: ParseIssue[] = []
  for (const [name, preset] of Object.entries(raw.import_presets ?? {})) {
    if (!isRecord(preset)) { presetIssues.push({ path: `settings.import_presets.${name}`, reason: 'must be an object' }); continue }
    const parsed: Record<string, string | null> = {}
    for (const key of ['date', 'specification', 'amount', 'balance', 'loan_number']) {
      const value = preset[key]
      if (value !== null && value !== undefined && typeof value !== 'string') presetIssues.push({ path: `settings.import_presets.${name}.${key}`, reason: 'must be a string or null' })
      else parsed[key] = value ?? null
    }
    import_presets[name] = parsed as unknown as MortgageSettings['import_presets'][string]
  }
  const scenarioRate = what_if_rate_pct.ok ? what_if_rate_pct.value : null
  const scenarioRateIssues = scenarioRate !== null && scenarioRate < 0
    ? [{ path: 'what_if_rate_pct', reason: 'must be non-negative' }]
    : []
  const issues = [...issueList([property_name, owner_a_name, owner_b_name, my_ownership_pct, i_am, currency, ranteavdrag, household_income_yearly, track_contributions, what_if_rate_pct]), ...presetIssues, ...scenarioRateIssues]
  if (issues.length) return { ok: false, issues }
  return success({ property_name: valueOf(property_name), owner_a_name: valueOf(owner_a_name), owner_b_name: valueOf(owner_b_name), my_ownership_pct: valueOf(my_ownership_pct), i_am: valueOf(i_am), currency: valueOf(currency), ranteavdrag: valueOf(ranteavdrag), household_income_yearly: valueOf(household_income_yearly), import_presets, track_contributions: valueOf(track_contributions), what_if_rate_pct: valueOf(what_if_rate_pct) })
}

function parseLoanPart(raw: unknown): ParseResult<PersistedLoanPart> {
  if (!isRecord(raw)) return failure('loan part', 'must be an object')
  const fields = [id(raw.id, 'id', parseLoanPartId), datetime(raw.created_at, 'created_at'), text(raw.label, 'label'), text(raw.loan_number, 'loan_number'), finite(raw.start_balance, 'start_balance'), dateOrBlank(raw.start_date, 'start_date'), boolean(raw.archived, 'archived')]
  const mortgage_id = nullable(raw.mortgage_id, (v) => id(v, 'mortgage_id', (x) => parseOpaqueId<'MortgageId'>(x, 'mortgage_id')))
  const original_balance = nullable(raw.original_balance, (v) => finite(v, 'original_balance'))
  const original_date = nullable(raw.original_date, (v) => dateOrBlank(v, 'original_date'))
  const planned_amortization = nullable(raw.planned_amortization, (v) => finite(v, 'planned_amortization'))
  const planned_amortization_start = nullable(raw.planned_amortization_start, (v) => dateOrBlank(v, 'planned_amortization_start'))
  const planned_amortization_end = nullable(raw.planned_amortization_end, (v) => dateOrBlank(v, 'planned_amortization_end'))
  const all = [...fields, mortgage_id, original_balance, original_date, planned_amortization, planned_amortization_start, planned_amortization_end]
  if (issueList(all).length) return { ok: false, issues: issueList(all) }
  return success({ id: fieldValue(fields[0]) as LoanPartId, created_at: fieldValue(fields[1]) as ISODateTime, label: fieldValue(fields[2]) as string, loan_number: fieldValue(fields[3]) as string, start_balance: fieldValue(fields[4]) as number, start_date: fieldValue(fields[5]) as ISODate | '', archived: fieldValue(fields[6]) as boolean, mortgage_id: valueOf(mortgage_id), original_balance: valueOf(original_balance), original_date: valueOf(original_date), planned_amortization: valueOf(planned_amortization), planned_amortization_start: valueOf(planned_amortization_start), planned_amortization_end: valueOf(planned_amortization_end) })
}

function parseBank(raw: unknown): ParseResult<Bank> {
  if (!isRecord(raw)) return failure('bank', 'must be an object')
  const fields = [id(raw.id, 'id', (v) => parseOpaqueId<'BankId'>(v, 'id')), datetime(raw.created_at, 'created_at'), text(raw.label, 'label')]
  const year_basis = raw.year_basis === null || raw.year_basis === undefined ? success<number | null>(null) : (raw.year_basis === 360 || raw.year_basis === 365 ? success<number | null>(raw.year_basis) : failure<number | null>('year_basis', 'must be 360 or 365'))
  const year_basis_source = raw.year_basis_source === null || raw.year_basis_source === undefined ? success<string | null>(null) : parseEnum(raw.year_basis_source, ['detected', 'suggested', 'declared'] as const, 'year_basis_source')
  const billing = raw.billing === null || raw.billing === undefined ? success<string | null>(null) : parseEnum(raw.billing, BILLING_MODES, 'billing')
  const billing_source = raw.billing_source === null || raw.billing_source === undefined ? success<string | null>(null) : parseEnum(raw.billing_source, BILLING_SOURCES, 'billing_source')
  // Plan 109a — catalogue link. Nullable and absent on pre-109a data.
  const catalog_id = nullable(raw.catalog_id, (v) => id(v, 'catalog_id', (x) => parseOpaqueId<'CatalogBankId'>(x, 'catalog_id')))
  const all = [...fields, year_basis, year_basis_source, billing, billing_source, catalog_id]
  if (issueList(all).length) return { ok: false, issues: issueList(all) }
  return success({ id: fieldValue(fields[0]) as string, created_at: fieldValue(fields[1]) as string, label: fieldValue(fields[2]) as string, year_basis: valueOf(year_basis), year_basis_source: valueOf(year_basis_source), billing: valueOf(billing), billing_source: valueOf(billing_source), catalog_id: valueOf(catalog_id) })
}

function parseMortgage(raw: unknown): ParseResult<Mortgage> {
  if (!isRecord(raw)) return failure('mortgage', 'must be an object')
  const fields = [id(raw.id, 'id', (v) => parseOpaqueId<'MortgageId'>(v, 'id')), datetime(raw.created_at, 'created_at'), text(raw.label, 'label'), boolean(raw.archived, 'archived')]
  const bank_id = nullable(raw.bank_id, (v) => parseOpaqueId<'BankId'>(v, 'bank_id'))
  const start_date = nullable(raw.start_date, (v) => dateOrBlank(v, 'start_date'))
  // Plan 109a — agreement end state. '' is the preserved unknown-legacy marker.
  const end_date = nullable(raw.end_date, (v) => dateOrBlank(v, 'end_date'))
  const all = [...fields, bank_id, start_date, end_date]
  if (issueList(all).length) return { ok: false, issues: issueList(all) }
  return success({ id: fieldValue(fields[0]) as string, created_at: fieldValue(fields[1]) as string, label: fieldValue(fields[2]) as string, archived: fieldValue(fields[3]) as boolean, bank_id: valueOf(bank_id), start_date: valueOf(start_date), end_date: valueOf(end_date) })
}

function parseMortgagePayment(raw: unknown): ParseResult<PersistedMortgagePayment> {
  if (!isRecord(raw)) return failure('payment', 'must be an object')
  const fields = [id(raw.id, 'id', parsePaymentId), datetime(raw.created_at, 'created_at'), dateOrBlank(raw.date, 'date'), parseEnum(raw.kind, mortgageKinds, 'kind'), text(raw.description, 'description'), finite(raw.amount, 'amount'), parseEnum(raw.paid_by, paidBy, 'paid_by'), text(raw.source, 'source')]
  const loan_part_id = nullable(raw.loan_part_id, (v) => id(v, 'loan_part_id', parseLoanPartId))
  const balance_after = nullable(raw.balance_after, (v) => finite(v, 'balance_after'))
  // Plan 109a — agreement provenance. Nullable; absent on pre-109a data.
  const mortgage_id = nullable(raw.mortgage_id, (v) => id(v, 'mortgage_id', (x) => parseOpaqueId<'MortgageId'>(x, 'mortgage_id')))
  const is_insats = field(raw, 'is_insats', false, (v) => boolean(v, 'is_insats'))
  let paid_split: { a: number; b: number } | null = null
  const splitIssues: ParseIssue[] = []
  if (raw.paid_split !== null && raw.paid_split !== undefined) {
    if (!isRecord(raw.paid_split)) splitIssues.push({ path: 'paid_split', reason: 'must be an object or null' })
    else { const a = finite(raw.paid_split.a, 'paid_split.a'); const b = finite(raw.paid_split.b, 'paid_split.b'); if (!a.ok) splitIssues.push(...a.issues); if (!b.ok) splitIssues.push(...b.issues); if (a.ok && b.ok) paid_split = { a: valueOf(a), b: valueOf(b) } }
  }
  const all = [...fields, loan_part_id, balance_after, mortgage_id, is_insats]
  const issues = [...issueList(all), ...splitIssues]
  if (issues.length) return { ok: false, issues }
  return success({ id: fieldValue(fields[0]) as PaymentId, created_at: fieldValue(fields[1]) as ISODateTime, date: fieldValue(fields[2]) as ISODate | '', kind: fieldValue(fields[3]) as MortgagePayment['kind'], description: fieldValue(fields[4]) as string, amount: fieldValue(fields[5]) as number, paid_by: fieldValue(fields[6]) as MortgagePayment['paid_by'], source: fieldValue(fields[7]) as string, loan_part_id: valueOf(loan_part_id), balance_after: valueOf(balance_after), mortgage_id: valueOf(mortgage_id), is_insats: valueOf(is_insats), paid_split })
}

function parseRatePeriod(raw: unknown): ParseResult<PersistedRatePeriod> {
  if (!isRecord(raw)) return failure('rate period', 'must be an object')
  const fields = [id(raw.id, 'id', (v) => parseOpaqueId<'RatePeriodId'>(v, 'id')), datetime(raw.created_at, 'created_at'), dateOrBlank(raw.start_date, 'start_date'), parseEnum(raw.rate_type, rateTypes, 'rate_type')]
  const loan_part_id = nullable(raw.loan_part_id, (v) => id(v, 'loan_part_id', parseLoanPartId))
  const end_date = nullable(raw.end_date, (v) => dateOrBlank(v, 'end_date'))
  const rate = nullable(raw.rate, (v) => finite(v, 'rate'))
  const all = [...fields, loan_part_id, end_date, rate]
  if (issueList(all).length) return { ok: false, issues: issueList(all) }
  return success({ id: fieldValue(fields[0]) as string, created_at: fieldValue(fields[1]) as ISODateTime, start_date: fieldValue(fields[2]) as ISODate | '', rate_type: fieldValue(fields[3]) as RatePeriod['rate_type'], loan_part_id: valueOf(loan_part_id), end_date: valueOf(end_date), rate: valueOf(rate) })
}

function parseValuation(raw: unknown): ParseResult<Valuation> {
  if (!isRecord(raw)) return failure('valuation', 'must be an object')
  const fields = [id(raw.id, 'id', (v) => parseOpaqueId<'ValuationId'>(v, 'id')), datetime(raw.created_at, 'created_at'), dateOrBlank(raw.date, 'date'), finite(raw.value, 'value'), text(raw.note, 'note'), field(raw, 'is_purchase', false, (v) => boolean(v, 'is_purchase'))]
  if (issueList(fields).length) return { ok: false, issues: issueList(fields) }
  return success({ id: fieldValue(fields[0]) as string, created_at: fieldValue(fields[1]) as string, date: fieldValue(fields[2]) as string, value: fieldValue(fields[3]) as number, note: fieldValue(fields[4]) as string, is_purchase: fieldValue(fields[5]) as boolean })
}

function parseContribution(raw: unknown): ParseResult<Contribution> {
  if (!isRecord(raw)) return failure('contribution', 'must be an object')
  const fields = [id(raw.id, 'id', (v) => parseOpaqueId<'ContributionId'>(v, 'id')), datetime(raw.created_at, 'created_at'), parseEnum(raw.owner, paidBy, 'owner'), dateOrBlank(raw.date, 'date'), finite(raw.amount, 'amount'), text(raw.note, 'note')]
  if (issueList(fields).length) return { ok: false, issues: issueList(fields) }
  return success({ id: fieldValue(fields[0]) as string, created_at: fieldValue(fields[1]) as string, owner: fieldValue(fields[2]) as Contribution['owner'], date: fieldValue(fields[3]) as string, amount: fieldValue(fields[4]) as number, note: fieldValue(fields[5]) as string })
}

export interface MortgageEnvelope {
  version: number; banks: Bank[]; mortgages: Mortgage[]; loan_parts: PersistedLoanPart[]; payments: PersistedMortgagePayment[]
  valuations: Valuation[]; rate_periods: PersistedRatePeriod[]; contributions: Contribution[]; settings: MortgageSettings
}

function parseRows<T>(raw: unknown, name: string, parser: (row: unknown) => ParseResult<T & { id: string }>): ParseResult<T[]> {
  if (!Array.isArray(raw)) return failure(name, 'must be an array')
  const value: T[] = []; const issues: ParseIssue[] = []; const ids = new Set<string>()
  raw.forEach((row, index) => {
    const parsed = parser(row)
    if (!parsed.ok) { issues.push(...parsed.issues.map((issue) => ({ ...issue, path: `${name}[${index}].${issue.path}` }))); return }
    if (ids.has(valueOf(parsed).id)) { issues.push({ path: `${name}[${index}].id`, reason: 'duplicates an earlier id' }); return }
    ids.add(valueOf(parsed).id); value.push(valueOf(parsed))
  })
  return issues.length ? { ok: false, issues } : success(value)
}

/** Strict full-envelope parser for backups/imports: one bad row rejects all. */
export function parseMortgageEnvelope(raw: unknown): ParseResult<MortgageEnvelope> {
  if (!isRecord(raw)) return failure('mortgage backup', 'must be an object')
  const version = field(raw, 'version', 4, (v) => finite(v, 'version'))
  const banks = parseRows(raw.banks ?? [], 'banks', parseBank)
  const mortgages = parseRows(raw.mortgages ?? [], 'mortgages', parseMortgage)
  const loan_parts = parseRows(raw.loan_parts ?? [], 'loan_parts', parseLoanPart)
  const payments = parseRows(raw.payments ?? [], 'payments', parseMortgagePayment)
  const valuations = parseRows(raw.valuations ?? [], 'valuations', parseValuation)
  const rate_periods = parseRows(raw.rate_periods ?? [], 'rate_periods', parseRatePeriod)
  const contributions = parseRows(raw.contributions ?? [], 'contributions', parseContribution)
  const settings = parseMortgageSettings(raw.settings ?? {})
  const all = [version, banks, mortgages, loan_parts, payments, valuations, rate_periods, contributions, settings]
  const issues = issueList(all)
  if (issues.length) return { ok: false, issues }
  const bankIds = new Set(valueOf(banks).map((row) => row.id)); const mortgageIds = new Set(valueOf(mortgages).map((row) => row.id)); const partIds = new Set(valueOf(loan_parts).map((row) => row.id))
  const referenceIssues: ParseIssue[] = []
  valueOf(mortgages).forEach((row, index) => { if (row.bank_id && !bankIds.has(row.bank_id)) referenceIssues.push({ path: `mortgages[${index}].bank_id`, reason: 'references an unknown bank' }) })
  valueOf(loan_parts).forEach((row, index) => { if (row.mortgage_id && !mortgageIds.has(row.mortgage_id)) referenceIssues.push({ path: `loan_parts[${index}].mortgage_id`, reason: 'references an unknown mortgage' }) })
  valueOf(payments).forEach((row, index) => { if (row.loan_part_id && !partIds.has(row.loan_part_id)) referenceIssues.push({ path: `payments[${index}].loan_part_id`, reason: 'references an unknown loan part' }) })
  valueOf(payments).forEach((row, index) => { if (row.mortgage_id && !mortgageIds.has(row.mortgage_id)) referenceIssues.push({ path: `payments[${index}].mortgage_id`, reason: 'references an unknown mortgage' }) })
  valueOf(rate_periods).forEach((row, index) => { if (row.loan_part_id && !partIds.has(row.loan_part_id)) referenceIssues.push({ path: `rate_periods[${index}].loan_part_id`, reason: 'references an unknown loan part' }) })
  if (referenceIssues.length) return { ok: false, issues: referenceIssues }
  return success({ version: valueOf(version), banks: valueOf(banks), mortgages: valueOf(mortgages), loan_parts: valueOf(loan_parts), payments: valueOf(payments), valuations: valueOf(valuations), rate_periods: valueOf(rate_periods), contributions: valueOf(contributions), settings: valueOf(settings) })
}

/** Salvage passive cache/cloud reads; independent good rows remain available. */
export function salvageMortgageEnvelope(raw: unknown): { value: MortgageEnvelope; rejected: RejectedRecord[] } {
  if (!isRecord(raw)) return { value: { version: 4, banks: [], mortgages: [], loan_parts: [], payments: [], valuations: [], rate_periods: [], contributions: [], settings: defaultMortgageSettings() }, rejected: [{ record: 'mortgage data', reason: 'must be an object' }] }
  const rejected: RejectedRecord[] = []
  const salvage = <T extends { id: string }>(rows: unknown, name: string, parser: (row: unknown) => ParseResult<T>): T[] => {
    if (!Array.isArray(rows)) { rejected.push({ record: name, reason: 'must be an array' }); return [] }
    const values: T[] = []; const ids = new Set<string>()
    rows.forEach((row, index) => { const parsed = parser(row); if (!parsed.ok) rejected.push({ record: `${name} ${index + 1}`, reason: parsed.issues[0].reason }); else if (ids.has(valueOf(parsed).id)) rejected.push({ record: `${name} ${index + 1}`, reason: 'duplicates an earlier id' }); else { ids.add(valueOf(parsed).id); values.push(valueOf(parsed)) } })
    return values
  }
  const banks = salvage(raw.banks ?? [], 'bank', parseBank); const bankIds = new Set(banks.map((row) => row.id))
  const mortgages = salvage(raw.mortgages ?? [], 'mortgage', parseMortgage).filter((row) => { if (!row.bank_id || bankIds.has(row.bank_id)) return true; rejected.push({ record: `mortgage ${row.id}`, reason: 'references an unknown bank' }); return false })
  const mortgageIds = new Set(mortgages.map((row) => row.id))
  const loan_parts = salvage(raw.loan_parts ?? [], 'loan part', parseLoanPart).filter((row) => { if (!row.mortgage_id || mortgageIds.has(row.mortgage_id)) return true; rejected.push({ record: `loan part ${row.id}`, reason: 'references an unknown mortgage' }); return false })
  const partIds = new Set(loan_parts.map((row) => row.id))
  // Deliberately no payment.mortgage_id → mortgages filter here: partial cache
  // refreshes (loadMortgageSyncSnapshot) rewrite payments without touching the
  // mortgages slice, so an agreement created on another device would make its
  // payment history vanish from cached reads. Provenance pointing at an
  // agreement missing from a passive read never invalidates the ledger row.
  const payments = salvage(raw.payments ?? [], 'payment', parseMortgagePayment).filter((row) => { if (!row.loan_part_id || partIds.has(row.loan_part_id)) return true; rejected.push({ record: `payment ${row.id}`, reason: 'references an unknown loan part' }); return false })
  const rate_periods = salvage(raw.rate_periods ?? [], 'rate period', parseRatePeriod).filter((row) => { if (!row.loan_part_id || partIds.has(row.loan_part_id)) return true; rejected.push({ record: `rate period ${row.id}`, reason: 'references an unknown loan part' }); return false })
  const valuations = salvage(raw.valuations ?? [], 'valuation', parseValuation); const contributions = salvage(raw.contributions ?? [], 'contribution', parseContribution)
  const settings = parseMortgageSettings(raw.settings ?? {})
  if (!settings.ok) rejected.push({ record: 'mortgage settings', reason: settings.issues[0].reason })
  return { value: { version: typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : 4, banks, mortgages, loan_parts, payments, valuations, rate_periods, contributions, settings: settings.ok ? valueOf(settings) : defaultMortgageSettings() }, rejected }
}

export type MortgageRowKind = 'banks' | 'mortgages' | 'loan_parts' | 'payments' | 'valuations' | 'rate_periods' | 'contributions'

/** Field validation for a single cloud table; cross-table references are checked by the envelope parser. */
export function salvageMortgageRows(raw: unknown, kind: MortgageRowKind): { value: unknown[]; rejected: RejectedRecord[] } {
  const parser: Record<MortgageRowKind, (row: unknown) => ParseResult<{ id: string }>> = {
    banks: parseBank, mortgages: parseMortgage, loan_parts: parseLoanPart, payments: parseMortgagePayment,
    valuations: parseValuation, rate_periods: parseRatePeriod, contributions: parseContribution,
  }
  if (!Array.isArray(raw)) return { value: [], rejected: [{ record: kind, reason: 'must be an array' }] }
  const value: unknown[] = []; const rejected: RejectedRecord[] = []; const ids = new Set<string>()
  raw.forEach((row, index) => {
    const parsed = parser[kind](row)
    if (!parsed.ok) rejected.push({ record: `${kind} ${index + 1}`, reason: parsed.issues[0].reason })
    else if (ids.has(valueOf(parsed).id)) rejected.push({ record: `${kind} ${index + 1}`, reason: 'duplicates an earlier id' })
    else { ids.add(valueOf(parsed).id); value.push(valueOf(parsed)) }
  })
  return { value, rejected }
}

function parseMonthEndSettings(raw: unknown): ParseResult<MonthEndSettings> {
  if (!isRecord(raw)) return failure('settings', 'must be an object')
  const defaults = defaultMonthEndSettings()
  const person_a_name = field(raw, 'person_a_name', defaults.person_a_name, (v) => text(v, 'person_a_name'))
  const person_b_name = field(raw, 'person_b_name', defaults.person_b_name, (v) => text(v, 'person_b_name'))
  const currency = field(raw, 'currency', defaults.currency, (v) => text(v, 'currency'))
  const default_split = field(raw, 'default_split', defaults.default_split, (v) => boolean(v, 'default_split'))
  const all = [person_a_name, person_b_name, currency, default_split]
  return issueList(all).length ? { ok: false, issues: issueList(all) } : success({ person_a_name: valueOf(person_a_name), person_b_name: valueOf(person_b_name), currency: valueOf(currency), default_split: valueOf(default_split) })
}

function parsePersonalEntries(raw: unknown): ParseResult<PersonalEntry[]> {
  if (!Array.isArray(raw)) return failure('personal_items', 'must be an array')
  const values: PersonalEntry[] = []; const issues: ParseIssue[] = []
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) { issues.push({ path: `personal_items[${index}]`, reason: 'must be an object' }); return }
    const person = parseEnum(entry.person, owners, 'person'); const amount = finite(entry.amount, 'amount'); const note = text(entry.note, 'note')
    const all = [person, amount, note]
    if (issueList(all).length) issues.push(...issueList(all).map((issue) => ({ ...issue, path: `personal_items[${index}].${issue.path}` })))
    else values.push({ person: valueOf(person), amount: valueOf(amount), note: valueOf(note) })
  })
  return issues.length ? { ok: false, issues } : success(values)
}

function parseMonthEndItem(raw: unknown): ParseResult<PersistedMonthEndItem> {
  if (!isRecord(raw)) return failure('item', 'must be an object')
  const fields = [id(raw.id, 'id', parseItemId), datetime(raw.created_at, 'created_at'), field(raw, 'date_purchased', '', (v) => monthEndItemDate(v, 'date_purchased')), field(raw, 'description', '', (v) => text(v, 'description')), field(raw, 'enter_amount', 0, (v) => finite(v, 'enter_amount')), field(raw, 'split', true, (v) => boolean(v, 'split')), field(raw, 'amount', 0, (v) => finite(v, 'amount')), field(raw, 'fronted_by', 'a' as const, (v) => parseEnum(v, owners, 'fronted_by')), field(raw, 'owed_by', 'a' as const, (v) => parseEnum(v, owners, 'owed_by')), field(raw, 'paid', false, (v) => boolean(v, 'paid')), field(raw, 'pending', false, (v) => boolean(v, 'pending')), field(raw, 'note', '', (v) => text(v, 'note')), field(raw, 'source', 'manual', (v) => text(v, 'source')), field(raw, 'personal_a', 0, (v) => finite(v, 'personal_a')), field(raw, 'personal_b', 0, (v) => finite(v, 'personal_b'))]
  const payment_id = nullable(raw.payment_id, (v) => id(v, 'payment_id', parsePaymentId))
  const personal_items = field(raw, 'personal_items', [] as PersonalEntry[], parsePersonalEntries)
  const all = [...fields, payment_id, personal_items]
  if (issueList(all).length) return { ok: false, issues: issueList(all) }
  return success({ id: fieldValue(fields[0]) as ItemId, created_at: fieldValue(fields[1]) as ISODateTime, date_purchased: fieldValue(fields[2]) as ISODate | '', description: fieldValue(fields[3]) as string, enter_amount: fieldValue(fields[4]) as number, split: fieldValue(fields[5]) as boolean, amount: fieldValue(fields[6]) as number, fronted_by: fieldValue(fields[7]) as Item['fronted_by'], owed_by: fieldValue(fields[8]) as Item['owed_by'], paid: fieldValue(fields[9]) as boolean, pending: fieldValue(fields[10]) as boolean, note: fieldValue(fields[11]) as string, source: fieldValue(fields[12]) as string, personal_a: fieldValue(fields[13]) as number, personal_b: fieldValue(fields[14]) as number, payment_id: valueOf(payment_id), personal_items: valueOf(personal_items) })
}

function parseMonthEndPayment(raw: unknown): ParseResult<PersistedMonthEndPayment> {
  if (!isRecord(raw)) return failure('payment', 'must be an object')
  const fields = [id(raw.id, 'id', parsePaymentId), datetime(raw.created_at, 'created_at'), finite(raw.amount, 'amount'), text(raw.period_label, 'period_label'), text(raw.note, 'note')]
  const from_person = nullable(raw.from_person, (v) => parseEnum(v, owners, 'from_person'))
  const to_person = nullable(raw.to_person, (v) => parseEnum(v, owners, 'to_person'))
  const item_ids = parseArray(raw.item_ids, 'item_ids', (entry) => id(entry, 'id', parseItemId))
  const all = [...fields, from_person, to_person, item_ids]
  if (issueList(all).length) return { ok: false, issues: issueList(all) }
  const ids = valueOf(item_ids); if (new Set(ids).size !== ids.length) return failure('item_ids', 'contains duplicate item ids')
  return success({ id: fieldValue(fields[0]) as PaymentId, created_at: fieldValue(fields[1]) as ISODateTime, amount: fieldValue(fields[2]) as number, period_label: fieldValue(fields[3]) as string, note: fieldValue(fields[4]) as string, from_person: valueOf(from_person), to_person: valueOf(to_person), item_ids: ids })
}

export interface MonthEndEnvelope { version: number; items: PersistedMonthEndItem[]; payments: PersistedMonthEndPayment[]; settings: MonthEndSettings }

export function parseMonthEndEnvelope(raw: unknown): ParseResult<MonthEndEnvelope> {
  if (!isRecord(raw)) return failure('month-end backup', 'must be an object')
  const version = field(raw, 'version', 1, (v) => finite(v, 'version'))
  const items = parseRows(raw.items ?? [], 'items', parseMonthEndItem)
  const payments = parseRows(raw.payments ?? [], 'payments', parseMonthEndPayment)
  const settings = parseMonthEndSettings(raw.settings ?? {})
  const all = [version, items, payments, settings]
  if (issueList(all).length) return { ok: false, issues: issueList(all) }
  const itemIds = new Set(valueOf(items).map((item) => item.id)); const paymentIds = new Set(valueOf(payments).map((payment) => payment.id)); const refs: ParseIssue[] = []
  valueOf(items).forEach((item, index) => { if (item.payment_id && !paymentIds.has(item.payment_id)) refs.push({ path: `items[${index}].payment_id`, reason: 'references an unknown payment' }) })
  valueOf(payments).forEach((payment, index) => payment.item_ids.forEach((itemId, childIndex) => { if (!itemIds.has(itemId)) refs.push({ path: `payments[${index}].item_ids[${childIndex}]`, reason: 'references an unknown item' }) }))
  return refs.length ? { ok: false, issues: refs } : success({ version: valueOf(version), items: valueOf(items), payments: valueOf(payments), settings: valueOf(settings) })
}

export function salvageMonthEndEnvelope(raw: unknown): { value: MonthEndEnvelope; rejected: RejectedRecord[] } {
  if (!isRecord(raw)) return { value: { version: 1, items: [], payments: [], settings: defaultMonthEndSettings() }, rejected: [{ record: 'month-end data', reason: 'must be an object' }] }
  const rejected: RejectedRecord[] = []
  const salvage = <T extends { id: string }>(rows: unknown, name: string, parser: (row: unknown) => ParseResult<T>): T[] => {
    if (!Array.isArray(rows)) { rejected.push({ record: name, reason: 'must be an array' }); return [] }
    const values: T[] = []; const ids = new Set<string>()
    rows.forEach((row, index) => { const parsed = parser(row); if (!parsed.ok) rejected.push({ record: `${name} ${index + 1}`, reason: parsed.issues[0].reason }); else if (ids.has(valueOf(parsed).id)) rejected.push({ record: `${name} ${index + 1}`, reason: 'duplicates an earlier id' }); else { ids.add(valueOf(parsed).id); values.push(valueOf(parsed)) } })
    return values
  }
  const items = salvage(raw.items ?? [], 'item', parseMonthEndItem)
  const itemIds = new Set(items.map((item) => item.id))
  const itemIndexes = new Map<string, number>()
  if (Array.isArray(raw.items)) {
    raw.items.forEach((item, index) => {
      if (isRecord(item) && typeof item.id === 'string' && !itemIndexes.has(item.id)) itemIndexes.set(item.id, index)
    })
  }
  const paymentIndexes = new Map<string, number>()
  if (Array.isArray(raw.payments)) {
    raw.payments.forEach((payment, index) => {
      if (isRecord(payment) && typeof payment.id === 'string' && !paymentIndexes.has(payment.id)) paymentIndexes.set(payment.id, index)
    })
  }
  const payments = salvage(raw.payments ?? [], 'payment', parseMonthEndPayment).filter((payment) => {
    if (payment.item_ids.every((itemId) => itemIds.has(itemId))) return true
    const index = paymentIndexes.get(payment.id)
    const itemIndex = payment.item_ids.findIndex((itemId) => !itemIds.has(itemId))
    rejected.push({
      record: index === undefined ? 'payment' : `payment ${index + 1}`,
      reason: 'references an unknown item',
      path: index === undefined ? 'payments' : `payments[${index}].item_ids[${itemIndex}]`,
    })
    return false
  })
  const paymentIds = new Set(payments.map((payment) => payment.id))
  const keptItems = items.filter((item) => {
    if (!item.payment_id || paymentIds.has(item.payment_id)) return true
    const index = itemIndexes.get(item.id)
    rejected.push({
      record: index === undefined ? 'item' : `item ${index + 1}`,
      reason: 'references an unknown payment',
      path: index === undefined ? 'items' : `items[${index}].payment_id`,
    })
    return false
  })
  const settings = parseMonthEndSettings(raw.settings ?? {})
  if (!settings.ok) rejected.push({ record: 'month-end settings', reason: settings.issues[0].reason })
  return { value: { version: typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : 1, items: keptItems, payments, settings: settings.ok ? valueOf(settings) : defaultMonthEndSettings() }, rejected }
}

export function salvageMonthEndRows(raw: unknown, kind: 'items' | 'payments'): { value: unknown[]; rejected: RejectedRecord[] } {
  const parser: (row: unknown) => ParseResult<{ id: string }> = kind === 'items' ? parseMonthEndItem : parseMonthEndPayment
  if (!Array.isArray(raw)) return { value: [], rejected: [{ record: kind, reason: 'must be an array', path: kind }] }
  const value: unknown[] = []; const rejected: RejectedRecord[] = []; const ids = new Set<string>()
  raw.forEach((row, index) => {
    const parsed = parser(row)
    if (!parsed.ok) {
      const issue = parsed.issues[0]
      const suffix = issue.path === 'item' || issue.path === 'payment' ? '' : `.${issue.path}`
      rejected.push({
        record: `${kind} ${index + 1}`,
        reason: issue.reason,
        path: `${kind}[${index}]${suffix}`,
      })
    } else if (ids.has(valueOf(parsed).id)) {
      rejected.push({
        record: `${kind} ${index + 1}`,
        reason: 'duplicates an earlier id',
        path: `${kind}[${index}].id`,
      })
    }
    else { ids.add(valueOf(parsed).id); value.push(valueOf(parsed)) }
  })
  return { value, rejected }
}
