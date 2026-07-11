import { describe, it, expect } from 'vitest'
import { todayISO, addYearsISO } from './date'

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
