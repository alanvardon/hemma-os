// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from './testSupabaseMock'

// Real sync coordinator (jsdom localStorage) + mocked supabase. Module-level
// identity state is isolated per test by activating a FRESH (user, household)
// sync identity each time — the same scoping that guarantees no cross-account
// reuse in the app.
const holder = vi.hoisted(() => ({ current: undefined as unknown as ReturnType<typeof createSupabaseMock> }))
vi.mock('./supabase', () => {
  holder.current = createSupabaseMock()
  return { supabase: holder.current.supabase }
})
const mock = () => holder.current

import {
  assignHouseholdPeople,
  fetchHouseholdIdentity,
  getHouseholdIdentitySnapshot,
  identityErrorMessage,
  myToolSlot,
  parseHouseholdIdentity,
  refreshHouseholdIdentity,
  setMyProfileName,
} from './person-identity'
import { activateSyncIdentity, syncCoordinator } from './sync'

const HH = '00000000-aaaa-4aaa-8aaa-000000000001'
const PA = '11111111-1111-4111-8111-111111111111'
const PB = '22222222-2222-4222-8222-222222222222'

const view = (overrides: Record<string, unknown> = {}) => ({
  household_id: HH,
  my_person_id: null,
  my_profile_name: null,
  people: [
    { id: PA, slot: 'a', display_name: 'Alex', assigned_email: 'alex@x.se' },
    { id: PB, slot: 'b', display_name: 'Sam', assigned_email: 'sam@x.se' },
  ],
  ...overrides,
})

let sequence = 0
beforeEach(() => {
  localStorage.clear()
  sequence += 1
  activateSyncIdentity({ userId: `user-${sequence}`, householdId: `house-${sequence}` })
  Object.keys(mock().tables).forEach((k) => delete mock().tables[k])
  mock().control.fail = false
  mock().control.failing.clear()
  mock().control.errors = {}
  mock().control.rpcHandlers = {}
})

describe('parseHouseholdIdentity', () => {
  it('parses a valid configured view with slot-ordered people', () => {
    const parsed = parseHouseholdIdentity(view({
      my_person_id: PB,
      my_profile_name: 'Sam',
      people: [
        { id: PB, slot: 'b', display_name: 'Sam', assigned_email: 'sam@x.se' },
        { id: PA, slot: 'a', display_name: 'Alex', assigned_email: 'alex@x.se' },
      ],
    }))
    expect(parsed).toEqual({
      householdId: HH,
      myPersonId: PB,
      myProfileName: 'Sam',
      people: [
        { id: PA, slot: 'a', display_name: 'Alex', assigned_email: 'alex@x.se' },
        { id: PB, slot: 'b', display_name: 'Sam', assigned_email: 'sam@x.se' },
      ],
    })
  })

  it('parses assigned_email (value / missing → null) and profile name', () => {
    const parsed = parseHouseholdIdentity(view({
      my_profile_name: '  ',
      people: [
        { id: PA, slot: 'a', display_name: 'Alex', assigned_email: 'alex@x.se' },
        { id: PB, slot: 'b', display_name: 'Person B' },
      ],
    }))
    expect(parsed?.people[0].assigned_email).toBe('alex@x.se')
    expect(parsed?.people[1].assigned_email).toBeNull()
    expect(parsed?.myProfileName).toBeNull()
  })

  it('falls back to Person A/B when a display name is blank', () => {
    const parsed = parseHouseholdIdentity(view({
      people: [
        { id: PA, slot: 'a', display_name: '', assigned_email: null },
        { id: PB, slot: 'b', display_name: 'Sam', assigned_email: 'sam@x.se' },
      ],
    }))
    expect(parsed?.people[0].display_name).toBe('Person A')
  })

  it('returns null for SQL NULL and unusable envelopes', () => {
    expect(parseHouseholdIdentity(null)).toBeNull()
    expect(parseHouseholdIdentity(undefined)).toBeNull()
    expect(parseHouseholdIdentity('nope')).toBeNull()
    expect(parseHouseholdIdentity([])).toBeNull()
    expect(parseHouseholdIdentity({ household_id: 'not-a-uuid' })).toBeNull()
  })

  it('parses an unconfigured household (empty people)', () => {
    const parsed = parseHouseholdIdentity(view({ people: [] }))
    expect(parsed).toEqual({ householdId: HH, myPersonId: null, myProfileName: null, people: [] })
  })

  it('treats malformed people as unconfigured instead of crashing', () => {
    for (const people of [
      'not-an-array',
      [{ id: PA, slot: 'a', display_name: 'Alex' }], // only one person
      [{ id: PA, slot: 'a', display_name: 'Alex' }, { id: PB, slot: 'a', display_name: 'Sam' }], // duplicate slot
      [{ id: PA, slot: 'a', display_name: 'Alex' }, { id: PA, slot: 'b', display_name: 'Sam' }], // duplicate id
      [{ id: PA, slot: 'a', display_name: 'Alex' }, { id: 'bad', slot: 'b', display_name: 'Sam' }],
      [{ id: PA, slot: 'a', display_name: 'Alex' }, null],
    ]) {
      const parsed = parseHouseholdIdentity(view({ people, my_person_id: PA }))
      expect(parsed).toEqual({ householdId: HH, myPersonId: null, myProfileName: null, people: [] })
    }
  })

  it('nulls a my_person_id that does not reference a known person', () => {
    expect(parseHouseholdIdentity(view({ my_person_id: '33333333-3333-4333-8333-333333333333' }))?.myPersonId).toBeNull()
    expect(parseHouseholdIdentity(view({ my_person_id: 42 }))?.myPersonId).toBeNull()
  })
})

