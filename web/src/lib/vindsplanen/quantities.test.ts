import { describe, expect, it } from 'vitest'
import { ATTIC_DEF, atticOf, deriveGeometry } from './attic'
import { examplePlan, PRICES_NONE, type PlanV2, type Prices } from './plan'
import { costLines, costTotal, polygonArea, quantities, quantityParts, roofArea, ZERO_M2, type Quantities } from './quantities'

// Hand calculation for the default attic (ATTIC_DEF):
//   len L = 8.5, knee 2.87 → KZ = 1.435, kneeH 0.9418, ridge H = 2.6
//   r0 1.2, cc 1.22, rn 6 → rafters at 1.2, 2.42, 3.64, 4.86, 6.08, 7.3
//   bays (EDGES): [0,1.2] [1.2,2.42] [2.42,3.64] [3.64,4.86] [4.86,6.08] [6.08,7.3] [7.3,8.5]
//     widths 1.2, 1.22, 1.22, 1.22, 1.22, 1.22, 1.2 (sum 8.5)
//   HALF = H·KZ/(H − kneeH) = 2.6·1.435/1.6582 = 3.731/1.6582 = 2.250030153…
//   SLOPE = H/HALF = (H − kneeH)/KZ = 1.6582/1.435 = 1.155540070…
//   KNEE_H = H − KZ·SLOPE = 2.6 − 1.6582 = 0.9418
//   SLEN = √(H² + HALF²) = √(6.76 + 5.062635684) = √11.822635684 = 3.438405981…
//   SIN = H/SLEN = 0.756164343…, COS = HALF/SLEN = 0.654381759…
//   slope length knee-wall top → ridge = √(KZ² + (H − KNEE_H)²)
//     = √(1.435² + 1.6582²) = √(2.059225 + 2.74962724) = √4.80885224 = 2.192909536…
//   (equal to KZ/COS = 1.435/0.654381759 = 2.192909536…)
const geo = deriveGeometry(ATTIC_DEF)

const SLOPE_KNEE_TO_RIDGE = 2.192909536
const SLEN = 3.438405981
const EAVES = 2.250030153 - 1.435 // HALF − KZ = 0.815030153
const GABLE_INNER = 1.435 * (2.6 + 0.9418) // KZ·(H + KNEE_H) = 1.435·3.5418 = 5.082483

const withOptions = (o: Partial<PlanV2['options']>, items?: PlanV2['items']): PlanV2 => {
  const p = examplePlan()
  return { ...p, options: { ...p.options, ...o }, items: items ?? p.items }
}
const ALL = [0, 1, 2, 3, 4, 5, 6]

