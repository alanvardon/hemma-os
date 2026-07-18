import { useSyncExternalStore } from 'react'

const sub = (cb: () => void) => {
  window.addEventListener('online', cb)
  window.addEventListener('offline', cb)
  return () => {
    window.removeEventListener('online', cb)
    window.removeEventListener('offline', cb)
  }
}

export const useOnline = () =>
  useSyncExternalStore(sub, () => navigator.onLine, () => true)
