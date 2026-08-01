import { describe, it, expect } from 'vitest'
import { todayISO, addYearsISO, addDaysISO, dayBefore } from './date'

describe('todayISO', () => {
  it('returns the local date as zero-padded YYYY-MM-DD', () => {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    const expected = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    expect(todayISO()).toBe(expected)
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('addYearsISO', () => {
  it('shifts whole years, zero-padded', () => {
    expect(addYearsISO('2026-07-11', -5)).toBe('2021-07-11')
    expect(addYearsISO('2026-01-05', 1)).toBe('2027-01-05')
  })

  it('rolls a leap day forward when the target year has no Feb 29', () => {
    expect(addYearsISO('2028-02-29', -5)).toBe('2023-03-01')
  })
})

describe('addDaysISO', () => {
  it('shifts whole days inside a month', () => {
    expect(addDaysISO('2026-08-01', 30)).toBe('2026-08-31')
    expect(addDaysISO('2026-08-31', -30)).toBe('2026-08-01')
  })

  it('crosses a month boundary in both directions', () => {
    expect(addDaysISO('2026-07-31', 1)).toBe('2026-08-01')
    expect(addDaysISO('2026-08-01', -1)).toBe('2026-07-31')
    expect(addDaysISO('2026-02-28', 1)).toBe('2026-03-01')   // 2026 is not a leap year
  })

  it('crosses a year boundary in both directions', () => {
    expect(addDaysISO('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysISO('2027-01-01', -1)).toBe('2026-12-31')
  })

  it('lands on a leap day', () => {
    expect(addDaysISO('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDaysISO('2028-03-01', -1)).toBe('2028-02-29')
    expect(addDaysISO('2028-02-29', 1)).toBe('2028-03-01')
    expect(addDaysISO('2028-01-01', 366)).toBe('2029-01-01')  // 2028 has 366 days
  })

  it('returns the same date for a zero offset', () => {
    expect(addDaysISO('2026-08-01', 0)).toBe('2026-08-01')
  })

  it('zero-pads month and day', () => {
    expect(addDaysISO('2026-01-08', 1)).toBe('2026-01-09')
    expect(addDaysISO('2026-09-30', 1)).toBe('2026-10-01')
  })

  it('returns null on an unparseable date or a non-finite offset', () => {
    expect(addDaysISO('', 1)).toBeNull()
    expect(addDaysISO('2026-13-01', 1)).toBeNull()
    expect(addDaysISO('inte ett datum', 1)).toBeNull()
    expect(addDaysISO('2026-08-01', Number.NaN)).toBeNull()
    expect(addDaysISO('2026-08-01', Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('dayBefore', () => {
  it('steps back one calendar day across month, year and leap boundaries', () => {
    expect(dayBefore('2026-08-02')).toBe('2026-08-01')
    expect(dayBefore('2026-08-01')).toBe('2026-07-31')
    expect(dayBefore('2027-01-01')).toBe('2026-12-31')
    expect(dayBefore('2028-03-01')).toBe('2028-02-29')
    expect(dayBefore('2026-03-01')).toBe('2026-02-28')
  })

  it('returns null on an unparseable date', () => {
    expect(dayBefore('')).toBeNull()
    expect(dayBefore('2026-00-10')).toBeNull()
  })
})
