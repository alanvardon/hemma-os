import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from './testSupabaseMock'
import { examplePlan, type PlanV2 } from './vindsplanen/plan'

const holder = vi.hoisted(() => ({ current: undefined as unknown as ReturnType<typeof createSupabaseMock> }))
vi.mock('./supabase', () => {
  holder.current = createSupabaseMock()
  return { supabase: holder.current.supabase }
})
const mock = () => holder.current

const mem = new Map<string, string>()
let store: typeof import('./vindsplanen-store')
let sync: typeof import('./sync')

const TABLE = 'attic_plans'
const ID = '63000000-0000-4000-8000-00000000000a'
const KEY = `${TABLE}:${ID}`

function planWithBedAt(x: number): PlanV2 {
  const plan = examplePlan()
  const bed = plan.items.find((item) => item.type === 'bed')
  if (!bed || !('x' in bed)) throw new Error('example plan has no bed')
  return { ...plan, items: plan.items.map((item) => (item === bed ? { ...bed, x } : item)) }
}

function cloudRow(plan: unknown, revision = 1): Record<string, unknown> {
  return {
    id: ID, household_id: 'house-a', created_at: '2026-11-25T10:00:00.000Z', updated_at: '2026-11-25T10:00:00.000Z',
    name: 'Vindsplanen', schema_version: 2, plan, revision,
  }
}

const bedX = (plan: unknown): unknown =>
  ((plan as PlanV2).items.find((item) => item.type === 'bed') as { x?: number } | undefined)?.x

const rpcCalls = () => mock().receipts.size

beforeEach(async () => {
  mem.clear()
  vi.stubGlobal('localStorage', {
    get length() { return mem.size },
    getItem: (key: string) => mem.get(key) ?? null,
    setItem: (key: string, value: string) => { mem.set(key, value) },
    removeItem: (key: string) => { mem.delete(key) },
    key: (index: number) => [...mem.keys()][index] ?? null,
    clear: () => mem.clear(),
  })
  vi.resetModules()
  store = await import('./vindsplanen-store')
  sync = await import('./sync')
  sync.activateSyncIdentity({ userId: 'user-a', householdId: 'house-a' })
  Object.keys(mock().tables).forEach((key) => delete mock().tables[key])
  mock().control.fail = false
  mock().control.failing.clear()
  Object.keys(mock().control.errors).forEach((key) => delete mock().control.errors[key])
  mock().receipts.clear()
})

