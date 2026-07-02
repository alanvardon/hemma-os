import { useEffect, useRef } from 'react'
import { overscanGeometry, parseHexColor, isCopperRow } from '../lib/heroScene'

/* The original 2D-canvas hero terrain, now the fallback / loading layer under
   the WebGL scene (HeroScene). It renders ONLY the canvas — the parent
   orchestrator (HeroCanvas) owns the `.hero-wrap` box and passes it in via
   `wrapRef` for sizing, mask-var anchoring and pointer parallax. Because the
   wrap outlives this component (it stays mounted while the WebGL layer takes
   over), every listener added to it or to `document` MUST be removed on
   cleanup — a leaked visibilitychange handler would restart the rAF loop on a
   detached canvas. */
export default function HeroCanvas2D({ wrapRef }: { wrapRef: React.RefObject<HTMLDivElement | null> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return

    const ctx = canvas.getContext('2d')!
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const ROWS = 26
    const SPAN_X_BASE = 1.3
    const SPAN_Z = 1.55
    const FOV = 1.6
    const CAM = 1.4
    const BASE_PITCH = -0.55

    let W = 0, H = 0, DPR = 1, COLS = 96
    let SPAN_X = SPAN_X_BASE
    // Reference (pre-overscan) width — kept separate from the (wider) canvas
    // width W so the projection's pixel-density stays constant into the
    // overscan margin instead of the extra width "zooming" the whole scene.
    let REF_W = 0
    let raf: number | null = null
    let t0: number | null = null
    let targetYaw = 0, targetPitch = 0, yaw = 0, pitchOff = 0
    let colors = {
      accent: [46, 93, 62] as [number, number, number],
      copper: [176, 107, 56] as [number, number, number],
    }

    function readColors() {
      const style = getComputedStyle(document.documentElement)
      // Read the hex alias vars — tokens.css OKLCH values aren't parseable as hex
      colors.accent = parseHexColor(style.getPropertyValue('--canvas-accent'), colors.accent)
      colors.copper = parseHexColor(style.getPropertyValue('--canvas-copper'), colors.copper)
    }

    function rgba(rgb: [number, number, number], a: number) {
      return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`
    }

    function elevation(x: number, z: number, time: number) {
      return 0.16 * Math.sin(x * 2.1 + time * 0.55)
           + 0.11 * Math.sin(x * 3.7 - z * 2.3 + time * 0.35)
           + 0.07 * Math.sin((x + z) * 5.3 + time * 0.7)
           + 0.05 * Math.sin(z * 4.1 - time * 0.45)
    }

    function project(x: number, y: number, z: number) {
      const zc = z - SPAN_Z / 2
      const cy = Math.cos(yaw), sy = Math.sin(yaw)
      const x1 = x * cy - zc * sy
      const z1 = x * sy + zc * cy
      const pitch = BASE_PITCH + pitchOff
      const cx = Math.cos(pitch), sx = Math.sin(pitch)
      const y2 = y * cx - z1 * sx
      const z2 = y * sx + z1 * cx
      const s = FOV / (FOV + z2 + CAM)
      return { x: W * 0.5 + x1 * s * REF_W * 0.55, y: H * 0.55 - y2 * s * H * 0.85, s }
    }

    function draw(time: number) {
      ctx.clearRect(0, 0, W, H)
      for (let r = ROWS - 1; r >= 0; r--) {
        const z = (r / (ROWS - 1)) * SPAN_Z
        const isCopper = isCopperRow(r)
        const rgb = isCopper ? colors.copper : colors.accent
        let first: { x: number; y: number; s: number } | null = null
        ctx.beginPath()
        for (let c = 0; c <= COLS; c++) {
          const x = (c / COLS) * SPAN_X * 2 - SPAN_X
          const p = project(x, elevation(x, z, time), z)
          if (c === 0) { ctx.moveTo(p.x, p.y); first = p }
          else ctx.lineTo(p.x, p.y)
        }
        const depth = first!.s
        ctx.strokeStyle = rgba(rgb, (isCopper ? 0.30 : 0.38) * depth * depth)
        ctx.lineWidth = 1.1 * depth
        ctx.stroke()
        ctx.fillStyle = rgba(rgb, 0.5 * depth * depth)
        for (let d = 2; d < COLS; d += 4) {
          const xd = (d / COLS) * SPAN_X * 2 - SPAN_X
          const pd = project(xd, elevation(xd, z, time), z)
          ctx.beginPath()
          ctx.arc(pd.x, pd.y, 1.4 * pd.s, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }

    function frame(ts: number) {
      if (t0 === null) t0 = ts
      yaw += (targetYaw - yaw) * 0.04
      pitchOff += (targetPitch - pitchOff) * 0.04
      draw((ts - t0) * 0.001)
      raf = requestAnimationFrame(frame)
    }

    function start() {
      if (raf === null && !reduceMotion) raf = requestAnimationFrame(frame)
    }

    function stop() {
      if (raf !== null) { cancelAnimationFrame(raf); raf = null }
    }

    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2)
      const w0 = wrap!.clientWidth
      REF_W = w0
      H = wrap!.clientHeight
      const geo = overscanGeometry(w0)
      W = geo.width
      SPAN_X = SPAN_X_BASE * geo.spanScale
      // Grow column count with sqrt(spanScale) rather than 1:1 — keeps the
      // overscan margin from reading as sparser than the core without paying
      // for a full linear density match (this runs every animation frame).
      const baseCols = w0 < 640 ? 64 : 96
      COLS = Math.round(baseCols * Math.sqrt(geo.spanScale))
      canvas!.style.left = `${-geo.marginX}px`
      canvas!.style.width = `${W}px`
      canvas!.width = W * DPR
      canvas!.height = H * DPR
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
      // Re-anchor the horizontal mask fade to where it fell on the original
      // (un-overscanned) box, so the vignette at the real hero edges is
      // unchanged — see the .hero-canvas comment in home.css.
      wrap!.style.setProperty('--hc-fade-in', `${geo.fadeInPx}px`)
      wrap!.style.setProperty('--hc-fade-out', `${geo.fadeOutPx}px`)
      if (reduceMotion) draw(7.3)
    }

    const onResize = () => resize()
    window.addEventListener('resize', onResize)

    const onPointerMove = (e: PointerEvent) => {
      const rect = wrap.getBoundingClientRect()
      targetYaw = ((e.clientX - rect.left) / rect.width - 0.5) * 0.14
      targetPitch = ((e.clientY - rect.top) / rect.height - 0.5) * 0.07
    }
    const onPointerLeave = () => {
      targetYaw = 0
      targetPitch = 0
    }
    const onVisibility = () => {
      if (document.hidden) stop(); else start()
    }
    if (!reduceMotion) {
      wrap.addEventListener('pointermove', onPointerMove)
      wrap.addEventListener('pointerleave', onPointerLeave)
      document.addEventListener('visibilitychange', onVisibility)
    }

    const observer = new MutationObserver(() => {
      readColors()
      if (reduceMotion) draw(7.3)
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    readColors()
    resize()
    start()

    return () => {
      stop()
      window.removeEventListener('resize', onResize)
      wrap.removeEventListener('pointermove', onPointerMove)
      wrap.removeEventListener('pointerleave', onPointerLeave)
      document.removeEventListener('visibilitychange', onVisibility)
      observer.disconnect()
    }
  }, [wrapRef])

  return <canvas ref={canvasRef} className="hero-canvas" aria-hidden="true" />
}