describe('myToolSlot', () => {
  it('returns the slot of the signed-in account, for any tool (position mapping)', () => {
    expect(myToolSlot(parseHouseholdIdentity(view({ my_person_id: PA })), 'bolanekoll')).toBe('a')
    expect(myToolSlot(parseHouseholdIdentity(view({ my_person_id: PB })), 'hushallsbudget')).toBe('b')
  })

  it('never guesses: unmapped account or missing identity give null', () => {
    expect(myToolSlot(parseHouseholdIdentity(view({ my_person_id: null })), 'bolanekoll')).toBeNull()
    expect(myToolSlot(null, 'bolanekoll')).toBeNull()
    expect(myToolSlot(parseHouseholdIdentity(view({ people: [], my_person_id: PA })), 'bolanekoll')).toBeNull()
  })
})

describe('fetchHouseholdIdentity', () => {
  it('returns the parsed view on success and null for no household', async () => {
    mock().control.rpcHandlers.household_identity = () => view()
    expect((await fetchHouseholdIdentity())?.householdId).toBe(HH)
    mock().control.rpcHandlers.household_identity = () => null
    expect(await fetchHouseholdIdentity()).toBeNull()
  })

  it('throws a user-worded error on RPC failure', async () => {
    mock().control.failing.add('household_identity')
    await expect(fetchHouseholdIdentity()).rejects.toMatchObject({
      message: 'Kunde inte spara ändringen. Försök igen.',
    })
  })
})

describe('refreshHouseholdIdentity (scoped snapshot + raw-envelope cache)', () => {
  it('publishes the server view and caches the raw envelope on success', async () => {
    mock().control.rpcHandlers.household_identity = () => view({ my_person_id: PA })
    await refreshHouseholdIdentity()
    const snapshot = getHouseholdIdentitySnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.identity?.myPersonId).toBe(PA)
    const cached = syncCoordinator.readScoped('household_identity_cache_v1')
    expect(JSON.parse(cached as string)).toEqual(view({ my_person_id: PA }))
  })

  it('keeps the prior identity with status error when the refresh fails', async () => {
    mock().control.rpcHandlers.household_identity = () => view({ my_person_id: PA })
    await refreshHouseholdIdentity()
    mock().control.failing.add('household_identity')
    await refreshHouseholdIdentity()
    const snapshot = getHouseholdIdentitySnapshot()
    expect(snapshot.status).toBe('error')
    expect(snapshot.identity?.myPersonId).toBe(PA)
  })

  it('never returns another account/household scope and never reads its cache', async () => {
    mock().control.rpcHandlers.household_identity = () => view({ my_person_id: PA })
    await refreshHouseholdIdentity()
    expect(getHouseholdIdentitySnapshot().status).toBe('ready')

    activateSyncIdentity({ userId: 'user-x', householdId: 'house-x' })
    expect(getHouseholdIdentitySnapshot()).toEqual({ status: 'idle', identity: null })
    mock().control.failing.add('household_identity')
    await refreshHouseholdIdentity()
    const snapshot = getHouseholdIdentitySnapshot()
    expect(snapshot.status).toBe('error')
    expect(snapshot.identity).toBeNull()
  })

  it('discards a response that lands after a scope switch', async () => {
    activateSyncIdentity({ userId: 'user-a', householdId: 'house-a' })
    mock().control.rpcHandlers.household_identity = () => {
      activateSyncIdentity({ userId: 'user-b', householdId: 'house-b' })
      return view({ my_person_id: PA })
    }
    await refreshHouseholdIdentity()
    expect(getHouseholdIdentitySnapshot()).toEqual({ status: 'idle', identity: null })
  })
})

