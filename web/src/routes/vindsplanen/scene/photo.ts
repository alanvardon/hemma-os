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
// - it cannot read the PMREM environment, so a session lights the photo with
//   the sky gradient (a float equirect it can sample) and puts the PMREM back;
// - it ignores `layers`, so overlays (zones, clash boxes, dims, highlights,
//   lamp bulbs) and the selection box are hidden with `visible = false` for the
//   session and shown again after, and the cut-away gets `matte` twins of its
//   materials, which a patched shader lets the camera see through (`patchMatte`);
// - it has no hemisphere light: the sky light stands in for it, and a white
//   balance against the raster view (`calibrate`) sets the colour and exposure;
// - `dispose()` misses the low-res tracer and the uniforms' textures: keep one
//   tracer per renderer and free everything in `disposePhoto`.

import * as THREE from 'three'
import { WebGLPathTracer } from 'three-gpu-pathtracer'
import { matchGain, photoPhase, shownSamples, type PhotoSettings } from '../photoMode'

/**
 * The sky's share of the light in a photo, relative to the raster view's
 * environment intensity. The photo is lit by the sky gradient itself (what
 * the windows and the opened-up side really look out on), not RoomEnvironment:
 * that studio box has small, very bright panels which, seen through the
 * cut-away side, flood the attic and add noise.
 */
export const PHOTO_SKY_BOOST = 1.5

/** Path depth. Each bounce past 4 costs ~13 % speed for fill light the white balance makes up anyway. */
export const PHOTO_BOUNCES = 4
/** Clear steps a ray may take before they count as bounces: in and out of a pane, through the cut-away's faces. */
export const PHOTO_TRANSMISSIVE_BOUNCES = 6
/** Whole samples traced for the white-balance measurement, under `minSamples`, so it is never on screen. */
export const CALIBRATION_SAMPLES = 2

export interface PhotoOptions {
  settings: PhotoSettings
  /** Objects to leave out of the photo (hidden for the session). Overlays are found on their own. */
  hide: readonly THREE.Object3D[]
  /**
   * The cut-away surfaces: unseen by the camera, as in the 3D view, yet still
   * casting the sun's and the lamps' shadows, as the raster view's shadow pass
   * keeps them. Hidden instead if the tracer cannot be patched for it.
   */
  cutaway: readonly THREE.Object3D[]
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
  /** The shader patch for camera-invisible surfaces took (see `patchMatte`). */
  matte: boolean
}

const tracers = new WeakMap<THREE.WebGLRenderer, Tracer>()

function tracerFor(gl: THREE.WebGLRenderer): Tracer {
  let t = tracers.get(gl)
  if (!t) {
    const pt = new WebGLPathTracer(gl)
    t = { pt, matte: patchMatte(pt) }
    tracers.set(gl, t)
  }
  return t
}

/**
 * Give the tracer the raster view's cut-away: a surface the camera does not
 * see that still casts the lights' shadows, while sky and bounce light pass
 * it (the raster view's sky fill is unshadowed too). Without it the cut-away
 * is either gone — and the morning sun pours through the missing east gable —
 * or solid, and the eaves and closets behind it turn black.
 *
 * The tracer has no such flag (it ignores `layers`; its `matte` ends a camera
 * ray as a transparent pixel), so this rewrites what `matte` does, for
 * three-gpu-pathtracer 0.0.27's shader:
 * - the path loop (PhysicalPathTracingMaterial.js:438-443) steps a ray past a
 *   matte surface the way it steps past a transparent one (:455-470), so
 *   neither the camera nor bounce light meets it;
 * - shadow rays (attenuate_hit_function.glsl.js `attenuateHit`) stop at it as
 *   at any surface, except those testing the sky
 *   (direct_light_contribution_function.glsl.js:71), which pass.
 * Returns false, leaving the shader as it was, if any of that text is not
 * found; the caller then hides the cut-away instead.
 */
