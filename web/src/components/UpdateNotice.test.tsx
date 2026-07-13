// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sha: 'old123',
  fetchDeployedVersion: vi.fn<() => Promise<{ sha: string; builtAt: string | null } | null>>(),
  reloadApp: vi.fn(),
}))

vi.mock('../lib/version', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/version')>()
  return {
    ...actual,
    get BUILD_SHA() { return mocks.sha },
    fetchDeployedVersion: mocks.fetchDeployedVersion,
    reloadApp: mocks.reloadApp,
  }
})

import UpdateNotice from './UpdateNotice'

describe('UpdateNotice', () => {
  beforeEach(() => {
    mocks.sha = 'old123'
    mocks.fetchDeployedVersion.mockReset()
    mocks.reloadApp.mockReset()
  })

  it('offers a reload when the deployed sha differs', async () => {
    mocks.fetchDeployedVersion.mockResolvedValue({ sha: 'new456', builtAt: null })
    render(<UpdateNotice />)
    expect(await screen.findByText('Ny version tillgänglig.')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Ladda om' }))
    expect(mocks.reloadApp).toHaveBeenCalledTimes(1)
  })

  it('stays quiet on the deployed build', async () => {
    mocks.fetchDeployedVersion.mockResolvedValue({ sha: 'old123', builtAt: null })
    render(<UpdateNotice />)
    await waitFor(() => expect(mocks.fetchDeployedVersion).toHaveBeenCalled())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('treats a failed check as no information, not an update', async () => {
    mocks.fetchDeployedVersion.mockResolvedValue(null)
    render(<UpdateNotice />)
    await waitFor(() => expect(mocks.fetchDeployedVersion).toHaveBeenCalled())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('never checks from an unstamped (dev/local) build', async () => {
    mocks.sha = ''
    render(<UpdateNotice />)
    await new Promise((r) => setTimeout(r, 10))
    expect(mocks.fetchDeployedVersion).not.toHaveBeenCalled()
  })

  it('can be dismissed', async () => {
    mocks.fetchDeployedVersion.mockResolvedValue({ sha: 'new456', builtAt: null })
    render(<UpdateNotice />)
    await screen.findByText('Ny version tillgänglig.')

    await userEvent.click(screen.getByRole('button', { name: 'Stäng' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
