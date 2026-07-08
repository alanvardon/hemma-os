import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSupabaseMock } from './testSupabaseMock'

// See mortgage-store.test.ts for why this shape (vi.hoisted holder + a fresh
// module import + manual mock-state clearing) is needed every test. household.ts
// has no localStorage cache — every helper is fail-closed on error instead.
const holder = vi.hoisted(() => ({ current: undefined as unknown as ReturnType<typeof createSupabaseMock> }))
vi.mock('./supabase', () => {
  holder.current = createSupabaseMock()
  return { supabase: holder.current.supabase }
})
const mock = () => holder.current

let store: typeof import('./household')
beforeEach(async () => {
  vi.resetModules()
  store = await import('./household')
  Object.keys(mock().tables).forEach((k) => delete mock().tables[k])
  mock().control.fail = false
  mock().control.failing.clear()
  mock().control.rpcHandlers = {}
  mock().control.user = null
})

describe('claimHousehold', () => {
  it('resolves the household id from the RPC', async () => {
    mock().control.rpcHandlers.claim_household = () => 'household-123'
    expect(await store.claimHousehold()).toBe('household-123')
  })

  it('fails closed to null on an RPC error', async () => {
    mock().control.failing.add('claim_household')
    expect(await store.claimHousehold()).toBeNull()
  })
})

describe('listMembers', () => {
  it('resolves the roster from the RPC', async () => {
    const roster = [{ user_id: 'u1', role: 'owner', email: 'a@x.com' }]
    mock().control.rpcHandlers.household_roster = () => roster
    expect(await store.listMembers()).toEqual(roster)
  })

  it('fails closed to an empty list on an RPC error', async () => {
    mock().control.failing.add('household_roster')
    expect(await store.listMembers()).toEqual([])
  })
})

describe('listInvites', () => {
  it('lists pending invites ordered by created_at', async () => {
    mock().tables.household_invites = [
      { email: 'b@x.com', created_at: '2024-02-01' },
      { email: 'a@x.com', created_at: '2024-01-01' },
    ]
    const invites = await store.listInvites()
    expect(invites.map((i) => i.email)).toEqual(['a@x.com', 'b@x.com'])
  })

  it('fails closed to an empty list on a cloud error', async () => {
    mock().control.failing.add('household_invites')
    expect(await store.listInvites()).toEqual([])
  })
})

describe('createInvite / removeInvite', () => {
  it('createInvite: success returns null (no error)', async () => {
    expect(await store.createInvite('New@Example.com')).toBeNull()
    expect(mock().tables.household_invites[0].email).toBe('new@example.com')
  })

  it('createInvite: cloud error returns the error message (does not throw)', async () => {
    mock().control.failing.add('household_invites')
    expect(await store.createInvite('new@example.com')).toBe('mock: household_invites insert failed')
  })

  it('removeInvite: success returns null', async () => {
    mock().tables.household_invites = [{ email: 'a@x.com' }]
    expect(await store.removeInvite('a@x.com')).toBeNull()
    expect(mock().tables.household_invites).toHaveLength(0)
  })

  it('removeInvite: cloud error returns the error message', async () => {
    mock().control.failing.add('household_invites')
    expect(await store.removeInvite('a@x.com')).toBe('mock: household_invites delete failed')
  })
})

describe('pendingInviteToJoin', () => {
  it('true when an invite to my email is for a household I am NOT in', async () => {
    mock().control.user = { id: 'me', email: 'Me@Example.com' }
    mock().tables.households = [{ id: 'hh-mine' }]
    mock().tables.household_invites = [{ household_id: 'hh-other', email: 'me@example.com' }]
    expect(await store.pendingInviteToJoin()).toBe(true)
  })

  it('false when the only invite to my email is for the household I am already in', async () => {
    mock().control.user = { id: 'me', email: 'me@example.com' }
    mock().tables.households = [{ id: 'hh-mine' }]
    mock().tables.household_invites = [{ household_id: 'hh-mine', email: 'me@example.com' }]
    expect(await store.pendingInviteToJoin()).toBe(false)
  })

  it('matches the invite email case-insensitively', async () => {
    mock().control.user = { id: 'me', email: 'me@example.com' }
    mock().tables.households = [{ id: 'hh-mine' }]
    mock().tables.household_invites = [{ household_id: 'hh-other', email: 'ME@Example.com' }]
    expect(await store.pendingInviteToJoin()).toBe(true)
  })

  it('false when there is no invite to my email', async () => {
    mock().control.user = { id: 'me', email: 'me@example.com' }
    mock().tables.households = [{ id: 'hh-mine' }]
    mock().tables.household_invites = [{ household_id: 'hh-other', email: 'someone@else.com' }]
    expect(await store.pendingInviteToJoin()).toBe(false)
  })

  it('false when signed out (no email)', async () => {
    mock().control.user = null
    expect(await store.pendingInviteToJoin()).toBe(false)
  })

  it('fails closed to false on a cloud error', async () => {
    mock().control.user = { id: 'me', email: 'me@example.com' }
    mock().control.failing.add('household_invites')
    expect(await store.pendingInviteToJoin()).toBe(false)
  })
})

describe('acceptInvite', () => {
  it('success returns null (no error)', async () => {
    expect(await store.acceptInvite()).toBeNull()
  })

  it('cloud error returns the error message (does not throw)', async () => {
    mock().control.failing.add('accept_invite')
    expect(await store.acceptInvite()).toBe('mock: rpc accept_invite failed')
  })
})

describe('leaveHousehold', () => {
  it('success returns null (no error)', async () => {
    expect(await store.leaveHousehold()).toBeNull()
  })

  it('cloud error returns the error message (does not throw)', async () => {
    mock().control.failing.add('leave_household')
    expect(await store.leaveHousehold()).toBe('mock: rpc leave_household failed')
  })
})
