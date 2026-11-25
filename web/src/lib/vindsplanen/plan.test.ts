import { describe, expect, it } from 'vitest'
import { ATTIC_DEF, deriveGeometry } from './attic'
import { defaultViewPrefs, examplePlan, num, sanitizePlan, sanitizeShape, sanitizeViewPrefs, type BedItem, type PlanV2 } from './plan'
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
    expect(defaultViewPrefs()).toEqual({ zones: true, rafters: true, cutaway: true, sun: 'morning', quality: 'nice', dims: false })
    expect(defaultViewPrefs(true).quality).toBe('fast')
  })

  it('take booleans, known suns and qualities only; dims only when exactly true', () => {
    expect(sanitizeViewPrefs({ zones: false, rafters: 'no', cutaway: false, sun: 'evening', quality: 'fast', dims: 1 })).toEqual({
      zones: false, rafters: true, cutaway: false, sun: 'evening', quality: 'fast', dims: false,
    })
    expect(sanitizeViewPrefs({ sun: 'night', quality: 'ultra', dims: true })).toMatchObject({ sun: 'morning', quality: 'nice', dims: true })
    expect(sanitizeViewPrefs('x')).toEqual(defaultViewPrefs())
  })
})
