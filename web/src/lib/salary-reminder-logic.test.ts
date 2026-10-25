// Tests plan 132's shared salary-reminder logic by importing the Deno edge
// function module directly by relative path (it has no imports, so it loads
// under Vitest too — same pattern as resend-request.test.ts).
import { describe, expect, it } from 'vitest'
import {
  base64UrlEncode,
  buildReminderEmail,
  isLocalDryRunLinkLoggingAllowed,
  isTokenFormat,
  localDryRunLinkLine,
  personDisplayName,
  submitStatusFor,
  toHex,
  isSendDay,
  lastValidDayEn,
  monthFor,
  monthLabelEn,
  splitPrefill,
  stockholmToday,
  tokenExpiry,
  validateHalf,
  adminKey,
  isTrustedServerCaller,
  safeEqual,
  salaryEmailDecision,
  buildPartnerSubmittedEmail,
  buildMonthResultsEmail,
  formatKronor,
  stockholmDateEn,
  type SalaryEmailRow,
  type SalaryResultsFigures,
} from '../../../supabase/functions/_shared/salary-reminder-logic.ts'
import { fmt } from './format'

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

describe('localDryRunLinkLine (the only path a raw link may be logged)', () => {
  const link = 'http://localhost:5174/#/lon/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

  it('logs locally when dry-run is on and the URL is not supabase.co', () => {
    expect(localDryRunLinkLine({ EMAIL_DRY_RUN: '1', SUPABASE_URL: 'http://kong:8000' }, 'a', link))
      .toBe(`[local dry-run] a link: ${link}`)
  })

  it('never logs against a hosted project, even in dry-run', () => {
    expect(localDryRunLinkLine({ EMAIL_DRY_RUN: '1', SUPABASE_URL: 'https://abcd.supabase.co' }, 'b', link)).toBeNull()
    expect(localDryRunLinkLine({ EMAIL_DRY_RUN: '1', SUPABASE_URL: 'https://ABCD.SUPABASE.CO.' }, 'b', link)).toBeNull()
  })

  it('never logs when dry-run is off or the URL is missing', () => {
    expect(localDryRunLinkLine({ SUPABASE_URL: 'http://kong:8000' }, 'a', link)).toBeNull()
    expect(localDryRunLinkLine({ EMAIL_DRY_RUN: 'true', SUPABASE_URL: 'http://kong:8000' }, 'a', link)).toBeNull()
    expect(localDryRunLinkLine({ EMAIL_DRY_RUN: '1' }, 'a', link)).toBeNull()
  })
})

describe('token encoding', () => {
  it('32 bytes → 43-char unpadded base64url that passes the format check', () => {
    const bytes = new Uint8Array(32).map((_, i) => (i * 37 + 250) % 256)
    const token = base64UrlEncode(bytes)
    expect(token).toHaveLength(43)
    expect(token).not.toMatch(/[+/=]/)
    expect(isTokenFormat(token)).toBe(true)
  })

  it('maps the url-unsafe base64 characters', () => {
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe('-_-_')
  })

  it('rejects anything that is not exactly 43 base64url chars', () => {
    expect(isTokenFormat('A'.repeat(42))).toBe(false)
    expect(isTokenFormat('A'.repeat(44))).toBe(false)
    expect(isTokenFormat('A'.repeat(42) + '=')).toBe(false)
    expect(isTokenFormat('A'.repeat(42) + '+')).toBe(false)
    expect(isTokenFormat(undefined)).toBe(false)
    expect(isTokenFormat(123)).toBe(false)
  })

  it('hex matches Postgres encode(…, \'hex\')', () => {
    expect(toHex(new Uint8Array([0, 15, 16, 255]))).toBe('000f10ff')
  })
})

describe('personDisplayName (mirrors private.household_person_display_name)', () => {
  it('profile name → assigned email → Person A/B', () => {
    expect(personDisplayName('Alva', 'alva@example.test', 'a')).toBe('Alva')
    expect(personDisplayName(null, 'alva@example.test', 'a')).toBe('alva@example.test')
    expect(personDisplayName(undefined, null, 'b')).toBe('Person B')
  })
})

