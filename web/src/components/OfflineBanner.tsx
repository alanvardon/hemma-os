import { useOnline } from '../lib/useOnline'

export default function OfflineBanner() {
  const online = useOnline()
  if (online) return null
  return (
    <div className="offline-banner" role="status">
      Offline — ändringar sparas lokalt och synkas när du är online igen.
    </div>
  )
}
