// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import PersistenceNotice from './PersistenceNotice'
import { reportPersistenceError, reportPersistenceWarning } from '../lib/persistence-error'
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

  it('renders recoverable persistence warnings', async () => {
    render(<PersistenceNotice />)
    reportPersistenceWarning('En sparad rad kunde inte läsas.')
    expect(await screen.findByRole('alert')).toHaveTextContent('En sparad rad kunde inte läsas.')
  })

  it.each([
    ['saving', 'Sparar'],
    ['waiting', 'Väntar på anslutning'],
    ['failed', 'Kunde inte spara'],
  ] as const)('shows the truthful %s sync state', async (state, label) => {
    render(<PersistenceNotice />)
    window.dispatchEvent(new CustomEvent(SYNC_STATUS_EVENT, { detail: { state, pending: 1 } }))
    expect(await screen.findByText(label)).toBeInTheDocument()
  })

  it('renders no global completion message for a routine saving → saved sequence', async () => {
    render(<PersistenceNotice />)
    act(() => {
      window.dispatchEvent(new CustomEvent(SYNC_STATUS_EVENT, { detail: { state: 'saving', pending: 1 } }))
    })
    expect(screen.getByText('Sparar')).toBeInTheDocument()
    act(() => {
      window.dispatchEvent(new CustomEvent(SYNC_STATUS_EVENT, { detail: { state: 'saved', pending: 0 } }))
    })
    expect(screen.queryByText('Sparat')).not.toBeInTheDocument()
    expect(screen.queryByText('Väntande ändringar sparade')).not.toBeInTheDocument()
    expect(screen.queryByText('Sparar')).not.toBeInTheDocument()
  })

  it.each([
    ['waiting'],
    ['failed'],
  ] as const)('confirms recovery once when a %s queue reaches saved via saving', (recoveryState) => {
    render(<PersistenceNotice />)
    act(() => {
      window.dispatchEvent(new CustomEvent(SYNC_STATUS_EVENT, { detail: { state: recoveryState, pending: 1 } }))
      window.dispatchEvent(new CustomEvent(SYNC_STATUS_EVENT, { detail: { state: 'saving', pending: 1 } }))
      window.dispatchEvent(new CustomEvent(SYNC_STATUS_EVENT, { detail: { state: 'saved', pending: 0 } }))
    })
    expect(screen.getAllByText('Väntande ändringar sparade')).toHaveLength(1)
    expect(screen.queryByText('Sparat')).not.toBeInTheDocument()
  })

  it('does not carry recovery context into a later ordinary write', () => {
    vi.useFakeTimers()
    try {
      render(<PersistenceNotice />)
      act(() => {
        window.dispatchEvent(new CustomEvent(SYNC_STATUS_EVENT, { detail: { state: 'waiting', pending: 1 } }))
        window.dispatchEvent(new CustomEvent(SYNC_STATUS_EVENT, { detail: { state: 'saved', pending: 0 } }))
      })
      expect(screen.getByText('Väntande ändringar sparade')).toBeInTheDocument()
      act(() => { vi.advanceTimersByTime(1601) })
      expect(screen.queryByText('Väntande ändringar sparade')).not.toBeInTheDocument()

      act(() => {
        window.dispatchEvent(new CustomEvent(SYNC_STATUS_EVENT, { detail: { state: 'saving', pending: 1 } }))
        window.dispatchEvent(new CustomEvent(SYNC_STATUS_EVENT, { detail: { state: 'saved', pending: 0 } }))
      })
      expect(screen.queryByText('Väntande ändringar sparade')).not.toBeInTheDocument()
      expect(screen.queryByText('Sparat')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
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

  it('treats saved as a recovery when the notice mounted with a pending outbox', async () => {
    const identity = { userId: 'notice-recovery-user', householdId: 'notice-recovery-house' }
    activateSyncIdentity(identity)
    syncCoordinator.register('notice-recovery', async () => { throw new TypeError('Failed to fetch') })
    await expect(syncCoordinator.mutate({
      resource: 'notice-recovery', operation: 'upsert', payload: { id: 'y' }, entityIds: ['y'],
    })).rejects.toBeTruthy()

    render(<PersistenceNotice />)
    expect(screen.getByText('Väntar på anslutning')).toBeInTheDocument()
    act(() => {
      window.dispatchEvent(new CustomEvent(SYNC_STATUS_EVENT, { detail: { state: 'saved', pending: 0 } }))
    })
    expect(screen.getByText('Väntande ändringar sparade')).toBeInTheDocument()
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

  it('shows an actionable conflict and keeps the local version against the current revision', async () => {
    const identity = { userId: 'notice-conflict-user', householdId: 'notice-conflict-house' }
    activateSyncIdentity(identity)
    const unregister = syncCoordinator.register('notice-conflict', async (operation) => {
      if (operation.expectedRevisions?.['tool_state:notice'] === 1) {
        throw { status: 409, currentRevisions: { 'tool_state:notice': 2 } }
      }
      return { revisions: { 'tool_state:notice': 3 } }
    })
    await expect(syncCoordinator.mutate({
      resource: 'notice-conflict', operation: 'upsert', payload: { mine: true }, entityIds: ['notice'],
      expectedRevisions: { 'tool_state:notice': 1 },
    })).rejects.toMatchObject({ category: 'conflict' })

    render(<PersistenceNotice />)
    expect(screen.getByRole('alert')).toHaveTextContent('Det här ändrades på en annan enhet.')
    expect(screen.getByRole('button', { name: 'Ladda molnversionen' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Behåll min version' }))

    await waitFor(() => expect(screen.queryByText('Det här ändrades på en annan enhet.')).not.toBeInTheDocument())
    expect(syncCoordinator.getRevision('tool_state:notice')).toBe(3)
    unregister()
    syncCoordinator.removeNamespace(identity)
  })
})
