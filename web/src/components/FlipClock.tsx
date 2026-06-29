import { useEffect, useRef, useState } from 'react'
import { forwardSteps, getDigits } from '../lib/flipClock'

// ── FlipDigit ──────────────────────────────────────────────────────────────
// One split-flap digit cell. Manages its own riffle queue.
//
// Animation is two-beat: fold-out (old top falls back, 0→-90°) then fold-in
// (new top swings in from front, 90°→0°). This requires a phase state machine
// so the two animations run sequentially, not simultaneously.
//
// Crucially, the perspective container (.flap-digit) must NOT have
// overflow:hidden — that collapses the 3D coordinate space and makes the
// rotateX render as a flat 2D squash. Corner clipping is handled instead by
// border-radius on the individual half-card layers.

type Phase = 'idle' | 'out' | 'in'

const CHARS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

function FlipDigit({ value, reduce }: { value: number; reduce: boolean }) {
  const [shown, setShown] = useState(value)
  const [phase, setPhase] = useState<Phase>('idle')
  const [flapNext, setFlapNext] = useState<number | null>(null)

  const shownRef = useRef(value)
  const phaseRef = useRef<Phase>('idle')
  const queueRef = useRef<number[]>([])

  useEffect(() => {
    const steps = forwardSteps(shownRef.current, value)
    if (!steps.length) return
    if (reduce) {
      setShown(value); shownRef.current = value
      setPhase('idle'); phaseRef.current = 'idle'
      setFlapNext(null); queueRef.current = []
      return
    }
    queueRef.current = steps
    startNext()
  }, [value, reduce])

  function startNext() {
    if (phaseRef.current !== 'idle') return
    const n = queueRef.current.shift()
    if (n === undefined) return
    phaseRef.current = 'out'
    setPhase('out')
    setFlapNext(n)
  }

  // Beat 1 ends: advance shown, start beat 2 (fold-in)
  function onFoldOutEnd() {
    const n = flapNext!
    setShown(n); shownRef.current = n
    phaseRef.current = 'in'
    setPhase('in')
    // flapNext stays as n; fold-in uses the newly-shown digit
  }

  // Beat 2 ends: back to idle, drain next queued step
  function onFoldInEnd() {
    phaseRef.current = 'idle'
    setPhase('idle')
    setFlapNext(null)
    startNext()
  }

  const c = CHARS[shown]
  const nc = flapNext !== null ? CHARS[flapNext] : null

  return (
    <div className="flap-digit">
      {/* Lower half of next — sits behind current bottom, revealed by fold-out */}
      {phase === 'out' && nc && (
        <div className="flap-half flap-bottom flap-next-bot">
          <div className="flap-char-wrap"><span className="flap-char">{nc}</span></div>
        </div>
      )}
      {/* Static bottom */}
      <div className="flap-half flap-bottom">
        <div className="flap-char-wrap"><span className="flap-char">{c}</span></div>
      </div>
      {/* Static top — shows current digit behind/beneath the fold */}
      <div className="flap-half flap-top">
        <div className="flap-char-wrap"><span className="flap-char">{c}</span></div>
      </div>
      {/* Beat 1: old top folds backward (0 → -90°) */}
      {phase === 'out' && nc && (
        <div
          key={'out' + nc}
          className="flap-half flap-top flap-fold-out"
          onAnimationEnd={onFoldOutEnd}
        >
          <div className="flap-char-wrap"><span className="flap-char">{CHARS[shown]}</span></div>
        </div>
      )}
      {/* Beat 2: new top swings in from front (90° → 0°) */}
      {phase === 'in' && (
        <div
          key={'in' + c}
          className="flap-half flap-top flap-fold-in"
          onAnimationEnd={onFoldInEnd}
        >
          <div className="flap-char-wrap"><span className="flap-char">{c}</span></div>
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
  const [digits, setDigits] = useState<number[]>(() =>
    reduce || instant ? getDigits(new Date()) : [0, 0, 0, 0, 0, 0],
  )
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!reduce && !instant) setDigits(getDigits(new Date()))

    function scheduleTick() {
      const delay = 1000 - (Date.now() % 1000)
      timerRef.current = setTimeout(() => {
        setDigits(getDigits(new Date()))
        scheduleTick()
      }, delay)
    }
    scheduleTick()

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
