// Gå runt: first-person walk through the plan at eye height (v41 1772–1865).
// Mounted while walking: it takes the camera over through the SceneHandle
// (orbit off, a frame hook), applies the pure `walkStep` from
// lib/vindsplanen/walk.ts every frame, and gives the camera back on unmount.
// Desktop: W/A/S/D or the arrow keys, Shift to hurry, drag to look, Esc to
// leave. Touch: the stick walks and turns, a drag on the view looks around.

import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type RefObject } from 'react'
import type { Geometry } from '../../lib/vindsplanen/attic'
import type { PlanV2 } from '../../lib/vindsplanen/plan'
import {
  addInputs,
  EYE,
  fpPlace,
  keysInput,
  mustStoop,
  stickInput,
  walkCamera,
  walkExitCamera,
  walkLook,
  walkStep,
  walkWorld,
  type WalkInput,
  type WalkState,
  type Where,
} from '../../lib/vindsplanen/walk'
import type { SceneHandle } from './scene/Scene'
import { headText, WHERE_TEXT } from './walkText'

const WALK_KEYS = new Set(['w', 'a', 's', 'd', 'shift', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'])
const FOV_WALK = 70
const FOV_ORBIT = 48
const NO_INPUT: WalkInput = { f: 0, sd: 0, turn: 0 }

type Start = 'below' | 'attic'

export default function WalkMode({
  sceneRef, geo, plan, onExit,
}: {
  sceneRef: RefObject<SceneHandle | null>
  geo: Geometry
  plan: PlanV2
  onExit: () => void
}) {
  // the walk follows edits made while walking (v41 `_fpRefresh`)
  const world = useMemo(() => walkWorld(geo, plan), [geo, plan])
  const live = useRef({ geo, plan, world })
  useEffect(() => {
    live.current = { geo, plan, world }
  })
  const walker = useRef<WalkState | null>(null)
  const keys = useRef(new Set<string>())
  const stick = useRef<WalkInput>(NO_INPUT)
  const [where, setWhere] = useState<Where | ''>('')
  const [head, setHead] = useState<number | null>(null)
  const exitBtn = useRef<HTMLButtonElement>(null)
  const onExitRef = useRef(onExit)
  useEffect(() => {
    onExitRef.current = onExit
  })

  const place = (at: Start) => {
    const { geo: g, plan: p, world: w } = live.current
    const s = fpPlace(g, p, w, at) ?? fpPlace(g, p, w, 'attic')
    if (s) walker.current = { x: s.x, z: s.z, feet: s.feet, where: s.where, yaw: s.yaw, pitch: s.pitch, eyeY: s.eyeY }
    else walker.current ??= { x: g.L / 2, z: 0, feet: 0, where: 'attic', yaw: Math.PI, pitch: -0.05, eyeY: EYE }
    keys.current.clear()
  }

  // take the camera over; give it back, looking where you were looking, on the way out
  useEffect(() => {
    const scene = sceneRef.current
    place('below')
    const run = (input: WalkInput, dt: number) => {
      const s = walker.current
      if (!s) return
      const { geo: g, plan: p, world: w } = live.current
      const r = walkStep(g, p, w, s, input, dt)
      walker.current = r.state
      setWhere(r.state.where)
      setHead(r.head)
    }
    if (scene) {
      scene.setOrbitEnabled(false)
      const cam = scene.getCamera()
      if (cam) {
        cam.fov = FOV_WALK
        cam.updateProjectionMatrix()
      }
      scene.setFrameHook((dt, camera) => {
        run(addInputs(keysInput(keys.current), stick.current), dt)
        const s = walker.current
        if (!s) return
        const c = walkCamera(s)
        camera.position.set(...c.p)
        camera.lookAt(...c.t)
      })
    } else run(NO_INPUT, 0)
    exitBtn.current?.focus({ preventScroll: true })
    // a hook for the parity scripts (plan 140 Stage 5): dev server only, never in a production build
    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).__vpWalk = {
        get: () => walker.current,
        set: (s: Partial<WalkState>) => {
          if (walker.current) walker.current = { ...walker.current, ...s }
          run(NO_INPUT, 0)
        },
        step: (input: WalkInput, dt: number) => run(input, dt),
        place: (at: Start) => {
          place(at)
          run(NO_INPUT, 0)
        },
      }
    }
    return () => {
      if (import.meta.env.DEV) delete (window as unknown as Record<string, unknown>).__vpWalk
      if (!scene) return
      scene.setFrameHook(null)
      const cam = scene.getCamera()
      if (cam) {
        cam.fov = FOV_ORBIT
        cam.updateProjectionMatrix()
      }
      if (walker.current) scene.flyTo(walkExitCamera(walker.current), { instant: true })
      scene.setOrbitEnabled(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per walk; the latest plan is read through `live`
  }, [sceneRef])

  // keys (ignored while typing in a field), Esc leaves
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const tag = ((e.target as HTMLElement | null)?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      if (e.key === 'Escape') {
        onExitRef.current()
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (WALK_KEYS.has(k)) {
        keys.current.add(k)
        e.preventDefault()
      }
    }
    const up = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase())
    const blur = () => {
      keys.current.clear()
      stick.current = NO_INPUT
    }
    document.addEventListener('keydown', down)
    document.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      document.removeEventListener('keydown', down)
      document.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  // drag on the view to look (v41 drags rather than locking the pointer)
  useEffect(() => {
    const el = sceneRef.current?.getCanvas()
    if (!el) return
    let look: { x: number; y: number; id: number } | null = null
    const down = (e: PointerEvent) => {
      look = { x: e.clientX, y: e.clientY, id: e.pointerId }
      el.setPointerCapture?.(e.pointerId)
    }
    const move = (e: PointerEvent) => {
      if (!look || e.pointerId !== look.id || !walker.current) return
      walker.current = walkLook(walker.current, e.clientX - look.x, e.clientY - look.y)
      look = { ...look, x: e.clientX, y: e.clientY }
    }
    const end = () => {
      look = null
    }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', end)
      el.removeEventListener('pointercancel', end)
    }
  }, [sceneRef])

  const stoop = head != null && mustStoop(head)
  return (
    <div className="vp-walk" role="region" aria-label="Gå runt">
      <div className="vp-walk-info">
        <div className="vp-walk-where">{where ? WHERE_TEXT[where] : ''}</div>
        <div className={'vp-walk-head' + (stoop ? ' is-warn' : '')} aria-live="polite">
          {head != null && (
            <>
              {stoop && <span className="vp-sr">Varning: </span>}
              {headText(head, where, !!plan.options.measured.B9)}
            </>
          )}
        </div>
        <p className="vp-walk-help">W A S D eller piltangenterna, Skift för att skynda. Dra för att se dig om.</p>
        <div className="vp-walk-acts">
          <button type="button" className="btn btn-ghost" onClick={() => place('below')}>Starta nere</button>
          <button type="button" className="btn btn-ghost" onClick={() => place('attic')}>Starta på vinden</button>
          <button ref={exitBtn} type="button" className="btn btn-primary" onClick={onExit} title="Esc">Sluta gå</button>
        </div>
      </div>
      <Stick onChange={(v) => { stick.current = v }} />
    </div>
  )
}

/** The touch stick: drag the knob; up walks, down backs, sideways turns. */
function Stick({ onChange }: { onChange: (v: WalkInput) => void }) {
  const base = useRef<HTMLDivElement>(null)
  const [knob, setKnob] = useState<[number, number]>([0, 0])
  const active = useRef<number | null>(null)
  const track = (e: RPointerEvent) => {
    const el = base.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const rad = r.width / 2
    let dx = e.clientX - (r.left + rad)
    let dy = e.clientY - (r.top + rad)
    const d = Math.hypot(dx, dy)
    if (d > rad) {
      dx = (dx / d) * rad
      dy = (dy / d) * rad
    }
    setKnob([dx, dy])
    onChange(stickInput(dx, dy, rad))
  }
  const release = () => {
    active.current = null
    setKnob([0, 0])
    onChange(NO_INPUT)
  }
  return (
    <div
      ref={base}
      className="vp-stick"
      aria-hidden="true"
      onPointerDown={(e) => {
        e.preventDefault()
        active.current = e.pointerId
        e.currentTarget.setPointerCapture?.(e.pointerId)
        track(e)
      }}
      onPointerMove={(e) => {
        if (active.current === e.pointerId) track(e)
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
    >
      <i style={{ transform: `translate(${knob[0]}px, ${knob[1]}px)` }} />
    </div>
  )
}
