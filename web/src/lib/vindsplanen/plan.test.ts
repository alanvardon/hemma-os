import { describe, expect, it } from 'vitest'
import { ATTIC_DEF, deriveGeometry } from './attic'
import { defaultViewPrefs, examplePlan, isMonthDay, num, PRICES_NONE, sanitizePlan, sanitizePrices, sanitizeShape, sanitizeSite, sanitizeViewPrefs, SITE_DEF, type BedItem, type PlanV2 } from './plan'
import { importV1 } from './legacy'
import { expectClose, FIXTURE_NAMES, loadGold, loadJson, v1ToV2 } from './testkit'

interface SanitizeGold {
  cases: unknown[]
  out: (Record<string, unknown> | null)[]
}

/** Replace ids the sanitizer made up (v41: time-based; here: deterministic) with '<new>'. */
function normaliseIds(input: unknown, plan: PlanV2 | null) {
  if (!plan) return null
  const items = input && typeof input === 'object' && Array.isArray((input as { items?: unknown }).items) ? ((input as { items: unknown[] }).items) : []
  const ids = new Set(items.map((i) => (i && typeof i === 'object' ? (i as { id?: unknown }).id : undefined)).filter((x) => typeof x === 'string'))
  return { ...plan, items: plan.items.map((i) => (ids.has(i.id) ? i : { ...i, id: '<new>' })) }
}

describe('sanitizeShape — parity with v41 sanitize (below.v 11, no migrations)', () => {
  const gold = loadJson<SanitizeGold>('sanitize')

  it.each(gold.cases.map((c, i) => [i, c] as const))('case %i', (i, input) => {
    const ours = normaliseIds(input, sanitizeShape(input))
    const expected = gold.out[i]
    if (expected === null) expect(ours).toBeNull()
    else expectClose(ours, v1ToV2(expected))
  })

  it.each(FIXTURE_NAMES)('%s: the fixture plan itself', (name) => {
    const g = loadGold(name)
    expectClose(sanitizeShape(g.input), v1ToV2(g.input))
  })
})

describe('sanitizePlan (stored PlanV2 documents)', () => {
  it('rejects anything that is not a v: 2 object with items', () => {
    expect(sanitizePlan(null)).toBeNull()
    expect(sanitizePlan('{}')).toBeNull()
    expect(sanitizePlan({ items: [] })).toBeNull()
    expect(sanitizePlan({ v: 1, items: [] })).toBeNull()
    expect(sanitizePlan({ v: 2 })).toBeNull()
    expect(sanitizePlan({ v: 2, items: {} })).toBeNull()
  })

  it('is idempotent on its own output', () => {
    const once = sanitizePlan(examplePlan()) as PlanV2
    expect(sanitizePlan(once)).toEqual(once)
    expect(sanitizePlan(JSON.parse(JSON.stringify(once)))).toEqual(once)
  })

  it('clamps out-of-range numbers and defaults the rest, exactly as v41 num()', () => {
    const p = sanitizePlan({ v: 2, items: [{ id: 'b', type: 'bed', x: 99, z: -99, rot: 'x' }] }) as PlanV2
    const bed = p.items[0] as BedItem
    expect(bed).toMatchObject({ id: 'b', type: 'bed', x: 8.5, rot: 0, size: '160×200' })
    expect(bed.z).toBe(-deriveGeometry(ATTIC_DEF).HALF)
    expect(num(5, 0, 1, 0.5)).toBe(1)
    expect(num('5', 0, 1, 0.5)).toBe(0.5)
    expect(num(Number.POSITIVE_INFINITY, 0, 1, 0.5)).toBe(0.5)
  })

  it('drops unknown item types, including inherited names v41 let through', () => {
    const p = sanitizePlan({ v: 2, items: [{ type: 'constructor' }, { type: 'toString' }, { type: 'unicorn' }, { id: 'r', type: 'rug' }] }) as PlanV2
    expect(p.items.map((i) => i.id)).toEqual(['r'])
  })

  it('gives items without a string id a deterministic unique id', () => {
    const p = sanitizePlan({ v: 2, items: [{ type: 'rug' }, { id: 'i1', type: 'rug' }, { type: 'rug', id: 7 }] }) as PlanV2
    expect(p.items.map((i) => i.id)).toEqual(['i2', 'i1', 'i3'])
    const q = sanitizePlan({ v: 2, items: [{ type: 'rug' }] }, { newId: () => 'mine' }) as PlanV2
    expect(q.items[0].id).toBe('mine')
  })

  it('keeps v41 lexicographic bay sorting', () => {
    const p = sanitizePlan({ v: 2, items: [], options: { attic: { ...ATTIC_DEF, len: 15, rn: 12, cc: 1.2 }, knee: { N: [10, 2, 2], S: [] } } }) as PlanV2
    expect(p.options.knee.N).toEqual([10, 2])
  })

  it('a missing options block gets the example defaults with door handles on the right', () => {
    const p = sanitizePlan({ v: 2, items: [] }) as PlanV2
    expect(p.options).toEqual({ ...examplePlan().options })
    expect(p.options.below.doors.every((d) => d.flip === false)).toBe(true)
  })
})

