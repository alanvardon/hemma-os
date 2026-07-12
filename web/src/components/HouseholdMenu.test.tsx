// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import HouseholdMenu from './HouseholdMenu'
import { acceptInvite, pendingInviteStatus } from '../lib/household'

vi.mock('./AnimatedDialog', () => ({
  default: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div>{children}</div> : null,
}))

vi.mock('../lib/supabase', () => ({
  supabase: { auth: { getUser: vi.fn(async () => ({ data: { user: { email: 'me@example.com' } } })) } },
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
  vi.mocked(pendingInviteStatus).mockReset()
  vi.mocked(acceptInvite).mockReset()
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
