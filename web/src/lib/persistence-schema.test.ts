import { describe, expect, it } from 'vitest'
import { DEFAULT_CONSTANTS, DEFAULT_INPUTS, derive } from './calc'
import {
  parseBostadPrefs,
  parseBostadScenario,
  parseBostadScenarios,
  parseInputs,
  parseISODate,
  parseISODateTime,
  parseMortgageEnvelope,
  parseMonthEndEnvelope,
  parseYearMonth,
  normalizeMonthEndItemDate,
  isoDate,
  isoDateTime,
  itemId,
  loanPartId,
  paymentId,
  salvageMortgageEnvelope,
  salvageBostadScenarios,
  salvageMonthEndRows,
} from './persistence-schema'

const scenario = {
  id: 'scenario-a', name: 'Test', savedAt: '2026-07-14T10:00:00.000Z',
  inputs: DEFAULT_INPUTS, constants: DEFAULT_CONSTANTS,
}

describe('Bostadskalkyl persistence schema', () => {
  it('accepts current records and parses them idempotently', () => {
    const first = parseBostadScenario(scenario)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = parseBostadScenario(first.value)
    expect(second).toEqual(first)
  })

  it('explicitly migrates missing legacy input fields without altering present values', () => {
    const legacy = { salePrice: 1_234_567, bankAName: 'Legacy bank' }
    const result = parseInputs(legacy)
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.value.salePrice).toBe(1_234_567)
    expect(result.value.bankAName).toBe('Legacy bank')
    expect(result.value.grossAnnualIncome).toBe(DEFAULT_INPUTS.grossAnnualIncome)
    expect(derive(result.value)).toBeTruthy()
  })

  it.each([
    [{ ...DEFAULT_INPUTS, salePrice: '123' }],
    [{ ...DEFAULT_INPUTS, salePrice: Number.NaN }],
    [{ ...DEFAULT_INPUTS, salePrice: Number.POSITIVE_INFINITY }],
    [null],
  ])('rejects malformed input values instead of coercing them', (raw) => {
    expect(parseInputs(raw).ok).toBe(false)
  })

  it('validates dates and month keys, while preserving blank legacy timestamps as unknown', () => {
    expect(parseISODate('2026-02-29').ok).toBe(false)
    expect(parseISODate('2024-02-29').ok).toBe(true)
    expect(parseISODateTime('2026-07-14').ok).toBe(false)
    expect(parseISODateTime('2026-07-14T10:00:00.000Z').ok).toBe(true)
    expect(parseISODateTime('2026-02-30T10:00:00Z').ok).toBe(false)
    expect(parseISODateTime('2026-07-14T10:00:00').ok).toBe(false)
    expect(parseISODateTime('2026-07-14T10:00:00+02:00').ok).toBe(true)
    expect(parseYearMonth('2026-13').ok).toBe(false)
    expect(parseBostadScenario({ ...scenario, savedAt: '' }).ok).toBe(true)
  })

  it('rejects malformed records, arrays, ids, and duplicate ids', () => {
    expect(parseBostadScenario({ ...scenario, id: '' }).ok).toBe(false)
    expect(parseBostadScenario({ ...scenario, inputs: [] }).ok).toBe(false)
    const result = parseBostadScenarios([scenario, { ...scenario, name: 'Duplicate' }])
    expect(result.ok).toBe(false)
  })

  it('salvages valid passive-read records and describes rejected siblings', () => {
    const result = salvageBostadScenarios([scenario, { ...scenario, id: '', name: 'Broken' }])
    expect(result.value).toHaveLength(1)
    expect(result.rejected).toEqual([{ record: 'scenario 2', reason: 'must be a non-empty string' }])
  })

  it('rejects malformed preference payloads all at once', () => {
    expect(parseBostadPrefs({
      globalConstants: DEFAULT_CONSTANTS,
      driftItems: [{ id: 'ok', label: 'El', amount: 500 }],
      savingsItems: [{ id: 'bad', label: 'Buffer', amount: Infinity }],
    }).ok).toBe(false)
  })
})

const mortgageBackup = {
  version: 4,
  banks: [{ id: 'bank-1', created_at: '2026-07-15T10:00:00.000Z', label: 'Bank', year_basis: 365, year_basis_source: 'declared' }],
  mortgages: [{ id: 'mortgage-1', created_at: '2026-07-15T10:00:00.000Z', bank_id: 'bank-1', label: 'Home', start_date: '2024-01-01', archived: false }],
  loan_parts: [{ id: 'part-1', created_at: '2026-07-15T10:00:00.000Z', mortgage_id: 'mortgage-1', label: 'Part', loan_number: '123', start_balance: 1_000_000, start_date: '2024-01-01', archived: false, original_balance: null, original_date: null, planned_amortization: null, planned_amortization_start: null, planned_amortization_end: null }],
  payments: [{ id: 'payment-1', created_at: '2026-07-15T10:00:00.000Z', loan_part_id: 'part-1', date: '2026-07-01', kind: 'interest', description: '', amount: 1000, balance_after: null, paid_by: 'joint', source: '', is_insats: false, paid_split: null }],
  valuations: [], rate_periods: [], contributions: [], settings: {},
}

