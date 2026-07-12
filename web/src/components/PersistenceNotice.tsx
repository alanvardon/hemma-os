import { useEffect, useRef, useState } from 'react'
import { PERSISTENCE_ERROR_EVENT } from '../lib/persistence-error'

export default function PersistenceNotice() {
  const [message, setMessage] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const onError = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail
      if (!detail?.message) return
      setMessage(detail.message)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setMessage(''), 6000)
    }
    window.addEventListener(PERSISTENCE_ERROR_EVENT, onError)
    return () => {
      window.removeEventListener(PERSISTENCE_ERROR_EVENT, onError)
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  return (
    <div className={'persistence-notice' + (message ? ' show' : '')} role="alert" aria-live="assertive">
      {message}
    </div>
  )
}
