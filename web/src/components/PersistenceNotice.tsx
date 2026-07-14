import { useEffect, useRef, useState } from 'react'
import { PERSISTENCE_ERROR_EVENT } from '../lib/persistence-error'
import { SYNC_STATUS_EVENT, syncCoordinator } from '../lib/sync'
import type { SyncSaveState, SyncStatus } from '../lib/sync-coordinator'

const LABELS: Record<Exclude<SyncSaveState, 'idle'>, string> = {
  saving: 'Sparar',
  saved: 'Sparat',
  waiting: 'Väntar på anslutning',
  failed: 'Kunde inte spara',
}

export default function PersistenceNotice() {
  const [message, setMessage] = useState('')
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(() => {
    const outbox = syncCoordinator.getOutbox()
    if (!outbox.length) return { state: 'idle', pending: 0 }
    return { state: outbox.some((operation) => operation.state === 'failed') ? 'failed' : 'waiting', pending: outbox.length }
  })
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const onError = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail
      if (!detail?.message) return
      setMessage(detail.message)
      if (errorTimer.current) clearTimeout(errorTimer.current)
      errorTimer.current = setTimeout(() => setMessage(''), 6000)
    }
    const onSync = (event: Event) => {
      const detail = (event as CustomEvent<SyncStatus>).detail
      if (!detail?.state) return
      setSyncStatus(detail)
      if (syncTimer.current) clearTimeout(syncTimer.current)
      if (detail.state === 'saved') syncTimer.current = setTimeout(() => setSyncStatus({ state: 'idle', pending: 0 }), 1600)
    }
    window.addEventListener(PERSISTENCE_ERROR_EVENT, onError)
    window.addEventListener(SYNC_STATUS_EVENT, onSync)
    return () => {
      window.removeEventListener(PERSISTENCE_ERROR_EVENT, onError)
      window.removeEventListener(SYNC_STATUS_EVENT, onSync)
      if (errorTimer.current) clearTimeout(errorTimer.current)
      if (syncTimer.current) clearTimeout(syncTimer.current)
    }
  }, [])

  const stateMessage = syncStatus.state === 'idle' ? '' : LABELS[syncStatus.state]
  const visible = !!message || !!stateMessage
  const canRetry = syncStatus.pending > 0 && (syncStatus.state === 'waiting' || syncStatus.state === 'failed')

  return (
    <div className={'persistence-notice' + (visible ? ' show' : '')} role="status" aria-live="polite" data-state={syncStatus.state}>
      {stateMessage && <span>{stateMessage}</span>}
      {canRetry && <button type="button" className="btn btn-ghost persistence-retry" onClick={() => void syncCoordinator.retryFailed()}>Försök igen</button>}
      {syncStatus.state === 'failed' && (
        <button type="button" className="btn btn-ghost persistence-retry" onClick={() => {
          if (!confirmDiscard) { setConfirmDiscard(true); return }
          syncCoordinator.discardFailed()
          window.location.reload()
        }}>
          {confirmDiscard ? 'Bekräfta: kasta lokala ändringar' : 'Kasta lokala ändringar'}
        </button>
      )}
      {message && <span className="persistence-error" role="alert">{message}</span>}
    </div>
  )
}