describe('attic plan load', () => {
  it('returns the cloud row as a sanitized PlanV2 and remembers its revision', async () => {
    const raw = examplePlan()
    // An out-of-range value is clamped by sanitizePlan exactly as v41 num() does.
    const stored = { ...raw, options: { ...raw.options, gable: { ...raw.options.gable, w: 99 } } }
    mock().tables[TABLE] = [cloudRow(stored, 3)]

    const result = await store.loadPlan()
    expect(result.fromCache).toBe(false)
    expect(result.invalid).toBeUndefined()
    expect(result.row).toMatchObject({ id: ID, name: 'Vindsplanen', schema_version: 2, created_at: '2026-11-25T10:00:00.000Z' })
    expect(result.row?.plan.v).toBe(2)
    expect(result.row?.plan.options.gable.w).toBe(2.5)
    expect(result.row?.plan.items).toHaveLength(raw.items.length)
    expect(sync.syncCoordinator.getRevision(KEY)).toBe(3)
    expect(store.cachedSnapshot()).toEqual([result.row])
    // The clamped value is never written back.
    expect((mock().tables[TABLE][0].plan as PlanV2).options.gable.w).toBe(99)
    expect(rpcCalls()).toBe(0)
  })

  it('loads a row saved before plan 144 (no site) with the default site, and keeps a stored site', async () => {
    const legacy = examplePlan() as unknown as { options: Record<string, unknown> }
    delete legacy.options.site
    mock().tables[TABLE] = [cloudRow(legacy, 1)]
    const old = await store.loadPlan()
    expect(old.invalid).toBeUndefined()
    expect(old.row?.plan.options.site).toEqual({ ridgeBearing: 90, lat: 59.3, lon: 18.0 })

    const withSite = examplePlan()
    withSite.options.site = { ridgeBearing: 135, lat: 63.8, lon: 20.3 }
    mock().tables[TABLE] = [cloudRow(withSite, 2)]
    const fresh = await store.loadPlan()
    expect(fresh.row?.plan.options.site).toEqual({ ridgeBearing: 135, lat: 63.8, lon: 20.3 })
  })

  it('returns null for a household with no plan', async () => {
    expect(await store.loadPlan()).toEqual({ row: null, fromCache: false })
    expect(store.cachedSnapshot()).toEqual([])
  })

  it.each([
    ['a v1 shape', { items: [], options: {} }],
    ['a future schema', { v: 3, items: [] }],
    ['a missing items array', { v: 2 }],
    ['a non-object', 'garbage'],
  ])('returns %s as invalid and never writes it back', async (_label, plan) => {
    mock().tables[TABLE] = [cloudRow(plan, 4)]
    const result = await store.loadPlan()
    expect(result).toEqual({ row: null, fromCache: false, invalid: plan })
    expect(sync.syncCoordinator.getRevision(KEY)).toBeNull()
    expect(store.cachedSnapshot()).toEqual([])
    expect(sync.syncCoordinator.getOutbox()).toEqual([])
    expect(rpcCalls()).toBe(0)

    // A save that would overwrite the unreadable row is refused before queueing.
    await expect(store.savePlan({ ...store.newPlanRow(examplePlan()), id: ID })).rejects.toMatchObject({ category: 'validation' })
    expect(sync.syncCoordinator.getOutbox()).toEqual([])
    expect(mock().tables[TABLE]).toEqual([cloudRow(plan, 4)])
  })

  it('refuses to save a plan that does not validate', async () => {
    const row = store.newPlanRow(examplePlan())
    await expect(store.savePlan({ ...row, plan: { v: 2 } as unknown as PlanV2 })).rejects.toMatchObject({ category: 'validation' })
    expect(sync.syncCoordinator.getOutbox()).toEqual([])
    expect(mock().tables[TABLE] ?? []).toEqual([])
  })

  it('falls back to the cache on a cloud read error', async () => {
    mock().tables[TABLE] = [cloudRow(planWithBedAt(2), 1)]
    await store.loadPlan()
    mock().control.failing.add(TABLE)
    const result = await store.loadPlan()
    expect(result.fromCache).toBe(true)
    expect(bedX(result.row?.plan)).toBe(2)
  })

  it('does not write the cache or revisions of a scope that became inactive', async () => {
    mock().tables[TABLE] = [cloudRow(planWithBedAt(2), 5)]
    const pending = store.loadPlan()
    sync.activateSyncIdentity({ userId: 'user-b', householdId: 'house-b' })
    const result = await pending
    expect(result.fromCache).toBe(true)
    expect(result.row).toBeNull()
    expect(store.cachedSnapshot()).toEqual([])
    expect(sync.syncCoordinator.getRevision(KEY)).toBeNull()
    sync.activateSyncIdentity({ userId: 'user-a', householdId: 'house-a' })
    expect(store.cachedSnapshot()).toEqual([])
    expect(sync.syncCoordinator.getRevision(KEY)).toBeNull()
  })
})

describe('attic plan save', () => {
  it('saves a new row, remembers the server revision and updates the cache', async () => {
    const row = { ...store.newPlanRow(planWithBedAt(2)), id: ID }
    await store.savePlan(row)
    expect(mock().tables[TABLE]).toHaveLength(1)
    const cloud = mock().tables[TABLE][0]
    expect(Object.keys(cloud).sort()).toEqual(['created_at', 'id', 'name', 'plan', 'revision', 'schema_version'])
    expect(cloud).toMatchObject({ id: ID, name: 'Vindsplanen', schema_version: 2, revision: 1 })
    expect(bedX(cloud.plan)).toBe(2)
    expect(sync.syncCoordinator.getRevision(KEY)).toBe(1)
    expect(sync.syncCoordinator.isDirty(TABLE)).toBe(false)
    expect(bedX(store.cachedSnapshot()[0]?.plan)).toBe(2)

    await store.savePlan({ ...row, plan: planWithBedAt(3) })
    expect(mock().tables[TABLE][0]).toMatchObject({ revision: 2 })
    expect(bedX(mock().tables[TABLE][0].plan)).toBe(3)
    expect(sync.syncCoordinator.getRevision(KEY)).toBe(2)
  })

  it('a failed save throws, stays dirty and in the cache, then replay() lands it', async () => {
    mock().tables[TABLE] = [cloudRow(planWithBedAt(2), 1)]
    const { row } = await store.loadPlan()
    mock().control.failing.add(TABLE)

    await expect(store.savePlan({ ...row!, plan: planWithBedAt(4) })).rejects.toBeTruthy()
    expect(sync.syncCoordinator.isDirty(TABLE)).toBe(true)
    expect(bedX(store.cachedSnapshot()[0]?.plan)).toBe(4)
    expect(bedX(mock().tables[TABLE][0].plan)).toBe(2)

    // Cache-first while dirty: the local edit wins reads, the cloud is not read.
    mock().control.failing.delete(TABLE)
    const dirtyRead = await store.loadPlan()
    expect(dirtyRead.fromCache).toBe(true)
    expect(bedX(dirtyRead.row?.plan)).toBe(4)

    await sync.syncCoordinator.replay()
    expect(sync.syncCoordinator.isDirty(TABLE)).toBe(false)
    expect(mock().tables[TABLE][0]).toMatchObject({ revision: 2 })
    expect(bedX(mock().tables[TABLE][0].plan)).toBe(4)
    expect(sync.syncCoordinator.getRevision(KEY)).toBe(2)
  })

  it('a failed save is not visible in another household', async () => {
    mock().control.failing.add(TABLE)
    await expect(store.savePlan(store.newPlanRow(examplePlan()))).rejects.toBeTruthy()
    sync.activateSyncIdentity({ userId: 'user-b', householdId: 'house-b' })
    expect(store.cachedSnapshot()).toEqual([])
    expect(sync.syncCoordinator.getOutbox()).toEqual([])
  })
})

