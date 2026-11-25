// Fixture plans for the golden capture, in v41's export shape (below.v 11, so
// v41's sanitize runs no migrations). All fictional: the owner-like plan is
// built from v41's documented defaults and the plan's description, not from
// OWNER_PLAN.

const DOORS = [
  { wall: 'S', at: 2.2, w: 0.82, kind: 'door', flip: false },
  { wall: 'S', at: 3.3, w: 0.82, kind: 'door', flip: false },
  { wall: 'N', at: 2.8, w: 0.9, kind: 'door', flip: false },
  { wall: 'N', at: 4.25, w: 0.82, kind: 'door', flip: false },
  { wall: 'W', at: 0.5, w: 0.8, kind: 'door', flip: false },
  { wall: 'W', at: 1.16, w: 0.34, kind: 'panel', flip: false },
  { wall: 'W', at: 1.8, w: 0.8, kind: 'door', flip: false },
]
const BELOW = {
  v: 11, show: true, ceil: 2.3, slab: 0.28, side: 'N', hw: 2.1, off: 0, east: 0, screen: 1.15, len: 2.3, sw: 1.0, hall: 1.3,
  hallLen: 4.75, ground: 0, oldN: 0, oldW: 0, oldG: 0, oldK: 0, oldB: 0, winZ: 0, winW: 0, winH: 0, winS: 0, fill: 0, ret: 0.44,
}
const ATTIC = { len: 8.5, knee: 2.87, kneeH: 0.9418, ridge: 2.6, r0: 1.2, cc: 1.22, rn: 6, rw: 0.045, rd: 0.19 }

function plan({ below = {}, options = {}, items }) {
  return {
    v: 1,
    example: false,
    materials: { floor: 'oak', panel: 'white', rafter: 'natural', walls: 'warm' },
    options: {
      zones: true, rafters: true, cutaway: true, sun: 'evening', quality: 'nice', dims: false,
      gable: { on: true, w: 1, h: 1.2, sill: 0.8, off: 0 },
      knee: { N: [], S: [] }, board: [], attic: { ...ATTIC }, measured: {},
      ...options,
      below: { ...BELOW, doors: DOORS.map((d) => ({ ...d })), ...below },
    },
    items,
  }
}

const bedroom = [
  { id: 'w1', type: 'wall', x: 3.65, door: true, doorZ: 0 },
  { id: 'b1', type: 'bed', x: 0.85, z: -0.1, rot: 90, size: '160×200' },
  { id: 'n1', type: 'nightstand', x: 0.25, z: -1.07, rot: 90, w: 0.45, d: 0.4, h: 0.5 },
  { id: 'n2', type: 'nightstand', x: 0.25, z: 1.07, rot: 90, w: 0.45, d: 0.4, h: 0.5 },
  { id: 'd1', type: 'dresser', x: 3.0, z: 1.19, rot: 0, w: 0.8, d: 0.45, h: 0.8 },
  { id: 'r1', type: 'rug', x: 2.2, z: 0, rot: 90, w: 1.6, d: 1.1, h: 0.01 },
  { id: 's1', type: 'skylight', slope: 'S', bay: 1, size: '78×118', bottom: 1 },
  { id: 's2', type: 'skylight', slope: 'N', bay: 2, size: '78×118', bottom: 1 },
  { id: 's3', type: 'skylight', slope: 'S', bay: 5, size: '78×118', bottom: 1 },
  { id: 'k1', type: 'desk', x: 4.6, z: 0.9, rot: 0, w: 1.2, d: 0.6, h: 0.75 },
]

const ownerLike = (w, x, fill) =>
  plan({
    below: { oldN: 14, oldK: 7, oldB: 1, fill, ret: 0.44 },
    options: { knee: { N: [4, 5, 6], S: [] }, board: [0, 1, 2], measured: { A1: '2026-10-01', B1: 'earlier', D3: '2026-10-02' } },
    items: [...bedroom, { id: 'c1', type: 'curved', x, z: -1.55, rot: 0, turn: 'R', a: 4, w, risers: 12 }],
  })

