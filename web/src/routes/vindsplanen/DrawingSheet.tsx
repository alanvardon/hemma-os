// The builder's drawing sheet (plan 145): renders the pure plan and section
// drawings from lib/vindsplanen/drawing.ts as SVG, always black on white, and
// wraps them in a full-screen view with Print / Close. All geometry comes from
// drawing.ts; this file only draws primitives and lays the sheet out.
//
// Scale: the SVG is sized in real millimetres. Each figure gets the largest
// standard scale (1:50 first) at which it fits an A4 landscape page, so a
// print at 100% really is that scale; the title block states which.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Geometry } from '../../lib/vindsplanen/attic'
import type { PlanV2 } from '../../lib/vindsplanen/plan'
import { isUpStair } from '../../lib/vindsplanen/stairs'
import { DIM_UNIT, planDrawing, sectionDrawing, type Drawing, type PlanDrawing, type Prim, type Pt } from '../../lib/vindsplanen/drawing'

const SCALES = [50, 75, 100, 125, 150, 200, 250, 300, 400, 500]
/** Usable paper for one figure on A4 landscape (10 mm margins, title block and caption below). */
const MAX_W_MM = 277
const MAX_H_MM = 135
const PAD_MM = 12
const STRIP_MM = 16
const INK = '#111'

interface Fig {
  scale: number
  /** metres per millimetre of paper */
  u: number
  vb: [number, number, number, number]
  wMm: number
  hMm: number
}

/** The largest standard scale at which the drawing (plus margin) fits one page. */
function fitFigure(d: Drawing, strip: boolean): Fig {
  const [[x0, z0], [x1, z1]] = d.bounds
  const bw = x1 - x0
  const bh = z1 - z0
  let scale = SCALES[SCALES.length - 1]
  for (const s of SCALES) {
    const u = s / 1000
    const w = bw / u + 2 * PAD_MM
    const h = bh / u + 2 * PAD_MM + (strip ? STRIP_MM : 0)
    if (w <= MAX_W_MM && h <= MAX_H_MM) {
      scale = s
      break
    }
  }
  const u = scale / 1000
  const wMm = bw / u + 2 * PAD_MM
  const hMm = bh / u + 2 * PAD_MM + (strip ? STRIP_MM : 0)
  return { scale, u, vb: [x0 - PAD_MM * u, z0 - PAD_MM * u, wMm * u, hMm * u], wMm, hMm }
}

const fmtNum = (n: number) => (Math.round(n * 1e4) / 1e4).toString()
const pt = (p: Pt) => `${fmtNum(p[0])},${fmtNum(p[1])}`

