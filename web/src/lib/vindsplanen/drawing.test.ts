import { describe, expect, it } from 'vitest'
import { ATTIC_DEF, atticOf, deriveGeometry, roofY } from './attic'
import { closetGeom, storageGeom } from './items'
import { examplePlan, sanitizeShape, type PlanV2 } from './plan'
import { isUpStair, stairHoles } from './stairs'
import { curvedInfo, stairInfo, wallInfo } from './warnings'
import { dimText, northArrow, planDrawing, planTags, sectionDrawing, skyFootprint, stairOpenings, type Prim } from './drawing'
import { FIXTURE_NAMES, goldPlan, loadJson } from './testkit'

const NBSP = ' '
const geoOf = (plan: PlanV2) => deriveGeometry(atticOf(plan.options.attic))
const tagged = (prims: Prim[], tag: string) => prims.filter((p) => p.tag === tag)
const dims = (prims: Prim[], tag: string) => tagged(prims, tag).filter((p): p is Extract<Prim, { k: 'dim' }> => p.k === 'dim')
const lines = (prims: Prim[], tag: string) => tagged(prims, tag).filter((p): p is Extract<Prim, { k: 'line' }> => p.k === 'line')

/** Every number anywhere in a drawing. */
function numbers(v: unknown): number[] {
  if (typeof v === 'number') return [v]
  if (Array.isArray(v)) return v.flatMap(numbers)
  if (v && typeof v === 'object') return Object.values(v).flatMap(numbers)
  return []
}
const expectFinite = (v: unknown, what: string) => {
  const bad = numbers(v).filter((n) => !Number.isFinite(n))
  expect(bad, what).toEqual([])
}

describe('dimText — centimetres, sv-SE, up to one decimal', () => {
  it('formats like warningText (comma decimal, NBSP grouping)', () => {
    expect(dimText(1.22)).toBe('122')
    expect(dimText(0.9418)).toBe('94,2') // 94.18 cm → one decimal
    expect(dimText(12.345)).toBe(`1${NBSP}234,5`)
    expect(dimText(3.6399999999999997)).toBe('364') // float noise from RAFT_X
    expect(dimText(-0.8)).toBe('80') // a length, never negative
  })
})

