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

describe('emailMaySignIn', () => {
  it('trims and lowercases the address before calling the RPC', async () => {
    let receivedArgs: unknown = null
    mock().control.rpcHandlers.email_may_sign_in = (args) => { receivedArgs = args; return true }
    expect(await store.emailMaySignIn('  Foo@Example.com  ')).toBe(true)
    expect(receivedArgs).toEqual({ addr: 'foo@example.com' })
  })

  it('fails closed to false on an RPC error (strangers cannot sign up)', async () => {
    mock().control.failing.add('email_may_sign_in')
    expect(await store.emailMaySignIn('foo@example.com')).toBe(false)
  })

  it('fails closed to false when the RPC returns anything but true', async () => {
    mock().control.rpcHandlers.email_may_sign_in = () => null
    expect(await store.emailMaySignIn('foo@example.com')).toBe(false)
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
