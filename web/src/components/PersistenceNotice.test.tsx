// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import PersistenceNotice from './PersistenceNotice'
import { reportPersistenceError } from '../lib/persistence-error'
import { activateSyncIdentity, SYNC_STATUS_EVENT, syncCoordinator } from '../lib/sync'

describe('PersistenceNotice', () => {
  it('renders stable copy for a background write failure without raw backend text', async () => {
    render(<PersistenceNotice />)

    reportPersistenceError({
      code: '23514',
      message: 'new row violates check constraint private_financial_schema',
    })

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Ändringen kunde inte sparas. Kontrollera uppgifterna och försök igen.',
    )
    expect(screen.queryByText(/private_financial_schema/i)).not.toBeInTheDocument()
  })

  it.each([
    ['saving', 'Sparar'],
    ['saved', 'Sparat'],
    ['waiting', 'Väntar på anslutning'],
    ['failed', 'Kunde inte spara'],
  ] as const)('shows the truthful %s sync state', async (state, label) => {
    render(<PersistenceNotice />)
    window.dispatchEvent(new CustomEvent(SYNC_STATUS_EVENT, { detail: { state, pending: state === 'saved' ? 0 : 1 } }))
    expect(await screen.findByText(label)).toBeInTheDocument()
  })

  it('shows a queued operation that existed before the notice mounted', async () => {
    const identity = { userId: 'notice-user', householdId: 'notice-house' }
    activateSyncIdentity(identity)
    syncCoordinator.register('notice-offline', async () => { throw new TypeError('Failed to fetch') })
    await expect(syncCoordinator.mutate({
      resource: 'notice-offline', operation: 'upsert', payload: { id: 'x' }, entityIds: ['x'],
    })).rejects.toBeTruthy()

    render(<PersistenceNotice />)
    expect(screen.getByText('Väntar på anslutning')).toBeInTheDocument()
    syncCoordinator.removeNamespace(identity)
  })

  it('expires an error independently when a saved status arrives', () => {
    vi.useFakeTimers()
    try {
      render(<PersistenceNotice />)
      act(() => {
        reportPersistenceError({ message: 'Failed to fetch' })
        window.dispatchEvent(new CustomEvent(SYNC_STATUS_EVENT, { detail: { state: 'saved', pending: 0 } }))
      })
      expect(screen.getByRole('alert')).toBeInTheDocument()
      act(() => { vi.advanceTimersByTime(6001) })
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