describe('view prefs', () => {
  it('default to v41 example options; quality is fast on touch', () => {
    expect(defaultViewPrefs()).toEqual({
      zones: true, rafters: true, cutaway: true, sun: 'morning', quality: 'nice', dims: false,
      sunMode: 'preset', sunDate: '06-21', sunMinutes: 720,
    })
    expect(defaultViewPrefs(true).quality).toBe('fast')
  })

  it('take booleans, known suns and qualities only; dims only when exactly true', () => {
    expect(sanitizeViewPrefs({ zones: false, rafters: 'no', cutaway: false, sun: 'evening', quality: 'fast', dims: 1 })).toEqual({
      zones: false, rafters: true, cutaway: false, sun: 'evening', quality: 'fast', dims: false,
      sunMode: 'preset', sunDate: '06-21', sunMinutes: 720,
    })
    expect(sanitizeViewPrefs({ sun: 'dusk', quality: 'ultra', dims: true })).toMatchObject({ sun: 'morning', quality: 'nice', dims: true })
    expect(sanitizeViewPrefs('x')).toEqual(defaultViewPrefs())
  })

  it("keep the evening-with-lamps mood ('night', plan 141)", () => {
    expect(sanitizeViewPrefs({ sun: 'night' }).sun).toBe('night')
    expect(sanitizeViewPrefs({ sun: 'night', quality: 'fast' }, true)).toMatchObject({ sun: 'night', quality: 'fast' })
  })
})

describe('site (plan 144)', () => {
  it('a plan without a site gets the default ridge bearing 90 and 59.3 N 18.0 E', () => {
    expect(SITE_DEF).toEqual({ ridgeBearing: 90, lat: 59.3, lon: 18.0 })
    expect((sanitizePlan({ v: 2, items: [] }) as PlanV2).options.site).toEqual(SITE_DEF)
    expect((sanitizePlan({ v: 2, items: [], options: { gable: { w: 1 } } }) as PlanV2).options.site).toEqual(SITE_DEF)
    expect(examplePlan().options.site).toEqual(SITE_DEF)
  })

  it('clamps out-of-range numbers like num() (370 → 359, not wrapped) and defaults non-numbers', () => {
    expect(sanitizeSite({ ridgeBearing: 370, lat: 80, lon: 3 })).toEqual({ ridgeBearing: 359, lat: 69, lon: 10 })
    expect(sanitizeSite({ ridgeBearing: -10, lat: 40, lon: 40 })).toEqual({ ridgeBearing: 0, lat: 55, lon: 25 })
    expect(sanitizeSite({ ridgeBearing: '45', lat: '60', lon: null })).toEqual(SITE_DEF)
    expect(sanitizeSite({ ridgeBearing: Number.NaN, lat: Number.POSITIVE_INFINITY })).toEqual(SITE_DEF)
    expect(sanitizeSite('north')).toEqual(SITE_DEF)
  })

  it('keeps lat/lon to one decimal (no precise location persists) and the bearing as given', () => {
    expect(sanitizeSite({ ridgeBearing: 123.4, lat: 59.33412, lon: 18.0686 })).toEqual({ ridgeBearing: 123.4, lat: 59.3, lon: 18.1 })
  })

  it('round-trips through sanitizePlan and JSON, and is idempotent', () => {
    const p = examplePlan()
    p.options.site = { ridgeBearing: 135, lat: 63.8, lon: 20.3 }
    const once = sanitizePlan(JSON.parse(JSON.stringify(p))) as PlanV2
    expect(once.options.site).toEqual({ ridgeBearing: 135, lat: 63.8, lon: 20.3 })
    expect(sanitizePlan(once)).toEqual(once)
  })

  it('a v1 (v41) import has no site and gets the default', () => {
    const r = importV1({ ...examplePlanAsV1(), v: 1 })
    expect(r.ok && r.plan.options.site).toEqual(SITE_DEF)
  })
})

