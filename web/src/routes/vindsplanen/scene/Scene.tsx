// The Vindsplanen 3D view: a lazy chunk (`lazy(() => import('./scene/Scene'))`)
// and the only part of the tool that imports three.js. R3F owns the renderer,
// resize and the frame loop; each v41 `build*()` is an imperative builder in
// this folder, mounted with <primitive> from a useMemo keyed on the plan
// slices it reads and disposed when it is replaced or unmounted.
//
// Ported from v41 (planning/140-vindsplanen-ref/vindsplanen-v41.html):
// renderer/lights/sky 544–591, cut-away 1429–1440, picking & drag 1441–1475,
// cameras 1476–1494, composer 1496–1503, frame loop 1553–1575. Photo mode
// (path tracing) is out of scope (plan 140, Decisions).

import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { atticOf, clamp, deriveGeometry, snap, type Geometry } from '../../../lib/vindsplanen/attic'
import { withFittedClosets } from '../../../lib/vindsplanen/items'
import { cameraPresets, type Camera } from '../../../lib/vindsplanen/measure'
import type { Item, PlanV2, ViewPrefs } from '../../../lib/vindsplanen/plan'
import { buildBelow } from './belowScene'
import { buildDims, buildHighlights, type MeasureHighlight } from './dims'
import { buildItem } from './itemsScene'
import { createMats, ENV_INTENSITY, EXPOSURE, skyTexture, SUN_STYLE, type SceneMats } from './materials'
import { buildBoard, buildEast, buildEastLabel, buildFloors, buildKnee, buildRafters, buildSlopes, buildWestGable, buildZones } from './shell'
import { disposeBuilt, disposeObject, type Built, type LabelData } from './util'

export type { MeasureHighlight } from './dims'
export type CameraPresetId = keyof ReturnType<typeof cameraPresets>

/** The fields a drag changes: x, and z for everything but partition walls and storage rooms. */
export type MovePatch = { x: number; z?: number }

export interface SceneProps {
  plan: PlanV2
  view: ViewPrefs
  selectedId: string | null
  onSelect(id: string | null): void
  /** Called on every drag step that changes the item (snapped to 5 cm). */
  onMoveItem(id: string, patch: MovePatch): void
  /** The drag is over (pointer up or cancelled after moving): commit an undo step. */
  onDragEnd(): void
  /** A fly-to request; set it back to null on `onCameraDone` so the same preset can be asked for again. */
  camera: CameraPresetId | null
  onCameraDone?(): void
  /** The Measure tab's current step (Stage 5): its lines, boxes and rafters; hides the measurements toggle's lines. */
  highlights?: MeasureHighlight | null
  /** The attic as it is today: no furniture or plasterboard, every knee wall and rafter. */
  shellToday?: boolean
  className?: string
  ref?: Ref<SceneHandle>
}

/** For walk mode (Stage 5): take over the camera without fighting OrbitControls. */
export interface SceneHandle {
  getCamera(): THREE.PerspectiveCamera | null
  getCanvas(): HTMLCanvasElement | null
  /** Fly (or jump, with reduced motion or `instant`) to a camera pose. */
  flyTo(cam: Camera, opts?: { instant?: boolean; onDone?: () => void }): void
  /** Suspend or resume orbiting and item picking/dragging. */
  setOrbitEnabled(on: boolean): void
  /** Called every frame before rendering, instead of the camera tween and OrbitControls. */
  setFrameHook(fn: ((dt: number, camera: THREE.PerspectiveCamera) => void) | null): void
}

let rectLightsReady = false

