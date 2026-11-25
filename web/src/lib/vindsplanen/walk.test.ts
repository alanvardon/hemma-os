import { describe, expect, it } from 'vitest'
import { FF, oldStairs } from './below'
import {
  addInputs,
  eyeHeight,
  fpGround,
  fpHeadroom,
  fpPlace,
  fpTry,
  keysInput,
  mustStoop,
  STEP,
  stickInput,
  WALK_SPEED,
  walkCamera,
  walkExitCamera,
  walkLook,
  walkStep,
  walkWorld,
  type Surface,
  type WalkPose,
  type WalkState,
} from './walk'
import { expectClose, FIXTURE_NAMES, goldPlan, lcg, walkRoute } from './testkit'

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

describe('walkStep — the per-frame walker (v41 fpUpdate)', () => {
  const { plan, geo } = goldPlan('owner-like')
  const world = walkWorld(geo, plan)
  const start = (where: 'below' | 'attic'): WalkState => {
    const s = fpPlace(geo, plan, world, where)!
    return { x: s.x, z: s.z, feet: s.feet, where: s.where, yaw: s.yaw, pitch: s.pitch, eyeY: s.eyeY }
  }
  const still = { f: 0, sd: 0, turn: 0 }

  it('walks 1.3 m/s along the view, 2.6 m/s with Shift, turning 1.9 rad/s before the move', () => {
    const s = start('below') // the hallway, looking east (yaw 0)
    const dt = 0.1
    const walk = walkStep(geo, plan, world, s, { f: 1, sd: 0, turn: 0 }, dt).state
    expect(walk.x - s.x).toBeCloseTo(0.13, 12)
    expect(walk.z).toBeCloseTo(s.z, 12)
    expect(walk.feet).toBe(s.feet)
    const run = walkStep(geo, plan, world, s, { f: 1, sd: 0, turn: 0, run: true }, dt).state
    expect(run.x - s.x).toBeCloseTo(0.26, 12)
    // back, and sideways: D steps to the right of the view (+z when looking +x)
    expect(walkStep(geo, plan, world, s, { f: -1, sd: 0, turn: 0 }, dt).state.x - s.x).toBeCloseTo(-0.13, 12)
    expect(walkStep(geo, plan, world, s, { f: 0, sd: 1, turn: 0 }, dt).state.z - s.z).toBeCloseTo(0.13, 12)
    const turned = walkStep(geo, plan, world, s, { f: 1, sd: 0, turn: 1 }, dt).state
    expect(turned.yaw).toBeCloseTo(0.19, 12)
    expect(turned.x - s.x).toBeCloseTo(Math.cos(0.19) * 0.13, 12)
    expect(turned.z - s.z).toBeCloseTo(Math.sin(0.19) * 0.13, 12)
    expect(turned.pitch).toBe(s.pitch)
  })

  it('no input: stays put, reports the headroom there and eases the eyes (10/s) towards feet + eye height', () => {
    const s = { ...start('attic'), eyeY: 1.18 }
    const r = walkStep(geo, plan, world, s, still, 0.05)
    expect(r.state).toMatchObject({ x: s.x, z: s.z, feet: s.feet, yaw: s.yaw })
    expect(r.head).toBe(fpHeadroom(geo, plan, world, s.x, s.z, s.feet))
    expect(r.state.eyeY).toBeCloseTo(1.18 + (eyeHeight(r.head) - 1.18) * 0.5, 12)
    expect(walkStep(geo, plan, world, s, still, 0.2).state.eyeY).toBeCloseTo(eyeHeight(r.head), 12)
  })

  it('a refused move slides along x, else along z, else stays (v41 order)', () => {
    // against the east gable, walking diagonally: x is refused, the z slide is taken
    const s: WalkState = { x: geo.L - 0.2, z: 0, feet: 0, where: 'attic', yaw: Math.PI / 4, pitch: 0, eyeY: 1.68 }
    const d = 0.13 * Math.SQRT1_2
    expect(fpTry(geo, plan, world, s, s.x + d, s.z + d)).toBeNull()
    expect(fpTry(geo, plan, world, s, s.x + d, s.z)).toBeNull()
    const r = walkStep(geo, plan, world, s, { f: 1, sd: 0, turn: 0 }, 0.1).state
    expect(r.x).toBe(s.x)
    expect(r.z).toBeCloseTo(d, 12)
    // straight into the gable: nothing to slide along
    const head = { ...s, yaw: 0 }
    expect(walkStep(geo, plan, world, head, { f: 1, sd: 0, turn: 0 }, 0.1).state).toMatchObject({ x: head.x, z: head.z })
  })

  it('drag-to-look turns 0.005 rad per pixel and clamps the pitch at ±1.2', () => {
    const s = start('attic')
    expect(walkLook(s, 100, 0).yaw).toBeCloseTo(s.yaw + 0.5, 12)
    expect(walkLook(s, 0, 100).pitch).toBeCloseTo(s.pitch - 0.5, 12)
    expect(walkLook(s, 0, -10000).pitch).toBe(1.2)
    expect(walkLook(s, 0, 10000).pitch).toBe(-1.2)
    const c = walkCamera({ ...s, yaw: 0, pitch: 0 })
    expect(c.p).toEqual([s.x, s.eyeY, s.z])
    expect(c.t).toEqual([s.x + 1, s.eyeY, s.z])
    expect(walkExitCamera({ ...s, yaw: 0 }).t).toEqual([s.x + 1.5, s.eyeY - 0.3, s.z])
  })

  it('keys and the stick map to input like v41 (W/↑, S/↓, A/D sideways, ←/→ turn, Shift)', () => {
    expect(keysInput(new Set(['w', 'd', 'shift']))).toEqual({ f: 1, sd: 1, turn: 0, run: true })
    expect(keysInput(new Set(['arrowdown', 'arrowleft']))).toEqual({ f: -1, sd: 0, turn: -1, run: false })
    expect(keysInput(new Set(['w', 's']))).toMatchObject({ f: 0 })
    expect(stickInput(0, -60, 60)).toEqual({ f: 1, sd: 0, turn: 0 })
    expect(stickInput(30, 0, 60)).toEqual({ f: 0, sd: 0, turn: 0.5 })
    expect(stickInput(0, 200, 60).f).toBe(-1) // beyond the rim: full speed
    expect(stickInput(5, 0, 60)).toEqual({ f: 0, sd: 0, turn: 0 }) // dead zone
    expect(addInputs({ f: 1, sd: 0, turn: 1 }, { f: 1, sd: 0, turn: -0.5, run: true })).toEqual({ f: 1, sd: 0, turn: 0.5, run: true })
  })

  it('walks the owner-like plan from the attic down both stairs to the ground floor, and back up', () => {
    let s = start('attic')
    const seen: string[] = []
    const heads: number[] = []
    for (const [tx, tz] of walkRoute(world)) {
      for (let i = 0; i < 400; i++) {
        const d = Math.hypot(tx - s.x, tz - s.z)
        if (d < 0.03) break
        s = { ...s, yaw: Math.atan2(tz - s.z, tx - s.x) }
        const prev = s
        const r = walkStep(geo, plan, world, s, { f: 1, sd: 0, turn: 0 }, Math.min(0.05, d) / WALK_SPEED)
        s = r.state
        expect(Math.abs(s.feet - prev.feet)).toBeLessThanOrEqual(STEP + 1e-9)
        expect(r.head).toBe(fpHeadroom(geo, plan, world, s.x, s.z, s.feet))
        heads.push(r.head)
        if (seen[seen.length - 1] !== s.where) seen.push(s.where)
      }
      expect(Math.hypot(tx - s.x, tz - s.z), `reached ${tx},${tz}`).toBeLessThan(0.03)
    }
    expect(seen).toEqual(['attic', 'new', 'below', 'old', 'ground', 'old', 'below', 'new', 'attic'])
    // the old stairs run under the new ones: on the way down you have to stoop
    expect(heads.some(mustStoop)).toBe(true)
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
