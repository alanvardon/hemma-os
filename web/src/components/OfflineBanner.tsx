import { useEffect, useRef } from 'react'
import { useOnline } from '../lib/useOnline'

export default function OfflineBanner() {
  const online = useOnline()
  const ref = useRef<HTMLDivElement>(null)

  // The banner is fixed at the top, so it would otherwise overlay the sticky
  // page header and swallow taps on its actions. Publish the banner's live
  // height (it wraps to two lines on narrow screens) so the layout can reserve
  // space and push sticky headers below it.
  useEffect(() => {
    const el = ref.current
    if (online || !el) return
    const root = document.documentElement
    const apply = () => root.style.setProperty('--offline-banner-h', `${el.offsetHeight}px`)
    apply()
    root.classList.add('has-offline-banner')
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null
    observer?.observe(el)
    return () => {
      observer?.disconnect()
      root.classList.remove('has-offline-banner')
      root.style.removeProperty('--offline-banner-h')
    }
  }, [online])

  if (online) return null
  return (
    <div ref={ref} className="offline-banner" role="status">
      Offline — ändringar sparas lokalt och synkas när du är online igen.
    </div>
  )
}