export default function Scene(props: SceneProps) {
  const { className, ref, view } = props
  const layerRef = useRef<HTMLDivElement>(null)
  const api = useRef<SceneHandle | null>(null)
  useImperativeHandle(
    ref,
    () => ({
      getCamera: () => api.current?.getCamera() ?? null,
      getCanvas: () => api.current?.getCanvas() ?? null,
      flyTo: (c, o) => api.current?.flyTo(c, o),
      setOrbitEnabled: (on) => api.current?.setOrbitEnabled(on),
      setFrameHook: (fn) => api.current?.setFrameHook(fn),
    }),
    [],
  )
  if (!rectLightsReady) {
    RectAreaLightUniformsLib.init()
    rectLightsReady = true
  }
  const nice = view.quality === 'nice'
  return (
    <div className={className} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <Canvas
        dpr={nice ? [1, 2] : [1, 1.25]}
        shadows="percentage"
        camera={{ fov: 48, near: 0.05, far: 200 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.NeutralToneMapping
          gl.toneMappingExposure = EXPOSURE
        }}
        style={{ display: 'block', touchAction: 'none' }}
      >
        <SceneContent {...props} layerRef={layerRef} apiRef={api} />
      </Canvas>
      <div
        ref={layerRef}
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden', zIndex: 1 }}
      />
    </div>
  )
}

// ---------- Helpers

type Slice = Pick<PlanV2, 'items' | 'options'>

const isUp = (i: Item) => i.type === 'curved' || i.type === 'spiral'
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** A JSON-equal copy that keeps its identity until the value really changes. */
function useJson<T>(v: T): T {
  const key = JSON.stringify(v)
  return useMemo(() => JSON.parse(key) as T, [key])
}

/** Dispose a built part when it is replaced or unmounted, and flag the scene for a cut-away/label refresh. */
function useOwned<T>(value: T, dispose: (v: T) => void, dirty: RefObject<boolean>) {
  const fn = useRef(dispose)
  useEffect(() => {
    fn.current = dispose
  })
  useEffect(() => {
    dirty.current = true
    return () => {
      dirty.current = true
      fn.current(value)
    }
  }, [value, dirty])
}

interface Graph {
  shell: THREE.Group
  slope: Record<'S' | 'N', THREE.Group>
  east: THREE.Group
  west: THREE.Group
  rafterGroup: THREE.Group
  below: THREE.Group
  items: THREE.Group
  winLights: THREE.Group
  dims: THREE.Group
  walk: THREE.Group
}

function makeGraph(): Graph {
  const g = (): THREE.Group => new THREE.Group()
  return { shell: g(), slope: { S: g(), N: g() }, east: g(), west: g(), rafterGroup: g(), below: g(), items: g(), winLights: g(), dims: g(), walk: g() }
}

interface CutLayer {
  g: THREE.Object3D
  p: THREE.Vector3
  n: THREE.Vector3
  hidden: boolean
}

const LABEL_STYLE: Record<LabelData['kind'], Partial<CSSStyleDeclaration>> = {
  dim: { font: '600 11px ui-monospace, Menlo, Consolas, monospace', color: '#7c2d12', background: 'rgba(255,250,245,.94)', border: '1px solid #e8762b', borderRadius: '6px', padding: '1px 6px' },
  big: { font: '600 13px ui-monospace, Menlo, Consolas, monospace', color: '#7c2d12', background: 'rgba(255,250,245,.94)', border: '1px solid #e8762b', borderRadius: '6px', padding: '2px 8px' },
  sign: { font: '600 13px var(--font-ui, system-ui, sans-serif)', color: '#1d2420', background: 'rgba(255,250,245,.94)', border: '1px solid rgba(0,0,0,.12)', borderRadius: '999px', padding: '3px 10px' },
}

// ---------- Item

function ItemView({ geo, plan, it: raw, mats, graph, groups, hidden, dirty }: {
  geo: Geometry
  /** The slice its builder reads: everything for stairs/storage/closet, else roof windows + options. */
  plan: Slice
  it: Item
  mats: SceneMats
  graph: Graph
  groups: Map<string, THREE.Object3D>
  hidden: boolean
  dirty: RefObject<boolean>
}) {
  const it = useJson(raw)
  const built = useMemo(() => buildItem(geo, plan, it, mats), [geo, plan, it, mats])
  useOwned(built, (b: Built) => disposeBuilt(b, mats.shared), dirty)
  useEffect(() => {
    groups.set(it.id, built.obj)
    const lights = built.lights ?? []
    lights.forEach((l) => graph.winLights.add(l))
    return () => {
      if (groups.get(it.id) === built.obj) groups.delete(it.id)
      lights.forEach((l) => graph.winLights.remove(l))
    }
  }, [built, groups, graph, it.id])
  built.obj.visible = !hidden
  return <primitive object={built.obj} />
}