describe('prices (plan 150)', () => {
  it('a plan without prices loads with every price not entered (null)', () => {
    expect(PRICES_NONE).toEqual({ floor: null, panel: null, walls: null, insulation: null })
    expect((sanitizePlan({ v: 2, items: [] }) as PlanV2).prices).toEqual(PRICES_NONE)
    expect(examplePlan().prices).toEqual(PRICES_NONE)
    expect(sanitizePrices(undefined)).toEqual(PRICES_NONE)
    expect(sanitizePrices(null)).toEqual(PRICES_NONE)
    expect(sanitizePrices('450')).toEqual(PRICES_NONE)
    expect(sanitizePrices([450])).toEqual(PRICES_NONE)
  })

  it('keeps finite prices ≥ 0 exactly, including 0 and decimals', () => {
    const p = sanitizePlan({ v: 2, items: [], prices: { floor: 450.5, panel: 0, walls: 1234567.89, insulation: 0.01 } }) as PlanV2
    expect(p.prices).toEqual({ floor: 450.5, panel: 0, walls: 1234567.89, insulation: 0.01 })
    expect(Object.is(sanitizePrices({ floor: -0 }).floor, 0)).toBe(true)
  })

  it('invalid prices become null — not clamped, not coerced', () => {
    expect(sanitizePrices({ floor: -1, panel: Number.NaN, walls: '450', insulation: Number.POSITIVE_INFINITY })).toEqual(PRICES_NONE)
    expect(sanitizePrices({ floor: true, panel: Number.NEGATIVE_INFINITY, walls: null, insulation: {} })).toEqual(PRICES_NONE)
    expect(sanitizePrices({ floor: -0.01, panel: '', walls: false, insulation: [1] })).toEqual(PRICES_NONE)
  })

  it('one bad field does not touch the others; unknown fields are dropped', () => {
    expect(sanitizePrices({ floor: 450, panel: -5, extra: 9 })).toEqual({ floor: 450, panel: null, walls: null, insulation: null })
  })

  it('round-trips through sanitizePlan and JSON, and is idempotent', () => {
    const p = examplePlan()
    p.prices = { floor: 450.5, panel: 0, walls: null, insulation: 199 }
    const once = sanitizePlan(JSON.parse(JSON.stringify(p))) as PlanV2
    expect(once.prices).toEqual({ floor: 450.5, panel: 0, walls: null, insulation: 199 })
    expect(sanitizePlan(JSON.parse(JSON.stringify(once)))).toEqual(once)
  })

  it('an older plan without prices keeps the rest of its data', () => {
    const p = examplePlan()
    delete p.prices
    const once = sanitizePlan(JSON.parse(JSON.stringify(p))) as PlanV2
    expect(once.items).toEqual(examplePlan().items)
    expect(once.prices).toEqual(PRICES_NONE)
  })

  it('a v1 (v41) import has no prices and gets all null', () => {
    const r = importV1({ ...examplePlanAsV1(), v: 1 })
    expect(r.ok && r.plan.prices).toEqual(PRICES_NONE)
  })
})

/** A minimal v41-style export: post-migration below.v 11, no site. */
function examplePlanAsV1() {
  const ex = examplePlan()
  const options: Record<string, unknown> = { ...ex.options, below: { ...ex.options.below, v: 11 } }
  delete options.site
  return { materials: ex.materials, options, items: ex.items }
}

describe('view prefs — real sun (plan 144)', () => {
  it('take a known sunMode, a valid MM-DD and an integer minute 0–1439', () => {
    expect(sanitizeViewPrefs({ sunMode: 'real', sunDate: '12-21', sunMinutes: 0 })).toMatchObject({ sunMode: 'real', sunDate: '12-21', sunMinutes: 0 })
    expect(sanitizeViewPrefs({ sunMinutes: 1439 }).sunMinutes).toBe(1439)
  })

  it('invalid values take the default (not clamped)', () => {
    expect(sanitizeViewPrefs({ sunMode: 'sunny', sunDate: '02-30', sunMinutes: 1440 })).toMatchObject({ sunMode: 'preset', sunDate: '06-21', sunMinutes: 720 })
    expect(sanitizeViewPrefs({ sunDate: 'xx', sunMinutes: -1 })).toMatchObject({ sunDate: '06-21', sunMinutes: 720 })
    expect(sanitizeViewPrefs({ sunDate: 1221, sunMinutes: '600' })).toMatchObject({ sunDate: '06-21', sunMinutes: 720 })
    expect(sanitizeViewPrefs({ sunMinutes: 600.5 }).sunMinutes).toBe(720)
  })

  it('MM-DD accepts only days that exist in every year', () => {
    expect(['01-01', '02-28', '04-30', '12-31'].every(isMonthDay)).toBe(true)
    expect(['02-29', '02-30', '04-31', '13-01', '00-10', '1-01', '06-21x', ''].some(isMonthDay)).toBe(false)
  })

  it('the caller can supply the default date (today, at load); an invalid one falls back to 06-21', () => {
    expect(defaultViewPrefs(false, '11-26').sunDate).toBe('11-26')
    expect(sanitizeViewPrefs({}, false, '11-26').sunDate).toBe('11-26')
    expect(sanitizeViewPrefs({ sunDate: '03-01' }, false, '11-26').sunDate).toBe('03-01')
    expect(defaultViewPrefs(false, '02-29').sunDate).toBe('06-21')
  })
})