describe('quantities — the example plan (hand-computed)', () => {
  const p = examplePlan()
  const parts = quantityParts(geo, p)
  const q = quantities(geo, p)

  it('derived geometry matches the hand values', () => {
    expect(geo.HALF).toBeCloseTo(2.250030153, 8)
    expect(geo.SLEN).toBeCloseTo(SLEN, 8)
    expect(geo.KZ / geo.COS).toBeCloseTo(SLOPE_KNEE_TO_RIDGE, 8)
    expect(geo.KNEE_H).toBeCloseTo(0.9418, 12)
  })

  it('floor: inside the knee walls minus the curved stair opening = 23.2242 m²', () => {
    // 2·KZ·L = 2·1.435·8.5 = 24.395
    expect(parts.floorInside).toBeCloseTo(24.395, 9)
    // Curved stair c1 (x 6.08, z −1.55, rot 0, turn R, a 4, w 0.8, risers 12), BELOW_DEF ceil 2.3 + slab 0.28:
    //   F = 2.58, r = F/12 = 0.215, going g = 0.24, a = 4, 3 winders, b = 11 − 4 − 3 = 4
    //   opening starts at the first tread with t > F − slab − 2.0 = 0.30 → tread 2 (0.43), ci = 1, xs = 0.24
    //   x0 = a·g = 0.96, zEnd = −0.4 − 4·0.24 = −1.36; right turn mirrors z
    //   world: (6.32,−1.95) (7.84,−1.95) (7.84,−0.19) (7.04,−0.19) (7.04,−1.15) (6.32,−1.15)
    //   clipped to z ≥ −KZ + 0.02 = −1.415:
    //     part A x 6.32..7.04 (0.72) × z −1.415..−1.15 (0.265) = 0.1908
    //     part B x 7.04..7.84 (0.80) × z −1.415..−0.19 (1.225) = 0.98
    //   opening = 1.1708
    expect(parts.floorInsideHoles).toBeCloseTo(1.1708, 9)
    expect(parts.floorEaves).toBe(0)
    expect(parts.floorEavesHoles).toBe(0)
    // 24.395 − 1.1708 = 23.2242
    expect(q.floor).toBeCloseTo(23.2242, 9)
  })

  it('panel: both slopes knee-wall top → ridge minus three roof windows = 34.518262 m²', () => {
    // 2 sides · L · 2.192909536 = 17 · 2.192909536 = 37.279462
    expect(parts.panelGross).toBeCloseTo(17 * SLOPE_KNEE_TO_RIDGE, 7)
    expect(parts.panelGross).toBeCloseTo(37.279462139, 7)
    // s1 (S, bay 1), s2 (N, bay 2), s3 (S, bay 5): 78×118, bottom 1.0
    //   s0 = 1.0/SIN = 1.322462, s1 = 2.502462; knee-wall top at v = EAVES/COS = 1.245499 < s0
    //   x: bay centres 1.81, 3.03, 6.69 ± 0.39 lie inside their bays → each fully on the panel
    //   3 · 0.78 · 1.18 = 3 · 0.9204 = 2.7612
    expect(parts.panelWindows).toBeCloseTo(2.7612, 9)
    // 37.279462139 − 2.7612 = 34.518262139
    expect(q.panel).toBeCloseTo(34.518262139, 7)
  })

  it('walls: knee walls + gables + partition (both faces) − door = 33.140532 m²', () => {
    // knee walls: 2 sides · 8.5 · 0.9418 = 16.0106
    expect(parts.kneeWalls).toBeCloseTo(16.0106, 9)
    // gables: 2 · KZ·(H + KNEE_H) = 2 · 1.435 · 3.5418 = 2 · 5.082483 = 10.164966
    expect(parts.gables).toBeCloseTo(10.164966, 9)
    // gable window 1.0×1.2 at sill 0.8: top 2.0 > roofY(0.5) − 0.08 = (2.250030 − 0.5)·1.155540 − 0.08
    //   = 2.022230 − 0.08 = 1.942230 → does not fit, not built, nothing subtracted
    expect(parts.gableWindow).toBe(0)
    // partition w1 at x 4.8: 2 faces · 5.082483 = 10.164966
    expect(parts.partitions).toBeCloseTo(10.164966, 9)
    // door: zc = 0, dh = min(2.0, roofY(0.4) − 0.1) = min(2.0, 2.137779 − 0.1) = 2.0
    //   2 faces · 0.8 · 2.0 = 3.2
    expect(parts.partitionDoors).toBeCloseTo(3.2, 9)
    // 16.0106 + 10.164966 − 0 + 10.164966 − 3.2 = 33.140532
    expect(q.walls).toBeCloseTo(33.140532, 9)
  })

  it('insulation: nothing boarded = 0 m²', () => {
    expect(q.insulation).toBe(0)
  })

  it('has no storage room or closet, so their wall terms are 0', () => {
    expect(p.items.some((i) => i.type === 'storage' || i.type === 'closet')).toBe(false)
    expect([parts.storageWalls, parts.storageDoors, parts.closetWalls, parts.closetDoors]).toEqual([0, 0, 0, 0])
  })
})