describe('submitStatusFor', () => {
  it('maps pending → submitted and passes the rest through', () => {
    expect(submitStatusFor('pending')).toBe('submitted')
    expect(submitStatusFor('finalized')).toBe('finalized')
    expect(submitStatusFor('already_logged')).toBe('already_logged')
    expect(submitStatusFor('zero_total')).toBe('zero_total')
  })

  it('returns null on anything unexpected', () => {
    expect(submitStatusFor('weird')).toBeNull()
    expect(submitStatusFor(null)).toBeNull()
  })
})

describe('safeEqual', () => {
  it('matches only identical strings', () => {
    expect(safeEqual('sb_secret_abc', 'sb_secret_abc')).toBe(true)
    expect(safeEqual('sb_secret_abc', 'sb_secret_abd')).toBe(false)
    expect(safeEqual('sb_secret_abc', 'sb_secret_ab')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
  })
})

// Server-to-server auth for salary-reminder-send (verify_jwt = false, so this
// check is the only gate). Fictional keys.
describe('isTrustedServerCaller', () => {
  const SECRET = 'sb_secret_default_FICTIONAL'
  const OTHER_SECRET = 'sb_secret_automations_FICTIONAL'
  const LEGACY = 'eyJlegacy.service_role.FICTIONAL'
  const ANON = 'eyJlegacy.anon.FICTIONAL'
  const env = {
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET, automations: OTHER_SECRET }),
    SUPABASE_SERVICE_ROLE_KEY: LEGACY,
  }
  const call = (h: { apikey?: string; authorization?: string }, e: Parameters<typeof isTrustedServerCaller>[1] = env) =>
    isTrustedServerCaller({ apikey: h.apikey ?? null, authorization: h.authorization ?? null }, e)

  it('accepts any project secret key in the apikey header', () => {
    expect(call({ apikey: SECRET })).toBe(true)
    expect(call({ apikey: OTHER_SECRET })).toBe(true)
  })
  it('accepts a secret key or the legacy service-role key as a Bearer token', () => {
    expect(call({ authorization: `Bearer ${SECRET}` })).toBe(true)
    expect(call({ authorization: `bearer ${LEGACY}` })).toBe(true)
  })
  it('rejects missing, empty, anon/publishable and wrong keys', () => {
    expect(call({})).toBe(false)
    expect(call({ apikey: '' })).toBe(false)
    expect(call({ authorization: 'Bearer ' })).toBe(false)
    expect(call({ authorization: `Bearer ${ANON}` })).toBe(false)
    expect(call({ apikey: 'sb_publishable_FICTIONAL' })).toBe(false)
    expect(call({ apikey: `${SECRET}x` })).toBe(false)
    expect(call({ authorization: SECRET })).toBe(false) // no Bearer scheme
  })
  it('one wrong header does not hide a right one', () => {
    expect(call({ apikey: ANON, authorization: `Bearer ${SECRET}` })).toBe(true)
  })
  it('fails closed when the env is missing or malformed', () => {
    expect(call({ apikey: SECRET }, {})).toBe(false)
    expect(call({ apikey: SECRET }, { SUPABASE_SECRET_KEYS: 'not json' })).toBe(false)
    expect(call({ apikey: '' }, { SUPABASE_SECRET_KEYS: JSON.stringify({ default: '' }), SUPABASE_SERVICE_ROLE_KEY: '' })).toBe(false)
    expect(call({ apikey: '42' }, { SUPABASE_SECRET_KEYS: JSON.stringify({ default: 42 }) })).toBe(false)
    // Legacy still works when the JSON is broken.
    expect(call({ authorization: `Bearer ${LEGACY}` }, { SUPABASE_SECRET_KEYS: '{', SUPABASE_SERVICE_ROLE_KEY: LEGACY })).toBe(true)
  })
})

