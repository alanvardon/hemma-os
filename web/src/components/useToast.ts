import { useCallback, useEffect, useRef, useState } from 'react'

export interface ToastState { msg: string; show: boolean }

// The transient status toast shared by Bolånekoll and Månadsavslut: show a
// message, auto-hide after `duration` ms, resetting the timer on each call.
// The state + timer live here; each route renders its own toast element (they
// use different CSS classes, e.g. `bk-toast` / `ma-toast`).
export function useToast(duration = 2600): { toast: ToastState; showToast: (msg: string) => void } {
  const [toast, setToast] = useState<ToastState>({ msg: '', show: false })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = useCallback((msg: string) => {
    if (timer.current) clearTimeout(timer.current)
    setToast({ msg, show: true })
    timer.current = setTimeout(() => setToast((t) => ({ ...t, show: false })), duration)
  }, [duration])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  return { toast, showToast }
}
