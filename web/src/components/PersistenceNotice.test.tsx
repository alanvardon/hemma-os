// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
