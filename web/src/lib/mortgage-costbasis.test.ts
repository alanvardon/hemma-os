import { describe, it, expect } from 'vitest'
import {
  purchaseValuation, purchasePrice, costBasisEquity, costBasisOwnedPct,
  derivedDeposit, costBasisSplit, marketEquitySplit, insatsPayments, totalAmortized, defaultSettings,
  contributionSplit, equityTimeline, legacyContributionPayment, makePayment,
  extraAmorteringAllocation, settlement,
} from './mortgage'
import type { LoanPart, Payment, Valuation, Contribution } from './mortgage'

// ── Fixtures ────────────────────────────────────────────────────────────────
// Bought for 5,000,000 with a 1,000,000 deposit → 4,000,000 original loan.
// Amortised 500,000 (balance now 3,500,000). Market value has risen to 7,300,000.

const part: LoanPart = {
  id: 'part-1', created_at: '2021-09-01T00:00:00Z', label: 'Lånedel 1',
  loan_number: '', start_balance: 4_000_000, start_date: '2021-09-01', archived: false,
}

const payments: Payment[] = [
  { id: 'p-a', created_at: '', loan_part_id: 'part-1', date: '2023-06-01', kind: 'amortization',
    description: '', amount: 300_000, balance_after: null, paid_by: 'a', source: 'manual', is_insats: true },
  { id: 'p-b', created_at: '', loan_part_id: 'part-1', date: '2024-01-01', kind: 'amortization',
    description: '', amount: 200_000, balance_after: 3_500_000, paid_by: 'b', source: 'manual' },
]

const valuations: Valuation[] = [
  { id: 'v-buy', created_at: '', date: '2021-09-01', value: 5_000_000, note: 'Köp', is_purchase: true },
  { id: 'v-now', created_at: '', date: '2025-01-01', value: 7_300_000, note: 'Booli' },
]

const contributions: Contribution[] = [
  { id: 'c-a', created_at: '', owner: 'a', date: '2021-09-01', amount: 600_000, note: 'Down payment' },
  { id: 'c-b', created_at: '', owner: 'b', date: '2021-09-01', amount: 400_000, note: 'Down payment' },
]

const settings = { ...defaultSettings(), i_am: 'a' as const, my_ownership_pct: 50, track_contributions: true }
const balance = 3_500_000 // partBalance driven by the latest Saldo row above

// ── purchase-price flag selection ───────────────────────────────────────────

describe('purchaseValuation / purchasePrice', () => {
  it('picks the valuation flagged is_purchase, not the latest', () => {
    expect(purchaseValuation(valuations)?.id).toBe('v-buy')
    expect(purchasePrice(valuations)).toBe(5_000_000)
  })
  it('returns null / 0 when no valuation is flagged', () => {
    const unflagged = valuations.map(v => ({ ...v, is_purchase: false }))
    expect(purchaseValuation(unflagged)).toBeNull()
    expect(purchasePrice(unflagged)).toBe(0)
  })
})

// ── cost-basis equity ───────────────────────────────────────────────────────

describe('costBasisEquity / costBasisOwnedPct', () => {
  it('is purchase price minus current debt', () => {
    expect(costBasisEquity(5_000_000, balance)).toBe(1_500_000)
  })
  it('equals derived deposit + total amortised (the invariant)', () => {
    const deposit = derivedDeposit(5_000_000, [part], payments)
    const amort = totalAmortized([part], payments)
    expect(deposit).toBe(1_000_000)
    expect(amort).toBe(500_000)
    expect(costBasisEquity(5_000_000, balance)).toBe(deposit + amort)
  })
  it('expresses ownership as a share of the purchase price', () => {
    expect(costBasisOwnedPct(5_000_000, balance)).toBe(30) // 1.5M / 5M
  })
  it('is 0 when no purchase price is set', () => {
    expect(costBasisEquity(0, balance)).toBe(0)
    expect(costBasisOwnedPct(0, balance)).toBe(0)
  })
})

