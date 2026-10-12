// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AuthGate from './AuthGate'
import { claimHousehold, signOut } from '../lib/household'
import { supabase } from '../lib/supabase'

const session = { user: { id: 'user-1' } }

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session } })),
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
      signInWithOtp: vi.fn(),
      verifyOtp: vi.fn(),
    },
  },
}))

// Keep the dev-only auto-sign-in out of the login-screen tests.
vi.mock('../lib/devAuth', () => ({ maybeDevSignIn: vi.fn(async () => {}) }))

vi.mock('../lib/household', () => ({
  claimHousehold: vi.fn(),
  signOut: vi.fn(),
}))

beforeEach(() => {
  localStorage.clear()
  vi.mocked(claimHousehold).mockReset()
  vi.mocked(signOut).mockReset().mockResolvedValue()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
  vi.mocked(supabase.auth.getSession).mockImplementation(
    async () => ({ data: { session } }) as never,
  )
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

const EMAIL = 'anna@example.se'
const INVALID = 'Koden stämmer inte eller har gått ut. Kontrollera mejlet eller skicka en ny kod.'
const RATE_LIMITED = 'För många försök. Vänta en stund och försök igen.'
const NETWORK = 'Kunde inte logga in. Kontrollera anslutningen och försök igen.'
const RESENT = 'En ny kod har skickats. Den gamla slutar gälla.'
const OTP_OPTIONS = {
  emailRedirectTo: window.location.origin + window.location.pathname,
  shouldCreateUser: true,
}

describe('AuthGate email code sign-in', () => {
  beforeEach(() => {
    vi.mocked(supabase.auth.getSession).mockImplementation(
      async () => ({ data: { session: null } }) as never,
    )
    vi.mocked(supabase.auth.signInWithOtp).mockReset()
      .mockResolvedValue({ data: {}, error: null } as never)
    vi.mocked(supabase.auth.verifyOtp).mockReset()
      .mockResolvedValue({ data: { user: null, session: null }, error: null } as never)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function requestCode(
    user: ReturnType<typeof userEvent.setup>,
    wrap: (ui: React.ReactElement) => React.ReactElement = (ui) => ui,
  ) {
    render(wrap(<AuthGate><div>Skyddad route</div></AuthGate>))
    await user.type(await screen.findByPlaceholderText('din@epost.se'), EMAIL)
    await user.click(screen.getByRole('button', { name: 'Skicka länk' }))
    return await screen.findByLabelText('Kod från mejlet') as HTMLInputElement
  }

  function rejectWith(error: { name?: string; status?: number; message: string }) {
    vi.mocked(supabase.auth.verifyOtp).mockResolvedValue(
      { data: { user: null, session: null }, error } as never,
    )
  }

  it('shows the code field and the address after a successful send', async () => {
    const user = userEvent.setup()
    const input = await requestCode(user)

    expect(screen.getByRole('heading', { name: 'Kolla din inkorg' })).toBeInTheDocument()
    expect(screen.getByText(EMAIL)).toBeInTheDocument()
    expect(screen.getByText(/Skriv in koden från mejlet, eller öppna länken på den här enheten/))
      .toBeInTheDocument()
    expect(input).toHaveAttribute('inputmode', 'numeric')
    expect(input).toHaveAttribute('autocomplete', 'one-time-code')
    expect(signInWithOtpCalls()).toEqual([{ email: EMAIL, options: OTP_OPTIONS }])
  })

  it('verifies automatically and exactly once when the sixth digit is typed', async () => {
    const user = userEvent.setup()
    const input = await requestCode(user, (ui) => <StrictMode>{ui}</StrictMode>)

    await user.type(input, '12345')
    expect(supabase.auth.verifyOtp).not.toHaveBeenCalled()
    await user.type(input, '6')
    await act(async () => {})

    expect(supabase.auth.verifyOtp).toHaveBeenCalledTimes(1)
    expect(supabase.auth.verifyOtp).toHaveBeenCalledWith({ email: EMAIL, token: '123456', type: 'email' })
  })

  it('submits a pasted "123 456" as 123456', async () => {
    const user = userEvent.setup()
    const input = await requestCode(user)

    await user.click(input)
    await user.paste('123 456')
    await act(async () => {})

    expect(input.value).toBe('123456')
    expect(supabase.auth.verifyOtp).toHaveBeenCalledTimes(1)
    expect(supabase.auth.verifyOtp).toHaveBeenCalledWith({ email: EMAIL, token: '123456', type: 'email' })
  })

  it('shows "Loggar in…" and locks the field while verifying', async () => {
    let resolve!: (value: unknown) => void
    vi.mocked(supabase.auth.verifyOtp).mockReturnValue(new Promise((r) => { resolve = r }) as never)
    const user = userEvent.setup()
    const input = await requestCode(user)

    await user.type(input, '123456')

    expect(input).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Loggar in…' })).toBeDisabled()
    await act(async () => { resolve({ data: { user: null, session: null }, error: null }) })
  })

  it('shows the invalid/expired copy, keeps the code and refocuses the field', async () => {
    rejectWith({ name: 'AuthApiError', status: 400, message: 'Token has expired or is invalid' })
    const user = userEvent.setup()
    const input = await requestCode(user)

    await user.type(input, '123456')

    expect(await screen.findByRole('alert')).toHaveTextContent(INVALID)
    expect(input.value).toBe('123456')
    expect(input).toHaveFocus()
    expect(screen.queryByText(/Token has expired/)).not.toBeInTheDocument()

    // The explicit button retries the same code.
    vi.mocked(supabase.auth.verifyOtp).mockClear()
    await user.click(screen.getByRole('button', { name: 'Logga in' }))
    expect(supabase.auth.verifyOtp).toHaveBeenCalledTimes(1)
  })

  it('shows the rate-limit copy on HTTP 429', async () => {
    rejectWith({ name: 'AuthApiError', status: 429, message: 'Too many requests' })
    const user = userEvent.setup()
    const input = await requestCode(user)

    await user.type(input, '123456')

    expect(await screen.findByRole('alert')).toHaveTextContent(RATE_LIMITED)
    expect(input.value).toBe('123456')
  })

  it('shows the network copy when the request fails or throws', async () => {
    vi.mocked(supabase.auth.verifyOtp)
      .mockResolvedValueOnce({
        data: { user: null, session: null },
        error: { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' },
      } as never)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const user = userEvent.setup()
    const input = await requestCode(user)

    await user.type(input, '123456')
    expect(await screen.findByRole('alert')).toHaveTextContent(NETWORK)

    await user.click(screen.getByRole('button', { name: 'Logga in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(NETWORK)
    expect(supabase.auth.verifyOtp).toHaveBeenCalledTimes(2)
    expect(input.value).toBe('123456')
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument()
  })

  it('locks "Skicka ny kod" for 60 s with a countdown, then resends with the same options', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await requestCode(user)

    expect(screen.getByRole('button', { name: 'Skicka ny kod (60 s)' })).toBeDisabled()
    await act(async () => { vi.advanceTimersByTime(18_000) })
    expect(screen.getByRole('button', { name: 'Skicka ny kod (42 s)' })).toBeDisabled()
    await act(async () => { vi.advanceTimersByTime(42_000) })

    const resend = screen.getByRole('button', { name: 'Skicka ny kod' })
    expect(resend).toBeEnabled()
    await user.click(resend)

    expect(await screen.findByText(RESENT)).toBeInTheDocument()
    expect(signInWithOtpCalls()).toEqual([
      { email: EMAIL, options: OTP_OPTIONS },
      { email: EMAIL, options: OTP_OPTIONS },
    ])
    expect(screen.getByRole('button', { name: 'Skicka ny kod (60 s)' })).toBeDisabled()
  })

  it('tells the user when a resend fails and keeps the button available', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await requestCode(user)
    vi.mocked(supabase.auth.signInWithOtp).mockResolvedValueOnce({
      data: {}, error: { status: 429, message: 'email rate limit exceeded' },
    } as never)

    await act(async () => { vi.advanceTimersByTime(60_000) })
    await user.click(screen.getByRole('button', { name: 'Skicka ny kod' }))

    expect(await screen.findByRole('alert'))
      .toHaveTextContent('Kunde inte skicka en ny kod. Försök igen om en stund.')
    expect(screen.queryByText(/rate limit/)).not.toBeInTheDocument()
    expect(screen.queryByText(RESENT)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skicka ny kod' })).toBeEnabled()
  })

  it('"Använd en annan e-post" returns to the email form and clears the code, error and notice', async () => {
    rejectWith({ name: 'AuthApiError', status: 400, message: 'invalid' })
    const user = userEvent.setup()
    const input = await requestCode(user)
    await user.type(input, '123456')
    await screen.findByRole('alert')

    await user.click(screen.getByRole('button', { name: 'Använd en annan e-post' }))

    expect(screen.getByRole('heading', { name: 'Logga in' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Kod från mejlet')).not.toBeInTheDocument()
    expect(screen.queryByText(INVALID)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Skicka länk' }))
    const fresh = await screen.findByLabelText('Kod från mejlet') as HTMLInputElement
    expect(fresh.value).toBe('')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText(RESENT)).not.toBeInTheDocument()
  })
})

function signInWithOtpCalls() {
  return vi.mocked(supabase.auth.signInWithOtp).mock.calls.map(([args]) => args)
}