describe('attic plan revision conflict', () => {
  async function conflicted() {
    mock().tables[TABLE] = [cloudRow(planWithBedAt(2), 1)]
    const { row } = await store.loadPlan()
    // The partner saves on another device.
    mock().tables[TABLE][0] = { ...mock().tables[TABLE][0], plan: planWithBedAt(7), revision: 2 }
    const save = store.savePlan({ ...row!, plan: planWithBedAt(4) })
    await expect(save).rejects.toMatchObject({ category: 'conflict' })
    return save.catch((error: unknown) => error)
  }

  it('surfaces a typed conflict and overwrites nothing', async () => {
    const error = await conflicted()
    expect(store.isConflictError(error)).toBe(true)
    expect(mock().tables[TABLE][0]).toMatchObject({ revision: 2 })
    expect(bedX(mock().tables[TABLE][0].plan)).toBe(7)
    const conflict = store.pendingConflict()
    expect(conflict).toMatchObject({ resource: TABLE, entityIds: [ID], conflictRevisions: { [KEY]: 2 } })
    // The local edit is kept (dirty) until the user chooses.
    expect(sync.syncCoordinator.isDirty(TABLE)).toBe(true)
    expect(bedX((await store.loadPlan()).row?.plan)).toBe(4)
    // A further replay never forces it through.
    await sync.syncCoordinator.replay()
    expect(bedX(mock().tables[TABLE][0].plan)).toBe(7)
  })

  it('notifies a conflict subscriber through the shared sync status event', async () => {
    const seen: unknown[] = []
    const target = new EventTarget()
    vi.stubGlobal('window', target)
    const stop = store.onConflictChange((conflict) => seen.push(conflict?.resource ?? null))
    await conflicted()
    stop()
    expect(seen).toContain(TABLE)
    vi.unstubAllGlobals()
  })

  it('take theirs drops the local edit and reloads the cloud row', async () => {
    await conflicted()
    const result = await store.takeTheirs()
    expect(result.fromCache).toBe(false)
    expect(bedX(result.rows[0]?.plan)).toBe(7)
    expect(store.pendingConflict()).toBeNull()
    expect(sync.syncCoordinator.isDirty(TABLE)).toBe(false)
    expect(sync.syncCoordinator.getRevision(KEY)).toBe(2)
    expect(bedX(store.cachedSnapshot()[0]?.plan)).toBe(7)
    expect(bedX(mock().tables[TABLE][0].plan)).toBe(7)
  })

  it('keep mine re-saves the local plan over the new revision', async () => {
    await conflicted()
    await store.keepMine()
    expect(store.pendingConflict()).toBeNull()
    expect(sync.syncCoordinator.isDirty(TABLE)).toBe(false)
    expect(mock().tables[TABLE][0]).toMatchObject({ revision: 3 })
    expect(bedX(mock().tables[TABLE][0].plan)).toBe(4)
    expect(sync.syncCoordinator.getRevision(KEY)).toBe(3)
  })

  it('keep mine rejects again if the partner saved once more', async () => {
    await conflicted()
    mock().tables[TABLE][0] = { ...mock().tables[TABLE][0], plan: planWithBedAt(8), revision: 3 }
    await expect(store.keepMine()).rejects.toMatchObject({ category: 'conflict' })
    expect(bedX(mock().tables[TABLE][0].plan)).toBe(8)
    expect(store.pendingConflict()).toMatchObject({ conflictRevisions: { [KEY]: 3 } })
  })
})

