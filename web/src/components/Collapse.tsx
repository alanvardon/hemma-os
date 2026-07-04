import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'

const EASE = [0.22, 1, 0.36, 1] as const

interface Props {
  open: boolean
  children: ReactNode
  className?: string
}

// Animates an inline disclosure section open/closed (height + fade) instead
// of the content hard-popping in and out. Content unmounts on close via
// AnimatePresence — a real unmount, not a clipped-but-present box, so
// collapsed rows leave the tab order rather than staying reachable by
// keyboard while invisible.
export default function Collapse({ open, children, className }: Props) {
  const reduce = useReducedMotion()
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={className}
          style={{ overflow: 'hidden' }}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={reduce ? { duration: 0 } : { duration: 0.32, ease: EASE }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
