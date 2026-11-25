// Tests the policy-rate-notify Edge Function's pure logic by importing the
// Deno module directly by relative path (it has no imports, so it loads
// under Vitest), the same pattern as salary-reminder-logic.test.ts.
//
// The function runs daily and emails when the policy rate VALUE differs from
// the last one emailed. SECBREPOEFF is a daily series (one observation per
// banking day) whose value only changes on the EFFECTIVE date, so the
// "gällande från" date is the first day of the latest unchanged run.
import { describe, expect, it } from 'vitest'
import {
  buildNotificationEmail,
  currentRate,
  parseObservations,
  parsePoint,
  serializePoint,
  shouldNotify,
} from '../../../supabase/functions/policy-rate-notify/logic.ts'

// Fictional but realistic: 1.75 % held, raised to 2.00 % effective 11 Nov.
const NOV_RAISE = [
  { date: '2026-11-06', value: 1.75 },
  { date: '2026-11-09', value: 1.75 },
  { date: '2026-11-10', value: 1.75 },
  { date: '2026-11-11', value: 2 },
  { date: '2026-11-12', value: 2 },
  { date: '2026-11-25', value: 2 },
]

describe('currentRate', () => {
  it('returns the latest value dated from the first day it took effect', () => {
    expect(currentRate(NOV_RAISE)).toEqual({ date: '2026-11-11', value: 2 })
  })

  it('does not depend on input order', () => {
    expect(currentRate([...NOV_RAISE].reverse())).toEqual({ date: '2026-11-11', value: 2 })
  })

  it('on the announcement day, before the change takes effect, still reports the old rate', () => {
    const beforeEffective = NOV_RAISE.slice(0, 3)
    expect(currentRate(beforeEffective)).toEqual({ date: '2026-11-06', value: 1.75 })
  })

  it('handles a cut, and only the latest run counts', () => {
    const series = [
      { date: '2026-01-02', value: 2.25 },
      { date: '2026-02-04', value: 2 },
      { date: '2026-03-25', value: 2.25 },
      { date: '2026-03-26', value: 2.25 },
    ]
    expect(currentRate(series)).toEqual({ date: '2026-03-25', value: 2.25 })
  })

  it('uses the first observation when the whole window has one value', () => {
    expect(currentRate([{ date: '2026-05-04', value: 1.75 }, { date: '2026-05-05', value: 1.75 }]))
      .toEqual({ date: '2026-05-04', value: 1.75 })
  })

  it('throws on an empty series rather than guessing', () => {
    expect(() => currentRate([])).toThrow()
  })
})

describe('parseObservations', () => {
  it('accepts the SWEA array shape', () => {
    expect(parseObservations([{ date: '2026-11-11', value: 2 }])).toEqual([{ date: '2026-11-11', value: 2 }])
  })

  it.each([
    ['not an array', { date: '2026-11-11', value: 2 }],
    ['null', null],
    ['empty body', ''],
    ['value as string', [{ date: '2026-11-11', value: '2' }]],
    ['NaN value', [{ date: '2026-11-11', value: Number.NaN }]],
    ['bad date', [{ date: '11/11/2026', value: 2 }]],
    ['missing date', [{ value: 2 }]],
  ])('throws on %s', (_label, body) => {
    expect(() => parseObservations(body)).toThrow()
  })
})

describe('shouldNotify', () => {
  const current = { date: '2026-11-11', value: 2 }

  it('notifies when there is no stored point (first run)', () => {
    expect(shouldNotify(null, current)).toBe(true)
    expect(shouldNotify(undefined, current)).toBe(true)
  })

  it('notifies when the value changed', () => {
    // The real prod baseline: the old (date, value) shape stored at setup.
    expect(shouldNotify('{"date":"2026-10-09","value":1.75}', current)).toBe(true)
  })

  it('skips when the value is unchanged, even if the stored date differs', () => {
    // A daily series gets a new date every day; that alone must not email.
    expect(shouldNotify('{"date":"2026-10-09","value":2}', current)).toBe(false)
    expect(shouldNotify(serializePoint(current), current)).toBe(false)
  })

  it('treats malformed stored JSON as no prior record', () => {
    expect(shouldNotify('not-json', current)).toBe(true)
    expect(shouldNotify('{"date":"2026-10-09","value":"1.75"}', current)).toBe(true)
  })

  it('detects a quarter-point move both ways', () => {
    expect(shouldNotify(serializePoint({ date: '2026-01-02', value: 2.25 }), { date: '2026-02-04', value: 2 })).toBe(true)
    expect(shouldNotify(serializePoint({ date: '2026-01-02', value: 2 }), { date: '2026-02-04', value: 2.25 })).toBe(true)
  })
})

describe('parsePoint', () => {
  it('round-trips through serializePoint', () => {
    expect(parsePoint(serializePoint({ date: '2026-11-11', value: 2 }))).toEqual({ date: '2026-11-11', value: 2 })
  })
})

describe('buildNotificationEmail', () => {
  const url = 'https://example.test/#/bolanekoll'

  it('states old and new rate and the effective date', () => {
    const email = buildNotificationEmail({ date: '2026-10-09', value: 1.75 }, { date: '2026-11-11', value: 2 }, url)
    expect(email.subject).toBe('Riksbanken ändrade styrräntan till 2,00 %')
    expect(email.text).toContain('från 1,75 % till 2,00 %')
    expect(email.text).toContain('11 november 2026')
    expect(email.html).toContain(url)
  })

  it('uses first-run framing without a previous point', () => {
    const email = buildNotificationEmail(null, { date: '2026-11-11', value: 2 }, url)
    expect(email.text).toContain('är nu 2,00 %')
  })
})
