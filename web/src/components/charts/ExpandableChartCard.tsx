import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'

// A compact chart preview that morphs into a fullscreen panel via Motion's
// shared-layout (`layoutId`) animation — the card and the open panel carry the
// same layoutId, so Motion tweens one into the other.
//
// Why the chart is deferred: a layoutId morph animates the panel with a `scale`
// transform, which visually distorts any non-`layout` child. The fullscreen body
// holds a visx SVG, so rendering it *during* the tween stretches/squashes it —
// the jank, worst on minimize (full-size chart squashed down to the card). Fix:
// keep the morph, but only mount the heavy chart once the open animation has
// settled, and unmount it *before* the close starts. During the tween the panel
// shows a same-height placeholder; the real chart cross-fades in at rest.
// Reduced-motion users get a plain fade (no morph), so the chart mounts at once.
// Escape / backdrop click / × all close it.

interface Props {
  title: string
  subtitle?: string
  preview: ReactNode // compact chart (no axes/tooltip)
  children: ReactNode // fullscreen body (sized chart + legend + any controls), mounted only once settled
}

export default function ExpandableChartCard({ title, subtitle, preview, children }: Props) {
  const [open, setOpen] = useState(false)
  // Gates the heavy chart so it never renders while the box is mid-morph.
  const [chartReady, setChartReady] = useState(false)
  const reduce = useReducedMotion()
  const rawId = useId()
  const layoutId = reduce ? undefined : `chartcard-${rawId}`
  const openRef = useRef(open)
  openRef.current = open

  // Unmount the heavy chart first, then start the shrink on the next frame so the
  // box morphs back to the card with nothing inside to distort.
  function close() {
    setChartReady(false)
    requestAnimationFrame(() => setOpen(false))
  }

  useEffect(() => {
    if (!open) {
      setChartReady(false)
      return
    }
    // Reduced motion = no layout morph (and so no settle event) → mount at once.
    if (reduce) setChartReady(true)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, reduce]) // eslint-disable-line react-hooks/exhaustive-deps

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
            onClick={close}
          >
            <motion.div
              layoutId={layoutId}
              className="chart-overlay-panel"
              role="dialog"
              aria-modal="true"
              aria-label={title}
              onClick={(e) => e.stopPropagation()}
              onLayoutAnimationComplete={() => {
                // Only promote to the real chart if we're still open (guards the
                // stray completion event fired by the closing morph).
                if (openRef.current) setChartReady(true)
              }}
              {...(reduce
                ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.15 } }
                : {})}
            >
              <div className="chart-overlay-head">
                <div>
                  <div className="chart-overlay-title">{title}</div>
                  {subtitle && <div className="chart-overlay-sub">{subtitle}</div>}
                </div>
                <button className="modal-close" aria-label="Close chart" autoFocus onClick={close}>
                  ×
                </button>
              </div>
              <div className="chart-overlay-body">
                {chartReady ? (
                  <div className="chart-overlay-figure">{children}</div>
                ) : (
                  <div className="chart-overlay-placeholder" aria-hidden="true" />
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
