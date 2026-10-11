// Tests plan 132's shared salary-reminder logic by importing the Deno edge
// function module directly by relative path (it has no imports, so it loads
// under Vitest too — same pattern as resend-request.test.ts).
import { describe, expect, it } from 'vitest'
import {
  buildReminderEmail,
  isLocalDryRunLinkLoggingAllowed,
  isSendDay,
  lastValidDayEn,
  monthFor,
  monthLabelEn,
  splitPrefill,
  stockholmToday,
  tokenExpiry,
  validateHalf,
} from '../../../supabase/functions/_shared/salary-reminder-logic.ts'

describe('stockholmToday', () => {
  it('winter (CET, UTC+1): the date flips at 23:00 UTC', () => {
    expect(stockholmToday(new Date('2026-01-15T22:59:59Z'))).toBe('2026-01-15')
    expect(stockholmToday(new Date('2026-01-15T23:00:00Z'))).toBe('2026-01-16')
    expect(stockholmToday(new Date('2026-01-16T00:00:00Z'))).toBe('2026-01-16')
  })

  it('summer (CEST, UTC+2): the date flips at 22:00 UTC', () => {
    expect(stockholmToday(new Date('2026-07-15T21:59:59Z'))).toBe('2026-07-15')
    expect(stockholmToday(new Date('2026-07-15T22:00:00Z'))).toBe('2026-07-16')
    expect(stockholmToday(new Date('2026-07-16T00:00:00Z'))).toBe('2026-07-16')
  })

  it('crosses the year boundary in Stockholm before UTC does', () => {
    expect(stockholmToday(new Date('2025-12-31T22:59:59Z'))).toBe('2025-12-31')
    expect(stockholmToday(new Date('2025-12-31T23:00:00Z'))).toBe('2026-01-01')
  })

  it('cron at 07:00 UTC lands on the same Stockholm day in both seasons', () => {
    expect(stockholmToday(new Date('2026-01-25T07:00:00Z'))).toBe('2026-01-25')
    expect(stockholmToday(new Date('2026-07-25T07:00:00Z'))).toBe('2026-07-25')
  })
})

describe('isSendDay', () => {
  it('null settings means enabled on day 25', () => {
    expect(isSendDay('2026-10-25', null)).toBe(true)
    expect(isSendDay('2026-10-24', null)).toBe(false)
    expect(isSendDay('2026-10-26', null)).toBe(false)
  })

  it('disabled never sends, even on the configured day', () => {
    expect(isSendDay('2026-10-25', { enabled: false, send_day: 25 })).toBe(false)
  })

  it('uses the configured day (28, 1)', () => {
    expect(isSendDay('2026-02-28', { enabled: true, send_day: 28 })).toBe(true)
    expect(isSendDay('2026-02-25', { enabled: true, send_day: 28 })).toBe(false)
    expect(isSendDay('2026-03-01', { enabled: true, send_day: 1 })).toBe(true)
    expect(isSendDay('2026-03-10', { enabled: true, send_day: 1 })).toBe(false)
  })

  it('a malformed date never sends', () => {
    expect(isSendDay('2026-10', null)).toBe(false)
    expect(isSendDay('', null)).toBe(false)
    expect(isSendDay('2026-13-25', null)).toBe(false)
  })
})

describe('monthFor', () => {
  it('returns YYYY-MM', () => {
    expect(monthFor('2026-10-25')).toBe('2026-10')
    expect(monthFor('2027-01-01')).toBe('2027-01')
  })

  it('throws on malformed input', () => {
    expect(() => monthFor('2026-10')).toThrow()
    expect(() => monthFor('garbage')).toThrow()
  })
})