// ── Plan 149: variants ──────────────────────────────────────────────────────
const ID_A = '63000000-0000-4000-8000-0000000000a1'
const ID_B = '63000000-0000-4000-8000-0000000000b2'
const ID_C = '63000000-0000-4000-8000-0000000000c3'
const CACHE = 'vindsplanen_attic_plans_cache_v1'

function variant(id: string, created: string, plan: unknown, revision = 1, name = `Plan ${id.slice(-2)}`): Record<string, unknown> {
  return { id, household_id: 'house-a', created_at: created, updated_at: created, name, schema_version: 2, plan, revision }
}

const cacheRaw = (): unknown => {
  const text = sync.syncCoordinator.readScoped(CACHE)
  return text ? JSON.parse(text) : null
}
const seedCache = (value: unknown) =>
  sync.syncCoordinator.writeScoped(CACHE, typeof value === 'string' ? value : JSON.stringify(value))
const rowById = <T,>(rows: T[], id: string): T | undefined => rows.find((row) => (row as { id?: unknown }).id === id)

describe('attic plan variants: load', () => {
  it('returns no rows for an empty household', async () => {
    expect(await store.loadPlans()).toEqual({ rows: [], fromCache: false, invalid: [] })
    expect(store.cachedSnapshot()).toEqual([])
  })

  it('returns a single row and keeps loadPlan identical for one variant', async () => {
    mock().tables[TABLE] = [cloudRow(planWithBedAt(2), 3)]
    const plans = await store.loadPlans()
    expect(plans.fromCache).toBe(false)
    expect(plans.invalid).toEqual([])
    expect(plans.rows.map((row) => row.id)).toEqual([ID])
    const single = await store.loadPlan()
    expect(single).toEqual({ row: plans.rows[0], fromCache: false })
    expect(store.cachedSnapshot()).toEqual(plans.rows)
  })

  it('returns three rows oldest first, remembers each revision and caches them all', async () => {
    // Deliberately out of order in the table; created_at decides.
    mock().tables[TABLE] = [
      variant(ID_C, '2026-11-26T09:00:00.000Z', planWithBedAt(3), 7),
      variant(ID_A, '2026-11-24T09:00:00.000Z', planWithBedAt(1), 2),
      variant(ID_B, '2026-11-25T09:00:00.000Z', planWithBedAt(2), 5),
    ]
    const { rows, fromCache, invalid } = await store.loadPlans()
    expect(fromCache).toBe(false)
    expect(invalid).toEqual([])
    expect(rows.map((row) => row.id)).toEqual([ID_A, ID_B, ID_C])
    expect(rows.map((row) => bedX(row.plan))).toEqual([1, 2, 3])
    expect(sync.syncCoordinator.getRevision(`${TABLE}:${ID_A}`)).toBe(2)
    expect(sync.syncCoordinator.getRevision(`${TABLE}:${ID_B}`)).toBe(5)
    expect(sync.syncCoordinator.getRevision(`${TABLE}:${ID_C}`)).toBe(7)
    expect(store.cachedSnapshot()).toEqual(rows)
    expect((await store.loadPlan()).row?.id).toBe(ID_A)
    expect(rpcCalls()).toBe(0)
  })

  it('keeps an invalid row untouched, reports it, and never caches, saves over or deletes it', async () => {
    const bad = { v: 3, items: [] }
    mock().tables[TABLE] = [
      variant(ID_A, '2026-11-24T09:00:00.000Z', planWithBedAt(1), 2),
      variant(ID_B, '2026-11-25T09:00:00.000Z', bad, 4),
    ]
    const before = JSON.parse(JSON.stringify(mock().tables[TABLE]))
    const result = await store.loadPlans()
    expect(result.rows.map((row) => row.id)).toEqual([ID_A])
    expect(result.invalid).toEqual([{ id: ID_B, raw: bad }])
    expect(sync.syncCoordinator.getRevision(`${TABLE}:${ID_B}`)).toBeNull()
    expect((cacheRaw() as { rows: { id: string }[] }).rows.map((row) => row.id)).toEqual([ID_A])

    await expect(store.savePlan({ ...store.newPlanRow(examplePlan()), id: ID_B })).rejects.toMatchObject({ category: 'validation' })
    await expect(store.deletePlan(ID_B)).rejects.toMatchObject({ category: 'validation' })
    expect(sync.syncCoordinator.getOutbox()).toEqual([])
    expect(mock().tables[TABLE]).toEqual(before)
    expect(rpcCalls()).toBe(0)
  })

  it('loadPlan reports an invalid OLDEST row exactly as before', async () => {
    const bad = { v: 2 }
    mock().tables[TABLE] = [
      variant(ID_A, '2026-11-24T09:00:00.000Z', bad, 1),
      variant(ID_B, '2026-11-25T09:00:00.000Z', planWithBedAt(2), 1),
    ]
    expect(await store.loadPlan()).toEqual({ row: null, fromCache: false, invalid: bad })
  })

  it('migrates the plan-140 single-row cache envelope to a list, idempotently', async () => {
    const legacyRow = { id: ID, name: 'Vindsplanen', schema_version: 2, plan: planWithBedAt(5), created_at: '2026-11-25T10:00:00.000Z' }
    seedCache({ version: 1, row: legacyRow })
    const first = store.cachedSnapshot()
    expect(first.map((row) => row.id)).toEqual([ID])
    expect(bedX(first[0].plan)).toBe(5)
    // Reading never rewrites the cache; a second read is identical.
    expect(cacheRaw()).toEqual({ version: 1, row: legacyRow })
    expect(store.cachedSnapshot()).toEqual(first)

    // The offline fallback serves it too.
    mock().control.failing.add(TABLE)
    const offline = await store.loadPlans()
    expect(offline).toMatchObject({ fromCache: true, invalid: [] })
    expect(offline.rows.map((row) => row.id)).toEqual([ID])
    expect((await store.loadPlan()).row?.id).toBe(ID)

    // A row write rebases on it and stores the list shape, legacy row kept.
    mock().control.failing.delete(TABLE)
    const b = { ...store.newPlanRow(planWithBedAt(6), 'Plan B'), id: ID_B, created_at: '2026-11-26T10:00:00.000Z' }
    await store.savePlan(b)
    expect(cacheRaw()).toMatchObject({ version: 2 })
    expect(store.cachedSnapshot().map((row) => row.id)).toEqual([ID, ID_B])

    // A legacy envelope with no row is an empty list.
    seedCache({ version: 1, row: null })
    expect(store.cachedSnapshot()).toEqual([])
  })

  it.each([
    ['not JSON', '{oops'],
    ['null', 'null'],
    ['an array', '[1,2]'],
    ['a number', '42'],
    ['an unknown envelope', JSON.stringify({ version: 9, things: [] })],
    ['rows that are not rows', JSON.stringify({ version: 2, rows: [null, 3, 'x', { plan: {} }] })],
  ])('reads a malformed cache (%s) as empty without throwing', async (_label, text) => {
    seedCache(text)
    expect(() => store.cachedSnapshot()).not.toThrow()
    expect(store.cachedSnapshot()).toEqual([])
    mock().control.failing.add(TABLE)
    expect(await store.loadPlans()).toEqual({ rows: [], fromCache: true, invalid: [] })
  })

  it('a cloud load replaces a malformed cache with the cloud rows', async () => {
    seedCache('{oops')
    mock().tables[TABLE] = [variant(ID_A, '2026-11-24T09:00:00.000Z', planWithBedAt(1), 1)]
    await store.loadPlans()
    expect(cacheRaw()).toMatchObject({ version: 2, rows: [{ id: ID_A }] })
  })

  it('reports a cached row that no longer validates as invalid and refuses to save it', async () => {
    seedCache({ version: 2, rows: [
      { id: ID_A, name: 'A', schema_version: 2, plan: planWithBedAt(1), created_at: '2026-11-24T09:00:00.000Z' },
      { id: ID_B, name: 'B', schema_version: 2, plan: { v: 3 }, created_at: '2026-11-25T09:00:00.000Z' },
    ] })
    mock().control.failing.add(TABLE)
    const result = await store.loadPlans()
    expect(result.rows.map((row) => row.id)).toEqual([ID_A])
    expect(result.invalid).toEqual([{ id: ID_B, raw: { v: 3 } }])
    await expect(store.savePlan({ ...store.newPlanRow(examplePlan()), id: ID_B })).rejects.toMatchObject({ category: 'validation' })
  })

  it('never serves a row the tombstone ledger lists, even if a stale cloud read returns it', async () => {
    mock().tables[TABLE] = [
      variant(ID_A, '2026-11-24T09:00:00.000Z', planWithBedAt(1), 1),
      variant(ID_B, '2026-11-25T09:00:00.000Z', planWithBedAt(2), 1),
    ]
    mock().tables.tool_state = [{ tool: 'sync-tombstones-v1', data: { version: 1, resources: { [TABLE]: { [ID_B]: '2026-11-26T08:00:00.000Z' } } } }]
    const result = await store.loadPlans()
    expect(result.rows.map((row) => row.id)).toEqual([ID_A])
    expect(store.cachedSnapshot().map((row) => row.id)).toEqual([ID_A])
    // A save cannot resurrect a tombstoned id either.
    await expect(store.savePlan({ ...store.newPlanRow(examplePlan()), id: ID_B })).rejects.toMatchObject({ category: 'validation' })
    expect(sync.syncCoordinator.getOutbox()).toEqual([])
  })
})