// Storage rooms and closets (owner decision 2026-11-26): the room-facing side
// of their new walls, minus door openings. roofY(z) = (HALF − |z|)·SLOPE,
//   HALF = 2.250030153, SLOPE = 1.155540070, roofY(KZ) = KNEE_H = 0.9418.
// A wall under the roof from z = a to z = b (same side of the ridge) is a
// trapezoid: |b − a|·(roofY(a) + roofY(b))/2.
describe('quantities — storage rooms and closets (hand-computed)', () => {
  type Storage = Extract<PlanV2['items'][number], { type: 'storage' }>
  type Closet = Extract<PlanV2['items'][number], { type: 'closet' }>
  const storage = (o: Partial<Storage>): Storage => ({ id: 'st', type: 'storage', x: 2.0, z: 0, rot: 0, w: 1.2, d: 1.0, side: 'S', door: 'slide', wrap: false, ...o })
  const closet = (o: Partial<Closet>): Closet => ({ id: 'cl', type: 'closet', wall: 'W', side: 'S', fit: false, d: 0.55, len: 1.0, ...o })
  // roofY(0.435) = (2.250030153 − 0.435)·1.155540070 = 1.815030153·1.155540070 = 2.097340070
  const H435 = 2.09734007
  const BASE_WALLS = 16.0106 + 10.164966 // knee walls + gables, no items

  it('roofArea: trapezoid on one side, split at the ridge', () => {
    // 0.435..1.435: 1.0·(2.097340070 + 0.9418)/2 = 1.519570035
    expect(roofArea(geo, 0.435, 1.435)).toBeCloseTo(1.519570035, 8)
    expect(roofArea(geo, 1.435, 0.435)).toBeCloseTo(1.519570035, 8)
    // −KZ..KZ = the gable inside the knee walls, 5.082483
    expect(roofArea(geo, -1.435, 1.435)).toBeCloseTo(GABLE_INNER, 9)
    // beyond the eaves adds nothing
    expect(roofArea(geo, 0, 5)).toBeCloseTo(roofArea(geo, 0, geo.HALF), 12)
  })

  it('storage room, south, x 1.4..2.6, d 1.0, sliding door: 5.555948 − 1.6 = 3.955948 m²', () => {
    // storageGeom: x0 = 2.0 − 0.6 = 1.4, x1 = 2.6, zf = KZ − d = 0.435, zb = KZ = 1.435 (bay 1 knee wall kept)
    //   hF = roofY(0.435) = 2.097340070; no stair → no corner part, xe = x1; no partitions → no shared sides
    //   front wall: (2.6 − 1.4)·2.097340070 = 1.2·2.097340070 = 2.516808084
    //   side walls x0 and x1: 2 · 1.0·(2.097340070 + 0.9418)/2 = 2 · 1.519570035 = 3.039140070
    //   walls = 2.516808084 + 3.039140070 = 5.555948153
    //   door: dw = min(0.8, 1.2 − 0.25) = 0.8, dh = min(2.0, 2.097340070 − 0.08) = 2.0 → 1.6
    const plan = withOptions({}, [storage({})])
    const p = quantityParts(geo, plan)
    expect(p.storageWalls).toBeCloseTo(1.2 * H435 + 2 * 1.519570035, 8)
    expect(p.storageWalls).toBeCloseTo(5.555948153, 8)
    expect(p.storageDoors).toBeCloseTo(1.6, 12)
    // total walls 26.175566 + 5.555948153 − 1.6 = 30.131514153
    expect(quantities(geo, plan).walls).toBeCloseTo(BASE_WALLS + 3.955948153, 8)
    expect(quantities(geo, plan).walls).toBeCloseTo(30.131514153, 8)
  })

  it("door 'hinge' and 'none' (an open doorway) cut the same opening as 'slide'", () => {
    // 'none' is "Open doorway" in the editor; buildStorage cuts the dw × dh opening for every door type
    const none = quantityParts(geo, withOptions({}, [storage({ door: 'none' })]))
    const hinge = quantityParts(geo, withOptions({}, [storage({ door: 'hinge' })]))
    expect(none.storageDoors).toBeCloseTo(1.6, 12)
    expect(hinge.storageDoors).toBeCloseTo(1.6, 12)
    expect(none.storageWalls).toBeCloseTo(5.555948153, 8)
  })

  it('storage room against a partition wall: that side is not counted again', () => {
    // x 5.4, w 1.2 → x0 = 4.8, where w1 stands (sharedX0); south side, so no corner part by c1 (north)
    //   front 2.516808084 + one side (x1 = 6.0) 1.519570035 = 4.036378119
    const items = [...examplePlan().items, storage({ x: 5.4, wrap: true })]
    const p = quantityParts(geo, withOptions({}, items))
    expect(p.storageWalls).toBeCloseTo(4.036378119, 8)
    expect(p.storageDoors).toBeCloseTo(1.6, 12)
  })

  it('storage room against the west gable: that side is not counted again', () => {
    // x 0.6, w 1.2 → x0 = 0 (on the gable), x1 = 1.2: front 2.516808084 + one side 1.519570035 = 4.036378119
    expect(quantityParts(geo, withOptions({}, [storage({ x: 0.6 })])).storageWalls).toBeCloseTo(4.036378119, 8)
  })

  it('storage room with the corner part beside the L-shaped stair opening: 7.010063 − 1.428986 m²', () => {
    // north side, x 5.6, w 1.2, d 0.8, wrap; stair c1 only (its opening starts at x 6.32, pivot (7.04, −1.15))
    //   x0 = 5.0, x1 = 6.2, zf = −(1.435 − 0.8) = −0.635, zb = −1.435
    //   corner: x2 = 7.04 − 0.05 = 6.99, zn = −1.15 + 0.05 = −1.1; xe = 6.99
    //   hF = roofY(0.635) = 1.615030153·1.155540070 = 1.866232056
    //   hn = roofY(1.1) = 1.150030153·1.155540070 = 1.328905923
    //   front wall x0..xe: 1.99·1.866232056 = 3.713801791
    //   side x0, 0.635..1.435: 0.8·(1.866232056 + 0.9418)/2 = 1.123212822
    //   side x1 behind the corner, 1.1..1.435: 0.335·(1.328905923 + 0.9418)/2 = 0.380343242
    //   along the stair run x1..x2 at zn: 0.79·1.328905923 = 1.049835679
    //   end piece at x2, zf..zn: 0.465·(1.866232056 + 1.328905923)/2 = 0.742869580
    //   walls = 3.713801791 + 1.123212822 + 0.380343242 + 1.049835679 + 0.742869580 = 7.010063115
    //   door: dw 0.8, dh = min(2.0, 1.866232056 − 0.08) = 1.786232056 → 1.428985645
    const c1 = examplePlan().items.find((i) => i.id === 'c1')!
    const p = quantityParts(geo, withOptions({}, [c1, storage({ x: 5.6, d: 0.8, side: 'N', wrap: true })]))
    expect(p.storageWalls).toBeCloseTo(7.010063115, 8)
    expect(p.storageDoors).toBeCloseTo(1.428985645, 8)
  })

  it('closet, west gable, south, d 0.55, len 1.0: 2.673107 − 0.86 = 1.813107 m²', () => {
    // closetGeom (fit off): xg = 0, xi = 0.55, zb = KZ = 1.435 (bay 0 kept), zd = 1.435 − 1.0 = 0.435
    //   hD = roofY(0.435) = 2.097340070
    //   long side at xi, 0.435..1.435: 1.0·(2.097340070 + 0.9418)/2 = 1.519570035
    //   door end x 0..0.55 at zd: 0.55·2.097340070 = 1.153537038
    //   walls = 1.519570035 + 1.153537038 = 2.673107073
    //   door: dw = max(0.3, min(0.6, 0.55 − 0.12)) = 0.43, dh = min(2.0, 2.097340070 − 0.08) = 2.0 → 0.86
    const plan = withOptions({}, [closet({})])
    const p = quantityParts(geo, plan)
    expect(p.closetWalls).toBeCloseTo(2.673107073, 8)
    expect(p.closetDoors).toBeCloseTo(0.86, 12)
    // total walls 26.175566 + 2.673107073 − 0.86 = 27.988673073
    expect(quantities(geo, plan).walls).toBeCloseTo(BASE_WALLS + 1.813107073, 8)
    expect(quantities(geo, plan).walls).toBeCloseTo(27.988673073, 8)
  })

  it('closet whose long side crosses the ridge: the roof profile is split at z = 0', () => {
    // len 1.5: zd = 1.435 − 1.5 = −0.065, hD = roofY(0.065) = 2.185030153·1.155540070 = 2.524889895
    //   long side −0.065..1.435 = (0..1.435) + (0..0.065)
    //     = 1.435·(2.6 + 0.9418)/2 + 0.065·(2.6 + 2.524889895)/2 = 2.5412415 + 0.166558922 = 2.707800422
    //   door end 0.55·2.524889895 = 1.388689442 → walls 4.096489864; door 0.43·2.0 = 0.86
    const p = quantityParts(geo, withOptions({}, [closet({ len: 1.5 })]))
    expect(p.closetWalls).toBeCloseTo(4.096489864, 8)
    expect(p.closetDoors).toBeCloseTo(0.86, 12)
  })

  it('the example plan plus the storage room and the closet', () => {
    // 33.140532 + (5.555948153 − 1.6) + (2.673107073 − 0.86) = 33.140532 + 3.955948153 + 1.813107073 = 38.909587226
    const items = [...examplePlan().items, storage({}), closet({})]
    expect(quantities(geo, withOptions({}, items)).walls).toBeCloseTo(38.909587226, 8)
  })
})

