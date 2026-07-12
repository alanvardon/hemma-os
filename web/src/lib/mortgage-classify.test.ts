// Import classification of bank-statement specification texts. The household's
// bank labels the fixed monthly amortering line "Betalning", so a bare
// "betalning" must classify as amortization — while in-/utbetalning, transfers
// and the English word "payment" stay account movements (kind 'payment').
import { describe, it, expect } from 'vitest'
import { classifyKind } from './mortgage'

describe('classifyKind', () => {
  it('classifies the bank’s "Betalning" line as amortization', () => {
    expect(classifyKind('Betalning')).toBe('amortization')
    expect(classifyKind('BETALNING')).toBe('amortization')
    expect(classifyKind('Betalning lån 1234')).toBe('amortization')
  })

  it('keeps account movements as kind payment — they merely contain "betalning"', () => {
    expect(classifyKind('Inbetalning')).toBe('payment')
    expect(classifyKind('Utbetalning')).toBe('payment')
    expect(classifyKind('Överföring')).toBe('payment')
    expect(classifyKind('Insättning')).toBe('payment')
    expect(classifyKind('Payment')).toBe('payment')
  })

  it('leaves the other kinds untouched', () => {
    expect(classifyKind('Ränta')).toBe('interest')
    expect(classifyKind('Amortering')).toBe('amortization')
    expect(classifyKind('Avbetalning')).toBe('amortization')
    expect(classifyKind('Nyutlåning')).toBe('loan')
    expect(classifyKind('Aviavgift')).toBe('fee')
    expect(classifyKind('')).toBe('other')
    expect(classifyKind(null)).toBe('other')
  })
})
