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
    expect(store.cachedSnapshot()).toEqual(result.row)
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
    expect(store.cachedSnapshot()).toBeNull()
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
    expect(store.cachedSnapshot()).toBeNull()
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
    expect(store.cachedSnapshot()).toBeNull()
    expect(sync.syncCoordinator.getRevision(KEY)).toBeNull()
    sync.activateSyncIdentity({ userId: 'user-a', householdId: 'house-a' })
    expect(store.cachedSnapshot()).toBeNull()
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
    expect(bedX(store.cachedSnapshot()?.plan)).toBe(2)

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
    expect(bedX(store.cachedSnapshot()?.plan)).toBe(4)
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
    expect(store.cachedSnapshot()).toBeNull()
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
    expect(bedX(result.row?.plan)).toBe(7)
    expect(store.pendingConflict()).toBeNull()
    expect(sync.syncCoordinator.isDirty(TABLE)).toBe(false)
    expect(sync.syncCoordinator.getRevision(KEY)).toBe(2)
    expect(bedX(store.cachedSnapshot()?.plan)).toBe(7)
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