function PrimView({ p, u }: { p: Prim; u: number }) {
  switch (p.k) {
    case 'line':
      return <line className={`vp-d-${p.style}`} x1={p.a[0]} y1={p.a[1]} x2={p.b[0]} y2={p.b[1]} />
    case 'poly':
      return <polygon className={`vp-d-${p.style}`} points={p.pts.map(pt).join(' ')} />
    case 'rect':
      return (
        <rect
          className={`vp-d-${p.style}`}
          x={-p.w / 2}
          y={-p.h / 2}
          width={p.w}
          height={p.h}
          transform={`translate(${fmtNum(p.at[0])} ${fmtNum(p.at[1])}) rotate(${fmtNum(-p.rot)})`}
        />
      )
    case 'dim': {
      const dx = p.b[0] - p.a[0]
      const dz = p.b[1] - p.a[1]
      const len = Math.hypot(dx, dz)
      const nx = -dz / len
      const nz = dx / len
      const s = p.offset < 0 ? -1 : 1
      const ox = nx * p.offset
      const oz = nz * p.offset
      const a2: Pt = [p.a[0] + ox, p.a[1] + oz]
      const b2: Pt = [p.b[0] + ox, p.b[1] + oz]
      const gap = 1 * u
      const over = 1.5 * u
      const tick = 1.2 * u
      const ux = dx / len
      const uz = dz / len
      // extension lines: from just off the measured point to just past the dimension line
      const ext = (q: Pt, q2: Pt) => (
        <line key={pt(q)} className="vp-d-ext" x1={q[0] + nx * gap * s} y1={q[1] + nz * gap * s} x2={q2[0] + nx * over * s} y2={q2[1] + nz * over * s} />
      )
      let ang = (Math.atan2(dz, dx) * 180) / Math.PI
      if (ang >= 90) ang -= 180
      else if (ang < -90) ang += 180
      const mid: Pt = [(a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2]
      // a 45-degree slash across each end, as on a builder's drawing
      const slash = (q: Pt) => (
        <line key={'t' + pt(q)} className="vp-d-tick" x1={q[0] - (ux - nx) * tick} y1={q[1] - (uz - nz) * tick} x2={q[0] + (ux - nx) * tick} y2={q[1] + (uz - nz) * tick} />
      )
      return (
        <g>
          {ext(p.a, a2)}
          {ext(p.b, b2)}
          <line className="vp-d-dim" x1={a2[0]} y1={a2[1]} x2={b2[0]} y2={b2[1]} />
          {slash(a2)}
          {slash(b2)}
          <text className="vp-d-text" fontSize={2 * u} textAnchor="middle" transform={`translate(${fmtNum(mid[0])} ${fmtNum(mid[1])}) rotate(${fmtNum(ang)})`} dy={-0.7 * u}>
            {p.text}
          </text>
        </g>
      )
    }
    case 'label':
      return (
        <text className="vp-d-text vp-d-label" fontSize={2.2 * u} textAnchor="middle" x={p.at[0]} y={p.at[1]} dy={p.sub ? -0.3 * u : 0.9 * u}>
          {p.text}
          {p.sub && (
            <tspan x={p.at[0]} dy={2.6 * u} fontSize={1.8 * u} className="vp-d-sub">
              {p.sub}
            </tspan>
          )}
        </text>
      )
  }
}

/** Scale bar (0 – 1 – 2 m) and, when the plan has a site, the north arrow, in the strip under the plan. */
function Strip({ fig, d }: { fig: Fig; d: PlanDrawing }) {
  const { u } = fig
  const [[x0], [, z1]] = d.bounds
  const y = z1 + PAD_MM * u + 6 * u
  const x = x0
  const northDeg = d.north ? (Math.atan2(d.north.dir[1], d.north.dir[0]) * 180) / Math.PI + 90 : 0
  return (
    <g>
      <g className="vp-d-scalebar">
        <line className="vp-d-wall" x1={x} y1={y} x2={x + 2} y2={y} />
        {[0, 1, 2].map((m) => (
          <g key={m}>
            <line className="vp-d-thin" x1={x + m} y1={y - 1.2 * u} x2={x + m} y2={y + 1.2 * u} />
            <text className="vp-d-text" fontSize={2.1 * u} textAnchor="middle" x={x + m} y={y + 4.2 * u}>
              {m === 2 ? '2 m' : String(m)}
            </text>
          </g>
        ))}
      </g>
      {d.north && (
        <g transform={`translate(${fmtNum(fig.vb[0] + fig.vb[2] - PAD_MM * u - 4 * u)} ${fmtNum(y)}) rotate(${fmtNum(northDeg)})`}>
          <polygon points={`0,${-5 * u} ${2 * u},${2.5 * u} 0,${1 * u} ${-2 * u},${2.5 * u}`} fill={INK} />
          <text className="vp-d-text" fontSize={2.6 * u} textAnchor="middle" x={0} y={-6.2 * u} transform={`rotate(${fmtNum(-northDeg)} 0 ${fmtNum(-6.2 * u)})`}>
            N
          </text>
        </g>
      )}
    </g>
  )
}

function FigureSvg({ d, fig, label, children }: { d: Drawing; fig: Fig; label: string; children?: React.ReactNode }) {
  return (
    <svg
      className="vp-sheet-svg"
      role="img"
      aria-label={label}
      viewBox={fig.vb.map(fmtNum).join(' ')}
      style={{ ['--w' as string]: `${fig.wMm}mm`, ['--h' as string]: `${fig.hMm}mm` }}
    >
      <defs>
        <pattern id="vp-hatch" width={2 * fig.u} height={2 * fig.u} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2={2 * fig.u} stroke={INK} strokeWidth="1" vectorEffect="non-scaling-stroke" />
        </pattern>
      </defs>
      <rect x={fig.vb[0]} y={fig.vb[1]} width={fig.vb[2]} height={fig.vb[3]} fill="#fff" />
      {d.prims.map((p, i) => (
        <PrimView key={i} p={p} u={fig.u} />
      ))}
      {children}
    </svg>
  )
}

function TitleBlock({ title, date, fig, extra }: { title: string; date: string; fig: Fig; extra?: string }) {
  return (
    <dl className="vp-sheet-title">
      <div>
        <dt>Plan</dt>
        <dd>{title}</dd>
      </div>
      <div>
        <dt>Date</dt>
        <dd>{date}</dd>
      </div>
      <div>
        <dt>Scale</dt>
        <dd>
          1:{fig.scale} on A4 landscape at 100%; not to scale if printed smaller or on screen
          {extra ? ` · ${extra}` : ''}
        </dd>
      </div>
      <div>
        <dt>Units</dt>
        <dd>Dimensions in {DIM_UNIT}</dd>
      </div>
      <p>Drawn in Hemma·OS — check all measurements on site</p>
    </dl>
  )
}

const STAIR_NAME = { stairs: 'Stairs', spiral: 'Spiral stairs', curved: 'Turning stairs' } as const

export function DrawingSheet({ geo, plan, title = 'Vindsplanen', date = new Date() }: { geo: Geometry; plan: PlanV2; title?: string; date?: Date }) {
  const dateText = date.toLocaleDateString('sv-SE')
  const pd = useMemo(() => planDrawing(geo, plan), [geo, plan])
  const planFig = useMemo(() => fitFigure(pd, true), [pd])
  const sections = useMemo(() => {
    const out: { id: string; name: string; d: Drawing; fig: Fig }[] = []
    let n = 0
    for (const it of plan.items) {
      if (it.type !== 'stairs' && !isUpStair(it)) continue
      n++
      const d = sectionDrawing(geo, plan, it.id)
      if (d) out.push({ id: it.id, name: `${STAIR_NAME[it.type]} ${n}`, d, fig: fitFigure(d, false) })
    }
    return out
  }, [geo, plan])

  return (
    <div className="vp-sheet-doc">
      <figure className="vp-sheet-fig">
        <figcaption>Plan, seen from above</figcaption>
        <FigureSvg d={pd} fig={planFig} label="Plan of the attic seen from above">
          <Strip fig={planFig} d={pd} />
        </FigureSvg>
        <TitleBlock title={title} date={dateText} fig={planFig} />
      </figure>
      {sections.map((s) => (
        <figure key={s.id} className="vp-sheet-fig">
          <figcaption>Section through {s.name.toLowerCase()}, looking east (north on the left)</figcaption>
          <FigureSvg d={s.d} fig={s.fig} label={`Section through ${s.name.toLowerCase()}`} />
          <TitleBlock title={title} date={dateText} fig={s.fig} />
        </figure>
      ))}
    </div>
  )
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/** The full-screen sheet view: Print, Close, zoom; Esc closes; focus moves in and back. */
export default function DrawingView({ geo, plan, onClose, title, date }: { geo: Geometry; plan: PlanV2; onClose: () => void; title?: string; date?: Date }) {
  const root = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const closeBtn = useRef<HTMLButtonElement>(null)
  const [zoom, setZoom] = useState(1)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  // focus in, and back to the opener on close; lock page scroll; mark the body for print CSS
  useLayoutEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    closeBtn.current?.focus({ preventScroll: true })
    document.body.classList.add('vp-sheet-open')
    return () => {
      document.body.classList.remove('vp-sheet-open')
      prev?.focus?.({ preventScroll: true })
    }
  }, [])

  // fit the first figure to the screen width on open (never above 100%)
  useLayoutEffect(() => {
    const el = scroller.current
    const svg = el?.querySelector<SVGSVGElement>('.vp-sheet-svg')
    if (!el || !svg) return
    const w = (parseFloat(svg.style.getPropertyValue('--w')) * 96) / 25.4
    const avail = el.clientWidth - 24
    if (w > 0 && avail > 0) setZoom(Math.max(0.2, Math.min(1, avail / w)))
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCloseRef.current()
      } else if (e.key === 'Tab' && root.current) {
        const f = Array.from(root.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => !x.hasAttribute('disabled'))
        if (!f.length) return
        const first = f[0]
        const last = f[f.length - 1]
        const act = document.activeElement
        if (e.shiftKey && act === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && act === last) {
          e.preventDefault()
          first.focus()
        } else if (!root.current.contains(act)) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return createPortal(
    <div ref={root} className="vp-sheet-view" role="dialog" aria-modal="true" aria-label="Builder's drawing">
      <div className="vp-sheet-bar">
        <h2>Drawing</h2>
        <div className="vp-sheet-zoom" role="group" aria-label="Zoom">
          <button type="button" className="btn btn-ghost" onClick={() => setZoom((z) => Math.max(0.2, z / 1.25))} aria-label="Zoom out">
            −
          </button>
          <span aria-live="polite">{Math.round(zoom * 100)}%</span>
          <button type="button" className="btn btn-ghost" onClick={() => setZoom((z) => Math.min(4, z * 1.25))} aria-label="Zoom in">
            +
          </button>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>
          Print
        </button>
        <button ref={closeBtn} type="button" className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <div ref={scroller} className="vp-sheet-scroll" tabIndex={0} aria-label="Drawing sheet, scrollable" style={{ ['--vp-zoom' as string]: zoom }}>
        <DrawingSheet geo={geo} plan={plan} title={title} date={date} />
      </div>
    </div>,
    document.body,
  )
}
