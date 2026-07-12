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
})
