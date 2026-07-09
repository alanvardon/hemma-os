import type { LucideIcon } from 'lucide-react'

// Thin wrapper so every lucide icon in the app shares the same stroke weight
// and default size, instead of repeating `strokeWidth={1.75}` at each call site.
export default function Icon({ icon: Cmp, size = 16, className }: { icon: LucideIcon; size?: number; className?: string }) {
  return <Cmp size={size} strokeWidth={1.75} className={className} aria-hidden />
}