describe('tokenExpiry (exclusive: 00:00 Stockholm on the 1st of month+2)', () => {
  const cases: [string, string, string][] = [
    // month, expected UTC instant, why
    ['2026-06', '2026-07-31T22:00:00.000Z', 'summer: Aug 1 00:00 CEST'],
    ['2026-01', '2026-02-28T23:00:00.000Z', 'winter: Mar 1 00:00 CET'],
    ['2026-02', '2026-03-31T22:00:00.000Z', 'month+1 = March, DST starts inside it → Apr 1 is CEST'],
    ['2026-09', '2026-10-31T23:00:00.000Z', 'month+1 = October, DST ends inside it → Nov 1 is CET'],
    ['2026-03', '2026-04-30T22:00:00.000Z', 'issued in a DST-start month, expires in CEST'],
    ['2026-11', '2026-12-31T23:00:00.000Z', 'November → Jan 1 of next year'],
    ['2026-12', '2027-01-31T23:00:00.000Z', 'December → Feb 1 of next year'],
  ]
  it.each(cases)('%s → %s (%s)', (month, iso) => {
    expect(tokenExpiry(month).toISOString()).toBe(iso)
  })

  it('the last millisecond of month+1 is still before the expiry, the bound itself is not', () => {
    const exp = tokenExpiry('2026-10')
    expect(exp.toISOString()).toBe('2026-11-30T23:00:00.000Z')
    expect(stockholmToday(new Date(exp.getTime() - 1))).toBe('2026-11-30')
    expect(stockholmToday(exp)).toBe('2026-12-01')
  })

  it('throws on a malformed month', () => {
    expect(() => tokenExpiry('2026-13')).toThrow()
    expect(() => tokenExpiry('2026-1')).toThrow()
    expect(() => tokenExpiry('')).toThrow()
  })
})

describe('splitPrefill (mirrors SalaryModal.prefillItems)', () => {
  const incomes = [
    { id: 'r1', label: 'Lön', amount: 42350, owner: 'a' },
    { id: 'r2', label: 'Barnbidrag', amount: 1250, owner: 'joint' },
    { id: 'r3', label: 'Lön', amount: 38900, owner: 'b' },
  ]

  it("routes 'a' and 'joint' rows to A, in order", () => {
    expect(splitPrefill(incomes, 'a')).toEqual([
      { label: 'Lön', amount: 42350 },
      { label: 'Barnbidrag', amount: 1250 },
    ])
  })

  it("routes only 'b' rows to B", () => {
    expect(splitPrefill(incomes, 'b')).toEqual([{ label: 'Lön', amount: 38900 }])
  })

  it('a row with a missing or unknown owner goes to A (owner !== "b")', () => {
    const rows = [{ label: 'X', amount: 1 }, { label: 'Y', amount: 2, owner: 'c' }]
    expect(splitPrefill(rows, 'a')).toEqual([{ label: 'X', amount: 1 }, { label: 'Y', amount: 2 }])
    expect(splitPrefill(rows, 'b')).toEqual([{ label: 'Lön / Salary', amount: 0 }])
  })

  it('keeps labels as stored (no trimming, like the modal)', () => {
    expect(splitPrefill([{ label: '  Lön ', amount: 100, owner: 'b' }], 'b')).toEqual([{ label: '  Lön ', amount: 100 }])
  })

  it('empty incomes → single fallback row for both slots', () => {
    expect(splitPrefill([], 'a')).toEqual([{ label: 'Lön / Salary', amount: 0 }])
    expect(splitPrefill([], 'b')).toEqual([{ label: 'Lön / Salary', amount: 0 }])
  })

  it('no rows for the slot → fallback', () => {
    expect(splitPrefill([{ label: 'Lön', amount: 30000, owner: 'a' }], 'b')).toEqual([{ label: 'Lön / Salary', amount: 0 }])
  })

  it('non-array input → fallback, never throws', () => {
    for (const bad of [undefined, null, 'x', 42, { incomes: [] }]) {
      expect(splitPrefill(bad, 'a')).toEqual([{ label: 'Lön / Salary', amount: 0 }])
    }
  })

  it('skips junk entries and keeps the valid ones', () => {
    const junk = [
      null, 'row', 7, [1, 2],
      { label: 5, amount: 100, owner: 'a' },
      { label: 'NaN', amount: Number.NaN, owner: 'a' },
      { label: 'Inf', amount: Number.POSITIVE_INFINITY, owner: 'a' },
      { label: 'Str', amount: '100', owner: 'a' },
      { label: 'Ok', amount: -500, owner: 'a' },
    ]
    expect(splitPrefill(junk, 'a')).toEqual([{ label: 'Ok', amount: -500 }])
    expect(splitPrefill(junk, 'b')).toEqual([{ label: 'Lön / Salary', amount: 0 }])
  })

  it('returns a fresh fallback object each call', () => {
    const first = splitPrefill([], 'a')
    first[0].amount = 99
    expect(splitPrefill([], 'a')).toEqual([{ label: 'Lön / Salary', amount: 0 }])
  })
})

