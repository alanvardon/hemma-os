// Vindsplanen photo mode (plan 143): a progressive path tracer over the live
// scene. Its own lazy chunk (`import('./photo')` from Scene), fetched only when
// the user enters photo mode, so the path tracer never weighs on the 3D view.
//
// CSP: import only from the 'three-gpu-pathtracer' main entry and build the
// scene synchronously (`setScene`). Never import 'three-mesh-bvh/worker' or
// call `setSceneAsync`/`setBVHWorker` — those spawn blob: workers, which the
// production CSP forbids.
//
// The tracer's quirks (plan 143, Stage 1 research findings):
// - it cannot read the PMREM environment, so a session swaps in a cube map of
//   the same RoomEnvironment and puts the PMREM back afterwards;
// - it ignores `layers`, so cut-away surfaces, overlays (zones, clash boxes,
//   dims, highlights, lamp bulbs) and the selection box are hidden with
//   `visible = false` for the session and shown again after;
// - it has no hemisphere light, so the environment is raised to compensate;
// - `dispose()` misses the low-res tracer and the uniforms' textures: keep one
//   tracer per renderer and free everything in `disposePhoto`.

import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { WebGLPathTracer } from 'three-gpu-pathtracer'
import { photoPhase, shownSamples, type PhotoSettings } from '../photoMode'

/** The environment boost that stands in for the hemisphere fill the tracer cannot draw. */
export const PHOTO_ENV_BOOST = 1.3

export interface PhotoOptions {
  settings: PhotoSettings
  /** Objects to leave out of the photo (hidden for the session). Overlays are found on their own. */
  hide: readonly THREE.Object3D[]
  /** No fade from the raster image to the traced one. */
  reducedMotion: boolean
  /** Whole samples, each time the count goes up. */
  onSamples(samples: number): void
  /** The sample cap is reached (the image stays on screen). */
  onDone(): void
}

export interface PhotoSession {
  /** One frame: a tile of samples (until the cap), drawn to the canvas. */
  frame(): void
  /** The current image as a PNG, captured synchronously (no `preserveDrawingBuffer`). */
  capture(): Promise<Blob>
  /** Put the scene back as it was. Idempotent. */
  stop(): void
}

interface Tracer {
  pt: WebGLPathTracer
  env: THREE.WebGLCubeRenderTarget
}

const tracers = new WeakMap<THREE.WebGLRenderer, Tracer>()

function tracerFor(gl: THREE.WebGLRenderer): Tracer {
  let t = tracers.get(gl)
  if (!t) {
    const env = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType, generateMipmaps: false })
    const room = new RoomEnvironment()
    const cam = new THREE.CubeCamera(0.1, 100, env)
    cam.update(gl, room)
    room.dispose()
    t = { pt: new WebGLPathTracer(gl), env }
    tracers.set(gl, t)
  }
  return t
}

/**
 * Build the path-traced scene (blocking, ~1 s for the example plan) and start
 * a session. Throws if the tracer cannot take the scene; the scene is then
 * already put back.
 */
export function startPhoto(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, opts: PhotoOptions): PhotoSession {
  const { pt, env } = tracerFor(gl)
  const { settings } = opts

  // hide what the photo leaves out, remembering only what we changed
  const hidden: THREE.Object3D[] = []
  const hide = (o: THREE.Object3D) => {
    if (!o.visible) return
    o.visible = false
    hidden.push(o)
  }
  opts.hide.forEach(hide)
  scene.traverse((o) => {
    if (o.userData.overlay) hide(o)
  })
  const prevEnv = scene.environment
  const prevIntensity = scene.environmentIntensity
  const boosted = prevIntensity * PHOTO_ENV_BOOST
  scene.environment = env.texture
  scene.environmentIntensity = boosted

  let stopped = false
  const restore = () => {
    if (stopped) return
    stopped = true
    hidden.forEach((o) => {
      o.visible = true
    })
    // only undo what is still ours: an effect may have set a new value meanwhile
    if (scene.environment === env.texture) scene.environment = prevEnv
    if (scene.environmentIntensity === boosted) scene.environmentIntensity = prevIntensity
  }

  pt.renderScale = settings.renderScale
  if (settings.tiles) pt.tiles.set(settings.tiles, settings.tiles)
  else pt.tiles.set(3, 3)
  pt.textureSize.set(settings.textureSize, settings.textureSize)
  pt.fadeDuration = opts.reducedMotion ? 0 : 500
  pt.minSamples = 5
  pt.pausePathTracing = false
  try {
    pt.setScene(scene, camera)
  } catch (e) {
    restore()
    throw e
  }

  let aspect = camera.aspect
  let shown = 0
  let done = false
  return {
    frame() {
      if (stopped) return
      // a resize changes the aspect: re-aim the tracer (it starts over)
      if (camera.aspect !== aspect) {
        aspect = camera.aspect
        pt.updateCamera()
        done = false
        pt.pausePathTracing = false
      }
      pt.renderSample()
      const n = shownSamples(pt.samples, settings.maxSamples)
      if (n !== shown) {
        shown = n
        opts.onSamples(n)
      }
      if (!done && photoPhase(pt.samples, settings.maxSamples) === 'done') {
        done = true
        pt.pausePathTracing = true
        opts.onDone()
      }
    },
    capture() {
      const paused = pt.pausePathTracing
      pt.pausePathTracing = true
      try {
        pt.renderSample() // redraw the composite without a new sample, then read it in the same task
        return new Promise<Blob>((resolve, reject) => {
          gl.domElement.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob returned no image'))), 'image/png')
        })
      } catch (e) {
        return Promise.reject(e)
      } finally {
        pt.pausePathTracing = paused
      }
    },
    stop: restore,
  }
}

/** Download a blob as a file (`<a download>`: allowed by the CSP, unlike an `<img src=blob:>`). */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

type Disposable = { dispose?: () => void }
type Internals = {
  _pathTracer: { material: THREE.ShaderMaterial }
  _lowResPathTracer: { dispose(): void; material: THREE.ShaderMaterial }
  _generator: { geometry?: THREE.BufferGeometry }
}

/** Free this renderer's tracer, its low-res twin, their uniform textures, the BVH geometry and the cube map. */
export function disposePhoto(gl: THREE.WebGLRenderer): void {
  const t = tracers.get(gl)
  if (!t) return
  tracers.delete(gl)
  const inner = t.pt as unknown as Internals
  const mats = new Set([inner._pathTracer.material, inner._lowResPathTracer.material])
  t.pt.dispose()
  inner._lowResPathTracer.dispose()
  mats.forEach((m) => {
    Object.values(m.uniforms ?? {}).forEach((u) => (u.value as Disposable | null)?.dispose?.())
    m.dispose()
  })
  inner._generator.geometry?.dispose()
  t.env.dispose()
}