const monthEndItem = {
  id: 'item-1',
  created_at: '2026-07-15T10:00:00.000Z',
  date_purchased: '2026-02-01',
  description: 'Fictional purchase',
  enter_amount: 100,
  split: true,
  amount: 50,
  fronted_by: 'a',
  owed_by: 'b',
  paid: false,
  pending: false,
  payment_id: null,
  note: '',
  personal_items: [],
  personal_a: 0,
  personal_b: 0,
  source: 'manual',
}

describe('Mortgage and month-end persistence schemas', () => {
  it('normalizes only exact zero-padded day-first month-end item dates', () => {
    expect(normalizeMonthEndItemDate('2026-02-01')).toMatchObject({ ok: true, value: '2026-02-01' })
    expect(normalizeMonthEndItemDate('')).toMatchObject({ ok: true, value: '' })
    expect(normalizeMonthEndItemDate('01/02/2026')).toMatchObject({ ok: true, value: '2026-02-01' })
    expect(normalizeMonthEndItemDate('29/02/2024')).toMatchObject({ ok: true, value: '2024-02-29' })

    for (const unsupported of ['1/2/2026', '2026/02/01', '02-01-2026', '01.02.2026', ' 01/02/2026 ']) {
      expect(normalizeMonthEndItemDate(unsupported).ok).toBe(false)
    }
    for (const impossible of ['29/02/2026', '31/04/2026', '2026-02-29']) {
      expect(normalizeMonthEndItemDate(impossible).ok).toBe(false)
    }
  })

  it('normalizes legacy dates without weakening strict month-end row validation', () => {
    const legacy = parseMonthEndEnvelope({
      version: 1,
      settings: {},
      items: [{ ...monthEndItem, date_purchased: '01/02/2026' }],
      payments: [],
    })
    expect(legacy).toMatchObject({ ok: true })
    if (legacy.ok) expect(legacy.value.items[0].date_purchased).toBe('2026-02-01')

    expect(parseMonthEndEnvelope({
      version: 1,
      settings: {},
      items: [{ ...monthEndItem, date_purchased: '01/02/2026', enter_amount: '100' }],
      payments: [],
    }).ok).toBe(false)
    expect(parseMonthEndEnvelope({
      version: 1,
      settings: {},
      items: [{ ...monthEndItem, date_purchased: '01/02/2026', fronted_by: 'household' }],
      payments: [],
    }).ok).toBe(false)
    expect(parseMonthEndEnvelope({
      version: 1,
      settings: {},
      items: [{ ...monthEndItem, date_purchased: '01/02/2026', payment_id: 'missing' }],
      payments: [],
    }).ok).toBe(false)
  })

  it('salvages a legacy-date row while still rejecting malformed financial siblings', () => {
    const result = salvageMonthEndRows([
      { ...monthEndItem, date_purchased: '01/02/2026' },
      { ...monthEndItem, id: 'item-2', date_purchased: '01/02/2026', amount: '50' },
    ], 'items')
    expect(result.value).toEqual([expect.objectContaining({ id: 'item-1', date_purchased: '2026-02-01' })])
    expect(result.rejected).toEqual([expect.objectContaining({
      path: 'items[1].amount',
      reason: 'must be a finite number',
    })])
  })

  it('keeps persistence brands non-interchangeable at the boundary', () => {
    const loan = loanPartId('loan-1')
    const payment = paymentId('payment-1')
    const item = itemId('item-1')
    const date = isoDate('2026-07-15')
    const timestamp = isoDateTime('2026-07-15T10:00:00.000Z')
    // @ts-expect-error LoanPartId must not be accepted as a PaymentId.
    const wrongPayment: typeof payment = loan
    // @ts-expect-error ItemId must not be accepted as a LoanPartId.
    const wrongLoan: typeof loan = item
    // @ts-expect-error ISODate must not be accepted as an ISODateTime.
    const wrongTimestamp: typeof timestamp = date
    expect([wrongPayment, wrongLoan, wrongTimestamp]).toHaveLength(3)
  })

  it('preserves brands on actual parsed envelope records', () => {
    const mortgage = parseMortgageEnvelope(mortgageBackup)
    if (!mortgage.ok) throw new Error('fixture must parse')
    const part = mortgage.value.loan_parts[0]
    const payment = mortgage.value.payments[0]
    // @ts-expect-error A parsed payment id is not a parsed loan-part id.
    const wrongPartId: typeof part.id = payment.id
    // @ts-expect-error A parsed start date is not the parsed creation timestamp.
    const wrongCreatedAt: typeof part.created_at = part.start_date
    const monthEnd = parseMonthEndEnvelope({ version: 1, settings: {}, items: [{ id: 'item-1', created_at: '2026-07-15T10:00:00.000Z', date_purchased: '', description: '', enter_amount: 0, split: true, amount: 0, fronted_by: 'a', owed_by: 'b', paid: false, pending: false, payment_id: null, note: '', personal_items: [], personal_a: 0, personal_b: 0, source: 'manual' }], payments: [] })
    if (!monthEnd.ok) throw new Error('fixture must parse')
    // @ts-expect-error A parsed item id is not a parsed payment id.
    const wrongPaymentId: typeof payment.id = monthEnd.value.items[0].id
    expect([wrongPartId, wrongCreatedAt, wrongPaymentId]).toHaveLength(3)
  })

  it('migrates omitted legacy bank-profile fields but rejects malformed values that are present', () => {
    const legacy = { ...mortgageBackup, banks: [{ id: 'bank-1', created_at: '2026-07-15T10:00:00.000Z', label: 'Bank' }] }
    const parsed = parseMortgageEnvelope(legacy)
    expect(parsed).toMatchObject({ ok: true })
    if (parsed.ok) expect(parsed.value.banks[0]).toMatchObject({ year_basis: null, year_basis_source: null })
    expect(parseMortgageEnvelope({ ...legacy, banks: [{ ...legacy.banks[0], year_basis: 999 }] }).ok).toBe(false)
  })

  it('migrates an omitted scenario rate to null, round-trips a finite rate, and rejects invalid persisted values', () => {
    const legacy = parseMortgageEnvelope(mortgageBackup)
    if (!legacy.ok) throw new Error('fixture must parse')
    expect(legacy.value.settings.what_if_rate_pct).toBeNull()

    const current = parseMortgageEnvelope({
      ...mortgageBackup,
      settings: { what_if_rate_pct: 3.45 },
    })
    expect(current).toMatchObject({ ok: true })
    if (!current.ok) return
    expect(current.value.settings.what_if_rate_pct).toBe(3.45)
    expect(parseMortgageEnvelope(current.value)).toEqual(current)

    for (const what_if_rate_pct of [-0.01, Number.NaN, Number.POSITIVE_INFINITY, '3,45']) {
      expect(parseMortgageEnvelope({ ...mortgageBackup, settings: { what_if_rate_pct } }).ok).toBe(false)
    }
  })
  it('parses current mortgage data idempotently, including Bank/Mortgage references', () => {
    const first = parseMortgageEnvelope(mortgageBackup)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(parseMortgageEnvelope(first.value)).toEqual(first)
  })

  it('round-trips Plan 104 billing profiles and rejects malformed values', () => {
    const current = { ...mortgageBackup, banks: [{ ...mortgageBackup.banks[0], billing: 'month-end', billing_source: 'declared' }] }
    const parsed = parseMortgageEnvelope(current)
    expect(parsed).toMatchObject({ ok: true })
    if (parsed.ok) expect(parseMortgageEnvelope(parsed.value)).toEqual(parsed)
    expect(parseMortgageEnvelope({ ...current, banks: [{ ...current.banks[0], billing: 'weekly' }] }).ok).toBe(false)
  })

  it('rejects mortgage duplicates, enum/numeric mistakes, and wrong child references', () => {
    expect(parseMortgageEnvelope({ ...mortgageBackup, payments: [{ ...mortgageBackup.payments[0], kind: 'unknown' }] }).ok).toBe(false)
    expect(parseMortgageEnvelope({ ...mortgageBackup, payments: [{ ...mortgageBackup.payments[0], amount: Infinity }] }).ok).toBe(false)
    expect(parseMortgageEnvelope({ ...mortgageBackup, payments: [{ ...mortgageBackup.payments[0], loan_part_id: 'missing' }] }).ok).toBe(false)
    expect(parseMortgageEnvelope({ ...mortgageBackup, banks: [...mortgageBackup.banks, { ...mortgageBackup.banks[0] }] }).ok).toBe(false)
  })

  it('accepts canonical down-payment rows without a loan-part reference', () => {
    const parsed = parseMortgageEnvelope({
      ...mortgageBackup,
      payments: [{
        ...mortgageBackup.payments[0], id: 'deposit-1', loan_part_id: null,
        kind: 'down_payment', amount: 500_000, paid_by: 'a', is_insats: true,
      }],
    })
    expect(parsed).toMatchObject({ ok: true })
  })

  it('preserves large finite persisted values without clamping them', () => {
    const amount = Number.MAX_SAFE_INTEGER
    const parsed = parseMortgageEnvelope({
      ...mortgageBackup,
      payments: [{ ...mortgageBackup.payments[0], amount }],
    })
    expect(parsed).toMatchObject({ ok: true })
    if (parsed.ok) expect(parsed.value.payments[0].amount).toBe(amount)
  })

  it('salvages valid mortgage siblings while warning about malformed rows', () => {
    const result = salvageMortgageEnvelope({ ...mortgageBackup, payments: [mortgageBackup.payments[0], { ...mortgageBackup.payments[0], id: 'payment-2', amount: Number.NaN }] })
    expect(result.value.payments).toHaveLength(1)
    expect(result.rejected).toHaveLength(1)
  })

  // Plan 109a — catalog_id (banks), end_date (mortgages), mortgage_id (payments).
  it('parses the 109a fields, round-trips them idempotently, and defaults them to null when absent', () => {
    const current = {
      ...mortgageBackup,
      banks: [{ ...mortgageBackup.banks[0], catalog_id: 'catalog-danske' }],
      mortgages: [
        { ...mortgageBackup.mortgages[0], id: 'mortgage-old', archived: true, end_date: '2026-07-31' },
        { ...mortgageBackup.mortgages[0], start_date: '2026-08-01' },
      ],
      loan_parts: [], rate_periods: [],
      payments: [{ ...mortgageBackup.payments[0], loan_part_id: null, kind: 'down_payment', is_insats: true, mortgage_id: 'mortgage-1' }],
    }
    const parsed = parseMortgageEnvelope(current)
    expect(parsed).toMatchObject({ ok: true })
    if (!parsed.ok) return
    expect(parsed.value.banks[0].catalog_id).toBe('catalog-danske')
    expect(parsed.value.mortgages[0].end_date).toBe('2026-07-31')
    expect(parsed.value.payments[0].mortgage_id).toBe('mortgage-1')
    expect(parseMortgageEnvelope(parsed.value)).toEqual(parsed)

    // The pre-109a fixture has none of the new fields: they migrate to null.
    const legacy = parseMortgageEnvelope(mortgageBackup)
    if (!legacy.ok) throw new Error('fixture must parse')
    expect(legacy.value.banks[0].catalog_id).toBeNull()
    expect(legacy.value.mortgages[0].end_date).toBeNull()
    expect(legacy.value.payments[0].mortgage_id).toBeNull()
  })

  it("accepts the unknown-legacy '' end_date marker and rejects malformed 109a values", () => {
    const archived = { ...mortgageBackup.mortgages[0], archived: true, end_date: '' }
    expect(parseMortgageEnvelope({ ...mortgageBackup, mortgages: [archived], loan_parts: [], rate_periods: [], payments: [] }).ok).toBe(true)
    expect(parseMortgageEnvelope({ ...mortgageBackup, mortgages: [{ ...archived, end_date: 'not-a-date' }], loan_parts: [], rate_periods: [], payments: [] }).ok).toBe(false)
    expect(parseMortgageEnvelope({ ...mortgageBackup, banks: [{ ...mortgageBackup.banks[0], catalog_id: '' }] }).ok).toBe(false)
    expect(parseMortgageEnvelope({ ...mortgageBackup, payments: [{ ...mortgageBackup.payments[0], mortgage_id: 42 }] }).ok).toBe(false)
  })

  it('strict import rejects payment provenance pointing at an unknown mortgage', () => {
    expect(parseMortgageEnvelope({
      ...mortgageBackup,
      payments: [{ ...mortgageBackup.payments[0], mortgage_id: 'missing-mortgage' }],
    }).ok).toBe(false)
  })

  it('salvage keeps a payment whose provenance points at a mortgage missing from a partial read', () => {
    // Passive cache refreshes rewrite payments without the mortgages slice; an
    // agreement created on another device must never hide payment history.
    const result = salvageMortgageEnvelope({
      ...mortgageBackup,
      mortgages: [],
      loan_parts: [{ ...mortgageBackup.loan_parts[0], mortgage_id: null }],
      payments: [{ ...mortgageBackup.payments[0], mortgage_id: 'not-yet-cached-mortgage' }],
    })
    expect(result.value.payments).toHaveLength(1)
    expect(result.value.payments[0].mortgage_id).toBe('not-yet-cached-mortgage')
  })

  it('rejects all of a month-end import when items and payments disagree', () => {
    expect(parseMonthEndEnvelope({ version: 1, settings: {}, items: [{ id: 'item-1', created_at: '2026-07-15T10:00:00.000Z', date_purchased: '', description: '', enter_amount: 0, split: true, amount: 0, fronted_by: 'a', owed_by: 'b', paid: false, pending: false, payment_id: 'missing', note: '', personal_items: [], personal_a: 0, personal_b: 0, source: 'manual' }], payments: [] }).ok).toBe(false)
  })
})
