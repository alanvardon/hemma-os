// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import HouseholdMenu from './HouseholdMenu'
import { acceptInvite, pendingInviteStatus, signOut } from '../lib/household'
import { activateSyncIdentity, syncCoordinator } from '../lib/sync'
import { LEGACY_QUARANTINE_KEY } from '../lib/legacy-data'

vi.mock('./AnimatedDialog', () => ({
  default: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div>{children}</div> : null,
}))

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: { getUser: vi.fn(async () => ({ data: { user: { email: 'me@example.com' } } })) },
    // household_identity resolves to SQL NULL (no household) so the people
    // section renders nothing in these lifecycle-focused tests.
    rpc: vi.fn(async () => ({ data: null, error: null })),
  },
}))

vi.mock('../lib/household', () => ({
  acceptInvite: vi.fn(),
  createInvite: vi.fn(),
  leaveHousehold: vi.fn(),
  listInvites: vi.fn(async () => []),
  listMembers: vi.fn(async () => []),
  pendingInviteStatus: vi.fn(),
  removeInvite: vi.fn(),
  signOut: vi.fn(),
}))

beforeEach(() => {
  localStorage.clear()
  activateSyncIdentity({ userId: 'user-1', householdId: 'house-1' })
  vi.mocked(pendingInviteStatus).mockReset()
  vi.mocked(pendingInviteStatus).mockResolvedValue('none')
  vi.mocked(acceptInvite).mockReset()
  vi.mocked(signOut).mockReset().mockResolvedValue()
})

