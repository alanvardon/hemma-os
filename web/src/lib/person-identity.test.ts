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
  claimHouseholdPersonByEmail,
  configureHouseholdPeople,
  fetchHouseholdIdentity,
  getHouseholdIdentitySnapshot,
  identityErrorMessage,
  myToolSlot,
  parseHouseholdIdentity,
  refreshHouseholdIdentity,
  setMyHouseholdPerson,
} from './person-identity'
import { activateSyncIdentity, syncCoordinator } from './sync'

const HH = '00000000-aaaa-4aaa-8aaa-000000000001'
const PA = '11111111-1111-4111-8111-111111111111'
const PB = '22222222-2222-4222-8222-222222222222'

const view = (overrides: Record<string, unknown> = {}) => ({
  household_id: HH,
  my_person_id: null,
  people: [
    { id: PA, slot: 'a', display_name: 'Alex' },
    { id: PB, slot: 'b', display_name: 'Sam' },
  ],
  bindings: { bolanekoll: { a: PA, b: PB } },
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
      people: [
        { id: PB, slot: 'b', display_name: 'Sam' },
        { id: PA, slot: 'a', display_name: 'Alex' },
      ],
    }))
    expect(parsed).toEqual({
      householdId: HH,
      myPersonId: PB,
      people: [
        { id: PA, slot: 'a', login_email: null, display_name: 'Alex' },
        { id: PB, slot: 'b', login_email: null, display_name: 'Sam' },
      ],
      bindings: { bolanekoll: { a: PA, b: PB } },
    })
  })

  it('parses login_email (value / null / malformed → null)', () => {
    const parsed = parseHouseholdIdentity(view({
      people: [
        { id: PA, slot: 'a', display_name: 'Alex', login_email: 'ALEX@Example.SE' },
        { id: PB, slot: 'b', display_name: 'Sam', login_email: 'not-an-email' },
      ],
    }))
    // A value is normalized to lowercase; a malformed address is dropped to null.
    expect(parsed?.people[0].login_email).toBe('alex@example.se')
    expect(parsed?.people[1].login_email).toBeNull()
    // A missing key is null.
    expect(parseHouseholdIdentity(view())?.people[0].login_email).toBeNull()
  })

  it('returns null for SQL NULL and unusable envelopes', () => {
    expect(parseHouseholdIdentity(null)).toBeNull()
    expect(parseHouseholdIdentity(undefined)).toBeNull()
    expect(parseHouseholdIdentity('nope')).toBeNull()
    expect(parseHouseholdIdentity([])).toBeNull()
    expect(parseHouseholdIdentity({ household_id: 'not-a-uuid' })).toBeNull()
  })

  it('parses an unconfigured household (empty people, no bindings)', () => {
    const parsed = parseHouseholdIdentity(view({ people: [], bindings: {} }))
    expect(parsed).toEqual({ householdId: HH, myPersonId: null, people: [], bindings: {} })
  })

  it('treats malformed people as unconfigured instead of crashing', () => {
    for (const people of [
      'not-an-array',
      [{ id: PA, slot: 'a', display_name: 'Alex' }], // only one person
      [{ id: PA, slot: 'a', display_name: 'Alex' }, { id: PB, slot: 'a', display_name: 'Sam' }], // duplicate slot
      [{ id: PA, slot: 'a', display_name: 'Alex' }, { id: PA, slot: 'b', display_name: 'Sam' }], // duplicate id
      [{ id: PA, slot: 'a', display_name: 'Alex' }, { id: 'bad', slot: 'b', display_name: 'Sam' }],
      [{ id: PA, slot: 'a', display_name: 'Alex' }, { id: PB, slot: 'b', display_name: '  ' }],
      [{ id: PA, slot: 'a', display_name: 'Alex' }, null],
    ]) {
      const parsed = parseHouseholdIdentity(view({ people, my_person_id: PA }))
      expect(parsed).toEqual({ householdId: HH, myPersonId: null, people: [], bindings: {} })
    }
  })

  it('nulls a my_person_id that does not reference a known person', () => {
    expect(parseHouseholdIdentity(view({ my_person_id: '33333333-3333-4333-8333-333333333333' }))?.myPersonId).toBeNull()
    expect(parseHouseholdIdentity(view({ my_person_id: 42 }))?.myPersonId).toBeNull()
  })

  it('drops malformed binding entries individually and keeps valid ones', () => {
    const parsed = parseHouseholdIdentity(view({
      bindings: {
        bolanekoll: { a: PA, b: PB },
        hushallsbudget: { a: PA, b: PA }, // duplicate person
        manadsavslut: { a: PA }, // incomplete
        unknown_tool: { a: PA, b: PB }, // not a known tool
      },
    }))
    expect(parsed?.bindings).toEqual({ bolanekoll: { a: PA, b: PB } })
  })

  it('drops bindings referencing unknown people and non-object bindings', () => {
    expect(parseHouseholdIdentity(view({
      bindings: { bolanekoll: { a: PA, b: '44444444-4444-4444-8444-444444444444' } },
    }))?.bindings).toEqual({})
    expect(parseHouseholdIdentity(view({ bindings: 'oops' }))?.bindings).toEqual({})
    expect(parseHouseholdIdentity(view({ bindings: null }))?.bindings).toEqual({})
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
    expect(cached).not.toBeNull()
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

  it('seeds a fresh scope from its own cache when offline', async () => {
    mock().control.rpcHandlers.household_identity = () => view({ my_person_id: PA })
    await refreshHouseholdIdentity()
    // Same user+household activated again (e.g. reload): cache serves offline.
    activateSyncIdentity({ userId: 'other', householdId: 'elsewhere' })
    activateSyncIdentity({ userId: `user-${sequence}`, householdId: `house-${sequence}` })
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

    // Switch account: previous identity must not flash — and a failing refresh
    // must not fall back to the previous scope's cache.
    activateSyncIdentity({ userId: 'user-x', householdId: 'house-x' })
    expect(getHouseholdIdentitySnapshot()).toEqual({ status: 'idle', identity: null })
    mock().control.failing.add('household_identity')
    await refreshHouseholdIdentity()
    const snapshot = getHouseholdIdentitySnapshot()
    expect(snapshot.status).toBe('error')
    expect(snapshot.identity).toBeNull()
  })

  it('returns idle when signed out and discards a response that lands after a scope switch', async () => {
    syncCoordinator.quarantineActive()
    expect(getHouseholdIdentitySnapshot()).toEqual({ status: 'idle', identity: null })
    await refreshHouseholdIdentity() // no-op without an active scope

    activateSyncIdentity({ userId: 'user-a', householdId: 'house-a' })
    mock().control.rpcHandlers.household_identity = () => {
      // The scope changes while the request is in flight.
      activateSyncIdentity({ userId: 'user-b', householdId: 'house-b' })
      return view({ my_person_id: PA })
    }
    await refreshHouseholdIdentity()
    expect(getHouseholdIdentitySnapshot()).toEqual({ status: 'idle', identity: null })
  })
})