describe('planDrawing — the example plan (default attic)', () => {
  // Default attic: L 8.5, knee 2.87 (KZ 1.435), kneeH 0.9418, ridge 2.6.
  // HALF = 2.6 · 1.435 / (2.6 − 0.9418) = 3.731 / 1.6582 = 2.25003 m.
  // RAFT_X = 1.20 + i · 1.22 = 1.20, 2.42, 3.64, 4.86, 6.08, 7.30.
  const plan = examplePlan()
  const geo = geoOf(plan)
  const d = planDrawing(geo, plan)

  it('the rafter chain runs from the west gable through every RAFT_X to the east gable', () => {
    const ch = dims(d.prims, 'rafters')
    // gable → 1.20 (120), five c/c steps of 1.22 (122), 7.30 → 8.50 (120)
    expect(ch.map((p) => p.text)).toEqual(['120', '122', '122', '122', '122', '122', '120'])
    expect(ch.map((p) => p.b[0]).slice(0, -1)).toEqual(geo.RAFT_X)
    expect(ch[0].a[0]).toBe(0)
    expect(ch[ch.length - 1].b[0]).toBe(geo.L)
    // running sums of the chain text, in cm, are RAFT_X in cm
    const sums = ch.slice(0, -1).map((_, i) => ch.slice(0, i + 1).reduce((s, p) => s + Number(p.text), 0))
    expect(sums).toEqual(geo.RAFT_X.map((x) => Math.round(x * 100)))
    // one thin centre line per rafter, eaves to eaves
    expect(lines(d.prims, 'rafters').map((l) => [l.a, l.b])).toEqual(geo.RAFT_X.map((x) => [[x, -geo.HALF], [x, geo.HALF]]))
    // the chain sits north of the eaves line, off the plan
    expect(ch.every((p) => p.a[1] === -geo.HALF && p.offset < 0)).toBe(true)
  })

  it('the curved stair opening is exactly the stairHoles output', () => {
    // c1: x 6.08, z −1.55, turn R after 4 steps, w 0.8, 12 risers, F = 2.30 + 0.28.
    // Opening (local) from step 2 (t 0.43 > F − slab − 2.0 = 0.30) at x 0.24, to
    // x0 + w = 0.96 + 0.80; mirrored for the right turn and clipped at −KZ + 0.02.
    const hole = stairHoles(geo, plan, geo.KZ).holes[0]
    const poly = tagged(d.prims, 'curved:c1').find((p) => p.k === 'poly')
    expect(poly).toEqual({ k: 'poly', pts: hole, style: 'opening', tag: 'curved:c1' })
    const r = (v: number) => Math.round(v * 1e6) / 1e6
    expect(hole.map(([x, z]) => [r(x), r(z)])).toEqual([[7.84, -1.415], [7.84, -0.19], [7.04, -0.19], [7.04, -1.15], [6.32, -1.15], [6.32, -1.415]])
    // size 152 × 122,5; west edge 632 from the gable; ridge-side edge 19 from the ridge
    expect(dims(d.prims, 'curved:c1').map((p) => p.text)).toEqual(['152', '122,5', '632', '19'])
  })

  it('stairOpenings keys every un-clashed hole by id, in stairHoles order', () => {
    for (const name of FIXTURE_NAMES) {
      const g = goldPlan(name)
      const all = stairHoles(g.geo, g.plan, g.geo.KZ)
      expect([...stairOpenings(g.geo, g.plan).values()], name).toEqual(all.holes)
    }
  })

  it('roof window footprint follows the slope (s1: south, bay 2, 78×118, sill 100)', () => {
    // bay 1 centre (1.20 + 2.42) / 2 = 1.81 → x 1.42..2.20.
    // Bottom edge at height 1.0: z = HALF − 1.0 / SLOPE = HALF · (1 − 1 / 2.6) = 1.384634.
    // Top edge 1.18 m further up the slope: z = 1.384634 − 1.18 · COS, COS = HALF / SLEN
    // = 2.25003 / 3.438407 = 0.654382 → 0.612463.
    const s1 = plan.items.find((i) => i.id === 's1')
    if (s1?.type !== 'skylight') throw new Error('fixture')
    const f = skyFootprint(geo, s1)
    expect(f.x0).toBeCloseTo(1.42, 9)
    expect(f.x1).toBeCloseTo(2.2, 9)
    expect(f.z1).toBeCloseTo(1.384634, 6)
    expect(f.z0).toBeCloseTo(0.612463, 6)
    const rect = tagged(d.prims, 'skylight:s1').find((p) => p.k === 'rect')
    expect(rect).toMatchObject({ w: f.x1 - f.x0, h: f.z1 - f.z0, rot: 0, style: 'window', at: [(f.x0 + f.x1) / 2, (f.z0 + f.z1) / 2] })
    const label = tagged(d.prims, 'skylight:s1').find((p) => p.k === 'label')
    // on the plan only the tag; west to east, south before north: s1 (x 1.42) W1, s2 (north, bay 3) W2, s3 W3
    expect(label).toEqual({ k: 'label', at: [(f.x0 + f.x1) / 2, (f.z0 + f.z1) / 2], text: 'W1', tag: 'skylight:s1' })
    expect(planTags(geo, plan).get('s2')).toBe('W2')
    expect(planTags(geo, plan).get('s3')).toBe('W3')
    expect(dims(d.prims, 'skylight:s1').map((p) => p.text)).toEqual(['142'])
  })

  it('the partition wall leaves the door gap wallInfo works out', () => {
    // w1: x 4.8, door centred (doorZ 0) → gap z −0.40..0.40; door height
    // min(2.0, roofY(0.40) − 0.10) = min(2.0, 1.850 · 1.15554 − 0.10 = 2.038) = 2.00.
    const w1 = plan.items[0]
    if (w1.type !== 'wall') throw new Error('fixture')
    const { zc, dh } = wallInfo(geo, w1)
    expect([zc, dh]).toEqual([0, 2])
    expect(lines(d.prims, 'wall:w1').map((l) => [l.a, l.b])).toEqual([
      [[4.8, -geo.KZ], [4.8, -0.4]],
      [[4.8, 0.4], [4.8, geo.KZ]],
    ])
    expect(dims(d.prims, 'wall:w1').map((p) => p.text)).toEqual(['80', '480'])
    expect(tagged(d.prims, 'wall:w1').find((p) => p.k === 'label' && p.text === 'D1')).toBeTruthy()
  })

  it('overall L × W, knee to knee, ridge and standing-height lines', () => {
    // 850 long; eaves to eaves 2 · 2.25003 = 450,0 → "450"; knee to knee 287
    expect(dims(d.prims, 'overall').map((p) => p.text)).toEqual(['850', '450', '287'])
    expect(lines(d.prims, 'shell').filter((l) => l.style === 'axis').map((l) => [l.a, l.b])).toEqual([[[0, 0], [8.5, 0]]])
    // no insulated bays: every standing-height segment is at ±Z190 (0.605777)
    const st = lines(d.prims, 'stand')
    expect(st).toHaveLength(2 * geo.BAYS.length)
    st.forEach((l) => {
      expect(Math.abs(l.a[1])).toBeCloseTo(geo.Z190, 12)
      expect(l.style).toBe('hidden')
    })
  })

  it('furniture is a light outline only: no label, no dimension, drawn first (behind)', () => {
    expect(tagged(d.prims, 'bed:b1')).toEqual([{ k: 'rect', at: [1.05, 0], w: 1.6, h: 2, rot: 90, style: 'furniture', tag: 'bed:b1' }])
    for (const id of ['n1', 'n2', 'd1', 'r1', 'k1']) {
      const it = plan.items.find((i) => i.id === id)
      const mine = tagged(d.prims, `${it?.type}:${id}`)
      expect(mine, id).toHaveLength(1)
      expect(mine[0], id).toMatchObject({ k: 'rect', style: 'furniture' })
    }
    const firstOther = d.prims.findIndex((p) => !(p.k === 'rect' && p.style === 'furniture'))
    expect(d.prims.slice(firstOther).some((p) => p.k === 'rect' && p.style === 'furniture')).toBe(false)
  })

  it('the schedule writes out every tagged item with the numbers the old labels used', () => {
    expect(d.schedule.map((r) => [r.tag, r.kind, r.text])).toEqual([
      ['W1', 'window', 'Roof window 78×118 cm · south slope, bay 2 · sill 100 cm'],
      ['W2', 'window', 'Roof window 78×118 cm · north slope, bay 3 · sill 100 cm'],
      ['W3', 'window', 'Roof window 78×118 cm · south slope, bay 6 · sill 100 cm'],
      ['D1', 'door', 'Door 80 × 200 cm in partition wall at 480 cm from west gable'],
      ['S1', 'stairs', 'Turning stairs · 12 steps · rise 21,5 · going 24 · opening 152 × 122,5'],
    ])
    expect(d.schedule.map((r) => r.id)).toEqual(['s1', 's2', 's3', 'w1', 'c1'])
  })

  it('tags are numbered west to east; storage rooms and closets in item order', () => {
    const { plan, geo } = goldPlan('owner-like')
    const t = planTags(geo, plan)
    const d = planDrawing(geo, plan)
    expect(d.schedule.filter((r) => r.kind === 'storage').map((r) => r.tag)).toEqual(plan.items.filter((i) => i.type === 'storage').map((_, n) => `ST${n + 1}`))
    expect(d.schedule.filter((r) => r.kind === 'closet').map((r) => r.tag)).toEqual(plan.items.filter((i) => i.type === 'closet').map((_, n) => `C${n + 1}`))
    const wallX = (k: string) => plan.items.filter((i) => i.type === 'wall' && i.door && t.get(i.id)?.startsWith(k)).map((i) => (i.type === 'wall' ? i.x : 0))
    expect(wallX('D')).toEqual([...wallX('D')].sort((a, b) => a - b))
    // every label on the plan is a short tag from the schedule, or one of the fixed notes
    const tagsSet = new Set(d.schedule.map((r) => r.tag))
    for (const p of d.prims) if (p.k === 'label' && p.tag.includes(':') && p.text !== 'Partition wall') expect(tagsSet.has(p.text), p.text).toBe(true)
  })

  it('bounds enclose every point, dimension lines included', () => {
    const [lo, hi] = d.bounds
    // the rafter chain hangs 0.30 north of the eaves; the overall length 0.30 south
    expect(lo[1]).toBeCloseTo(-geo.HALF - 0.75, 9) // the rafter label sits highest of all
    expect(hi[1]).toBeCloseTo(geo.HALF + 0.6, 9) // the partition wall's position hangs below the overall length
    expect(lo[0]).toBeCloseTo(-1.3, 9) // the standing-height label, west of the knee-to-knee dim
    expect(hi[0]).toBeCloseTo(geo.L + 0.75, 9) // the ridge label, east of the gable
  })
})