export const FIXTURES = [
  { name: 'example', input: null, opts: { useExample: true } },
  // the 105 cm curved stairs at x 6.08, a fitted closet on the east gable and the storage room by the stairs
  { name: 'owner-like', input: ownerLike(1.05, 6.08, 0.1), opts: { addCloset: true, addStorage: true } },
  // the 80 cm variant
  { name: 'curved-80', input: ownerLike(0.8, 6.0, 0.15), opts: { addCloset: true, addStorage: true } },
  {
    name: 'spiral',
    input: plan({
      options: { knee: { N: [], S: [1] }, board: [5], gable: { on: true, w: 0.9, h: 1.0, sill: 0.7, off: 0.3 } },
      items: [
        { id: 'sp1', type: 'spiral', x: 4.8, z: -0.7, rot: 225, dir: 'cw', d: 1.7, deg: 330, risers: 0 },
        { id: 'sp2', type: 'spiral', x: 2.0, z: 0.6, rot: 90, dir: 'ccw', d: 1.2, deg: 200, risers: 10 },
        // turned past a full circle, so the top landing sits over a low step
        { id: 'sp3', type: 'spiral', x: 6.8, z: 0.5, rot: 0, dir: 'cw', d: 1.6, deg: 420, risers: 0 },
        { id: 'c3', type: 'curved', x: 4.6, z: -0.9, rot: 90, turn: 'L', a: 3, w: 0.9, risers: 0 },
        { id: 'cl2', type: 'closet', wall: 'W', side: 'S', fit: false, d: 0.3, len: 2.4 },
        { id: 'cl3', type: 'closet', wall: 'E', side: 'N', fit: true, d: 0.55, len: 1.5 },
        { id: 'sr2', type: 'storage', x: 6.5, z: 0, rot: 0, w: 1.0, d: 0.5, side: 'S', door: 'hinge', wrap: false },
        { id: 'w2', type: 'wall', x: 7.0, door: false, doorZ: 0 },
        { id: 'sf1', type: 'sofa', x: 7.6, z: 0.2, rot: 270, w: 2.0, d: 0.9, h: 0.82 },
      ],
    }),
    opts: {},
  },
  {
    name: 'straight',
    input: plan({
      below: { side: 'S', east: 0.3, off: 0.15 },
      options: { board: [3, 4], knee: { N: [10, 2, 0], S: [] }, gable: { on: true, w: 2.4, h: 2.0, sill: 0.2, off: 0 } },
      items: [
        { id: 'st1', type: 'stairs', x: 4.25, z: 0, rot: 0, w: 0.9, run: 2.8, drop: 2.58 },
        { id: 'st2', type: 'stairs', x: 2.0, z: 0.5, rot: 90, w: 0.7, run: 1.2, drop: 3.0 },
        { id: 'st3', type: 'stairs', x: 7.0, z: 1.2, rot: 0, w: 0.9, run: 2.0, drop: 2.6 },
        { id: 'st4', type: 'stairs', x: 4.0, z: -0.8, rot: 180, w: 0.9, run: 4.5, drop: 1.8 },
        { id: 'c5', type: 'curved', x: 5.5, z: 1.5, rot: 0, turn: 'N', a: 6, w: 0.9, risers: 0 },
        { id: 'c6', type: 'curved', x: 6.9, z: 1.0, rot: 180, turn: 'R', a: 2, w: 0.7, risers: 14 },
        { id: 'wr1', type: 'wardrobe', x: 1.0, z: 1.3, rot: 0, w: 1.0, d: 0.6, h: 2.0 },
        { id: 'rg1', type: 'rug', x: 8.4, z: 0, rot: 45, w: 2.0, d: 1.4, h: 0.01 },
        { id: 'b2', type: 'bed', x: 6.0, z: 1.2, rot: 0, size: '90×200' },
        { id: 'w3', type: 'wall', x: 4.86, door: true, doorZ: 1.2 },
        { id: 'w4', type: 'wall', x: 1.2, door: false, doorZ: 0 },
        { id: 'sk1', type: 'skylight', slope: 'S', bay: 3, size: '134×98', bottom: 1.0 },
        { id: 'sk2', type: 'skylight', slope: 'N', bay: 4, size: '78×118', bottom: 1.0 },
        { id: 'sk3', type: 'skylight', slope: 'N', bay: 4, size: '78×118', bottom: 1.3 },
        { id: 'sk4', type: 'skylight', slope: 'S', bay: 0, size: '78×140', bottom: 2.2 },
        { id: 'sr3', type: 'storage', x: 5.0, z: 0, rot: 0, w: 1.4, d: 1.0, side: 'N', door: 'slide', wrap: true },
      ],
    }),
    opts: {},
  },
  {
    name: 'attic-custom',
    input: plan({
      below: { side: 'S', east: 0.4, off: 0.1, hw: 2.0, hallLen: 5.5, oldW: 0.9, oldG: 0.26, ground: 2.7, winW: 0.9, winZ: 0.5, winH: 1.1, winS: 0.9 },
      options: {
        attic: { len: 7.2, knee: 3.1, kneeH: 0.6, ridge: 2.9, r0: 0.9, cc: 0.9, rn: 7, rw: 0.05, rd: 0.22 },
        knee: { N: [], S: [5, 6, 7] },
        board: [0, 1],
        measured: { A1: '2026-11-01', A4: '2026-11-01', W1: 'earlier', bogus: 'x', D1: 42 },
      },
      items: [
        { id: 'w5', type: 'wall', x: 3.5, door: true, doorZ: -0.4 },
        { id: 'b3', type: 'bed', x: 1.2, z: 0, rot: 90, size: '180×200' },
        { id: 'sk5', type: 'skylight', slope: 'S', bay: 2, size: '114×118', bottom: 0.9 },
        { id: 'sk6', type: 'skylight', slope: 'N', bay: 6, size: '78×98', bottom: 1.1 },
      ],
    }),
    opts: { addCurved: true, addCloset: true, addStorage: true },
  },
]

