import { Component, lazy, Suspense, useCallback, useRef, useState } from 'react'
import HeroCanvas2D from './HeroCanvas2D'

/* Hero background orchestrator (plan 28a). Owns the `.hero-wrap` box and
   decides which terrain layer renders inside it:

   1. ≤600px, reduced motion, WebGL unavailable, or a previous GL failure this
      session → HeroCanvas2D only (exactly the pre-WebGL experience; the 2D
      layer already handles reduced-motion with a single static frame).
   2. Otherwise: HeroCanvas2D paints immediately while the lazy HeroScene
      chunk loads (first paint is never blocked by three.js), then the WebGL
      scene crossfades in over its first frames and the 2D layer unmounts.

   The ladder is decided once per mount — a mid-session viewport resize across
   600px keeps whichever layer it started with (both work at any size; the
   cutoff only exists so phones never fetch the three.js chunk). */

const HeroScene = lazy(() => import('./HeroScene'))

const GL_FAILED_KEY = 'hemma-hero-gl-failed'

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    return false
  }
}

function wantsWebgl(): boolean {
  if (typeof window === 'undefined') return false
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
  if (window.matchMedia('(max-width: 600px)').matches) return false
  try {
    if (sessionStorage.getItem(GL_FAILED_KEY)) return false
  } catch { /* storage blocked — just probe */ }
  return webglAvailable()
}

/* A render/creation error inside the lazy scene must degrade to the 2D
   canvas, never crash the hub. */
class SceneBoundary extends Component<
  { onFail: () => void; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch() {
    this.props.onFail()
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

export default function HeroCanvas({ children }: { children: React.ReactNode }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [gl, setGl] = useState(() => wantsWebgl())
  // Keep the 2D layer mounted under the GL scene until the crossfade lands
  const [glSettled, setGlSettled] = useState(false)

  const onFail = useCallback(() => {
    try {
      sessionStorage.setItem(GL_FAILED_KEY, '1')
    } catch { /* fine — the state flip below covers this session */ }
    setGl(false)
    setGlSettled(false)
  }, [])

  const onReady = useCallback(() => {
    // .hero-canvas-gl fades in over 0.4s (home.css); retire the 2D loop after
    setTimeout(() => setGlSettled(true), 450)
  }, [])

  return (
    <div ref={wrapRef} className="hero-wrap">
      {(!gl || !glSettled) && <HeroCanvas2D wrapRef={wrapRef} />}
      {gl && (
        <SceneBoundary onFail={onFail}>
          <Suspense fallback={null}>
            <HeroScene wrapRef={wrapRef} onReady={onReady} onFail={onFail} />
          </Suspense>
        </SceneBoundary>
      )}
      {children}
    </div>
  )
}
