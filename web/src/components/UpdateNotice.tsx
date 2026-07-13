import { useEffect, useRef, useState } from 'react'
import { BUILD_SHA, fetchDeployedVersion, isUpdateAvailable, reloadApp } from '../lib/version'

// Re-check cadence (plan 100): app start, tab becoming visible again (the
// overnight-tab case this exists for), and a slow safety interval. Throttled
// so visibility flapping can't turn into a fetch storm.
const CHECK_INTERVAL_MS = 15 * 60 * 1000
const MIN_GAP_MS = 60 * 1000

export default function UpdateNotice() {
  const [newSha, setNewSha] = useState('')
  const [dismissedSha, setDismissedSha] = useState('')
  const lastCheck = useRef(0)

  useEffect(() => {
    if (!BUILD_SHA) return // dev / local build — no stamp, no checker
    let alive = true
    const check = async () => {
      const now = Date.now()
      if (now - lastCheck.current < MIN_GAP_MS) return
      lastCheck.current = now
      const deployed = await fetchDeployedVersion()
      if (alive && isUpdateAvailable(BUILD_SHA, deployed)) setNewSha(deployed!.sha)
    }
    const onVisible = () => { if (document.visibilityState === 'visible') check() }
    check()
    const timer = setInterval(check, CHECK_INTERVAL_MS)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // Dismissal is per-SHA: a NEWER deploy after dismissing shows it again.
  const open = !!newSha && newSha !== dismissedSha
  if (!open) return null
  return (
    <div className="update-notice" role="status" aria-live="polite">
      <span>Ny version tillgänglig.</span>
      <button className="btn btn-ghost" onClick={reloadApp}>Ladda om</button>
      <button className="update-notice-close" aria-label="Stäng" onClick={() => setDismissedSha(newSha)}>×</button>
    </div>
  )
}