describe('planDrawing — shell options', () => {
  it('empty items → shell, rafters, standing height and overall dims only', () => {
    const plan = { ...examplePlan(), items: [] }
    const geo = geoOf(plan)
    const d = planDrawing(geo, plan)
    expect(new Set(d.prims.map((p) => p.tag))).toEqual(new Set(['shell', 'rafters', 'stand', 'overall']))
    // 2 gables + 2 eaves + knee wall per bay on both sides (7 bays) + ridge
    expect(lines(d.prims, 'shell')).toHaveLength(2 + 2 + 2 * 7 + 1)
    expect(d.prims.some((p) => p.k === 'rect' || p.k === 'poly')).toBe(false)
  })

  it('no knee wall in an opened bay; a lower standing-height line under an insulated bay', () => {
    const base = examplePlan()
    const plan: PlanV2 = { ...base, items: [], options: { ...base.options, knee: { N: [2], S: [] }, board: [1] } }
    const geo = geoOf(plan)
    const d = planDrawing(geo, plan)
    const north = lines(d.prims, 'shell').filter((l) => l.a[1] === -geo.KZ && l.b[1] === -geo.KZ)
    expect(north.map((l) => l.a[0])).toEqual([geo.EDGES[0], geo.EDGES[1], geo.EDGES[3], geo.EDGES[4], geo.EDGES[5], geo.EDGES[6]])
    const st = lines(d.prims, 'stand').filter((l) => l.a[0] === geo.EDGES[1])
    // ceiling BOARD_DY lower: 1.90 m is reached where the roof is 1.90 + BOARD_DY high
    st.forEach((l) => {
      expect(Math.abs(l.a[1])).toBeLessThan(geo.Z190)
      expect(roofY(geo, l.a[1]) - geo.BOARD_DY).toBeCloseTo(1.9, 9)
    })
  })

  it('storage room and closet footprints come from storageGeom / closetGeom', () => {
    const { plan, geo } = goldPlan('owner-like')
    const d = planDrawing(geo, plan)
    const st = plan.items.find((i) => i.type === 'storage')
    const cl = plan.items.find((i) => i.type === 'closet')
    if (st?.type !== 'storage' || cl?.type !== 'closet') throw new Error('fixture')
    const S = storageGeom(geo, plan, st)
    const sp = tagged(d.prims, `storage:${st.id}`).find((p) => p.k === 'poly')
    const xs = sp && sp.k === 'poly' ? sp.pts.map((q) => q[0]) : []
    expect(Math.min(...xs)).toBe(S.x0)
    expect(Math.max(...xs)).toBe(S.ext ? S.ext.x2 : S.x1)
    const C = closetGeom(geo, plan, cl)
    const cp = tagged(d.prims, `closet:${cl.id}`).find((p) => p.k === 'poly')
    expect(cp).toMatchObject({ pts: [[C.x0, C.zd], [C.x1, C.zd], [C.x1, C.zb], [C.x0, C.zb]], style: 'storage' })
    // the long side wall at xi, door end to the back
    expect(lines(d.prims, `closet:${cl.id}`)[0]).toMatchObject({ a: [C.xi, C.zd], b: [C.xi, C.zb], style: 'wall' })
  })
})