describe('validateHalf', () => {
  const item = (label: string, amount: number) => ({ label, amount })
  const fail = (input: unknown) => {
    const r = validateHalf(input)
    if (r.ok) throw new Error('expected failure')
    return r
  }

  it('golden: trims labels and note, keeps negatives', () => {
    expect(validateHalf({ items: [item(' Lön ', 42350), item('Skatt', -1200.5)], note: '  bonus  ' })).toEqual({
      ok: true,
      items: [{ label: 'Lön', amount: 42350 }, { label: 'Skatt', amount: -1200.5 }],
      note: 'bonus',
    })
  })

  it('drops items with an empty trimmed label AND zero amount, keeps either alone', () => {
    const r = validateHalf({ items: [item('   ', 0), item('', 500), item('Lön', 0)] })
    expect(r).toEqual({ ok: true, items: [{ label: '', amount: 500 }, { label: 'Lön', amount: 0 }], note: null })
  })

  it('an all-empty submission is valid with no items (zero_total is decided later)', () => {
    expect(validateHalf({ items: [item('', 0)], note: '' })).toEqual({ ok: true, items: [], note: null })
  })

  it('20 items OK, 21 rejected — counted on the raw array, empties included', () => {
    expect(validateHalf({ items: Array.from({ length: 20 }, () => item('L', 1)) }).ok).toBe(true)
    expect(fail({ items: Array.from({ length: 21 }, () => item('', 0)) }).field).toBe('items')
  })

  it('label 80 chars after trim OK, 81 rejected', () => {
    expect(validateHalf({ items: [item('  ' + 'x'.repeat(80) + '  ', 1)] }).ok).toBe(true)
    expect(fail({ items: [item('x'.repeat(81), 1)] }).field).toBe('items[0].label')
  })

  it('|amount| 10 000 000 OK, 10 000 000.01 rejected (both signs) — no clamping', () => {
    expect(validateHalf({ items: [item('L', 10_000_000)] })).toEqual({ ok: true, items: [{ label: 'L', amount: 10_000_000 }], note: null })
    expect(validateHalf({ items: [item('L', -10_000_000)] }).ok).toBe(true)
    expect(fail({ items: [item('L', 10_000_000.01)] }).field).toBe('items[0].amount')
    expect(fail({ items: [item('L', -10_000_000.01)] }).field).toBe('items[0].amount')
  })

  it('rejects NaN, Infinity, strings, null and missing amounts', () => {
    for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '100', null, undefined]) {
      expect(fail({ items: [{ label: 'Lön', amount }] }).field).toBe('items[0].amount')
    }
  })

  it('reports the failing index', () => {
    expect(fail({ items: [item('A', 1), item('B', Number.NaN)] }).field).toBe('items[1].amount')
  })

  it('rejects a non-string label and a non-object item', () => {
    expect(fail({ items: [{ label: 5, amount: 1 }] }).field).toBe('items[0].label')
    expect(fail({ items: [{ amount: 1 }] }).field).toBe('items[0].label')
    expect(fail({ items: [null] }).field).toBe('items[0]')
    expect(fail({ items: ['x'] }).field).toBe('items[0]')
  })

  it('note 200 chars after trim OK, 201 rejected; non-string rejected; empty/absent → null', () => {
    expect(validateHalf({ items: [], note: ' ' + 'n'.repeat(200) + ' ' })).toEqual({ ok: true, items: [], note: 'n'.repeat(200) })
    expect(fail({ items: [], note: 'n'.repeat(201) }).field).toBe('note')
    expect(fail({ items: [], note: 42 }).field).toBe('note')
    expect(validateHalf({ items: [], note: null })).toEqual({ ok: true, items: [], note: null })
    expect(validateHalf({ items: [] })).toEqual({ ok: true, items: [], note: null })
    expect(validateHalf({ items: [], note: '   ' })).toEqual({ ok: true, items: [], note: null })
  })

  it('rejects a non-object body and non-array items', () => {
    for (const bad of [null, undefined, 'x', 1, []]) expect(fail(bad).field).toBe('body')
    expect(fail({}).field).toBe('items')
    expect(fail({ items: 'x' }).field).toBe('items')
  })
})