describe('attic plan variants: save', () => {
  it('saving variant B rewrites only B and keeps A\'s cache entry verbatim', async () => {
    mock().tables[TABLE] = [
      variant(ID_A, '2026-11-24T09:00:00.000Z', planWithBedAt(1), 1),
      variant(ID_B, '2026-11-25T09:00:00.000Z', planWithBedAt(2), 1),
    ]
    const { rows } = await store.loadPlans()
    // An extra field on A's cached entry proves the write base is the raw
    // envelope, not a re-validated copy (PR #332).
    const env = cacheRaw() as { version: number; rows: Record<string, unknown>[] }
    env.rows[0] = { ...env.rows[0], futureField: 'keep me' }
    seedCache(env)
    const rawA = JSON.parse(JSON.stringify(env.rows[0]))

    await store.savePlan({ ...rowById(rows, ID_B)!, plan: planWithBedAt(6) })
    const after = cacheRaw() as { rows: Record<string, unknown>[] }
    expect(after.rows.find((row) => row.id === ID_A)).toEqual(rawA)
    expect(bedX(rowById(store.cachedSnapshot(), ID_B)!.plan)).toBe(6)
    expect(bedX(rowById(mock().tables[TABLE], ID_A)!.plan)).toBe(1)
    expect(rowById(mock().tables[TABLE], ID_A)).toMatchObject({ revision: 1 })
    expect(rowById(mock().tables[TABLE], ID_B)).toMatchObject({ revision: 2 })
  })

  it('a failed save of B keeps A intact and B dirty in the cache', async () => {
    mock().tables[TABLE] = [
      variant(ID_A, '2026-11-24T09:00:00.000Z', planWithBedAt(1), 1),
      variant(ID_B, '2026-11-25T09:00:00.000Z', planWithBedAt(2), 1),
    ]
    const { rows } = await store.loadPlans()
    mock().control.failing.add(TABLE)
    await expect(store.savePlan({ ...rowById(rows, ID_B)!, plan: planWithBedAt(6) })).rejects.toBeTruthy()
    const snap = store.cachedSnapshot()
    expect(bedX(rowById(snap, ID_A)!.plan)).toBe(1)
    expect(bedX(rowById(snap, ID_B)!.plan)).toBe(6)
    expect(sync.syncCoordinator.isDirty(TABLE)).toBe(true)
  })

  it('duplicate creates a distinct new id with a copy of the plan and a "(copy)" name', async () => {
    mock().tables[TABLE] = [variant(ID_A, '2026-11-24T09:00:00.000Z', planWithBedAt(1), 1, 'Plan A')]
    const { rows: [a] } = await store.loadPlans()
    const copy = store.duplicatePlanRow(a)
    expect(copy.id).not.toBe(a.id)
    expect(copy.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(copy.name).toBe('Plan A (copy)')
    expect(copy.plan).toEqual(a.plan)
    expect(copy.plan).not.toBe(a.plan)
    expect(store.duplicatePlanRow(a).id).not.toBe(copy.id)

    await store.savePlan(copy)
    const { rows } = await store.loadPlans()
    expect(rows.map((row) => row.id)).toEqual([ID_A, copy.id])
    expect(mock().tables[TABLE]).toHaveLength(2)
  })

  it('copyName and normalizePlanName respect the 1–80 character column', () => {
    const long = 'x'.repeat(80)
    expect(store.copyName(long)).toHaveLength(80)
    expect(store.copyName(long).endsWith(' (copy)')).toBe(true)
    expect(store.copyName('  ')).toBe('Vindsplanen (copy)')
    expect(store.normalizePlanName('  Plan B  ')).toBe('Plan B')
    expect(store.normalizePlanName('   ')).toBeNull()
    expect(store.normalizePlanName('y'.repeat(81))).toBeNull()
    expect(store.normalizePlanName('y'.repeat(80))).toBe('y'.repeat(80))
  })
})

describe('attic plan variants: delete', () => {
  async function twoVariants() {
    mock().tables[TABLE] = [
      variant(ID_A, '2026-11-24T09:00:00.000Z', planWithBedAt(1), 1),
      variant(ID_B, '2026-11-25T09:00:00.000Z', planWithBedAt(2), 3),
    ]
    return (await store.loadPlans()).rows
  }

  it('success deletes in the cloud, drops it from the cache, and the next load does not resurrect it', async () => {
    await twoVariants()
    await store.deletePlan(ID_B)
    expect(mock().tables[TABLE].map((row) => row.id)).toEqual([ID_A])
    expect(store.cachedSnapshot().map((row) => row.id)).toEqual([ID_A])
    expect(sync.syncCoordinator.getOutbox()).toEqual([])
    expect(sync.syncCoordinator.getRevision(`${TABLE}:${ID_B}`)).toBeNull()

    expect((await store.loadPlans()).rows.map((row) => row.id)).toEqual([ID_A])
    // Offline, the cache fallback does not bring it back either.
    mock().control.failing.add(TABLE)
    expect((await store.loadPlans()).rows.map((row) => row.id)).toEqual([ID_A])
    // A late save of the deleted variant is refused before it is queued.
    mock().control.failing.delete(TABLE)
    await expect(store.savePlan({ ...store.newPlanRow(examplePlan()), id: ID_B })).rejects.toMatchObject({ category: 'validation' })
    expect(sync.syncCoordinator.getOutbox()).toEqual([])
  })

  it('sends the delete through sync_delete_rows with the row\'s known revision', async () => {
    await twoVariants()
    const calls: { name: string; args: unknown }[] = []
    const original = mock().supabase.rpc
    mock().supabase.rpc = ((name: string, args?: unknown) => { calls.push({ name, args }); return original(name, args) }) as typeof original
    try { await store.deletePlan(ID_B) } finally { mock().supabase.rpc = original }
    expect(calls).toEqual([{ name: 'sync_delete_rows', args: expect.objectContaining({
      p_resource: TABLE, p_ids: [ID_B], p_expected_revisions: { [`${TABLE}:${ID_B}`]: 3 },
    }) }])
  })

  it.each([
    ['the server lacks the delete arm (22023)', 'validation', { message: 'unsupported generic delete resource', code: '22023' }],
    ['offline', 'offline', { message: 'fetch failed', status: 0 }],
  ])('failure when %s throws, keeps the row in the cache and leaves nothing queued', async (_label, category, error) => {
    await twoVariants()
    const cacheBefore = cacheRaw()
    mock().control.failing.add('sync_delete_rows')
    mock().control.errors.sync_delete_rows = error
    await expect(store.deletePlan(ID_B)).rejects.toMatchObject({ name: 'PersistenceError', category })

    expect(cacheRaw()).toEqual(cacheBefore)
    expect(store.cachedSnapshot().map((row) => row.id)).toEqual([ID_A, ID_B])
    expect(mock().tables[TABLE].map((row) => row.id)).toEqual([ID_A, ID_B])
    expect(sync.syncCoordinator.getOutbox()).toEqual([])
    expect(sync.syncCoordinator.isDirty(TABLE)).toBe(false)
    expect(store.pendingConflict()).toBeNull()
    expect(sync.syncCoordinator.getRevision(`${TABLE}:${ID_B}`)).toBe(3)

    // Nothing replays later, and B can still be edited and saved.
    mock().control.failing.delete('sync_delete_rows')
    await sync.syncCoordinator.replay()
    expect(mock().tables[TABLE].map((row) => row.id)).toEqual([ID_A, ID_B])
    expect((await store.loadPlans()).fromCache).toBe(false)
    await store.savePlan({ ...rowById(store.cachedSnapshot(), ID_B)!, plan: planWithBedAt(8) })
    expect(rowById(mock().tables[TABLE], ID_B)).toMatchObject({ revision: 4 })
  })

  it('a delete that conflicts with a partner edit throws conflict and changes nothing', async () => {
    await twoVariants()
    mock().tables[TABLE][1] = { ...mock().tables[TABLE][1], plan: planWithBedAt(7), revision: 4 }
    await expect(store.deletePlan(ID_B)).rejects.toMatchObject({ category: 'conflict' })
    expect(mock().tables[TABLE].map((row) => row.id)).toEqual([ID_A, ID_B])
    expect(store.cachedSnapshot().map((row) => row.id)).toEqual([ID_A, ID_B])
    expect(sync.syncCoordinator.getOutbox()).toEqual([])
    expect(store.pendingConflict()).toBeNull()
  })

  it('a failed delete does not drop a queued save of another variant', async () => {
    const rows = await twoVariants()
    // A's save fails and stays queued ahead of the delete.
    mock().control.failing.add(TABLE)
    await expect(store.savePlan({ ...rowById(rows, ID_A)!, plan: planWithBedAt(5) })).rejects.toBeTruthy()
    await expect(store.deletePlan(ID_B)).rejects.toBeTruthy()
    const outbox = sync.syncCoordinator.getOutbox()
    expect(outbox).toHaveLength(1)
    expect(outbox[0]).toMatchObject({ operation: 'upsert', entityIds: [ID_A] })
    expect(store.cachedSnapshot().map((row) => row.id)).toEqual([ID_A, ID_B])

    mock().control.failing.delete(TABLE)
    await sync.syncCoordinator.replay()
    expect(bedX(rowById(mock().tables[TABLE], ID_A)!.plan)).toBe(5)
    expect(mock().tables[TABLE].map((row) => row.id)).toEqual([ID_A, ID_B])
  })

  it('rejects an empty id without queueing', async () => {
    await expect(store.deletePlan('')).rejects.toMatchObject({ category: 'validation' })
    expect(sync.syncCoordinator.getOutbox()).toEqual([])
  })
})

describe('attic plan variants: conflicts are per row', () => {
  async function conflictOnB() {
    mock().tables[TABLE] = [
      variant(ID_A, '2026-11-24T09:00:00.000Z', planWithBedAt(1), 1),
      variant(ID_B, '2026-11-25T09:00:00.000Z', planWithBedAt(2), 1),
    ]
    const { rows } = await store.loadPlans()
    const idx = mock().tables[TABLE].findIndex((row) => row.id === ID_B)
    mock().tables[TABLE][idx] = { ...mock().tables[TABLE][idx], plan: planWithBedAt(7), revision: 2 }
    await expect(store.savePlan({ ...rowById(rows, ID_B)!, plan: planWithBedAt(4) })).rejects.toMatchObject({ category: 'conflict' })
    return rows
  }

  it('a conflict on B is visible for B only and A still saves', async () => {
    const rows = await conflictOnB()
    expect(store.pendingConflict(ID_B)).toMatchObject({ entityIds: [ID_B] })
    expect(store.pendingConflict(ID_A)).toBeNull()
    expect(store.pendingConflict()).toMatchObject({ entityIds: [ID_B] })

    await store.savePlan({ ...rowById(rows, ID_A)!, plan: planWithBedAt(3) })
    expect(rowById(mock().tables[TABLE], ID_A)).toMatchObject({ revision: 2 })
    expect(bedX(rowById(store.cachedSnapshot(), ID_A)!.plan)).toBe(3)
    expect(store.pendingConflict(ID_B)).not.toBeNull()
  })

  it('keepMine(A) with no conflict on A leaves B\'s conflict alone', async () => {
    await conflictOnB()
    await store.keepMine(ID_A)
    expect(store.pendingConflict(ID_B)).not.toBeNull()
    expect(bedX(rowById(mock().tables[TABLE], ID_B)!.plan)).toBe(7)
  })

  it('takeTheirs(A) does not drop B\'s conflicted edit', async () => {
    await conflictOnB()
    const result = await store.takeTheirs(ID_A)
    expect(result.fromCache).toBe(true)
    expect(store.pendingConflict(ID_B)).not.toBeNull()
    expect(bedX(rowById(result.rows, ID_B)!.plan)).toBe(4)
  })

  it('takeTheirs(B) reloads B from the cloud and leaves A untouched', async () => {
    await conflictOnB()
    const result = await store.takeTheirs(ID_B)
    expect(result.fromCache).toBe(false)
    expect(store.pendingConflict()).toBeNull()
    expect(bedX(rowById(result.rows, ID_B)!.plan)).toBe(7)
    expect(bedX(rowById(result.rows, ID_A)!.plan)).toBe(1)
    expect(rowById(mock().tables[TABLE], ID_A)).toMatchObject({ revision: 1 })
  })

  it('keepMine(B) re-saves B over the new revision and leaves A untouched', async () => {
    await conflictOnB()
    await store.keepMine(ID_B)
    expect(store.pendingConflict()).toBeNull()
    expect(rowById(mock().tables[TABLE], ID_B)).toMatchObject({ revision: 3 })
    expect(bedX(rowById(mock().tables[TABLE], ID_B)!.plan)).toBe(4)
    expect(rowById(mock().tables[TABLE], ID_A)).toMatchObject({ revision: 1 })
    expect(bedX(rowById(store.cachedSnapshot(), ID_A)!.plan)).toBe(1)
  })

  it('onConflictChange(listener, A) never reports B\'s conflict', async () => {
    const seenA: unknown[] = []
    const seenB: unknown[] = []
    vi.stubGlobal('window', new EventTarget())
    const stopA = store.onConflictChange((c) => seenA.push(c?.entityIds ?? null), ID_A)
    const stopB = store.onConflictChange((c) => seenB.push(c?.entityIds ?? null), ID_B)
    await conflictOnB()
    stopA(); stopB()
    vi.unstubAllGlobals()
    expect(seenA.every((value) => value === null)).toBe(true)
    expect(seenB).toContainEqual([ID_B])
  })
})