describe('adminKey', () => {
  it('prefers the default secret key, then any secret key, then the legacy service-role key', () => {
    expect(adminKey({ SUPABASE_SECRET_KEYS: JSON.stringify({ other: 'sb_secret_o', default: 'sb_secret_d' }), SUPABASE_SERVICE_ROLE_KEY: 'eyJ' })).toBe('sb_secret_d')
    expect(adminKey({ SUPABASE_SECRET_KEYS: JSON.stringify({ other: 'sb_secret_o' }), SUPABASE_SERVICE_ROLE_KEY: 'eyJ' })).toBe('sb_secret_o')
    expect(adminKey({ SUPABASE_SECRET_KEYS: 'nope', SUPABASE_SERVICE_ROLE_KEY: 'eyJ' })).toBe('eyJ')
    expect(adminKey({})).toBeNull()
  })
})

// ── Plan 139 Stage 5: salary emails (D7 partner, D8 results) ─────────────────
// Fictional household: Anna (slot a, user u-a) and Bo (slot b, user u-b).

const MEMBERS = [
  { user_id: 'u-a', email: 'anna@example.test' },
  { user_id: 'u-b', email: 'bo@example.test' },
]
const PEOPLE = [
  { slot: 'a', assigned_email: 'anna@example.test' },
  { slot: 'b', assigned_email: 'bo@example.test' },
]
const partnerRow = (over: Partial<SalaryEmailRow> = {}): SalaryEmailRow => ({
  kind: 'partner_submitted', trigger: 'auto', submitter_slot: 'a', submission_id: null, actor_user_id: 'u-a', ...over,
})
const resultsRow = (over: Partial<SalaryEmailRow> = {}): SalaryEmailRow => ({
  kind: 'month_results', trigger: 'auto', submitter_slot: null, submission_id: 'sub-1', actor_user_id: null, ...over,
})

// Base golden row (plan 139): A = 38 450 + 1 250 = 39 700, B = 31 200;
// gap 8 500 → transfer 8 500 / 2 = 4 250 a→b; equal_share 70 900 / 2 = 35 450.
const BASE: SalaryResultsFigures = {
  person_a_name: 'Anna', person_b_name: 'Bo',
  income_a: 39700, income_b: 31200, transfer_from: 'a', transfer_to: 'b', transfer_amount: 4250, equal_share: 35450,
}
// Equal: 30 000 / 30 000 → transfer 0, equal_share 30 000.
const EQUAL: SalaryResultsFigures = { ...BASE, income_a: 30000, income_b: 30000, transfer_amount: 0, equal_share: 30000 }
// Half-krona: 30 001 / 30 000 → gap 1 → transfer 0.5 a→b; equal_share 60 001 / 2 = 30 000.5.
const HALF: SalaryResultsFigures = { ...BASE, income_a: 30001, income_b: 30000, transfer_amount: 0.5, equal_share: 30000.5 }

const decide = (over: Partial<Parameters<typeof salaryEmailDecision>[0]> & { row: SalaryEmailRow }) =>
  salaryEmailDecision({ settings: null, members: MEMBERS, people: PEOPLE, submission: null, draftSlots: ['a'], ...over })

