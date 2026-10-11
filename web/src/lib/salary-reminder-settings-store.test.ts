import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSupabaseMock } from './testSupabaseMock'

// See mortgage-store.test.ts for why this shape (vi.hoisted holder + a fresh
// module import + manual mock-state clearing) is needed every test.
const holder = vi.hoisted(() => ({ current: undefined as unknown as ReturnType<typeof createSupabaseMock> }))
vi.mock('./supabase', () => {
  holder.current = createSupabaseMock()
  return { supabase: holder.current.supabase }
})
const mock = () => holder.current

const mem = new Map<string, string>()
let store: typeof import('./salary-reminder-settings-store')
beforeEach(async () => {
  mem.clear()
  vi.stubGlobal('localStorage', {
    get length() { return mem.size },
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, v) },
    removeItem: (k: string) => { mem.delete(k) },
    clear: () => mem.clear(),
    key: (index: number) => [...mem.keys()][index] ?? null,
  })
  vi.resetModules()
  store = await import('./salary-reminder-settings-store')
  const { activateSyncIdentity } = await import('./sync')
  activateSyncIdentity({ userId: 'test-user', householdId: 'test-house' })
  Object.keys(mock().tables).forEach((k) => delete mock().tables[k])
  mock().control.fail = false
  mock().control.failing.clear()
})

const TABLE = 'salary_reminder_settings'

describe('loadSalaryReminderSettings', () => {
  it('reads an existing row as saved fact (unknown: false)', async () => {
    mock().tables[TABLE] = [{ household_id: 'test-house', enabled: false, send_day: 10 }]
    expect(await store.loadSalaryReminderSettings()).toEqual({ settings: { enabled: false, send_day: 10 }, unknown: false })
  })

  it('no row means the documented default (enabled, day 25) — NOT unknown', async () => {
    expect(await store.loadSalaryReminderSettings()).toEqual({ settings: { enabled: true, send_day: 25 }, unknown: false })
  })

  it('a read failure falls back to the default but flags it unknown', async () => {
    mock().control.failing.add(TABLE)
    expect(await store.loadSalaryReminderSettings()).toEqual({ settings: { enabled: true, send_day: 25 }, unknown: true })
  })

  it('an out-of-range stored send_day falls back to the default for that field only', async () => {
    mock().tables[TABLE] = [{ household_id: 'test-house', enabled: true, send_day: 0 }]
    expect(await store.loadSalaryReminderSettings()).toEqual({ settings: { enabled: true, send_day: 25 }, unknown: false })
  })
})

describe('saveSalaryReminderSettings', () => {
  it('upserts on household_id and resolves on success', async () => {
    await store.saveSalaryReminderSettings({ enabled: false, send_day: 12 })
    expect(mock().tables[TABLE]).toEqual([{ household_id: 'test-house', enabled: false, send_day: 12 }])
  })

  it('re-saving updates the same row rather than inserting a second one', async () => {
    await store.saveSalaryReminderSettings({ enabled: true, send_day: 25 })
    await store.saveSalaryReminderSettings({ enabled: false, send_day: 5 })
    expect(mock().tables[TABLE]).toEqual([{ household_id: 'test-house', enabled: false, send_day: 5 }])
  })

  it('throws the backend error on failure', async () => {
    mock().control.failing.add(TABLE)
    await expect(store.saveSalaryReminderSettings({ enabled: true, send_day: 25 })).rejects.toBeTruthy()
  })

  it.each([0, 29, 1.5, Number.NaN])('rejects an invalid send_day (%s) with no network call', async (sendDay) => {
    await expect(store.saveSalaryReminderSettings({ enabled: true, send_day: sendDay })).rejects.toThrow(/send_day/)
    expect(mock().tables[TABLE] ?? []).toEqual([])
  })
})
