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

  it('rejects through the persistence contract on an RPC error', async () => {
    mock().control.failing.add('claim_household')
    await expect(store.claimHousehold()).rejects.toMatchObject({
      category: 'unknown',
      message: 'Kunde inte spara ändringen. Försök igen.',
    })
  })

  it('rejects when the RPC resolves without a household id', async () => {
    await expect(store.claimHousehold()).rejects.toMatchObject({ category: 'unknown' })
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
  it('createInvite: resolves on success', async () => {
    await expect(store.createInvite('New@Example.com')).resolves.toBeUndefined()
    expect(mock().tables.household_invites[0].email).toBe('new@example.com')
  })

  it('createInvite: cloud error rejects without exposing the backend message', async () => {
    mock().control.failing.add('household_invites')
    await expect(store.createInvite('new@example.com')).rejects.toMatchObject({
      category: 'unknown',
      message: 'Kunde inte spara ändringen. Försök igen.',
    })
  })

  it('removeInvite: resolves on success', async () => {
    mock().tables.household_invites = [{ email: 'a@x.com' }]
    await expect(store.removeInvite('a@x.com')).resolves.toBeUndefined()
    expect(mock().tables.household_invites).toHaveLength(0)
  })

  it('removeInvite: cloud error rejects explicitly', async () => {
    mock().control.failing.add('household_invites')
    await expect(store.removeInvite('a@x.com')).rejects.toMatchObject({ category: 'unknown' })
  })
})

describe('pendingInviteStatus', () => {
  it('single when exactly one other household invited me', async () => {
    mock().control.user = { id: 'me', email: 'Me@Example.com' }
    mock().tables.households = [{ id: 'hh-mine' }]
    mock().tables.household_invites = [{ household_id: 'hh-other', email: 'me@example.com' }]
    expect(await store.pendingInviteStatus()).toBe('single')
  })

  it('false when the only invite to my email is for the household I am already in', async () => {
    mock().control.user = { id: 'me', email: 'me@example.com' }
    mock().tables.households = [{ id: 'hh-mine' }]
    mock().tables.household_invites = [{ household_id: 'hh-mine', email: 'me@example.com' }]
    expect(await store.pendingInviteStatus()).toBe('none')
  })

  it('matches the invite email case-insensitively', async () => {
    mock().control.user = { id: 'me', email: 'me@example.com' }
    mock().tables.households = [{ id: 'hh-mine' }]
    mock().tables.household_invites = [{ household_id: 'hh-other', email: 'ME@Example.com' }]
    expect(await store.pendingInviteStatus()).toBe('single')
  })

  it('false when there is no invite to my email', async () => {
    mock().control.user = { id: 'me', email: 'me@example.com' }
    mock().tables.households = [{ id: 'hh-mine' }]
    mock().tables.household_invites = [{ household_id: 'hh-other', email: 'someone@else.com' }]
    expect(await store.pendingInviteStatus()).toBe('none')
  })

  it('false when signed out (no email)', async () => {
    mock().control.user = null
    expect(await store.pendingInviteStatus()).toBe('none')
  })

  it('fails closed to false on a cloud error', async () => {
    mock().control.user = { id: 'me', email: 'me@example.com' }
    mock().control.failing.add('household_invites')
    expect(await store.pendingInviteStatus()).toBe('none')
  })

  it('ambiguous when multiple households have active invites for me', async () => {
    mock().control.user = { id: 'me', email: 'me@example.com' }
    mock().tables.households = [{ id: 'hh-mine' }]
    mock().tables.household_invites = [
      { household_id: 'hh-other-a', email: 'me@example.com' },
      { household_id: 'hh-other-b', email: 'me@example.com' },
    ]
    expect(await store.pendingInviteStatus()).toBe('ambiguous')
  })

  it('ambiguous when a stale same-household invite exists beside another invite', async () => {
    mock().control.user = { id: 'me', email: 'me@example.com' }
    mock().tables.households = [{ id: 'hh-mine' }]
    mock().tables.household_invites = [
      { household_id: 'hh-mine', email: 'me@example.com' },
      { household_id: 'hh-other', email: 'me@example.com' },
    ]
    expect(await store.pendingInviteStatus()).toBe('ambiguous')
  })
})

describe('acceptInvite', () => {
  it('resolves on success', async () => {
    await expect(store.acceptInvite()).resolves.toBeUndefined()
  })

  it('cloud error rejects explicitly', async () => {
    mock().control.failing.add('accept_invite')
    await expect(store.acceptInvite()).rejects.toMatchObject({ category: 'unknown' })
  })
})

describe('leaveHousehold', () => {
  it('resolves on success', async () => {
    await expect(store.leaveHousehold()).resolves.toBeUndefined()
  })

  it('cloud error rejects explicitly', async () => {
    mock().control.failing.add('leave_household')
    await expect(store.leaveHousehold()).rejects.toMatchObject({ category: 'unknown' })
  })
})

describe('signOut', () => {
  it('resolves on success', async () => {
    await expect(store.signOut()).resolves.toBeUndefined()
  })

  it('rejects explicitly on an auth error', async () => {
    mock().control.failing.add('signOut')
    await expect(store.signOut()).rejects.toMatchObject({ category: 'unknown' })
  })
})