describe('assignHouseholdPeople', () => {
  it('sends the two emails (blank → null), updates the snapshot and returns it', async () => {
    let args: Record<string, unknown> | undefined
    mock().control.rpcHandlers.assign_household_people = (raw) => {
      args = raw as Record<string, unknown>
      return view({ my_person_id: PA })
    }
    const result = await assignHouseholdPeople(' alex@x.se ', '')
    expect(args).toEqual({ p_slot_a_email: 'alex@x.se', p_slot_b_email: null })
    expect(result?.myPersonId).toBe(PA)
    expect(getHouseholdIdentitySnapshot()).toEqual({ status: 'ready', identity: result })
  })

  it('maps stable rule errors to Swedish and leaves prior state intact', async () => {
    mock().control.rpcHandlers.household_identity = () => view()
    await refreshHouseholdIdentity()
    const before = getHouseholdIdentitySnapshot()

    mock().control.failing.add('assign_household_people')
    mock().control.errors.assign_household_people = { message: 'duplicate person email', code: 'P0001' }
    await expect(assignHouseholdPeople('alex@x.se', 'alex@x.se'))
      .rejects.toMatchObject({ message: 'Person A och Person B kan inte vara samma konto.' })
    expect(getHouseholdIdentitySnapshot()).toEqual(before)
  })

  it('maps an unknown-email rejection to Swedish', async () => {
    mock().control.failing.add('assign_household_people')
    mock().control.errors.assign_household_people = { message: 'unknown person email', code: 'P0001' }
    await expect(assignHouseholdPeople('stranger@x.se', null))
      .rejects.toMatchObject({ message: 'E-postadressen tillhör inte hushållet.' })
  })
})

describe('setMyProfileName', () => {
  it('sends the trimmed name, or null when blank', async () => {
    const calls: unknown[] = []
    mock().control.rpcHandlers.set_my_profile_name = (args) => { calls.push(args); return null }
    await setMyProfileName('  Alan  ')
    await setMyProfileName('   ')
    expect(calls).toEqual([{ p_name: 'Alan' }, { p_name: null }])
  })

  it('maps an invalid profile name to Swedish', async () => {
    mock().control.failing.add('set_my_profile_name')
    mock().control.errors.set_my_profile_name = { message: 'invalid profile name', code: 'P0001' }
    await expect(setMyProfileName('x'.repeat(61)))
      .rejects.toMatchObject({ message: 'Namnet får vara högst 60 tecken.' })
  })
})

describe('identityErrorMessage', () => {
  it('keeps rule messages and falls back to the persistence contract', async () => {
    mock().control.failing.add('assign_household_people')
    mock().control.errors.assign_household_people = { message: 'unknown person email', code: 'P0001' }
    const ruleError = await assignHouseholdPeople('x@x.se', null).catch((e: unknown) => e)
    expect(identityErrorMessage(ruleError)).toBe('E-postadressen tillhör inte hushållet.')
    expect(identityErrorMessage(new TypeError('Failed to fetch')))
      .toBe('Ingen anslutning. Ändringen sparades inte i molnet.')
  })
})