describe('quantities — boundaries', () => {
  it('no items: no openings, no partition', () => {
    const q = quantities(geo, withOptions({}, []))
    expect(q.floor).toBeCloseTo(24.395, 9) // 2·1.435·8.5
    expect(q.panel).toBeCloseTo(37.279462139, 7) // 17·2.192909536
    expect(q.walls).toBeCloseTo(16.0106 + 10.164966, 9) // knee walls + gables = 26.175566
    expect(q.insulation).toBe(0)
  })

  it('all bays boarded: the panel moves to insulation on the plasterboard plane', () => {
    const p = withOptions({ board: ALL })
    const parts = quantityParts(geo, p)
    const q = quantities(geo, p)
    expect(q.panel).toBe(0)
    // boardSpan (kept knee): v0 = (HALF − KZ − d·SIN)/COS, vTop = (HALF − d·SIN)/COS, d = BOARD_D = 0.203
    //   vTop − v0 = KZ/COS = 2.192909536 (the same length as the panel strip)
    //   gross = 17 · 2.192909536 = 37.279462; the three windows (s0 1.322 > v0 1.011, s1 2.502 < vTop 3.204) − 2.7612
    expect(parts.insulationGross).toBeCloseTo(37.279462139, 7)
    expect(parts.insulationWindows).toBeCloseTo(2.7612, 9)
    expect(q.insulation).toBeCloseTo(34.518262139, 7)
    // floor and walls unchanged
    expect(q.floor).toBeCloseTo(23.2242, 9)
    expect(q.walls).toBeCloseTo(33.140532, 9)
  })

  it('all knee bays opened on both sides: eaves floored, panel to the eaves, no knee walls', () => {
    const p = withOptions({ knee: { N: ALL, S: ALL } })
    const parts = quantityParts(geo, p)
    const q = quantities(geo, p)
    // eaves: 2 sides · 8.5 · (HALF − KZ) = 17 · 0.815030153 = 13.855512604
    expect(parts.floorEaves).toBeCloseTo(17 * EAVES, 8)
    expect(parts.floorEaves).toBeCloseTo(13.855512604, 8)
    // stair opening in the north eaves (stairHoles(HALF) clipped as buildKnee: z −HALF+0.001 .. −KZ−0.001 = −1.436):
    //   z −1.95..−1.436 = 0.514
    //   bay 5 x 6.081..7.299 → hole x 6.32..7.299 = 0.979 · 0.514 = 0.503206
    //   bay 6 x 7.301..8.499 → hole x 7.301..7.84 = 0.539 · 0.514 = 0.277046
    //   = 0.780252
    expect(parts.floorEavesHoles).toBeCloseTo(0.780252, 9)
    // 24.395 − 1.1708 + 13.855512604 − 0.780252 = 36.299460604
    expect(q.floor).toBeCloseTo(36.299460604, 8)
    // panel from the eaves: 17 · SLEN = 17 · 3.438405981 = 58.452901677; − 2.7612 = 55.691701677
    expect(parts.panelGross).toBeCloseTo(17 * SLEN, 7)
    expect(q.panel).toBeCloseTo(55.691701677, 7)
    expect(parts.kneeWalls).toBe(0)
    // gables gain the eaves triangle on both sides of both ends:
    //   (HALF − KZ)·KNEE_H/2 = 0.815030153 · 0.9418 / 2 = 0.383797699; · 4 = 1.535190796
    //   10.164966 + 1.535190796 = 11.700156796  (eaves triangle checked below)
    expect(parts.gables).toBeCloseTo(2 * GABLE_INNER + 4 * ((EAVES * 0.9418) / 2), 8)
    // walls = 0 + 11.70… + 10.164966 − 3.2
    expect(q.walls).toBeCloseTo(parts.gables + 10.164966 - 3.2, 9)
  })

  it('eaves triangle per opened end bay, hand value', () => {
    const one = quantityParts(geo, withOptions({ knee: { N: [], S: [0] } }))
    // west gable, south side only: 0.815030153 · 0.9418 / 2 = 0.767595398 / 2 = 0.383797699
    expect(one.gables - 2 * GABLE_INNER).toBeCloseTo(0.383797699, 8)
    // knee walls lose bay 0 on the south side: 16.0106 − 1.2·0.9418 = 16.0106 − 1.13016 = 14.88044
    expect(one.kneeWalls).toBeCloseTo(14.88044, 9)
    // floor gains 1.2 · 0.815030153 = 0.978036184 (no stair there)
    expect(one.floorEaves).toBeCloseTo(0.978036184, 8)
    expect(one.floorEavesHoles).toBe(0)
  })

  it('an opened middle bay adds no gable area', () => {
    const p = quantityParts(geo, withOptions({ knee: { N: [3], S: [] } }))
    expect(p.gables).toBeCloseTo(2 * GABLE_INNER, 9)
  })

  it('a 15 m attic: finite values, the long last bay counted', () => {
    const attic = atticOf({ ...ATTIC_DEF, len: 15 })
    const g15 = deriveGeometry(attic)
    const q = quantities(g15, withOptions({ attic }))
    Object.values(q).forEach((v) => expect(Number.isFinite(v)).toBe(true))
    // floor 2·1.435·15 − 1.1708 = 43.05 − 1.1708 = 41.8792
    expect(q.floor).toBeCloseTo(41.8792, 9)
    // panel 2·15·2.192909536 − 2.7612 = 65.787286083 − 2.7612 = 63.026086083
    expect(q.panel).toBeCloseTo(63.026086, 5)
    // walls 2·15·0.9418 + 10.164966 + 10.164966 − 3.2 = 28.254 + 17.129932 = 45.383932
    expect(q.walls).toBeCloseTo(45.383932, 9)
    expect(q.insulation).toBe(0)
  })

  it('a roof window across a boarded and an open bay is split between panel and insulation', () => {
    // 134×98 in bay 1 (centre 1.81): x 1.14..2.48, s 1.322462..2.302462 (h 0.98)
    //   bay 0 [0,1.2]: 0.06 wide, bay 1 [1.2,2.42]: 1.22, bay 2 [2.42,3.64]: 0.06
    //   board [1]: insulation cut 1.22·0.98 = 1.1956; panel cut (0.06 + 0.06)·0.98 = 0.1176
    const items: PlanV2['items'] = [{ id: 'w', type: 'skylight', slope: 'S', bay: 1, size: '134×98', bottom: 1.0 }]
    const p = quantityParts(geo, withOptions({ board: [1] }, items))
    expect(p.insulationWindows).toBeCloseTo(1.1956, 9)
    expect(p.panelWindows).toBeCloseTo(0.1176, 9)
    // insulation gross: one bay, two sides: 2 · 1.22 · 2.192909536 = 5.350699268
    expect(p.insulationGross).toBeCloseTo(5.350699268, 8)
  })

  it('a roof window reaching below the knee-wall top only cuts the panel above it', () => {
    // bottom 0.3: s0 = 0.3/SIN = 0.396739, s1 = 1.576739; knee-wall top v = 0.815030153/0.654381759 = 1.245499
    //   on the panel: 1.576739 − 1.245499 = 0.331240 · 0.78 = 0.258367
    const items: PlanV2['items'] = [{ id: 'w', type: 'skylight', slope: 'S', bay: 1, size: '78×118', bottom: 0.3 }]
    const p = quantityParts(geo, withOptions({}, items))
    const s0 = 0.3 / geo.SIN
    expect(s0).toBeCloseTo(0.396739, 6)
    expect(p.panelWindows).toBeCloseTo((s0 + 1.18 - EAVES / geo.COS) * 0.78, 9)
    expect(p.panelWindows).toBeCloseTo(0.258367, 5)
  })

  it('a roof window that gets no opening (overlapping another) is not subtracted', () => {
    const items: PlanV2['items'] = [
      { id: 'a', type: 'skylight', slope: 'S', bay: 1, size: '78×118', bottom: 1.0 },
      { id: 'b', type: 'skylight', slope: 'S', bay: 1, size: '78×118', bottom: 1.0 },
    ]
    expect(quantityParts(geo, withOptions({}, items)).panelWindows).toBeCloseTo(0.9204, 9)
  })

  it('a gable window that fits is subtracted, clipped to the finished gable', () => {
    // 1.0×1.2 at sill 0.6: top 1.8 ≤ 1.942230 → fits; 1.2 m²
    const fit = quantityParts(geo, withOptions({ gable: { on: true, w: 1.0, h: 1.2, sill: 0.6, off: 0 } }))
    expect(fit.gableWindow).toBeCloseTo(1.2, 12)
    // switched off: nothing
    const off = quantityParts(geo, withOptions({ gable: { on: false, w: 1.0, h: 1.2, sill: 0.6, off: 0 } }))
    expect(off.gableWindow).toBe(0)
    // 0.5×0.8 at sill 0, off 1.2: z 0.95..1.45; roofY(1.45) − 0.08 = 0.800030·1.155540 − 0.08 = 0.844467 ≥ 0.8 → fits
    //   finished gable only to KZ = 1.435: (1.435 − 0.95)·0.8 = 0.485·0.8 = 0.388
    const g = { on: true, w: 0.5, h: 0.8, sill: 0, off: 1.2 }
    expect(quantityParts(geo, withOptions({ gable: g })).gableWindow).toBeCloseTo(0.388, 12)
    // with the east bay's south knee wall opened the gable is finished to HALF: 0.5·0.8 = 0.4
    expect(quantityParts(geo, withOptions({ gable: g, knee: { N: [], S: [6] } })).gableWindow).toBeCloseTo(0.4, 12)
  })

  it('a partition door near the knee wall is lower', () => {
    // doorZ 1.2 → zc = KZ − 0.4 − 0.05 = 0.985; dh = roofY(1.385) − 0.1
    //   = (2.250030153 − 1.385)·1.155540070 − 0.1 = 0.865030153·1.155540070 − 0.1 = 0.999577 − 0.1 = 0.899577
    //   doors: 2 · 0.8 · 0.899577 = 1.439323
    const items: PlanV2['items'] = [{ id: 'w', type: 'wall', x: 3, door: true, doorZ: 1.2 }]
    expect(quantityParts(geo, withOptions({}, items)).partitionDoors).toBeCloseTo(1.439323, 5)
    const noDoor: PlanV2['items'] = [{ id: 'w', type: 'wall', x: 3, door: false, doorZ: 0 }]
    expect(quantityParts(geo, withOptions({}, noDoor)).partitionDoors).toBe(0)
  })

  it('polygonArea: either winding, degenerate', () => {
    expect(polygonArea([[0, 0], [2, 0], [2, 1], [0, 1]])).toBe(2)
    expect(polygonArea([[0, 0], [0, 1], [2, 1], [2, 0]])).toBe(2)
    expect(polygonArea([])).toBe(0)
  })
})