describe('north arrow (plan 144 site)', () => {
  it('ridge bearing 90 (the default): +x is east, so north is −z, up the sheet', () => {
    const n = northArrow(examplePlan())
    expect(n?.bearing).toBe(90)
    expect(n?.dir[0]).toBeCloseTo(0, 12)
    expect(n?.dir[1]).toBeCloseTo(-1, 12)
  })

  it('bearing 0: +x points north; bearing 180: north is −x; bearing 45 halfway', () => {
    const at = (b: number) => northArrow({ options: { ...examplePlan().options, site: { ridgeBearing: b, lat: 59.3, lon: 18 } } })?.dir
    expect(at(0)).toEqual([1, 0])
    const s = at(180) as [number, number]
    expect(s[0]).toBeCloseTo(-1, 12)
    expect(s[1]).toBeCloseTo(0, 12)
    const h = at(45) as [number, number]
    expect(h[0]).toBeCloseTo(Math.SQRT1_2, 12)
    expect(h[1]).toBeCloseTo(-Math.SQRT1_2, 12)
  })

  it('absent without a site; returned beside the prims, never as one', () => {
    const plan = examplePlan()
    const noSite = { ...plan, options: { ...plan.options, site: undefined } } as unknown as PlanV2
    expect(northArrow(noSite)).toBeNull()
    expect(planDrawing(geoOf(noSite), noSite).north).toBeNull()
    expect(planDrawing(geoOf(plan), plan).north).not.toBeNull()
  })
})