// ── derived deposit ─────────────────────────────────────────────────────────

describe('derivedDeposit', () => {
  it('is purchase price minus the original loans', () => {
    expect(derivedDeposit(5_000_000, [part], payments)).toBe(1_000_000)
  })
})

// ── per-owner funded split ──────────────────────────────────────────────────

describe('costBasisSplit', () => {
  it('splits cost-basis equity by funded percentages (deposit + amortering by owner)', () => {
    // p-a is a LEGACY unsplit extra amortering (is_insats, 300k): under the new
    // contract it derives a 50/50 person split rather than crediting a in full.
    // a: 600k deposit + 150k derived extra = 750k (50%);
    // b: 400k deposit + 200k ordinary amort + 150k derived extra = 750k (50%).
    const split = costBasisSplit(5_000_000, balance, payments, contributions, settings)
    expect(split.a_pct).toBe(50)
    expect(split.b_pct).toBe(50)
    expect(split.a).toBe(750_000)
    expect(split.b).toBe(750_000)
  })
  it('halves always sum to the cost-basis total', () => {
    const split = costBasisSplit(5_000_000, balance, payments, contributions, settings)
    expect(split.a + split.b).toBe(costBasisEquity(5_000_000, balance))
  })
  it('returns zero owner capital when no purchase price is configured', () => {
    expect(costBasisSplit(0, balance, payments, contributions, settings)).toEqual({
      a: 0, b: 0, a_pct: 50, b_pct: 50,
    })
  })

  it('adds a personal extra amortering directly without redistributing prior capital', () => {
    const baseCapital: Payment[] = [
      { id: 'deposit-a', created_at: '', loan_part_id: null, date: '2024-01-01', kind: 'down_payment', description: '', amount: 521_000, balance_after: null, paid_by: 'a', source: 'manual', is_insats: true },
      { id: 'deposit-b', created_at: '', loan_part_id: null, date: '2024-01-01', kind: 'down_payment', description: '', amount: 521_000, balance_after: null, paid_by: 'b', source: 'manual', is_insats: true },
    ]
    // A fully-personal extra amortering now carries an explicit 100/0 split;
    // under the new contract that is what attributes all 8k to a's account.
    const extra: Payment = {
      id: 'extra-a', created_at: '', loan_part_id: 'part-1', date: '2024-02-01', kind: 'amortization',
      description: '', amount: 8_000, balance_after: 950_000, paid_by: 'a', source: 'manual', is_insats: true,
      paid_split: { a: 8_000, b: 0 },
    }

    expect(costBasisSplit(2_000_000, 958_000, baseCapital, [], settings)).toMatchObject({
      a: 521_000, b: 521_000, a_pct: 50, b_pct: 50,
    })
    expect(costBasisSplit(2_000_000, 950_000, [...baseCapital, extra], [], settings)).toMatchObject({
      a: 529_000, b: 521_000,
    })
    expect(marketEquitySplit(2_000_000, 950_000, [...baseCapital, extra], [], settings)).toMatchObject({
      a: 529_000, b: 521_000,
    })
    // A 200k market gain follows the configured 50/50 ownership target. The
    // personal 8k amortering still moves only a's account.
    expect(marketEquitySplit(2_200_000, 950_000, [...baseCapital, extra], [], settings)).toMatchObject({
      a: 629_000, b: 621_000,
    })

    const loan = { ...part, start_balance: 958_000, original_balance: 958_000, start_date: '2024-01-01' }
    const ledger: Payment[] = [
      { id: 'saldo', created_at: '', loan_part_id: loan.id, date: '2024-01-31', kind: 'payment', description: '', amount: 0, balance_after: 958_000, paid_by: 'joint', source: 'manual' },
      ...baseCapital,
      extra,
    ]
    const values: Valuation[] = [{ id: 'value', created_at: '', date: '2024-01-01', value: 2_000_000, note: '', is_purchase: true }]
    expect(equityTimeline([loan], ledger, values, settings).at(-1)).toMatchObject({
      balance: 950_000, equity: 1_050_000, a_equity: 529_000, b_equity: 521_000,
    })
  })
})