describe('buildReminderEmail', () => {
  const link = 'https://hemma.example.se/#/lon/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'
  const expiresAt = tokenExpiry('2026-10')
  const email = buildReminderEmail({ displayName: 'Alex', month: '2026-10', link, expiresAt })

  it('has the English subject', () => {
    expect(email.subject).toBe('Submit your salary for October 2026')
  })

  it('has exactly one link, to the token URL, in both bodies', () => {
    expect(email.html.match(/<a /g)).toHaveLength(1)
    expect(email.html).toContain(`href="${link}"`)
    expect(email.text).toContain(link)
  })

  it('says it works without login and expires after the last valid Stockholm day', () => {
    for (const body of [email.text, email.html]) {
      expect(body).toContain('without logging in')
      expect(body).toContain('expires after 30 November 2026')
    }
  })

  it('never includes amounts (visible text has no digits beyond the month/expiry dates)', () => {
    for (const body of [email.text, email.html]) {
      const stripped = body.replace(/<[^>]*>/g, ' ').replace(link, '').replace(/2026/g, '').replace(/30 November/g, '')
      expect(stripped).not.toMatch(/\d{3,}/)
      expect(stripped).not.toMatch(/\bkr\b/)
    }
  })

  it('HTML-escapes the display name', () => {
    const e = buildReminderEmail({ displayName: '<script>alert("x")</script> & Co', month: '2026-10', link, expiresAt })
    expect(e.html).not.toContain('<script>')
    expect(e.html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co')
  })

  it('formats December → February expiry across the year', () => {
    const e = buildReminderEmail({ displayName: 'A', month: '2026-12', link, expiresAt: tokenExpiry('2026-12') })
    expect(e.subject).toBe('Submit your salary for December 2026')
    expect(e.text).toContain('expires after 31 January 2027')
  })
})

describe('month/day labels', () => {
  it('monthLabelEn', () => {
    expect(monthLabelEn('2027-01')).toBe('January 2027')
    expect(monthLabelEn('bad')).toBe('bad')
  })

  it('lastValidDayEn uses Stockholm time in both seasons', () => {
    expect(lastValidDayEn(tokenExpiry('2026-06'))).toBe('31 July 2026')
    expect(lastValidDayEn(tokenExpiry('2026-01'))).toBe('28 February 2026')
  })
})

describe('isLocalDryRunLinkLoggingAllowed', () => {
  const local = 'http://127.0.0.1:54321'
  it.each([
    [{ EMAIL_DRY_RUN: '1', SUPABASE_URL: local }, true],
    [{ EMAIL_DRY_RUN: '1', SUPABASE_URL: 'http://kong:8000' }, true],
    [{ EMAIL_DRY_RUN: '1', SUPABASE_URL: 'https://abcdefgh.supabase.co' }, false],
    [{ EMAIL_DRY_RUN: '1', SUPABASE_URL: 'https://ABCDEFGH.SUPABASE.CO' }, false],
    [{ EMAIL_DRY_RUN: '1', SUPABASE_URL: 'https://abcdefgh.supabase.co.' }, false],
    [{ EMAIL_DRY_RUN: '1', SUPABASE_URL: 'https://supabase.co' }, false],
    [{ EMAIL_DRY_RUN: '1', SUPABASE_URL: undefined }, false],
    [{ EMAIL_DRY_RUN: '1', SUPABASE_URL: '' }, false],
    [{ EMAIL_DRY_RUN: '1', SUPABASE_URL: 'not a url' }, false],
    [{ EMAIL_DRY_RUN: undefined, SUPABASE_URL: local }, false],
    [{ EMAIL_DRY_RUN: '0', SUPABASE_URL: local }, false],
    [{ EMAIL_DRY_RUN: 'true', SUPABASE_URL: local }, false],
  ])('%j → %s', (env, expected) => {
    expect(isLocalDryRunLinkLoggingAllowed(env)).toBe(expected)
  })
})