function patchMatte(pt: WebGLPathTracer): boolean {
  const mat = (pt as unknown as Internals)._pathTracer.material
  const edits: [RegExp, string][] = [
    // path loop: camera and bounce rays pass a matte surface (a skipped transparent surface's steps)
    [
      /if \( material\.matte && state\.firstRay \) \{\s*gl_FragColor = vec4\( 0\.0 \);\s*break;\s*\}/,
      `if ( material.matte ) {
							i -= sign( state.transmissiveTraversals );
							state.transmissiveTraversals -= sign( state.transmissiveTraversals );
							ray.origin = stepRayOrigin( ray.origin, ray.direction, - surfaceHit.faceNormal, surfaceHit.dist );
							continue;
						}`,
    ],
    // shadow rays: a matte surface stops the lights' but not the sky's
    [
      /(\/\/ adjust the ray to the new surface\s*bool isEntering = surfaceHit\.side == 1\.0;\s*ray\.origin = stepRayOrigin\( ray\.origin, ray\.direction, - surfaceHit\.faceNormal, surfaceHit\.dist \);)/,
      `$1
				if ( material.matte && attenuatingSky ) continue;`,
    ],
    [/(\tbool attenuateHit\()/, `\tbool attenuatingSky = false;\n$1`],
    [
      /(\tvec3 directLightContribution\()/,
      `\tbool attenuateSkyHit( RenderState state, Ray ray, out vec3 color ) {
		attenuatingSky = true;
		bool hit = attenuateHit( state, ray, INFINITY, color );
		attenuatingSky = false;
		return hit;
	}
$1`,
    ],
    [/! attenuateHit\( state, envRay, INFINITY, attenuatedColor \)/, '! attenuateSkyHit( state, envRay, attenuatedColor )'],
  ]
  let src = mat.fragmentShader
  for (const [from, to] of edits) {
    if (!from.test(src)) return false
    src = src.replace(from, to)
  }
  mat.fragmentShader = src
  mat.needsUpdate = true
  return true
}

/**
 * Build the path-traced scene (blocking, ~1 s for the example plan) and start
 * a session. Throws if the tracer cannot take the scene; the scene is then
 * already put back.
 */
export function startPhoto(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, opts: PhotoOptions): PhotoSession {
  const { pt, matte } = tracerFor(gl)
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
  // the cut-away: its meshes get matte twins of their (shared) materials for the session
  const swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = []
  const twins = new Map<THREE.Material, THREE.Material>()
  const twin = (m: THREE.Material): THREE.Material => {
    let t = twins.get(m)
    if (!t) {
      t = m.clone()
      ;(t as THREE.Material & { matte?: boolean }).matte = true
      twins.set(m, t)
    }
    return t
  }
  if (matte) {
    opts.cutaway.forEach((g) =>
      g.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        swapped.push([mesh, mesh.material])
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(twin) : twin(mesh.material)
      }),
    )
  } else opts.cutaway.forEach(hide)
  // The windows' area lights (the raster view's daylight through the glass)
  // stay: the sky also comes in through the glass, but a ray that has to find
  // a small window by chance is noisy, and the lights let the tracer aim at
  // the windows. Counting the sky twice there only shifts the balance, which
  // the white balance below evens out.

  // the sky gradient (the background) lights the photo
  const sky = scene.background instanceof THREE.DataTexture ? scene.background : null
  const prevEnv = scene.environment
  const prevIntensity = scene.environmentIntensity
  const skyIntensity = prevIntensity * PHOTO_SKY_BOOST
  let skyEnv = sky ? tinted(sky, [1, 1, 1]) : null
  if (skyEnv) {
    scene.environment = skyEnv
    scene.environmentIntensity = skyIntensity
  }

  // light colours, kept to put back after the white balance scales them
  const lights: [THREE.Light, THREE.Color][] = []
  scene.traverseVisible((o) => {
    const l = o as THREE.Light
    if (l.isLight && !(l as THREE.HemisphereLight).isHemisphereLight) lights.push([l, l.color.clone()])
  })

  let stopped = false
  const restore = () => {
    if (stopped) return
    stopped = true
    hidden.forEach((o) => {
      o.visible = true
    })
    lights.forEach(([l, c]) => l.color.copy(c))
    swapped.forEach(([mesh, m]) => (mesh.material = m))
    twins.forEach((t) => t.dispose())
    // only undo what is still ours: an effect may have set a new value meanwhile
    if (skyEnv && scene.environment === skyEnv) {
      scene.environment = prevEnv
      if (scene.environmentIntensity === skyIntensity) scene.environmentIntensity = prevIntensity
    }
    skyEnv?.dispose()
    skyEnv = null
  }

  pt.renderScale = settings.renderScale
  pt.tiles.set(settings.tiles, settings.tiles)
  pt.textureSize.set(settings.textureSize, settings.textureSize)
  pt.bounces = PHOTO_BOUNCES
  pt.transmissiveBounces = PHOTO_TRANSMISSIVE_BOUNCES
  pt.fadeDuration = opts.reducedMotion ? 0 : 500
  pt.minSamples = CALIBRATION_SAMPLES + 3
  pt.pausePathTracing = false
  try {
    pt.setScene(scene, camera)
  } catch (e) {
    restore()
    throw e
  }

  /**
   * White balance and exposure, the way a camera would set them: trace a
   * couple of samples, compare their mean colour with the raster view's on
   * the same pixels, and scale every light (and the sky that lights the room,
   * not the one in view) by the difference. Light bouncing between warm walls
   * and an oak floor otherwise tints the whole photo orange, and the sun the
   * raster view balances with its sky fill would overexpose it. Rendering is
   * linear in the lights, so this is the same as correcting the image, minus
   * the background. Then trace from scratch.
   */
  let calibrated = false
  const calibrate = () => {
    calibrated = true
    const w = pt.target.width
    const h = pt.target.height
    const traced = new Float32Array(w * h * 4)
    gl.readRenderTargetPixels(pt.target, 0, 0, w, h, traced)
    const raster = rasterPixels(gl, scene, camera, w, h, prevEnv, prevIntensity)
    const gain = matchGain(raster, traced)
    const g = new THREE.Color(...gain)
    lights.forEach(([l, c]) => l.color.copy(c).multiply(g))
    if (sky && skyEnv) {
      skyEnv.dispose()
      skyEnv = tinted(sky, gain)
      scene.environment = skyEnv
    }
    pt.updateLights()
    pt.updateEnvironment()
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
      if (!calibrated && pt.samples >= CALIBRATION_SAMPLES && Number.isInteger(pt.samples)) {
        try {
          calibrate()
        } catch (e) {
          console.warn('Photo mode: white balance skipped', e)
        }
        return
      }
      const n = calibrated ? shownSamples(pt.samples, settings.maxSamples) : 0
      if (n !== shown) {
        shown = n
        opts.onSamples(n)
      }
      if (calibrated && !done && photoPhase(pt.samples, settings.maxSamples) === 'done') {
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

/** A copy of an equirect float sky with each channel scaled (the white-balanced light). */
function tinted(sky: THREE.DataTexture, gain: readonly [number, number, number]): THREE.DataTexture {
  const src = sky.image.data as Float32Array
  const data = new Float32Array(src.length)
  for (let i = 0; i < src.length; i += 4) {
    data[i] = src[i] * gain[0]
    data[i + 1] = src[i + 1] * gain[1]
    data[i + 2] = src[i + 2] * gain[2]
    data[i + 3] = src[i + 3]
  }
  const t = new THREE.DataTexture(data, sky.image.width, sky.image.height, THREE.RGBAFormat, THREE.FloatType)
  t.mapping = THREE.EquirectangularReflectionMapping
  t.magFilter = t.minFilter = THREE.LinearFilter
  t.needsUpdate = true
  return t
}

/**
 * The raster view as linear RGBA floats at `w`×`h` (no tone mapping: it goes
 * to a render target), with its own environment put back for the one draw
 * and no background, so alpha marks the pixels the attic covers.
 */
function rasterPixels(
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  w: number,
  h: number,
  env: THREE.Texture | null,
  envIntensity: number,
): Float32Array {
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType })
  const prev = { target: gl.getRenderTarget(), alpha: gl.getClearAlpha(), color: gl.getClearColor(new THREE.Color()) }
  const swap = { bg: scene.background, env: scene.environment, intensity: scene.environmentIntensity }
  scene.background = null
  scene.environment = env
  scene.environmentIntensity = envIntensity
  try {
    gl.setRenderTarget(rt)
    gl.setClearColor(0x000000, 0)
    gl.clear()
    gl.render(scene, camera)
    const out = new Float32Array(w * h * 4)
    gl.readRenderTargetPixels(rt, 0, 0, w, h, out)
    return out
  } finally {
    scene.background = swap.bg
    scene.environment = swap.env
    scene.environmentIntensity = swap.intensity
    gl.setRenderTarget(prev.target)
    gl.setClearColor(prev.color, prev.alpha)
    rt.dispose()
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

/** Free this renderer's tracer, its low-res twin, their uniform textures and the BVH geometry. */
export function disposePhoto(gl: THREE.WebGLRenderer): void {
  const t = tracers.get(gl)
  if (!t) return
  tracers.delete(gl)
  const { pt } = t
  const inner = pt as unknown as Internals
  const mats = new Set([inner._pathTracer.material, inner._lowResPathTracer.material])
  pt.dispose()
  inner._lowResPathTracer.dispose()
  mats.forEach((m) => {
    Object.values(m.uniforms ?? {}).forEach((u) => (u.value as Disposable | null)?.dispose?.())
    m.dispose()
  })
  inner._generator.geometry?.dispose()
}