describe('salaryEmailDecision — partner_submitted (D7)', () => {
  it('sends to the other slot only while the month is waiting', () => {
    expect(decide({ row: partnerRow() })).toEqual({
      action: 'send', recipients: [{ slot: 'b', email: 'bo@example.test', userId: 'u-b' }],
    })
    // Email-link path: actor null, submitter b → Anna.
    expect(decide({ row: partnerRow({ submitter_slot: 'b', actor_user_id: null }), draftSlots: ['b'] })).toEqual({
      action: 'send', recipients: [{ slot: 'a', email: 'anna@example.test', userId: 'u-a' }],
    })
  })

  it('skips when the month has since completed (the results email covers it)', () => {
    expect(decide({ row: partnerRow(), submission: BASE })).toEqual({ action: 'skip', reason: 'month_complete' })
  })

  it('skips when notify_partner is off; a missing field/row means on', () => {
    expect(decide({ row: partnerRow(), settings: { notify_partner: false, email_results: true } }))
      .toEqual({ action: 'skip', reason: 'opted_out' })
    expect(decide({ row: partnerRow(), settings: {} }).action).toBe('send')
    expect(decide({ row: partnerRow(), settings: null }).action).toBe('send')
    // email_results off does not stop the partner email.
    expect(decide({ row: partnerRow(), settings: { email_results: false } }).action).toBe('send')
  })

  it('drops a pending-invite recipient (assigned but not a current member)', () => {
    expect(decide({ row: partnerRow(), members: [MEMBERS[0]] })).toEqual({ action: 'skip', reason: 'no_recipient' })
  })

  it('never emails the person who acted (D3: A submits unassigned B\'s half)', () => {
    const people = [PEOPLE[0], { slot: 'b', assigned_email: null }]
    expect(decide({ row: partnerRow({ submitter_slot: 'b', actor_user_id: 'u-a' }), people, draftSlots: ['b'] }))
      .toEqual({ action: 'skip', reason: 'no_recipient' })
  })

  it('skips an unassigned recipient slot and a recipient who has meanwhile submitted', () => {
    expect(decide({ row: partnerRow(), people: [PEOPLE[0]] })).toEqual({ action: 'skip', reason: 'no_recipient' })
    expect(decide({ row: partnerRow(), draftSlots: ['a', 'b'] }))
      .toEqual({ action: 'skip', reason: 'partner_already_submitted' })
  })

  it('matches emails case-insensitively and skips a malformed row', () => {
    const people = [PEOPLE[0], { slot: 'b', assigned_email: ' Bo@Example.TEST ' }]
    expect(decide({ row: partnerRow(), people }).action).toBe('send')
    expect(decide({ row: partnerRow({ submitter_slot: null }) })).toEqual({ action: 'skip', reason: 'malformed' })
  })
})

describe('salaryEmailDecision — month_results (D8)', () => {
  it('sends one email to both current members', () => {
    expect(decide({ row: resultsRow(), submission: BASE })).toEqual({
      action: 'send', recipients: [
        { slot: 'a', email: 'anna@example.test', userId: 'u-a' },
        { slot: 'b', email: 'bo@example.test', userId: 'u-b' },
      ],
    })
  })

  it('skips a deleted submission', () => {
    expect(decide({ row: resultsRow(), submission: null })).toEqual({ action: 'skip', reason: 'submission_deleted' })
    expect(decide({ row: resultsRow({ trigger: 'manual' }), submission: null }))
      .toEqual({ action: 'skip', reason: 'submission_deleted' })
  })

  it('opt-out stops only the automatic email; a manual resend always sends', () => {
    const off = { notify_partner: true, email_results: false }
    expect(decide({ row: resultsRow(), submission: BASE, settings: off })).toEqual({ action: 'skip', reason: 'opted_out' })
    expect(decide({ row: resultsRow({ trigger: 'manual' }), submission: BASE, settings: off }).action).toBe('send')
    // notify_partner off does not stop results.
    expect(decide({ row: resultsRow(), submission: BASE, settings: { notify_partner: false } }).action).toBe('send')
  })

  it('drops a pending-invite slot, and skips when nobody is left', () => {
    expect(decide({ row: resultsRow(), submission: BASE, members: [MEMBERS[1]] })).toEqual({
      action: 'send', recipients: [{ slot: 'b', email: 'bo@example.test', userId: 'u-b' }],
    })
    expect(decide({ row: resultsRow(), submission: BASE, members: [] })).toEqual({ action: 'skip', reason: 'no_recipient' })
  })

  it('skips a row with a missing figure instead of guessing it', () => {
    expect(decide({ row: resultsRow(), submission: { ...BASE, transfer_amount: null } }))
      .toEqual({ action: 'skip', reason: 'submission_malformed' })
    expect(decide({ row: resultsRow(), submission: { ...BASE, income_a: '39700' } }))
      .toEqual({ action: 'skip', reason: 'submission_malformed' })
    expect(decide({ row: resultsRow(), submission: { ...BASE, transfer_from: 'x' } }))
      .toEqual({ action: 'skip', reason: 'submission_malformed' })
    expect(decide({ row: resultsRow({ submission_id: null }), submission: BASE })).toEqual({ action: 'skip', reason: 'malformed' })
  })
})

