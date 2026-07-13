// Import classification of bank-statement specification texts. The bank's
// per-part "Betalning" line is the TOTAL debited (ränta included), so it must
// classify as kind 'payment' — an account movement, never principal. On an
// interest-only part betalning simply equals the ränta; classifying it as
// amortization would invent principal that was never repaid. The part's real
// amortering is derived downstream as betalning − ränta within the month.
import { describe, it, expect } from 'vitest'
import { classifyKind } from './mortgage'

describe('classifyKind', () => {
  it('classifies the bank’s "Betalning" line (the total debit) as kind payment', () => {
    expect(classifyKind('Betalning')).toBe('payment')
    expect(classifyKind('BETALNING')).toBe('payment')
    expect(classifyKind('Betalning lån 1234')).toBe('payment')
    expect(classifyKind('Inbetalning')).toBe('payment')
    expect(classifyKind('Utbetalning')).toBe('payment')
    expect(classifyKind('Överföring')).toBe('payment')
    expect(classifyKind('Payment')).toBe('payment')
  })

  it('reserves kind amortization for explicit principal texts', () => {
    expect(classifyKind('Amortering')).toBe('amortization')
    expect(classifyKind('Avbetalning')).toBe('amortization')
    expect(classifyKind('Principal')).toBe('amortization')
  })

  it('leaves the other kinds untouched', () => {
    expect(classifyKind('Ränta')).toBe('interest')
    expect(classifyKind('Nyutlåning')).toBe('loan')
    expect(classifyKind('Aviavgift')).toBe('fee')
    expect(classifyKind('')).toBe('other')
    expect(classifyKind(null)).toBe('other')
  })
})
