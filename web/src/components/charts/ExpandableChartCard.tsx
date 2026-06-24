import { useEffect, useId, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'

// A compact chart preview that morphs into a fullscreen panel via Motion's
// shared-layout (`layoutId`) animation — the card and the open panel carry the
// same layoutId, so Motion tweens one into the other. Reduced-motion users get
// a plain fade instead. Escape / backdrop click / × all close it.

interface Props {
  title: string
  subtitle?: string
  preview: ReactNode // compact chart (no axes/tooltip)
  full: ReactNode // full chart (axes + tooltip), mounted only while open
  legend?: ReactNode // small legend / caption under the full chart
}

export default function ExpandableChartCard({ title, subtitle, preview, full, legend }: Props) {
  const [open, setOpen] = useState(false)
  const reduce = useReducedMotion()
  const rawId = useId()
  const layoutId = reduce ? undefined : `chartcard-${rawId}`

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open])

  return (
    <>
      <motion.div
        layoutId={layoutId}
        className="chart-card"
        role="button"
        tabIndex={0}
        aria-label={`${title} — expand chart`}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        <div className="chart-card-head">
          <span className="chart-card-title">{title}</span>
          <span className="chart-card-expand" aria-hidden>
            ⤢
          </span>
        </div>
        {subtitle && <div className="chart-card-sub">{subtitle}</div>}
        <div className="chart-card-preview">{preview}</div>
      </motion.div>

      <AnimatePresence>
        {open && (
          <motion.div
            className="chart-overlay-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setOpen(false)}
          >
            <motion.div
              layoutId={layoutId}
              className="chart-overlay-panel"
              role="dialog"
              aria-modal="true"
              aria-label={title}
              onClick={(e) => e.stopPropagation()}
              {...(reduce
                ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.15 } }
                : {})}
            >
              <div className="chart-overlay-head">
                <div>
                  <div className="chart-overlay-title">{title}</div>
                  {subtitle && <div className="chart-overlay-sub">{subtitle}</div>}
                </div>
                <button className="modal-close" aria-label="Close chart" autoFocus onClick={() => setOpen(false)}>
                  ×
                </button>
              </div>
              <div className="chart-overlay-body">{full}</div>
              {legend && <div className="chart-overlay-legend">{legend}</div>}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