describe('formatKronor', () => {
  it('is the app fmt expression exactly (NBSP grouping, whole kronor)', () => {
    for (const n of [0, 0.5, 0.49, 4250, 35450, 30000.5, 1234567.89, -1500]) expect(formatKronor(n)).toBe(fmt(n))
    expect(formatKronor(4250).replace(/ /g, ' ')).toBe('4 250 kr')
  })
})

const LINK = 'http://localhost:5174/#/loner'
const AMOUNT_RE = /\d[\d  ]*\s?kr\b|\bkr\b/
// Strip the year so any remaining digit in the partner email is an amount leak.
const digitsOtherThanYear = (s: string) => s.replace(/2026/g, '').replace(/5174/g, '').match(/\d/)

describe('buildPartnerSubmittedEmail', () => {
  it('renders the plan copy, "their", the button and the Löner link', () => {
    const e = buildPartnerSubmittedEmail({ recipientName: 'Bo', submitterName: 'Anna', month: '2026-10', link: LINK })
    expect(e.subject).toBe('Anna has submitted their salary for October 2026')
    expect(e.text).toContain('Hi Bo,')
    expect(e.text).toContain(
      'Anna has logged their salary for October 2026 in Hemma OS. Yours is still missing — add it in Löner, or use the link from your monthly reminder.')
    expect(e.html).toContain(`href="${LINK}"`)
    expect(e.html).toContain('>Open Löner</a>')
    expect(`${e.subject} ${e.text} ${e.html}`).not.toMatch(/\b(he|she|his|her|him)\b/i)
  })

  it('never contains an amount, for any input', () => {
    const inputs = [
      { recipientName: 'Bo', submitterName: 'Anna', month: '2026-10' },
      { recipientName: 'bo@example.test', submitterName: 'Person A', month: '2026-01' },
      { recipientName: 'Ö', submitterName: '', month: 'bad' },
    ]
    for (const i of inputs) {
      // Extra fields (as a careless caller might pass) must not leak either.
      const e = buildPartnerSubmittedEmail({ ...i, link: LINK, ...({ amount: 4250, income_a: 39700 } as object) } as never)
      for (const s of [e.subject, e.text, e.html]) {
        expect(s).not.toMatch(AMOUNT_RE)
        expect(digitsOtherThanYear(s.replace(/style="[^"]*"/g, ''))).toBeNull()
      }
    }
  })

  it('escapes names in the HTML', () => {
    const e = buildPartnerSubmittedEmail({ recipientName: '<b>', submitterName: 'A&"B\'', month: '2026-10', link: 'http://x/"><script>' })
    expect(e.html).not.toContain('<b>')
    expect(e.html).not.toContain('<script>')
    expect(e.html).toContain('A&amp;&quot;B&#39;')
    expect(e.html).toContain('&lt;b&gt;')
  })
})

const nbsp = (s: string) => s.replace(/ /g, ' ')

describe('buildMonthResultsEmail', () => {
  const build = (submission: SalaryResultsFigures, previousSentAt: Date | null = null) =>
    buildMonthResultsEmail({ month: '2026-10', nameA: 'Anna', nameB: 'Bo', submission, previousSentAt, link: LINK })

  it('Base golden: totals, "Anna pays Bo 4 250 kr", each takes home 35 450 kr', () => {
    const e = build(BASE)
    expect(e.subject).toBe('Salary results for October 2026')
    for (const s of [e.text, e.html]) {
      expect(nbsp(s)).toContain('Anna pays Bo 4 250 kr')
      expect(nbsp(s)).toContain('35 450 kr')
      expect(nbsp(s)).toContain('39 700 kr')
      expect(nbsp(s)).toContain('31 200 kr')
      expect(s).toContain('Each takes home')
      // Exactly the app formatter's string (with its NBSP).
      expect(s).toContain(fmt(4250))
      expect(s).not.toContain('replace the ones')
    }
    expect(nbsp(e.text)).toContain('Anna: 39 700 kr\nBo: 31 200 kr\nEach takes home: 35 450 kr\nAnna pays Bo 4 250 kr')
    expect(e.html).toContain(`href="${LINK}"`)
    expect(e.html).toContain('>Open Löner</a>')
  })

  it('B > A: Bo pays Anna', () => {
    // B overtakes: 39 700 / 45 000 → gap −5 300 → 2 650 b→a; equal 84 700 / 2 = 42 350.
    const e = build({ ...BASE, income_b: 45000, transfer_from: 'b', transfer_to: 'a', transfer_amount: 2650, equal_share: 42350 })
    expect(nbsp(e.text)).toContain('Bo pays Anna 2 650 kr')
    expect(nbsp(e.text)).toContain('Each takes home: 42 350 kr')
  })

  it('Equal golden: "Nothing to transfer"', () => {
    const e = build(EQUAL)
    expect(e.text).toContain('Nothing to transfer')
    expect(e.html).toContain('Nothing to transfer')
    expect(e.text).not.toContain('pays')
  })

  it('Half-krona golden: shows the transfer through fmt\'s own rounding', () => {
    const e = build(HALF)
    expect(e.text).toContain(`Anna pays Bo ${fmt(0.5)}`)
    expect(e.text).toContain(`Each takes home: ${fmt(30000.5)}`)
    expect(e.text).toContain(`Anna: ${fmt(30001)}`)
  })

  it('"Updated:" subject and the replace line when a previous email was sent', () => {
    const sent = new Date('2026-11-03T08:00:00Z')
    const e = build(BASE, sent)
    expect(e.subject).toBe('Updated: salary results for October 2026')
    expect(e.text).toContain(`These figures replace the ones we sent on ${stockholmDateEn(sent)}.`)
    expect(stockholmDateEn(sent)).toBe('3 November 2026')
    // Stockholm date, not UTC: 23:30 UTC on 2 Nov is 3 Nov in Stockholm.
    expect(stockholmDateEn(new Date('2026-11-02T23:30:00Z'))).toBe('3 November 2026')
  })

  it('never contains itemised lines or notes', () => {
    const withExtras = {
      ...BASE, note: 'Bonus i mars HEMLIG',
      income_items: [{ owner: 'a', label: 'Barnbidrag', amount: 1250 }, { owner: 'a', label: 'Lön', amount: 38450 }],
    } as SalaryResultsFigures
    const e = build(withExtras, new Date('2026-11-03T08:00:00Z'))
    for (const s of [e.subject, e.text, e.html]) {
      expect(s).not.toContain('Barnbidrag')
      expect(s).not.toMatch(/Lön(?!er)/) // "Open Löner" is the only Lön* text
      expect(s).not.toContain('HEMLIG')
      expect(s).not.toContain('Bonus')
      expect(nbsp(s)).not.toContain('1 250')
      expect(nbsp(s)).not.toContain('38 450')
    }
  })

  it('escapes names and throws on missing figures', () => {
    const e = buildMonthResultsEmail({ month: '2026-10', nameA: '<i>A', nameB: 'B&B', submission: BASE, previousSentAt: null, link: LINK })
    expect(e.html).toContain('&lt;i&gt;A pays B&amp;B')
    expect(e.html).not.toContain('<i>')
    expect(() => build({ ...BASE, equal_share: null })).toThrow()
  })
})