describe('HouseholdMenu sign out data choices', () => {
  it('cancels without signing out or changing local data', async () => {
    syncCoordinator.writeScoped('cache', 'keep')
    const user = userEvent.setup()
    render(<HouseholdMenu />)
    await user.click(screen.getByRole('button', { name: 'Hushåll' }))
    await user.click(await screen.findByRole('button', { name: 'Logga ut' }))
    await user.click(screen.getByRole('button', { name: 'Avbryt' }))
    expect(signOut).not.toHaveBeenCalled()
    expect(syncCoordinator.readScoped('cache')).toBe('keep')
  })

  it('preserves the snapshotted namespace when sign out succeeds', async () => {
    syncCoordinator.writeScoped('cache', 'keep')
    const key = syncCoordinator.scopedStorageKey('cache')
    const user = userEvent.setup()
    render(<HouseholdMenu />)
    await user.click(screen.getByRole('button', { name: 'Hushåll' }))
    await user.click(await screen.findByRole('button', { name: 'Logga ut' }))
    await user.click(screen.getByRole('button', { name: 'Behåll på enheten och logga ut' }))
    expect(signOut).toHaveBeenCalledOnce()
    expect(localStorage.getItem(key)).toBe('keep')
    activateSyncIdentity({ userId: 'user-2', householdId: 'house-2' })
    expect(syncCoordinator.getActiveIdentity()).toEqual({ userId: 'user-2', householdId: 'house-2' })
  })

  it('removes all namespaces for the signed-out user and leaves other users and legacy quarantine', async () => {
    activateSyncIdentity({ userId: 'user-1', householdId: 'old-house' })
    syncCoordinator.writeScoped('cache', 'old-remove')
    const oldKey = syncCoordinator.scopedStorageKey('cache')
    activateSyncIdentity({ userId: 'other-user', householdId: 'other-house' })
    syncCoordinator.writeScoped('cache', 'other-keep')
    const otherKey = syncCoordinator.scopedStorageKey('cache')
    activateSyncIdentity({ userId: 'user-1', householdId: 'house-1' })
    syncCoordinator.writeScoped('cache', 'remove')
    const key = syncCoordinator.scopedStorageKey('cache')
    localStorage.setItem(LEGACY_QUARANTINE_KEY, JSON.stringify({ version: 1, capturedAt: 'now', entries: { old: 'data' } }))
    const user = userEvent.setup()
    render(<HouseholdMenu />)
    await user.click(screen.getByRole('button', { name: 'Hushåll' }))
    await user.click(await screen.findByRole('button', { name: 'Logga ut' }))
    await user.click(screen.getByRole('button', { name: 'Ta bort från enheten och logga ut' }))
    expect(localStorage.getItem(key)).toBe('remove')
    await user.click(screen.getByRole('button', { name: 'Bekräfta och logga ut' }))
    expect(localStorage.getItem(key)).toBeNull()
    expect(localStorage.getItem(oldKey)).toBeNull()
    expect(localStorage.getItem(otherKey)).toBe('other-keep')
    expect(localStorage.getItem(LEGACY_QUARANTINE_KEY)).not.toBeNull()
  })

  it('restores sync identity and all local data when sign out fails', async () => {
    syncCoordinator.writeScoped('cache', 'keep')
    vi.mocked(signOut).mockRejectedValue(new TypeError('Failed to fetch'))
    const user = userEvent.setup()
    render(<HouseholdMenu />)
    await user.click(screen.getByRole('button', { name: 'Hushåll' }))
    await user.click(await screen.findByRole('button', { name: 'Logga ut' }))
    await user.click(screen.getByRole('button', { name: 'Ta bort från enheten och logga ut' }))
    await user.click(screen.getByRole('button', { name: 'Bekräfta och logga ut' }))
    expect(await screen.findByText('Ingen anslutning. Ändringen sparades inte i molnet.')).toBeInTheDocument()
    expect(syncCoordinator.readScoped('cache')).toBe('keep')
    expect(syncCoordinator.getActiveIdentity()).toEqual({ userId: 'user-1', householdId: 'house-1' })
  })

  it('blocks auth callback activation while sign out is unresolved', async () => {
    let rejectSignOut!: (error: unknown) => void
    vi.mocked(signOut).mockReturnValue(new Promise<void>((_resolve, reject) => { rejectSignOut = reject }))
    const user = userEvent.setup()
    render(<HouseholdMenu />)
    await user.click(screen.getByRole('button', { name: 'Hushåll' }))
    await user.click(await screen.findByRole('button', { name: 'Logga ut' }))
    await user.click(screen.getByRole('button', { name: 'Behåll på enheten och logga ut' }))

    activateSyncIdentity({ userId: 'racing-user', householdId: 'racing-house' })
    expect(syncCoordinator.getActiveIdentity()).toBeNull()
    rejectSignOut(new TypeError('Failed to fetch'))
    expect(await screen.findByText('Ingen anslutning. Ändringen sparades inte i molnet.')).toBeInTheDocument()
    expect(syncCoordinator.getActiveIdentity()).toEqual({ userId: 'user-1', householdId: 'house-1' })
  })
})

describe('HouseholdMenu invitation ambiguity', () => {
  it('explains the conflict and offers no arbitrary accept action', async () => {
    vi.mocked(pendingInviteStatus).mockResolvedValue('ambiguous')
    const user = userEvent.setup()
    render(<HouseholdMenu />)

    await user.click(screen.getByRole('button', { name: 'Hushåll' }))

    expect(await screen.findByText('Flera hushåll har bjudit in dig')).toBeInTheDocument()
    expect(screen.getByText(/bara en aktiv inbjudan återstår/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Gå med i hushållet' })).not.toBeInTheDocument()
  })

  it('explains when saved data prevents a sole-member move', async () => {
    vi.mocked(pendingInviteStatus).mockResolvedValue('single')
    vi.mocked(acceptInvite).mockRejectedValue({
      code: 'P0004', message: 'household contains persisted data',
    })
    const user = userEvent.setup()
    render(<HouseholdMenu />)

    await user.click(screen.getByRole('button', { name: 'Hushåll' }))
    await user.click(await screen.findByRole('button', { name: 'Gå med i hushållet' }))

    expect(await screen.findByText(
      'Du kan inte gå med i ett annat hushåll medan du är ensam i ett hushåll med sparad data.',
    )).toBeInTheDocument()
  })
})