describe('costLines / costTotal', () => {
  const q: Quantities = { floor: 21.4, panel: 34.5, walls: 33.1, insulation: 0 }

  it('kr = m² × price at full precision (21.4 m² × 450.5 kr = 9 640.7 kr)', () => {
    const lines = costLines(q, { floor: 450.5, panel: null, walls: null, insulation: null })
    expect(lines[0]).toMatchObject({ key: 'floor', m2: 21.4, price: 450.5 })
    expect(lines[0].kr).toBeCloseTo(9640.7, 9)
    expect(Number.isInteger(lines[0].kr)).toBe(false) // not rounded in the core
    const t = costTotal(lines)
    expect(t.kr).toBeCloseTo(9640.7, 9)
    expect(t.missing).toEqual(['panel', 'walls']) // insulation is 0 m², never missing
  })

  it('price 0 is included as 0 kr, not missing', () => {
    const lines = costLines(q, { floor: 0, panel: 0, walls: 0, insulation: 0 })
    expect(lines.map((l) => l.kr)).toEqual([0, 0, 0, 0])
    expect(costTotal(lines)).toEqual({ kr: 0, missing: [] })
  })

  it('null prices on lines with m² > 0 are excluded and listed as missing, never 0', () => {
    // insulation is 0 m² here, so only the other three can be missing
    const lines = costLines(q, PRICES_NONE)
    expect(lines.map((l) => l.kr)).toEqual([null, null, null, 0])
    expect(costTotal(lines)).toEqual({ kr: 0, missing: ['floor', 'panel', 'walls'] })
    expect(costTotal(costLines(q, undefined)).missing).toEqual(['floor', 'panel', 'walls'])
  })

  it('all four prices null with all four areas > 0: kr 0 and all four missing (not an estimate)', () => {
    const all: Quantities = { floor: 21.4, panel: 34.5, walls: 33.1, insulation: 12 }
    const lines = costLines(all, PRICES_NONE)
    expect(lines.map((l) => l.kr)).toEqual([null, null, null, null])
    expect(costTotal(lines)).toEqual({ kr: 0, missing: ['floor', 'panel', 'walls', 'insulation'] })
  })

  it('mixed: priced lines summed, the rest missing', () => {
    // floor 21.4·450 = 9630; panel 34.5·0 = 0; walls missing; insulation 0·120 = 0
    const lines = costLines(q, { floor: 450, panel: 0, walls: null, insulation: 120 })
    const t = costTotal(lines)
    expect(t.kr).toBeCloseTo(9630, 9)
    expect(t.missing).toEqual(['walls'])
  })

  it('a 0 m² line with no price is not missing and does not block the total (owner decision 2026-11-26)', () => {
    // insulation 0 m², price null → kr 0; floor 21.4 + panel 34.5 + walls 33.1 at 1 kr/m² = 89.0
    const lines = costLines(q, { floor: 1, panel: 1, walls: 1, insulation: null })
    expect(lines[3]).toEqual({ key: 'insulation', m2: 0, price: null, kr: 0 })
    const t = costTotal(lines)
    expect(t.missing).toEqual([])
    expect(t.kr).toBeCloseTo(89, 12)
  })

  it('a line with m² > 0 and no price is missing', () => {
    const t = costTotal(costLines({ ...q, insulation: 5 }, { floor: 1, panel: 1, walls: 1, insulation: null }))
    expect(t.missing).toEqual(['insulation'])
    expect(t.kr).toBeCloseTo(89, 12)
  })

  it('float noise below ZERO_M2 counts as 0 m²; at ZERO_M2 it is a real area', () => {
    expect(costLines({ ...q, insulation: 1e-15 }, PRICES_NONE)[3].kr).toBe(0)
    expect(costLines({ ...q, insulation: 1e-15 }, { ...PRICES_NONE, insulation: 500 })[3].kr).toBe(0)
    expect(costLines({ ...q, insulation: ZERO_M2 }, PRICES_NONE)[3].kr).toBeNull()
  })

  it('invalid prices that bypassed sanitize count as not entered', () => {
    const bad = { floor: -1, panel: Number.NaN, walls: '450', insulation: Number.POSITIVE_INFINITY } as unknown as Prices
    const lines = costLines({ ...q, insulation: 12 }, bad)
    expect(lines.map((l) => l.price)).toEqual([null, null, null, null])
    expect(costTotal(lines).missing).toHaveLength(4)
  })

  it('the example plan, every price entered (hand-computed)', () => {
    const ex = quantities(geo, examplePlan())
    // floor 23.2242·450 = 10450.89; panel 34.518262139·320 = 11045.843884;
    // walls 33.140532·95.5 = 3164.920806; insulation 0·200 = 0
    // total = 10450.89 + 11045.843884 + 3164.920806 = 24661.65469
    const t = costTotal(costLines(ex, { floor: 450, panel: 320, walls: 95.5, insulation: 200 }))
    expect(t.missing).toEqual([])
    expect(t.kr).toBeCloseTo(24661.65469, 4)
  })
})