describe('claimHouseholdPersonByEmail + claim-first load path', () => {
  it('returns the identity the claim RPC resolves (caller mapped by email)', async () => {
    let called = 0
    mock().control.rpcHandlers.claim_my_household_person_by_email = () => { called += 1; return view({ my_person_id: PA }) }
    const claimed = await claimHouseholdPersonByEmail()
    expect(called).toBe(1)
    expect(claimed?.myPersonId).toBe(PA)
  })

  it('tolerates a non-match / failure without throwing (resolves null)', async () => {
    mock().control.failing.add('claim_my_household_person_by_email')
    await expect(claimHouseholdPersonByEmail()).resolves.toBeNull()
  })

  it('the load path calls claim FIRST and reflects its identity (auto-claim)', async () => {
    let claimCalls = 0
    let identityCalls = 0
    // Claim both maps AND returns the identity, so household_identity is never
    // needed when claim succeeds.
    mock().control.rpcHandlers.claim_my_household_person_by_email = () => { claimCalls += 1; return view({ my_person_id: PB }) }
    mock().control.rpcHandlers.household_identity = () => { identityCalls += 1; return view() }
    await refreshHouseholdIdentity()
    const snapshot = getHouseholdIdentitySnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.identity?.myPersonId).toBe(PB)
    expect(claimCalls).toBe(1)
    expect(identityCalls).toBe(0)
  })

  it('is a no-op when the caller is already mapped (claim returns the same view)', async () => {
    mock().control.rpcHandlers.claim_my_household_person_by_email = () => view({ my_person_id: PA })
    await refreshHouseholdIdentity()
    expect(getHouseholdIdentitySnapshot().identity?.myPersonId).toBe(PA)
    // A second load keeps the same mapping — claim never overrides it.
    await refreshHouseholdIdentity()
    expect(getHouseholdIdentitySnapshot().identity?.myPersonId).toBe(PA)
  })

  it('discards a claim response that lands after a scope switch (no cross-account leak)', async () => {
    activateSyncIdentity({ userId: 'user-a', householdId: 'house-a' })
    mock().control.rpcHandlers.claim_my_household_person_by_email = () => {
      activateSyncIdentity({ userId: 'user-b', householdId: 'house-b' })
      return view({ my_person_id: PA })
    }
    await refreshHouseholdIdentity()
    expect(getHouseholdIdentitySnapshot()).toEqual({ status: 'idle', identity: null })
  })

  it('falls back to household_identity when claim is unavailable', async () => {
    mock().control.failing.add('claim_my_household_person_by_email')
    mock().control.rpcHandlers.household_identity = () => view({ my_person_id: PB })
    await refreshHouseholdIdentity()
    expect(getHouseholdIdentitySnapshot().identity?.myPersonId).toBe(PB)
  })
})