// ── flagged extra payments ──────────────────────────────────────────────────

describe('insatsPayments', () => {
  it('returns only payments flagged is_insats', () => {
    const flagged = insatsPayments(payments)
    expect(flagged.map(p => p.id)).toEqual(['p-a'])
  })
})

// ── per-payment co-funding split ────────────────────────────────────────────

describe('contributionSplit honours a per-payment paid_split', () => {
  const base = { id: 'x', created_at: '', loan_part_id: 'part-1', date: '2024-01-01', kind: 'amortization' as const, description: '', balance_after: null, source: 'manual' }

  it('allocates one co-funded payment across both owners', () => {
    const pays: Payment[] = [{ ...base, amount: 200_000, paid_by: 'joint', paid_split: { a: 120_000, b: 80_000 } }]
    const cs = contributionSplit(pays, [], settings)
    expect(cs.a).toBe(120_000)
    expect(cs.b).toBe(80_000)
  })

  it('falls back to paid_by when there is no split', () => {
    const pays: Payment[] = [{ ...base, amount: 200_000, paid_by: 'a' }]
    const cs = contributionSplit(pays, [], settings)
    expect(cs.a).toBe(200_000)
    expect(cs.b).toBe(0)
  })

  it('makePayment normalises a provided paid_split', () => {
    const p = makePayment({ amount: 200_000, kind: 'amortization', paid_split: { a: 120_000, b: 80_000 } })
    expect(p.paid_split).toEqual({ a: 120_000, b: 80_000 })
    const plain = makePayment({ amount: 5_000, kind: 'interest' })
    expect(plain.paid_split).toBeNull()
  })
})

describe('contributionSplit uses canonical Betalning principal', () => {
  it('attributes inferred principal jointly while explicit amortering keeps its owner', () => {
    const pays: Payment[] = [
      { id: 'pay', created_at: '', loan_part_id: 'part-1', date: '2024-02-01', kind: 'payment', description: '', amount: 6_000, balance_after: null, paid_by: 'a', paid_split: { a: 6_000, b: 0 }, source: 'manual' },
      { id: 'interest', created_at: '', loan_part_id: 'part-1', date: '2024-02-28', kind: 'interest', description: '', amount: 3_000, balance_after: null, paid_by: 'b', source: 'manual' },
      { id: 'extra', created_at: '', loan_part_id: 'part-1', date: '2024-02-28', kind: 'amortization', description: '', amount: 2_000, balance_after: null, paid_by: 'a', source: 'manual', is_insats: true, paid_split: { a: 2_000, b: 0 } },
    ]

    // Betalning principal is 3 000 and always joint → 1 500 each at the
    // configured 50/50 target. The extra amortering carries an explicit 100/0
    // split, so its 2 000 remains attributed to a.
    expect(contributionSplit(pays, [], settings)).toMatchObject({
      a: 3_500,
      b: 1_500,
      joint: 3_000,
      total: 5_000,
      a_pct: 70,
      b_pct: 30,
    })
  })

  it('revises the joint amount when a missing Ränta row arrives', () => {
    const debit: Payment = { id: 'pay', created_at: '', loan_part_id: 'part-1', date: '2024-02-01', kind: 'payment', description: '', amount: 6_000, balance_after: null, paid_by: 'joint', source: 'manual' }
    const interest: Payment = { ...debit, id: 'interest', date: '2024-02-28', kind: 'interest', amount: 3_000 }

    expect(contributionSplit([debit], [], settings).joint).toBe(6_000)
    expect(contributionSplit([debit, interest], [], settings).joint).toBe(3_000)
  })
})