// sanitize corpus: every entry keeps below.v 11 so v41 runs no migrations
const v11 = (extra = {}) => ({ ...extra, below: { v: 11, ...(extra.below || {}) } })
export const SANITIZE_CASES = [
  null,
  42,
  'plan',
  [],
  { items: 'nope' },
  { options: v11(), items: [] },
  {
    options: v11({ gable: { on: 0, w: 9, h: -1, sill: '0.5', off: 3 }, below: { ceil: 9, slab: 0, side: 'X', hw: '2', oldN: '14', oldK: '7', oldB: 9, fill: 1, ret: -3, doors: [null, 5, { wall: 'E', at: 99, w: 0.1, kind: 'x', flip: 1 }, { wall: 'W', at: -1, w: 3, kind: 'panel', flip: true }] } }),
    items: [],
  },
  {
    options: v11({ knee: { N: [6, 1.5, -1, 99, 6, 0], S: 'x' }, board: [2, 10, 1], measured: { A1: '2026-01-01T12:00:00', Z9: 'x', B12: 'earlier', D100: 'x', W1: 5 }, attic: { len: '7', knee: null, kneeH: 3, ridge: 2.2, r0: 9, cc: 0.5, rn: 40, rw: 1, rd: 0.01 }, zones: 'yes', sun: 'night', quality: 'ultra', dims: 1 }),
    items: [],
  },
  {
    materials: { floor: 'marble', panel: 'green', rafter: 7, walls: 'navy' },
    options: v11(),
    items: [
      null,
      'x',
      { type: 'unicorn', id: 'u1' },
      { type: 'bed', id: 'bx', x: 99, z: -99, rot: 400, size: '200×200' },
      { type: 'bed', x: '2', z: null, rot: -5 },
      { type: 'skylight', id: 'sx', slope: 'E', bay: 2.6, size: 'huge', bottom: 9 },
      { type: 'skylight', id: 'sy', bay: '1' },
      { type: 'wall', id: 'wx', x: -1, door: 'yes', doorZ: 5 },
      { type: 'stairs', id: 'tx', rot: 45, w: 9, run: 0, drop: 'x' },
      { type: 'curved', id: 'cx', rot: 90, turn: 'Q', a: 99.6, w: 0.1, risers: 3 },
      { type: 'curved', id: 'cy', rot: 270, turn: 'N', a: '4', risers: '12' },
      { type: 'spiral', id: 'px', dir: 'up', d: 9, deg: 100, risers: 30 },
      { type: 'storage', id: 'ox', w: 0.1, d: 9, side: 'S', door: 'trapdoor', wrap: 0 },
      { type: 'closet', id: 'lx', wall: 'N', side: 'S', fit: 0, d: 0, len: 9 },
      { type: 'wardrobe', id: 'fx', w: 0, d: 5, h: 3 },
      { type: 'rug', id: 'fy' },
    ],
  },
]