describe('sectionDrawing — through one stair', () => {
  it('the example curved stair: treads, rise/going and the tightest headroom', () => {
    const plan = examplePlan()
    const geo = geoOf(plan)
    const s = sectionDrawing(geo, plan, 'c1')
    if (!s) throw new Error('no section')
    const c1 = plan.items.find((i) => i.id === 'c1')
    if (!c1 || !isUpStair(c1)) throw new Error('fixture')
    const c = curvedInfo(geo, plan, c1, new Set())
    // 12 risers over F = 2.58 → rise 0.215, going 0.24; 11 treads, the 11th at t = 2.365
    expect(c.P.n).toBe(12)
    const tr = lines(s.prims, 'curved:c1')
    expect(tr).toHaveLength(c.P.treads.length)
    expect(tr.map((l) => -l.a[1])).toEqual(c.P.treads.map((t) => t.t - c.P.F))
    // tightest headroom 1.9655 m → 197 cm, as the item info line prints it
    expect(dims(s.prims, 'curved:c1').map((p) => p.text)).toEqual(['197'])
    const hd = dims(s.prims, 'curved:c1')[0]
    expect(Math.abs(hd.b[1] - hd.a[1])).toBeCloseTo(c.head, 9)
    expect(tagged(s.prims, 'curved:c1').filter((p) => p.k === 'label').map((p) => (p.k === 'label' ? [p.text, p.sub] : []))).toEqual([
      ['Tightest headroom 197 cm', undefined],
      ['Turning stairs', '12 steps · rise 21,5 cm · going 24 cm'],
    ])
    // ridge 260; floor to floor 2.30 + 0.28 = 258
    expect(dims(s.prims, 'overall').map((p) => p.text)).toEqual(['260', '258'])
    // the attic floor is open over the opening's z range (−1.415..−0.19)
    const floor = lines(s.prims, 'shell').filter((l) => l.a[1] === 0 && l.b[1] === 0 && l.style === 'wall')
    expect(floor.map((l) => [l.a[0], l.b[0]])).toEqual([[-geo.HALF, -1.415], [-0.19000000000000017, geo.HALF]])
  })

  it('straight stairs: headroom equals stairInfo.minHead', () => {
    const { plan, geo } = goldPlan('straight')
    for (const it of plan.items) {
      if (it.type !== 'stairs') continue
      const s = sectionDrawing(geo, plan, it.id)
      if (!s) throw new Error(it.id)
      const info = stairInfo(geo, it)
      const hd = dims(s.prims, `stairs:${it.id}`)[0]
      expect(Math.abs(hd.b[1] - hd.a[1]), it.id).toBeCloseTo(info.minHead, 9)
      expect(lines(s.prims, `stairs:${it.id}`)).toHaveLength(info.n)
    }
  })

  it('null for an unknown id or an item that is not a stair', () => {
    const plan = examplePlan()
    const geo = geoOf(plan)
    expect(sectionDrawing(geo, plan, 'nope')).toBeNull()
    expect(sectionDrawing(geo, plan, 'w1')).toBeNull()
    expect(sectionDrawing(geo, plan, 's1')).toBeNull()
    expect(sectionDrawing(geo, plan, 'b1')).toBeNull()
  })
})

describe('every fixture draws without NaN or Infinity', () => {
  const check = (plan: PlanV2, name: string) => {
    const geo = deriveGeometry(atticOf(plan.options.attic))
    const d = planDrawing(geo, plan)
    expectFinite(d, name)
    for (const it of plan.items) {
      const s = sectionDrawing(geo, plan, it.id)
      if (it.type === 'stairs' || isUpStair(it)) {
        expect(s, `${name}/${it.id}`).not.toBeNull()
        expectFinite(s, `${name}/${it.id}`)
      } else expect(s).toBeNull()
    }
  }

  it.each(FIXTURE_NAMES)('%s', (name) => check(goldPlan(name).plan, name))

  it('sanitize.json: every case that sanitizes to a plan', () => {
    const cases = loadJson<{ cases: unknown[] }>('sanitize').cases
    let drawn = 0
    cases.forEach((c, i) => {
      const plan = sanitizeShape(c)
      if (!plan) return
      check(plan, `sanitize[${i}]`)
      drawn++
    })
    expect(drawn).toBeGreaterThan(0)
  })

  it('the default attic itself', () => check(examplePlan(ATTIC_DEF), 'example(ATTIC_DEF)'))
})
