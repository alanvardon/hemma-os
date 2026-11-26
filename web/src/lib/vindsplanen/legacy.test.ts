import { describe, expect, it } from 'vitest'
import { importV1, importV1Text } from './legacy'
import { examplePlan } from './plan'
import { expectClose, FIXTURE_NAMES, loadGold, v1ToV2 } from './testkit'

describe('importV1 — a v41 "Copy plan" export', () => {
  it.each(FIXTURE_NAMES)('%s: maps to the same plan v41 holds, minus example and below.v', (name) => {
    const g = loadGold(name)
    const r = importV1(JSON.parse(JSON.stringify(g.input)))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expectClose(r.plan, v1ToV2(g.input))
    expect(r.plan.v).toBe(2)
    expect('example' in r.plan).toBe(false)
    expect('v' in r.plan.options.below).toBe(false)
  })

  it('splits the viewing choices out as view prefs', () => {
    const g = loadGold('owner-like')
    const r = importV1(g.input)
    if (!r.ok) throw new Error(r.reason)
    expect(r.view).toEqual({
      zones: true, rafters: true, cutaway: true, sun: 'evening', quality: 'nice', dims: false,
      sunMode: 'preset', sunDate: '06-21', sunMinutes: 720, // v41 had no real sun (plan 144)
    })
    for (const k of ['zones', 'rafters', 'cutaway', 'sun', 'quality', 'dims']) expect(k in r.plan.options).toBe(false)
  })

  it('round-trips through JSON text', () => {
    const g = loadGold('spiral')
    const r = importV1Text(JSON.stringify(g.input))
    expect(r.ok).toBe(true)
  })
})

describe('importV1 — refusals', () => {
  const ok = () => JSON.parse(JSON.stringify(loadGold('example').input)) as { options: { below: Record<string, unknown> }; items: unknown }

  it('not an object', () => {
    expect(importV1(null)).toEqual({ ok: false, reason: 'not-object' })
    expect(importV1(42)).toEqual({ ok: false, reason: 'not-object' })
    expect(importV1([])).toEqual({ ok: false, reason: 'not-object' })
    expect(importV1Text('not json')).toEqual({ ok: false, reason: 'not-object' })
    expect(importV1Text('"a string"')).toEqual({ ok: false, reason: 'not-object' })
  })

  it('too old: below.v under 11, missing, or no floor-below block at all', () => {
    const p = ok()
    p.options.below.v = 10
    expect(importV1(p)).toEqual({ ok: false, reason: 'too-old' })
    delete p.options.below.v
    expect(importV1(p)).toEqual({ ok: false, reason: 'too-old' })
    expect(importV1({ items: [] })).toEqual({ ok: false, reason: 'too-old' })
    expect(importV1({ v: 1, options: { below: { v: '11' } }, items: [] })).toEqual({ ok: false, reason: 'too-old' })
  })

  it('invalid: a newer below.v than v41 writes, or no items array', () => {
    const p = ok()
    p.options.below.v = 12
    expect(importV1(p)).toEqual({ ok: false, reason: 'invalid' })
    const q = ok()
    q.items = 'x'
    expect(importV1(q)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('a PlanV2 document is not a v41 export', () => {
    expect(importV1(examplePlan())).toEqual({ ok: false, reason: 'too-old' })
  })

  it('keeps malformed items out but still imports the rest', () => {
    const p = ok()
    p.items = [null, { type: 'unicorn' }, { id: 'r', type: 'rug', x: 'x' }]
    const r = importV1(p)
    if (!r.ok) throw new Error(r.reason)
    expect(r.plan.items).toEqual([{ id: 'r', type: 'rug', x: 4.25, z: 0, rot: 0, w: 2, d: 1.4, h: 0.01 }])
  })
})