describe('canonical contribution payments', () => {
  it('normalises Betalning and Ränta to joint without changing explicit amortering attribution', () => {
    expect(makePayment({ kind: 'payment', paid_by: 'a', paid_split: { a: 6_000, b: 0 } })).toMatchObject({ paid_by: 'joint', paid_split: null })
    expect(makePayment({ kind: 'interest', paid_by: 'b', paid_split: { a: 0, b: 3_000 } })).toMatchObject({ paid_by: 'joint', paid_split: null })
    expect(makePayment({ kind: 'amortization', paid_by: 'a', paid_split: { a: 2_000, b: 0 } })).toMatchObject({ paid_by: 'a', paid_split: { a: 2_000, b: 0 } })
  })

  it('normalises a down payment to an attributable, loan-independent Insats row', () => {
    expect(makePayment({ kind: 'down_payment', loan_part_id: 'part-1', paid_by: 'b', amount: 400_000 })).toMatchObject({
      kind: 'down_payment', loan_part_id: null, paid_by: 'b', amount: 400_000, is_insats: true,
    })
  })

  it('converts a legacy contribution deterministically and rejects invented financial fields', () => {
    const legacy: Contribution = { id: 'c-a', created_at: '2021-09-01T10:00:00.000Z', owner: 'a', date: '2021-09-01', amount: 600_000, note: 'Kontantinsats' }
    const expected = {
      id: 'legacy-contribution:c-a', created_at: legacy.created_at, loan_part_id: null,
      date: legacy.date, kind: 'down_payment', description: 'Kontantinsats', amount: 600_000,
      paid_by: 'a', source: 'legacy-contribution:c-a', is_insats: true,
    }
    expect(legacyContributionPayment(legacy)).toMatchObject(expected)
    expect(legacyContributionPayment(legacy)).toMatchObject(expected)
    expect(legacyContributionPayment({ ...legacy, amount: 0 })).toBeNull()
    expect(legacyContributionPayment({ ...legacy, date: '2021-02-30' })).toBeNull()
    expect(legacyContributionPayment({ ...legacy, owner: undefined })).toBeNull()
  })

  it('counts a canonical down payment once when its legacy source row is also present', () => {
    const canonical = legacyContributionPayment(contributions[0])!
    expect(contributionSplit([canonical], contributions, settings)).toMatchObject({ a: 600_000, b: 400_000, total: 1_000_000 })
  })
})

// ── Plan 116: extra-amortering payer vs. person allocation ───────────────────