describe('configureHouseholdPeople', () => {
  it('sends trimmed names, updates the snapshot from the server view and returns it', async () => {
    let args: Record<string, unknown> | undefined
    mock().control.rpcHandlers.configure_household_people = (raw) => {
      args = raw as Record<string, unknown>
      return view()
    }
    const result = await configureHouseholdPeople({
      personAName: ' Alex ', personBName: 'Sam',
      tool: 'bolanekoll', toolSlotAPerson: 'a', toolSlotBPerson: 'b',
    })
    expect(args).toEqual({
      p_person_a_name: 'Alex', p_person_b_name: 'Sam',
      p_person_a_email: null, p_person_b_email: null,
      p_tool: 'bolanekoll', p_tool_slot_a_person: 'a', p_tool_slot_b_person: 'b',
    })
    expect(result?.people).toHaveLength(2)
    expect(getHouseholdIdentitySnapshot()).toEqual({ status: 'ready', identity: result })
  })

  it('passes nulls for a people-only configure call', async () => {
    let args: Record<string, unknown> | undefined
    mock().control.rpcHandlers.configure_household_people = (raw) => {
      args = raw as Record<string, unknown>
      return view({ bindings: {} })
    }
    await configureHouseholdPeople({ personAName: 'Alex', personBName: 'Sam' })
    expect(args).toEqual({
      p_person_a_name: 'Alex', p_person_b_name: 'Sam',
      p_person_a_email: null, p_person_b_email: null,
      p_tool: null, p_tool_slot_a_person: null, p_tool_slot_b_person: null,
    })
  })

  it('sends the two login emails in their param positions (empty → null)', async () => {
    let args: Record<string, unknown> | undefined
    mock().control.rpcHandlers.configure_household_people = (raw) => {
      args = raw as Record<string, unknown>
      return view()
    }
    await configureHouseholdPeople({
      personAName: 'Alex', personBName: 'Sam',
      personAEmail: '  Alex@Example.se ', personBEmail: '  ',
    })
    expect(args).toMatchObject({ p_person_a_email: 'Alex@Example.se', p_person_b_email: null })
  })

  it('maps stable rule errors to Swedish and leaves prior state intact', async () => {
    mock().control.rpcHandlers.household_identity = () => view()
    await refreshHouseholdIdentity()
    const before = getHouseholdIdentitySnapshot()

    mock().control.failing.add('configure_household_people')
    mock().control.errors.configure_household_people = { message: 'duplicate tool binding', code: 'P0001' }
    await expect(configureHouseholdPeople({ personAName: 'Alex', personBName: 'Alex' }))
      .rejects.toMatchObject({ message: 'Samma person kan inte ha båda platserna i ett verktyg.' })
    expect(getHouseholdIdentitySnapshot()).toEqual(before)
    expect(syncCoordinator.readScoped('household_identity_cache_v1')).toEqual(
      JSON.stringify(view()),
    )
  })
})