// ---------- Scene content (inside the Canvas)

interface Drag {
  id: string
  type: Item['type']
  dx: number
  dz: number
  sx: number
  sy: number
  armed: boolean
  last: string
}

function SceneContent(props: SceneProps & { layerRef: RefObject<HTMLDivElement | null>; apiRef: RefObject<SceneHandle | null> }) {
  const { plan, view, camera: camReq, highlights, shellToday = false, layerRef, apiRef } = props
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const today = shellToday

  // ----- geometry and the plan slices builders key on. Each slice is a
  // JSON-stable copy, so a builder reruns only when what it reads changes.
  const attic = useJson(plan.options.attic)
  const geo = useMemo(() => deriveGeometry(atticOf(attic)), [attic])
  const rplan = withFittedClosets(geo, plan) // fitted closets drawn at their fitted size
  const options = useJson(rplan.options)
  const materials = useJson(rplan.materials)
  const items = useJson(rplan.items)
  const skyItems = useJson(rplan.items.filter((i) => i.type === 'skylight'))
  const stairItems = useJson(rplan.items.filter((i) => i.type === 'stairs' || isUp(i)))
  const zoneItems = useJson(rplan.items.filter((i) => i.type === 'stairs' || i.type === 'wall' || isUp(i)))
  /** Everything: for builders that read other items (stairs, storage, closet). */
  const full = useMemo<Slice>(() => ({ items, options }), [items, options])
  /** Roof windows only: the slopes, plasterboard, and items that read only the options. */
  const skySlice = useMemo<Slice>(() => ({ items: skyItems, options }), [skyItems, options])
  /** Stairs only: openings in the floors, knee-wall eaves, the floor below, dims. */
  const stairSlice = useMemo<Slice>(() => ({ items: stairItems, options }), [stairItems, options])
  const zoneSlice = useMemo<Slice>(() => ({ items: zoneItems, options }), [zoneItems, options])
  const hlStable = useJson(highlights ?? null)

  // ----- long-lived objects
  const [graph] = useState(makeGraph)
  const dirty = useRef(true)
  const groups = useRef(new Map<string, THREE.Object3D>()).current
  const [mats] = useState(() => createMats(gl.capabilities.getMaxAnisotropy()))
  useEffect(() => () => mats.dispose(), [mats])
  useEffect(() => mats.apply(materials), [mats, materials])

  const [lights] = useState(() => {
    const hemi = new THREE.HemisphereLight('#e4edf7', '#a08c74', 0.9)
    const sun = new THREE.DirectionalLight('#fff0dc', 3.2)
    sun.castShadow = true
    sun.shadow.bias = -0.0004
    sun.shadow.normalBias = 0.025
    sun.shadow.radius = 3
    Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 0.5, far: 40 })
    sun.shadow.camera.updateProjectionMatrix()
    sun.shadow.camera.layers.enableAll() // cut-away surfaces still cast shadows
    return { hemi, sun }
  })
  useEffect(() => {
    const { hemi, sun } = lights
    const s = SUN_STYLE[view.sun]
    const c = new THREE.Vector3(geo.L / 2, 0, 0)
    sun.position.copy(c).add(new THREE.Vector3(...s.off).multiplyScalar(1.6))
    sun.target.position.copy(c)
    sun.target.updateMatrixWorld()
    sun.intensity = s.int
    sun.color.set(s.color)
    sun.visible = s.int > 0
    hemi.intensity = s.int > 0 ? 0.9 : 1.3
  }, [lights, view.sun, geo.L])
  const nice = view.quality === 'nice'
  useEffect(() => {
    const { sun } = lights
    const sz = nice ? 2048 : 1024
    if (sun.shadow.mapSize.x !== sz) {
      sun.shadow.mapSize.set(sz, sz)
      if (sun.shadow.map) {
        sun.shadow.map.dispose()
        sun.shadow.map = null as unknown as THREE.WebGLRenderTarget
      }
    }
  }, [lights, nice])
  useEffect(() => () => {
    lights.sun.dispose()
    lights.hemi.dispose()
  }, [lights])

  // Cut-away surfaces sit on layer 1 so the camera does not see them, yet they
  // must still cast the sun's shadow (v41, on three 0.187, set
  // `sun.shadow.camera.layers.enableAll()` and its shadow pass honoured each
  // light's shadow-camera layers). three 0.185's shadow pass tests objects
  // against the *viewing* camera's layers, so render each light's shadow with
  // the viewing camera's layers set to that light's shadow-camera layers.
  useEffect(() => {
    const sm = gl.shadowMap
    const orig = sm.render
    sm.render = function (this: THREE.WebGLShadowMap, ls, sc, cam) {
      const mask = cam.layers.mask
      try {
        for (const l of ls) {
          cam.layers.mask = (l as THREE.Light & { shadow?: THREE.LightShadow }).shadow?.camera.layers.mask ?? mask
          orig.call(this, [l], sc, cam)
        }
      } finally {
        cam.layers.mask = mask
      }
    }
    return () => {
      sm.render = orig
    }
  }, [gl])

  // sky as background and soft ambient light
  useEffect(() => {
    const sky = skyTexture()
    scene.background = sky
    scene.environment = sky
    scene.environmentIntensity = ENV_INTENSITY
    return () => {
      scene.background = null
      scene.environment = null
      sky.dispose()
    }
  }, [scene])

  // ----- shell builders
  const rafters = useMemo(() => buildRafters(geo, mats, options.board, today), [geo, mats, options.board, today])
  useOwned(rafters, (r) => Object.values(r).forEach((g) => disposeObject(g, mats.shared)), dirty)
  const west = useMemo(() => buildWestGable(geo, mats), [geo, mats])
  useOwned(west, (g) => disposeObject(g, mats.shared), dirty)
  const eastLabel = useMemo(() => buildEastLabel(geo), [geo])
  const east = useMemo(() => buildEast(geo, options.gable, mats), [geo, mats, options.gable])
  useOwned(east, (b) => disposeBuilt(b, mats.shared), dirty)
  useEffect(() => {
    const ls = east.lights ?? []
    ls.forEach((l) => graph.winLights.add(l))
    return () => ls.forEach((l) => graph.winLights.remove(l))
  }, [east, graph])
  const slopes = useMemo(() => buildSlopes(geo, skyItems, mats), [geo, mats, skyItems])
  useOwned(slopes, (s) => Object.values(s).forEach((m) => disposeObject(m, mats.shared)), dirty)
  const board = useMemo(() => buildBoard(geo, skySlice, mats, today), [geo, mats, skySlice, today])
  useOwned(board, (b) => Object.values(b).forEach((g) => disposeObject(g, mats.shared)), dirty)
  const knee = useMemo(() => buildKnee(geo, stairSlice, mats, today), [geo, mats, stairSlice, today])
  useOwned(knee, (g) => disposeObject(g, mats.shared), dirty)
  const floors = useMemo(() => buildFloors(geo, stairSlice, mats), [geo, mats, stairSlice])
  useOwned(floors, (f) => Object.values(f).forEach((m) => disposeObject(m, mats.shared)), dirty)
  const zones = useMemo(() => buildZones(geo, zoneSlice), [geo, zoneSlice])
  useOwned(zones, (m) => disposeObject(m, mats.shared), dirty)
  const below = useMemo(() => buildBelow(geo, stairSlice, mats), [geo, mats, stairSlice])
  useOwned(below, (b) => disposeObject(b.root, mats.shared), dirty)
  const dims = useMemo(() => (view.dims ? buildDims(geo, stairSlice, mats) : null), [geo, mats, view.dims, stairSlice])
  useOwned(dims, (d) => d && (disposeObject(d.attic, mats.shared), disposeObject(d.below, mats.shared)), dirty)
  const hl = useMemo(() => (hlStable ? buildHighlights(hlStable, rafters, mats) : null), [hlStable, rafters, mats])
  useOwned(hl, (g) => g && disposeObject(g, mats.shared), dirty)

  // ----- selection helper
  const [helper] = useState(() => {
    const h = new THREE.BoxHelper(new THREE.Object3D(), 0xd98b2b)
    h.visible = false
    ;(h.material as THREE.Material).depthTest = false
    h.renderOrder = 10
    return h
  })
  useEffect(() => () => {
    helper.geometry.dispose()
    ;(helper.material as THREE.Material).dispose()
  }, [helper])

  // ----- cut-away layers: surfaces the camera is outside of move to layer 1, hidden but still casting shadows
  const cuts = useMemo<CutLayer[]>(() => {
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
    const { L, HALF, H } = geo
    return [
      ...(['S', 'N', 'E', 'W'] as const).map((c) => ({
        g: below.cut[c],
        p: below.anchors[c],
        n: c === 'S' ? V(0, 0, 1) : c === 'N' ? V(0, 0, -1) : c === 'E' ? V(1, 0, 0) : V(-1, 0, 0),
        hidden: false,
      })),
      { g: graph.slope.S, p: V(0, 0, HALF), n: V(0, HALF, H).normalize(), hidden: false },
      { g: graph.slope.N, p: V(0, 0, -HALF), n: V(0, HALF, -H).normalize(), hidden: false },
      { g: graph.east, p: V(L, 0, 0), n: V(1, 0, 0), hidden: false },
      { g: graph.west, p: V(0, 0, 0), n: V(-1, 0, 0), hidden: false },
    ]
  }, [geo, below, graph])

  // ----- latest values for the event handlers and the frame loop
  const live = useRef({ props, geo, rplan })
  useEffect(() => {
    live.current = { props, geo, rplan }
  })

  // ----- camera: presets, tween, OrbitControls, picking and dragging
  const ctl = useRef<{
    controls: OrbitControls | null
    tween: { p0: THREE.Vector3; t0: THREE.Vector3; p: THREE.Vector3; t: THREE.Vector3; start: number; dur: number; done?: () => void } | null
    hook: ((dt: number, camera: THREE.PerspectiveCamera) => void) | null
    orbit: boolean
    last: number
  }>({ controls: null, tween: null, hook: null, orbit: true, last: 0 })

  useEffect(() => {
    const el = gl.domElement
    const ray = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const hit = new THREE.Vector3()
    let drag: Drag | null = null
    let downAt: { x: number; y: number } | null = null
    const setNdc = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, camera)
    }
    const shown = (o: THREE.Object3D | null) => {
      for (let p = o; p; p = p.parent) if (!p.visible) return false
      return true
    }
    const pick = (): string | null => {
      const hits = ray.intersectObjects([...groups.values()], true).filter((h) => !h.object.userData.overlay && shown(h.object))
      for (const h of hits) {
        let ob: THREE.Object3D | null = h.object
        while (ob && !ob.userData.itemId) ob = ob.parent
        if (ob) return ob.userData.itemId as string
      }
      return null
    }
    const down = (e: PointerEvent) => {
      if (!ctl.current.orbit) return
      setNdc(e)
      downAt = { x: e.clientX, y: e.clientY }
      const id = pick()
      if (!id) return
      const { props: p, rplan: rp } = live.current
      const it = rp.items.find((i) => i.id === id)
      if (!it) return
      p.onSelect(id)
      if (it.type === 'skylight') return
      if (ray.ray.intersectPlane(floorPlane, hit)) {
        const ix = 'x' in it ? it.x : 0
        const iz = 'z' in it ? it.z : 0
        drag = { id, type: it.type, dx: ix - hit.x, dz: iz - hit.z, sx: e.clientX, sy: e.clientY, armed: false, last: '' }
        if (ctl.current.controls) ctl.current.controls.enabled = false
        el.setPointerCapture(e.pointerId)
      }
    }
    const move = (e: PointerEvent) => {
      if (!drag) return
      // a dead zone so a click or a shaky press (touch) selects without nudging the item
      if (!drag.armed) {
        if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 8) return
        drag.armed = true
      }
      setNdc(e)
      if (!ray.ray.intersectPlane(floorPlane, hit)) return
      if (drag.type === 'closet') return // a closet is placed by its wall and side, not dragged
      const { geo: g, props: p } = live.current
      const patch: MovePatch = { x: snap(clamp(hit.x + drag.dx, 0, g.L)) }
      if (drag.type !== 'wall' && drag.type !== 'storage') patch.z = snap(clamp(hit.z + drag.dz, -g.HALF, g.HALF))
      const key = JSON.stringify(patch)
      if (key === drag.last) return
      drag.last = key
      p.onMoveItem(drag.id, patch)
    }
    const up = (e: PointerEvent) => {
      if (drag) {
        const moved = drag.armed
        if (ctl.current.controls) ctl.current.controls.enabled = ctl.current.orbit
        drag = null
        if (moved) live.current.props.onDragEnd()
      } else if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 4) {
        setNdc(e)
        if (!pick()) live.current.props.onSelect(null)
      }
      downAt = null
    }
    const cancel = () => {
      if (drag) {
        if (ctl.current.controls) ctl.current.controls.enabled = ctl.current.orbit
        const moved = drag.armed
        drag = null
        if (moved) live.current.props.onDragEnd()
      }
      downAt = null
    }
    // registered before OrbitControls so a press on an item stops the orbit before it starts
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', cancel)
    const controls = new OrbitControls(camera, el)
    controls.enableDamping = true
    controls.dampingFactor = 0.12
    controls.minDistance = 0.4
    controls.maxDistance = 28
    controls.maxPolarAngle = Math.PI * 0.62
    controls.enabled = ctl.current.orbit
    const c0 = cameraPresets(live.current.geo, live.current.rplan).overview
    camera.position.set(...c0.p)
    controls.target.set(...c0.t)
    controls.update()
    const c = ctl.current
    c.controls = controls
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', cancel)
      controls.dispose()
      c.controls = null
    }
  }, [gl, camera, groups])

  const flyTo = (c: Camera, opts: { instant?: boolean; onDone?: () => void } = {}) => {
    const controls = ctl.current.controls
    const p = new THREE.Vector3(...c.p)
    const t = new THREE.Vector3(...c.t)
    if (!controls) return
    if (opts.instant || reducedMotion()) {
      ctl.current.tween = null
      camera.position.copy(p)
      controls.target.copy(t)
      controls.update()
      opts.onDone?.()
      return
    }
    ctl.current.tween = { p0: camera.position.clone(), t0: controls.target.clone(), p, t, start: performance.now(), dur: 650, done: opts.onDone }
  }
  const flyRef = useRef(flyTo)
  useEffect(() => {
    flyRef.current = flyTo
  })

  useEffect(() => {
    if (!camReq) return
    const { geo: g, rplan: rp, props: p } = live.current
    flyRef.current(cameraPresets(g, rp)[camReq], { onDone: () => p.onCameraDone?.() })
  }, [camReq])

  useEffect(() => {
    apiRef.current = {
      getCamera: () => camera,
      getCanvas: () => gl.domElement,
      flyTo: (c, opts) => flyRef.current(c, opts),
      setOrbitEnabled: (on) => {
        ctl.current.orbit = on
        if (ctl.current.controls) ctl.current.controls.enabled = on
      },
      setFrameHook: (fn) => {
        ctl.current.hook = fn
        if (fn) ctl.current.tween = null
      },
    }
    return () => {
      apiRef.current = null
    }
  }, [apiRef, camera, gl])

  // ----- post-processing (ambient occlusion), 'nice' quality only
  const composerRef = useRef<EffectComposer | null>(null)
  useEffect(() => {
    if (!nice) return
    const composer = new EffectComposer(gl)
    composer.addPass(new RenderPass(scene, camera))
    const gtao = new GTAOPass(scene, camera, 16, 16)
    gtao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.4, thickness: 1.2, scale: 1.1, samples: 16 })
    gtao.blendIntensity = 0.9
    composer.addPass(gtao)
    composer.addPass(new OutputPass())
    composerRef.current = composer
    return () => {
      composerRef.current = null
      gtao.dispose()
      composer.dispose()
    }
  }, [gl, scene, camera, nice])
  useEffect(() => {
    const c = composerRef.current
    if (!c) return
    c.setPixelRatio(dpr)
    c.setSize(size.width, size.height)
  }, [size.width, size.height, dpr, nice])

  // ----- labels: page elements pinned to 3D points, crisp and untouched by the shading pass
  const labelEls = useRef(new Map<THREE.Object3D, HTMLSpanElement>())
  useEffect(() => {
    const els = labelEls.current
    return () => {
      els.forEach((el) => el.remove())
      els.clear()
    }
  }, [])
  const syncLabels = () => {
    const layer = layerRef.current
    if (!layer) return
    const seen = new Set<THREE.Object3D>()
    scene.traverse((ob) => {
      const d = ob.userData.label as LabelData | undefined
      if (!d) return
      seen.add(ob)
      if (labelEls.current.has(ob)) return
      const el = document.createElement('span')
      el.textContent = d.text
      el.dataset.kind = d.kind
      Object.assign(el.style, { position: 'absolute', left: '0', top: '0', whiteSpace: 'nowrap', display: 'none' }, LABEL_STYLE[d.kind])
      layer.appendChild(el)
      labelEls.current.set(ob, el)
    })
    labelEls.current.forEach((el, ob) => {
      if (!seen.has(ob)) {
        el.remove()
        labelEls.current.delete(ob)
      }
    })
  }

  // ----- frame loop (priority 1: this callback renders)
  const v = useMemo(() => new THREE.Vector3(), [])
  const camPos = useMemo(() => new THREE.Vector3(), [])
  useFrame((_, delta) => {
    const c = ctl.current
    const dt = Math.min(0.05, delta)
    if (c.hook) c.hook(dt, camera)
    else {
      const tw = c.tween
      if (tw) {
        const kk = Math.min(1, (performance.now() - tw.start) / tw.dur)
        const e = kk < 0.5 ? 2 * kk * kk : 1 - Math.pow(-2 * kk + 2, 2) / 2
        camera.position.lerpVectors(tw.p0, tw.p, e)
        c.controls?.target.lerpVectors(tw.t0, tw.t, e)
        if (kk >= 1) {
          c.tween = null
          tw.done?.()
        }
      }
      c.controls?.update()
    }
    const { props: p } = live.current
    const force = dirty.current
    if (force) {
      dirty.current = false
      syncLabels()
    }
    camPos.copy(camera.position)
    cuts.forEach((cut) => {
      const hide = p.view.cutaway && v.copy(camPos).sub(cut.p).dot(cut.n) >= 0
      if (hide !== cut.hidden || force) {
        cut.hidden = hide
        cut.g.traverse((ob) => ob.layers.set(hide ? 1 : 0))
      }
    })
    zones.visible = p.view.zones
    graph.rafterGroup.visible = rafters.S.visible = rafters.N.visible = p.view.rafters
    const sel = p.selectedId ? groups.get(p.selectedId) : undefined
    if (sel && sel.visible) {
      helper.setFromObject(sel)
      helper.visible = true
    } else helper.visible = false
    if (dims) {
      dims.attic.visible = !p.highlights && camera.position.y >= 0
      dims.below.visible = !p.highlights && camera.position.y < 0
    }
    const composer = composerRef.current
    if (p.view.quality === 'nice' && composer) composer.render(dt)
    else gl.render(scene, camera)
    // place the labels: hidden with their group, or behind the camera
    const layer = layerRef.current
    if (layer) {
      const w = layer.clientWidth
      const h = layer.clientHeight
      labelEls.current.forEach((el, ob) => {
        let vis = true
        for (let q: THREE.Object3D | null = ob; q && vis; q = q.parent) vis = q.visible
        if (vis) {
          ob.getWorldPosition(v).project(camera)
          vis = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1
        }
        if (!vis) {
          if (el.style.display !== 'none') el.style.display = 'none'
          return
        }
        el.style.display = ''
        let px = ((v.x + 1) / 2) * w
        let py = ((1 - v.y) / 2) * h
        // Name signs ("Väster · mot bostaden") describe a whole side, not a point
        // on a line, so keep them inside the canvas instead of cut at its edge.
        // Dimension labels stay on their line (a moved one would mislabel it).
        if (el.dataset.kind === 'sign') {
          const hw = el.offsetWidth / 2 + 4
          const hh = el.offsetHeight / 2 + 4
          px = Math.min(Math.max(px, hw), Math.max(hw, w - hw))
          py = Math.min(Math.max(py, hh), Math.max(hh, h - hh))
        }
        el.style.transform = `translate(${px.toFixed(1)}px,${py.toFixed(1)}px) translate(-50%,-50%)`
      })
    }
  }, 1)

  // ----- the scene graph
  const skyIn = (side: 'S' | 'N'): ReactNode =>
    items
      .filter((i) => i.type === 'skylight' && i.slope === side)
      .map((it) => <ItemView key={it.id} geo={geo} plan={skySlice} it={it} mats={mats} graph={graph} groups={groups} hidden={today} dirty={dirty} />)
  graph.below.visible = rplan.options.below.show
  return (
    <>
      <primitive object={lights.hemi} />
      <primitive object={lights.sun} />
      <primitive object={lights.sun.target} />
      <primitive object={graph.winLights} />
      <primitive object={helper} />
      <primitive object={graph.shell}>
        <primitive object={graph.slope.S}>
          <primitive object={slopes.S} />
          <primitive object={rafters.S} />
          <primitive object={board.S} />
          {skyIn('S')}
        </primitive>
        <primitive object={graph.slope.N}>
          <primitive object={slopes.N} />
          <primitive object={rafters.N} />
          <primitive object={board.N} />
          {skyIn('N')}
        </primitive>
        <primitive object={graph.east}>
          <primitive object={east.obj} />
        </primitive>
        <primitive object={graph.west}>
          <primitive object={west} />
        </primitive>
        <primitive object={graph.rafterGroup}>
          <primitive object={board.ridge} />
        </primitive>
        <primitive object={knee} />
        <primitive object={floors.floor} />
        <primitive object={floors.edge} />
        <primitive object={zones} />
        <primitive object={eastLabel} />
      </primitive>
      <primitive object={graph.below}>
        <primitive object={below.root} />
        <primitive object={floors.ceil} />
      </primitive>
      <primitive object={graph.items}>
        {items
          .filter((i) => i.type !== 'skylight')
          .map((it) => (
            <ItemView
              key={it.id}
              geo={geo}
              plan={it.type === 'curved' || it.type === 'spiral' || it.type === 'storage' || it.type === 'closet' ? full : skySlice}
              it={it}
              mats={mats}
              graph={graph}
              groups={groups}
              hidden={today}
              dirty={dirty}
            />
          ))}
      </primitive>
      <primitive object={graph.dims}>
        {dims && <primitive object={dims.attic} />}
        {dims && <primitive object={dims.below} />}
      </primitive>
      <primitive object={graph.walk}>{hl && <primitive object={hl} />}</primitive>
    </>
  )
}