describe('extraAmorteringAllocation resolves person split independently of payer', () => {
  // A 10 000 kr extra amortering; overridable payer and split.
  const extra = (over: Partial<Payment> = {}): Payment => ({
    id: 'ex', created_at: '', loan_part_id: 'part-1', date: '2024-03-01', kind: 'amortization',
    description: '', amount: 10_000, balance_after: null, paid_by: 'a', source: 'manual', is_insats: true, ...over,
  })

  it('honours a valid explicit split and credits both people, leaving the total unchanged', () => {
    const p = extra({ paid_by: 'a', paid_split: { a: 6_000, b: 4_000 } })
    expect(extraAmorteringAllocation(p, settings)).toEqual({ a: 6_000, b: 4_000, provenance: 'explicit' })
    const cs = contributionSplit([p], [], settings)
    expect(cs).toMatchObject({ a: 6_000, b: 4_000, joint: 0, total: 10_000 })
    // Debt is reallocated between people only; the transaction total is intact.
    expect(cs.a + cs.b).toBe(10_000)
  })

  it('is unaffected by a payer-only change (a→b) — attribution and settlement stay identical', () => {
    const paidByA = extra({ paid_by: 'a', paid_split: { a: 6_000, b: 4_000 } })
    const paidByB = extra({ paid_by: 'b', paid_split: { a: 6_000, b: 4_000 } })
    expect(extraAmorteringAllocation(paidByB, settings)).toEqual({ a: 6_000, b: 4_000, provenance: 'explicit' })
    expect(contributionSplit([paidByB], [], settings)).toEqual(contributionSplit([paidByA], [], settings))
    expect(settlement([paidByB], [], settings)).toEqual(settlement([paidByA], [], settings))
  })

  it('moves personal accounts when only the split changes, but never the total', () => {
    const a = contributionSplit([extra({ paid_split: { a: 6_000, b: 4_000 } })], [], settings)
    const b = contributionSplit([extra({ paid_split: { a: 3_000, b: 7_000 } })], [], settings)
    expect(a.a).not.toBe(b.a)
    expect(a.total).toBe(10_000)
    expect(b.total).toBe(10_000)
  })

  it('accepts a valid 100/0 explicit split as explicit', () => {
    expect(extraAmorteringAllocation(extra({ paid_split: { a: 10_000, b: 0 } }), settings))
      .toEqual({ a: 10_000, b: 0, provenance: 'explicit' })
  })

  it('derives a legacy unsplit row from the configured ownership and reconciles öre exactly', () => {
    // 50/50
    expect(extraAmorteringAllocation(extra(), settings)).toEqual({ a: 5_000, b: 5_000, provenance: 'derived' })

    // Unequal 70/30 ownership.
    const s70 = { ...settings, my_ownership_pct: 70 }
    expect(extraAmorteringAllocation(extra(), s70)).toEqual({ a: 7_000, b: 3_000, provenance: 'derived' })

    // 100/0 ownership.
    const s100 = { ...settings, my_ownership_pct: 100 }
    expect(extraAmorteringAllocation(extra(), s100)).toEqual({ a: 10_000, b: 0, provenance: 'derived' })

    // Odd-öre amount: the rounding remainder goes to the second person so
    // a + b === amount exactly.
    const odd = extra({ amount: 10_000.01 })
    for (const s of [settings, s70, s100]) {
      const alloc = extraAmorteringAllocation(odd, s)
      expect(alloc.provenance).toBe('derived')
      expect(alloc.a + alloc.b).toBe(10_000.01)
    }
  })

  it('treats a malformed explicit split as absent and derives instead', () => {
    // Sum mismatch.
    expect(extraAmorteringAllocation(extra({ paid_split: { a: 5_000, b: 4_000 } }), settings))
      .toEqual({ a: 5_000, b: 5_000, provenance: 'derived' })
    // Negative share.
    expect(extraAmorteringAllocation(extra({ paid_split: { a: -1_000, b: 11_000 } }), settings))
      .toEqual({ a: 5_000, b: 5_000, provenance: 'derived' })
    // Non-finite share.
    expect(extraAmorteringAllocation(extra({ paid_split: { a: NaN, b: 10_000 } }), settings))
      .toEqual({ a: 5_000, b: 5_000, provenance: 'derived' })
    // A malformed split must not be credited verbatim by contributionSplit.
    expect(contributionSplit([extra({ paid_split: { a: 5_000, b: 4_000 } })], [], settings))
      .toMatchObject({ a: 5_000, b: 5_000, total: 10_000 })
  })

  it('leaves ordinary amortering and down payments on their existing attribution', () => {
    // Ordinary amortering (is_insats falsy): still follows paid_by.
    const ordinary: Payment = { ...extra({ paid_by: 'a' }), id: 'ord', is_insats: false }
    expect(contributionSplit([ordinary], [], settings)).toMatchObject({ a: 10_000, b: 0, total: 10_000 })

    // Down payment (is_insats true, but kind down_payment): unchanged behaviour —
    // paid_by when unsplit, explicit paid_split when present.
    const dpUnsplit: Payment = { ...extra({ paid_by: 'a' }), id: 'dp1', kind: 'down_payment' }
    expect(contributionSplit([dpUnsplit], [], settings)).toMatchObject({ a: 10_000, b: 0, total: 10_000 })
    const dpSplit: Payment = { ...extra({ paid_by: 'a' }), id: 'dp2', kind: 'down_payment', paid_split: { a: 6_000, b: 4_000 } }
    expect(contributionSplit([dpSplit], [], settings)).toMatchObject({ a: 6_000, b: 4_000, total: 10_000 })
  })
})