describe('setMyHouseholdPerson', () => {
  it('resolves on success and passes the person id (or null to clear)', async () => {
    const calls: unknown[] = []
    mock().control.rpcHandlers.set_my_household_person = (args) => { calls.push(args); return null }
    await setMyHouseholdPerson(PA)
    await setMyHouseholdPerson(null)
    expect(calls).toEqual([{ p_person_id: PA }, { p_person_id: null }])
  })

  it('maps "person already claimed" to Swedish', async () => {
    mock().control.failing.add('set_my_household_person')
    mock().control.errors.set_my_household_person = { message: 'person already claimed', code: 'P0001' }
    await expect(setMyHouseholdPerson(PA)).rejects.toMatchObject({
      message: 'Personen är redan vald av en annan medlem.',
    })
  })
})

describe('identityErrorMessage', () => {
  it('keeps rule messages and falls back to the persistence contract', async () => {
    mock().control.failing.add('set_my_household_person')
    mock().control.errors.set_my_household_person = { message: 'person not in household', code: 'P0001' }
    const ruleError = await setMyHouseholdPerson(PA).catch((e: unknown) => e)
    expect(identityErrorMessage(ruleError)).toBe('Personen finns inte i hushållet. Ladda om och försök igen.')
    expect(identityErrorMessage(new TypeError('Failed to fetch')))
      .toBe('Ingen anslutning. Ändringen sparades inte i molnet.')
  })
})

// ── myToolSlot — view perspective for Bolånekoll and friends (plan 111 St 3) ─

describe('myToolSlot', () => {
  it('returns the slot whose bound person is the signed-in account', () => {
    // The household creator mapped to person A (bolanekoll binding a→PA).
    expect(myToolSlot(parseHouseholdIdentity(view({ my_person_id: PA })), 'bolanekoll')).toBe('a')
    // An invited partner mapped to the OTHER person sees slot b — same data.
    expect(myToolSlot(parseHouseholdIdentity(view({ my_person_id: PB })), 'bolanekoll')).toBe('b')
  })

  it('follows the binding, not the canonical slot, when a tool is bound reversed', () => {
    const reversed = parseHouseholdIdentity(view({
      my_person_id: PA,
      bindings: { bolanekoll: { a: PB, b: PA } },
    }))
    expect(myToolSlot(reversed, 'bolanekoll')).toBe('b')
  })

  it('never guesses: unmapped account, unbound tool or missing identity give null', () => {
    // Unmapped account (legacy fallback: the tool keeps its i_am perspective).
    expect(myToolSlot(parseHouseholdIdentity(view({ my_person_id: null })), 'bolanekoll')).toBeNull()
    // Tool without a binding.
    expect(myToolSlot(parseHouseholdIdentity(view({ my_person_id: PA })), 'manadsavslut')).toBeNull()
    expect(myToolSlot(parseHouseholdIdentity(view({ my_person_id: PA, bindings: {} })), 'bolanekoll')).toBeNull()
    // No identity at all (signed out / load failed).
    expect(myToolSlot(null, 'bolanekoll')).toBeNull()
    // Unconfigured household (malformed people ⇒ no bindings survive parsing).
    expect(myToolSlot(parseHouseholdIdentity(view({ people: [], my_person_id: PA })), 'bolanekoll')).toBeNull()
  })
})
