import { useEffect, useRef, useState } from 'react'
import { forwardSteps, getDigits } from '../lib/flipClock'

// ── FlipDigit ──────────────────────────────────────────────────────────────
// One split-flap digit cell. Manages its own riffle queue: when `value`
// changes, it steps forward through every intermediate digit at ~60 ms/flap
// (the Solari riffle). Under reduced-motion it snaps directly.

const CHARS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

function FlipDigit({ value, reduce }: { value: number; reduce: boolean }) {
  const [shown, setShown] = useState(value)
  const [animNext, setAnimNext] = useState<number | null>(null)

  // Refs so event callbacks (onFoldEnd) always see current values without
  // re-subscribing to effects, and queue mutations don't cause extra renders.
  const shownRef = useRef(value)
  const animatingRef = useRef(false)
  const queueRef = useRef<number[]>([])

  useEffect(() => {
    const steps = forwardSteps(shownRef.current, value)
    if (!steps.length) return

    if (reduce) {
      setShown(value); shownRef.current = value
      setAnimNext(null); queueRef.current = []; animatingRef.current = false
      return
    }

    // Replace queue with steps from current displayed position to new target.
    // This handles mid-riffle target updates (e.g. tab return) without drift.
    queueRef.current = steps
    pump()
  }, [value, reduce])

  function pump() {
    if (animatingRef.current) return
    const n = queueRef.current.shift()
    if (n === undefined) return
    animatingRef.current = true
    setAnimNext(n)
  }

  function onFoldEnd() {
    const n = animNext!
    setShown(n); shownRef.current = n
    // Both of the following setState calls are batched with the above in React
    // 18. If the queue has more steps, setAnimNext(n2) overrides setAnimNext(null).
    setAnimNext(null); animatingRef.current = false
    pump()
  }

  const c = CHARS[shown]
  const nc = animNext !== null ? CHARS[animNext] : null

  return (
    <div className="flap-digit">
      {/* Lower half of next digit — revealed as the fold completes */}
      {nc && (
        <div className="flap-half flap-bottom flap-next-bot">
          <span className="flap-char">{nc}</span>
        </div>
      )}
      {/* Lower half of current digit — static */}
      <div className="flap-half flap-bottom">
        <span className="flap-char">{c}</span>
      </div>
      {/* Upper half of current digit — static, visible beneath the fold */}
      <div className="flap-half flap-top">
        <span className="flap-char">{c}</span>
      </div>
      {/* Animated fold: top half of current digit rotates from 0 to -90 deg */}
      {nc && (
        <div
          key={animNext}
          className="flap-half flap-top flap-fold"
          onAnimationEnd={onFoldEnd}
        >
          <span className="flap-char">{c}</span>
        </div>
      )}
    </div>
  )
}

// ── FlipColon ──────────────────────────────────────────────────────────────

function FlipColon() {
  return <div className="flap-colon" aria-hidden="true">:</div>
}

// ── FlipClock ──────────────────────────────────────────────────────────────

interface FlipClockProps {
  reduce: boolean
  /** Skip the 00:00:00 → current-time riffle (use on back-navigation). */
  instant?: boolean
}

export default function FlipClock({ reduce, instant = false }: FlipClockProps) {
  // Mount at 00:00:00 so each digit riffles to the real time on first effect,
  // giving the Solari entrance. Under reduced-motion or on a back-nav (instant),
  // start directly at the current time.
  const [digits, setDigits] = useState<number[]>(() =>
    reduce || instant ? getDigits(new Date()) : [0, 0, 0, 0, 0, 0],
  )
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // Show the real current time (triggers riffle from 00:00:00 for each digit).
    if (!reduce && !instant) setDigits(getDigits(new Date()))

    // Align ticks to the wall-clock second boundary to avoid drift.
    function scheduleTick() {
      const delay = 1000 - (Date.now() % 1000)
      timerRef.current = setTimeout(() => {
        setDigits(getDigits(new Date()))
        scheduleTick()
      }, delay)
    }
    scheduleTick()

    // Snap to current time when the tab becomes visible again after being hidden.
    function onVisibility() {
      if (!document.hidden) setDigits(getDigits(new Date()))
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  const [h1, h2, m1, m2, s1, s2] = digits

  return (
    <div className="flip-clock" role="timer" aria-label="Current time">
      <div className="flap-group">
        <FlipDigit value={h1} reduce={reduce} />
        <FlipDigit value={h2} reduce={reduce} />
      </div>
      <FlipColon />
      <div className="flap-group">
        <FlipDigit value={m1} reduce={reduce} />
        <FlipDigit value={m2} reduce={reduce} />
      </div>
      <FlipColon />
      <div className="flap-group">
        <FlipDigit value={s1} reduce={reduce} />
        <FlipDigit value={s2} reduce={reduce} />
      </div>
    </div>
  )
}
