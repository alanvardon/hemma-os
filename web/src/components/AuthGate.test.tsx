// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AuthGate from './AuthGate'
import { claimHousehold, signOut } from '../lib/household'

const session = { user: { id: 'user-1' } }

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session } })),
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
      signInWithOtp: vi.fn(),
    },
  },
}))

vi.mock('../lib/household', () => ({
  claimHousehold: vi.fn(),
  signOut: vi.fn(),
}))

beforeEach(() => {
  localStorage.clear()
  vi.mocked(claimHousehold).mockReset()
  vi.mocked(signOut).mockReset().mockResolvedValue()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
})

describe('AuthGate household provisioning', () => {
  it('keeps children unmounted on claim failure and Retry tries again', async () => {
    vi.mocked(claimHousehold)
      .mockRejectedValueOnce({
        message: 'new row violates check constraint households_owner_key',
        code: '23514',
      })
      .mockResolvedValueOnce('household-1')

    const user = userEvent.setup()
    render(<AuthGate><div>Skyddad route</div></AuthGate>)

    expect(await screen.findByRole('heading', { name: 'Hushållet kunde inte öppnas' })).toBeInTheDocument()
    expect(screen.queryByText('Skyddad route')).not.toBeInTheDocument()
    expect(screen.queryByText(/households_owner_key/i)).not.toBeInTheDocument()
    expect(screen.getByText('Ändringen kunde inte sparas. Kontrollera uppgifterna och försök igen.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Försök igen' }))

    expect(await screen.findByText('Skyddad route')).toBeInTheDocument()
    expect(claimHousehold).toHaveBeenCalledTimes(2)
  })

  it('keeps Sign out available while provisioning is blocked', async () => {
    vi.mocked(claimHousehold).mockRejectedValue(new TypeError('Failed to fetch'))
    const user = userEvent.setup()
    render(<AuthGate><div>Skyddad route</div></AuthGate>)

    await user.click(await screen.findByRole('button', { name: 'Logga ut' }))

    expect(signOut).toHaveBeenCalledOnce()
    expect(screen.queryByText('Skyddad route')).not.toBeInTheDocument()
  })

  it('explains how to resolve multiple active household invitations', async () => {
    vi.mocked(claimHousehold).mockRejectedValue({
      code: 'P0003', message: 'ambiguous household invitations',
    })

    render(<AuthGate><div>Skyddad route</div></AuthGate>)

    expect(await screen.findByText(
      'Flera hushåll har bjudit in dig. Be ett hushåll ta bort sin inbjudan innan du fortsätter.',
    )).toBeInTheDocument()
    expect(screen.queryByText('Skyddad route')).not.toBeInTheDocument()
  })

  it('keeps older unowned data behind an explicit import or leave choice', async () => {
    localStorage.setItem('bostadskalkyl_draft_v1', '{"newPrice":7000000}')
    vi.mocked(claimHousehold).mockResolvedValue('household-1')
    const user = userEvent.setup()
    render(<AuthGate><div>Skyddad route</div></AuthGate>)

    expect(await screen.findByRole('heading', { name: 'Äldre data på den här enheten' })).toBeInTheDocument()
    expect(screen.queryByText('Skyddad route')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Lämna kvar på enheten' }))
    expect(await screen.findByText('Skyddad route')).toBeInTheDocument()
    expect(localStorage.getItem('hemma-sync-v1:legacy-quarantine')).not.toBeNull()
  })

  it('imports older data only after the user chooses the active household', async () => {
    localStorage.setItem('bostadskalkyl_draft_v1', '{"newPrice":7000000}')
    vi.mocked(claimHousehold).mockResolvedValue('household-1')
    const user = userEvent.setup()
    render(<AuthGate><div>Skyddad route</div></AuthGate>)

    await user.click(await screen.findByRole('button', { name: 'Importera till detta hushåll' }))
    expect(await screen.findByText('Skyddad route')).toBeInTheDocument()
    expect([...Array(localStorage.length).keys()].map((index) => localStorage.key(index))).toContain(
      'hemma-sync-v1:user-1:household-1:bostadskalkyl_draft_v1',
    )
  })

  it('requires a second warned action before removing older data', async () => {
    localStorage.setItem('bostadskalkyl_draft_v1', '{}')
    vi.mocked(claimHousehold).mockResolvedValue('household-1')
    const user = userEvent.setup()
    render(<AuthGate><div>Skyddad route</div></AuthGate>)

    await user.click(await screen.findByRole('button', { name: 'Ta bort äldre data' }))
    expect(screen.getByText('Detta tar permanent bort den äldre lokala datan från enheten.')).toBeInTheDocument()
    expect(localStorage.getItem('hemma-sync-v1:legacy-quarantine')).not.toBeNull()
    await user.click(screen.getByRole('button', { name: 'Bekräfta: ta bort äldre data' }))
    expect(await screen.findByText('Skyddad route')).toBeInTheDocument()
    expect(localStorage.getItem('hemma-sync-v1:legacy-quarantine')).toBeNull()
  })
})
