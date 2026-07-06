import { useCallback, useEffect, useRef, useState } from 'react'

// The "Saved ✓" header flash shared by every tool page: show it, then hide
// after `duration` ms, resetting the timer if called again before it fades.
// Clears its timer on unmount. Replaces the per-route flashSaved() copies.
export function useSaveFlash(duration = 1400): { saveVisible: boolean; flashSaved: () => void } {
  const [saveVisible, setSaveVisible] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashSaved = useCallback(() => {
    setSaveVisible(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setSaveVisible(false), duration)
  }, [duration])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  return { saveVisible, flashSaved }
}
