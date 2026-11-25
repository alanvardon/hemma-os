import { describe, expect, it } from 'vitest'
import { FF, oldStairs } from './below'
import { eyeHeight, fpGround, fpHeadroom, fpPlace, fpTry, mustStoop, walkWorld, type Surface, type WalkPose } from './walk'
import { expectClose, FIXTURE_NAMES, goldPlan, lcg } from './testkit'

const WH = ['attic', 'below', 'old', 'new', 'ground']

describe('fpGround / fpHeadroom — parity with v41 on a 25 cm grid at four foot levels', () => {
  it.each(FIXTURE_NAMES)('%s', (name) => {
    const { gold, plan, geo } = goldPlan(name)
    const world = walkWorld(geo, plan)
    const F = FF(plan.options.below)
    const feetLevels = [0, -F / 2, -F, -F - oldStairs(geo, plan.options.below).P.F]
    expectClose(feetLevels, gold.walk.feetLevels)
    const grid: [number, number, number][] = []
    for (const feet of feetLevels)
      for (let x = 0; x <= geo.L + 1e-9; x += 0.25)
        for (let z = -geo.HALF; z <= geo.HALF + 1e-9; z += 0.25) {
          const g = fpGround(world, x, z, feet)
          grid.push(g ? [WH.indexOf(g.where), g.y, fpHeadroom(geo, plan, world, x, z, g.y)] : [-1, 0, fpHeadroom(geo, plan, world, x, z, feet)])
        }
    expectClose(grid, gold.walk.grid)
  })
})

describe('fpPlace / fpTry — 400 scripted moves from each start, parity with v41', () => {
  it.each(FIXTURE_NAMES)('%s', (name) => {
    const { gold, plan, geo } = goldPlan(name)
    const world = walkWorld(geo, plan)
    // v41 walked the two starts in one session: the attic walk began where the hallway walk left FP
    let pose: WalkPose = { x: 0, z: 0, feet: 0, where: '' }
    for (const where of ['below', 'attic'] as const) {
      const start = fpPlace(geo, plan, world, where)
      if (start) pose = start
      const g = gold.walk.walks[where]
      expectClose({ x: pose.x, z: pose.z, feet: pose.feet, where: pose.where }, { x: g.start.x, z: g.start.z, feet: g.start.feet, where: g.start.where }, 1e-3, where)
      const rnd = lcg(where === 'below' ? 7 : 11)
      let yaw = start ? start.yaw : (g.start.yaw as number)
      const steps: [number, number, number, number, string, number][] = []
      for (let i = 0; i < 400; i++) {
        yaw += (rnd() - 0.5) * 0.6
        const next = fpTry(geo, plan, world, pose, pose.x + Math.cos(yaw) * 0.08, pose.z + Math.sin(yaw) * 0.08)
        if (next) pose = next
        else yaw += Math.PI / 2 + rnd() * Math.PI
        steps.push([next ? 1 : 0, pose.x, pose.z, pose.feet, pose.where, fpHeadroom(geo, plan, world, pose.x, pose.z, pose.feet)])
      }
      expectClose(steps, g.steps, 1e-3, where)
    }
  })
})

describe('guided routes — up the new stairs and down the old ones to the ground floor', () => {
  const centre = (s: Surface): [number, number] =>
    s.poly ? s.poly.reduce<[number, number]>((a, q) => [a[0] + q[0] / s.poly.length, a[1] + q[1] / s.poly.length], [0, 0]) : [(s.rect[0] + s.rect[1]) / 2, (s.rect[2] + s.rect[3]) / 2]

  it.each(FIXTURE_NAMES)('%s: same poses and headroom at every step as v41', (name) => {
    const { gold, plan, geo } = goldPlan(name)
    const world = walkWorld(geo, plan)
    const route = (start: WalkPose, targets: [number, number][]) => {
      let pose = start
      const steps: [number, number, number, number, string, number][] = []
      for (const [tx, tz] of targets)
        for (let i = 0; i < 80; i++) {
          const dx = tx - pose.x
          const dz = tz - pose.z
          const d = Math.hypot(dx, dz)
          if (d < 0.03) break
          const s = Math.min(0.05, d)
          const next = fpTry(geo, plan, world, pose, pose.x + (dx / d) * s, pose.z + (dz / d) * s)
          if (next) pose = next
          steps.push([next ? 1 : 0, pose.x, pose.z, pose.feet, pose.where, fpHeadroom(geo, plan, world, pose.x, pose.z, pose.feet)])
          if (!next) break
        }
      return steps
    }
    const nu = world.surf.filter((s) => s.where === 'new')
    const old = world.surf.filter((s) => s.where === 'old')
    const gnd = world.surf.find((s) => s.where === 'ground')
    const routes: Record<string, unknown> = {}
    if (nu.length) {
      const c = centre(nu[0])
      routes.upNew = route({ x: c[0], z: c[1], feet: nu[0].y, where: 'new' }, nu.slice(1).map(centre))
    }
    if (old.length && gnd?.rect) {
      const top = old[old.length - 1]
      const c = centre(top)
      routes.downOld = route({ x: c[0], z: c[1], feet: top.y, where: 'old' }, [...old.slice(0, -1).reverse().map(centre), [gnd.rect[0] + 0.3, centre(gnd)[1]]])
    }
    expectClose(routes, gold.walk.routes)
  })

  it('the owner-like routes climb every tread and reach the ground floor', () => {
    const { gold } = goldPlan('owner-like')
    const { upNew = [], downOld = [] } = gold.walk.routes
    expect(upNew.every((s) => s[0] === 1)).toBe(true)
    expect(new Set(downOld.map((s) => s[4]))).toEqual(new Set(['old', 'ground']))
  })
})

describe('walk helpers', () => {
  it('eyes at 168 cm, crouching 12 cm under anything lower, never below 60 cm', () => {
    expect(eyeHeight(3)).toBe(1.68)
    expect(eyeHeight(1.5)).toBeCloseTo(1.38, 12)
    expect(eyeHeight(0.2)).toBe(0.6)
    expect(mustStoop(1.84)).toBe(true)
    expect(mustStoop(1.85)).toBe(false)
  })
})
