import { useId } from 'react'
import { motion, useReducedMotion } from 'motion/react'

const EASE = [0.22, 1, 0.36, 1] as const

// Segmented radio-group control shared by the tool pages. With `responsive`
// set, a sibling <select class="seg-select"> renders as the narrow-viewport
// fallback (CSS decides which of the two is visible).
//
// The active fill is a single `motion.span` sliding between segments via a
// shared `layoutId` (Motion's FLIP-based shared-layout animation) — each
// `.seg` button hosts the pill only while it's active, so on selection the
// pill un-mounts from the old button and re-mounts in the new one, and
// Motion tweens the position/size difference. The id is generated per
// instance (useId) so two Segmented controls on the same page never animate
// a pill across each other.
export default function Segmented<T extends string>({ value, options, onChange, small, responsive, ariaLabel }: {
  value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; small?: boolean; responsive?: boolean; ariaLabel?: string
}) {
  const pillId = `seg-pill-${useId()}`
  const reduce = useReducedMotion()

  return (
    <>
      <div className={'segmented' + (small ? ' segmented-sm' : '') + (responsive ? ' segmented-responsive' : '')} role="radiogroup" aria-label={ariaLabel}>
        {options.map(o => {
          const active = value === o.v
          return (
            <button key={o.v} type="button" role="radio" aria-checked={active}
              className={'seg' + (active ? ' is-active' : '')} onClick={() => onChange(o.v)}>
              {active && (
                <motion.span
                  className="seg-pill"
                  layoutId={pillId}
                  transition={reduce ? { duration: 0 } : { duration: 0.28, ease: EASE }}
                />
              )}
              <span className="seg-label">{o.label}</span>
            </button>
          )
        })}
      </div>
      {responsive && (
        <select className="seg-select" value={value} aria-label={ariaLabel}
          onChange={e => onChange(e.target.value as T)}>
          {options.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
        </select>
      )}
    </>
  )
}
