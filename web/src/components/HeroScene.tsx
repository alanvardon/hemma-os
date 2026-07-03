import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame } from '@react-three/fiber'
import {
  overscanGeometry,
  parseHexColor,
  isCopperRow,
  terrainGrid,
  scrollProgress,
  dollyFor,
  stepRipple,
  rippleTarget,
  timeBucket,
  paletteFor,
  type ScenePalette,
} from '../lib/heroScene'
import { isVtActive } from '../lib/viewTransition'

/* WebGL hero terrain (plan 28a) — the same landscape motif as HeroCanvas2D,
   rebuilt as a GPU points field with depth fog. This file is the ONLY module
   that imports three.js; it is loaded lazily by the HeroCanvas orchestrator
   so the entry chunk stays three-free (verified in the build output).

   Shares the .hero-wrap element with the 2D layer via `wrapRef`: sizing,
   overscan and the mask-fade vars all anchor to it, and the pointer parallax
   listens on it (the hero copy sits on top of the canvas, so listening on the
   canvas itself would lose the pointer over text). */

// World scale: elevation() below is fed the SAME coordinate ranges as the 2D
// canvas (x over ±1.3·spanScale, z over 0..1.55) so the wave pattern is the
// same landscape; the world-unit spans only control how it sits in the camera.
const ELEV_X_BASE = 1.3
const ELEV_Z = 1.55
const WORLD_X_BASE = 1.78
const WORLD_Z = 2.2
const HEIGHT = 0.62
// Terrain group and camera rest pose — the scroll dolly and the pointer→plane
// mapping both need these, so they live beside the JSX that uses them.
const GROUP_Y = -0.12
const GROUP_Z = -1.35
const CAM_Y = 0.55
const CAM_PITCH = -0.35

const VERT = /* glsl */ `
  uniform float uTime;
  uniform float uSpanX;
  uniform float uElevX;
  uniform float uPointScale;
  uniform float uFogScale;
  // xy: ripple centre in grid coords (x −1..1, z 0..1), z: strength 0..1
  uniform vec3 uRipple;
  attribute float aCopper;
  varying float vCopper;
  varying float vFog;

  // Port of HeroCanvas2D's elevation(), plus one ridged octave for relief
  // the 2D strokes could only hint at. The ridge is the dominant visual
  // feature, so it must drift at a clearly perceptible rate — at its original
  // t*0.12 it crawled and the whole scene read as frozen even though the four
  // wave octaves were moving underneath it.
  float elevation(float x, float z, float t) {
    return 0.17 * sin(x * 2.1 + t * 0.55)
         + 0.11 * sin(x * 3.7 - z * 2.3 + t * 0.35)
         + 0.07 * sin((x + z) * 5.3 + t * 0.7)
         + 0.05 * sin(z * 4.1 - t * 0.45)
         + 0.06 * (1.0 - abs(sin(x * 1.15 - z * 1.7 - t * 0.34)));
  }

  void main() {
    // position.x in [-1,1], position.z in [0 near, 1 far]
    float ex = position.x * uElevX;
    float ez = position.z * ${ELEV_Z};
    float h = elevation(ex, ez, uTime);
    // Pointer ripple: a gaussian swell around the cursor's footprint on the
    // plane, measured in world units so it stays circular despite the grid's
    // anisotropy. Radius ≈ 15% of the terrain width; height ≈ wave amplitude.
    float rdx = (position.x - uRipple.x) * uSpanX;
    float rdz = (position.z - uRipple.y) * ${WORLD_Z};
    h += uRipple.z * 0.3 * exp(-(rdx * rdx + rdz * rdz) / 0.45);
    vec3 world = vec3(
      position.x * uSpanX,
      h * ${HEIGHT},
      (0.5 - position.z) * ${WORLD_Z}
    );
    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * mv;
    float dist = max(-mv.z, 0.001);
    gl_PointSize = clamp(uPointScale / dist, 0.75, 6.5);
    // Depth fade echoing the 2D depth² alpha: far rows dissolve toward the
    // paper, but never fully vanish (the 2D far rows sit ~0.28).
    vFog = mix(0.3, 1.0, smoothstep(3.6, 0.8, dist * uFogScale));
    vCopper = aCopper;
  }
`

const FRAG = /* glsl */ `
  precision mediump float;
  uniform vec3 uAccent;
  uniform vec3 uCopper;
  uniform float uAlpha;
  uniform float uCopperWeight;
  varying float vCopper;
  varying float vFog;

  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d2 = dot(c, c);
    if (d2 > 0.25) discard;
    float edge = smoothstep(0.25, 0.14, d2);
    // uCopperWeight warms EVERY dot toward copper — dusk light on the peaks
    vec3 col = mix(uAccent, uCopper, min(vCopper + uCopperWeight, 1.0));
    float a = uAlpha * mix(1.0, 0.85, vCopper) * vFog * vFog * edge;
    gl_FragColor = vec4(col, a);
  }
`

/* Aurora curtains — a quad on the horizon behind the terrain, always on:
   additive glow in dark theme, a normal-blended pigment veil on the light
   paper (additive washes out to white there). Built for realism:
   - large-scale DOMAIN WARP sways the whole curtain like folding drapery
   - a sharp, undulating LOWER EDGE with a long diffuse fade upward (real
     aurora physics: the bright oxygen line sits at the curtain's base)
   - fine vertical RAYS that shear with the sway and flicker
   - brightness PULSES travelling along the curtain
   - an altitude COLOR RAMP: emission green at the base rising through the
     theme copper into violet tops.
   uIntensity is a hard opacity cap (lib/heroScene AURORA_MAX). */
const AURORA_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const AURORA_FRAG = /* glsl */ `
  precision mediump float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uIntensity;
  uniform vec3 uColor1;
  uniform vec3 uColor2;

  float hash(float n) { return fract(sin(n) * 43758.5453123); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i.x + i.y * 57.0);
    float b = hash(i.x + 1.0 + i.y * 57.0);
    float c = hash(i.x + (i.y + 1.0) * 57.0);
    float d = hash(i.x + 1.0 + (i.y + 1.0) * 57.0);
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float fbm(vec2 p) {
    return 0.5 * noise(p) + 0.25 * noise(p * 2.1) + 0.125 * noise(p * 4.3);
  }

  void main() {
    float t = uTime;

    // Folding drapery: two scales of domain warp displace where along the
    // curtain each fragment samples — the whole sheet sways and creases.
    float sway = fbm(vec2(vUv.x * 1.6 + t * 0.05, t * 0.035)) - 0.5;
    float crease = fbm(vec2(vUv.x * 3.4 - t * 0.075, 7.3 + t * 0.025)) - 0.5;
    float x = vUv.x + sway * 0.34 + crease * 0.12;

    // Curtain density along the warped axis — bands with dark gaps.
    float bands = 0.0;
    bands += fbm(vec2(x * 5.0 + t * 0.11, 0.0)) * 0.55;
    bands += fbm(vec2(x * 9.0 - t * 0.16, 3.7)) * 0.30;
    bands += fbm(vec2(x * 17.0 + t * 0.06, 8.1)) * 0.15;
    bands = smoothstep(0.22, 0.68, bands);

    // Fine vertical rays, sheared by the warp, flickering over seconds.
    float ray = noise(vec2(x * 64.0, t * 0.6));
    ray = 0.55 + 0.45 * smoothstep(0.3, 0.75, ray);

    // Brightness pulses travelling along the curtain.
    float pulse = 0.72 + 0.28 * sin(x * 12.0 - t * 0.9 + fbm(vec2(x * 4.0, t * 0.2)) * 4.0);

    // Altitude profile: a sharp lower edge that itself undulates with the
    // sway, then a long exponential fade toward the top of the sky. The base
    // sits clear of the terrain ridge so the curtains stand in open sky.
    float base = 0.26 + sway * 0.15 + bands * 0.05;
    float up = (vUv.y - base) / max(1.0 - base, 0.001);
    float profile = smoothstep(-0.02, 0.06, up) * exp(-up * 1.9);

    float curtain = bands * ray * pulse * profile;

    // Altitude color ramp: vivid oxygen-emission green at the base (the
    // theme accent pushed toward the real 557.7nm line) -> violet tops
    // (high-altitude aurora reds/purples, warmed slightly by theme copper).
    vec3 green = mix(uColor1 * 1.25, vec3(0.24, 0.95, 0.52), 0.5);
    vec3 violet = mix(uColor2, vec3(0.5, 0.3, 0.82), 0.72);
    vec3 col = mix(green, violet, clamp(up * 1.4, 0.0, 1.0));

    float a = min(curtain * 1.7, 1.0) * uIntensity;
    gl_FragColor = vec4(col, a);
  }
`

/* Mutable channel between the DOM side (pointer, resize, theme observer) and
   the render loop — refs, not state, so nothing re-renders per frame. */
interface SharedState {
  targetYaw: number
  targetPitch: number
  accentTarget: THREE.Color
  copperTarget: THREE.Color
  spanScale: number
  ready: boolean
  /* pointer position in the overscanned canvas's NDC, for the ripple raycast */
  ndcX: number
  ndcY: number
  /* performance.now() of the last pointermove; -Infinity once the pointer leaves */
  lastMoveAt: number
  /* 0–1 progress of the hero scrolling off toward the Tools grid */
  scroll: number
  /* lerp targets for the time-of-day light (plan 28c) */
  palette: ScenePalette
  /* the aurora flips blending per theme: additive glow (dark) vs pigment veil (light) */
  isDark: boolean
}

function currentTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function readPalette(shared: SharedState) {
  const theme = currentTheme()
  shared.isDark = theme === 'dark'
  shared.palette = paletteFor(timeBucket(new Date().getHours()), theme)
}

function readTargetColors(shared: SharedState) {
  const style = getComputedStyle(document.documentElement)
  const a = parseHexColor(style.getPropertyValue('--canvas-accent'), [77, 138, 98])
  const k = parseHexColor(style.getPropertyValue('--canvas-copper'), [176, 107, 56])
  shared.accentTarget.setRGB(a[0] / 255, a[1] / 255, a[2] / 255)
  shared.copperTarget.setRGB(k[0] / 255, k[1] / 255, k[2] / 255)
}

function Terrain({ shared, cols, onFirstFrame }: {
  shared: SharedState
  cols: number
  onFirstFrame: () => void
}) {
  const group = useRef<THREE.Group>(null)
  const time = useRef(0)
  const rot = useRef({ yaw: 0, pitch: 0 })
  const rippleStrength = useRef(0)
  const scrollCur = useRef(0)
  // Smoothed time-of-day light, easing toward shared.palette (~1s, atmospheric)
  const paletteCur = useRef<ScenePalette>({ ...shared.palette })
  // Reused per-frame objects for the pointer→terrain-plane mapping (the
  // terrain's base plane sits at world y = GROUP_Y; small parallax rotations
  // are ignored — the ripple is a soft gaussian, exactness buys nothing).
  const pick = useRef({
    raycaster: new THREE.Raycaster(),
    plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -GROUP_Y),
    ndc: new THREE.Vector2(),
    hit: new THREE.Vector3(),
  }).current

  const rows = 44
  const geometry = useMemo(() => {
    const n = rows * (cols + 1)
    const positions = new Float32Array(n * 3)
    const copper = new Float32Array(n)
    let i = 0
    for (let r = 0; r < rows; r++) {
      const z = r / (rows - 1)
      const isCopper = isCopperRow(r) ? 1 : 0
      for (let c = 0; c <= cols; c++) {
        positions[i * 3] = (c / cols) * 2 - 1
        positions[i * 3 + 1] = 0
        positions[i * 3 + 2] = z
        copper[i] = isCopper
        i++
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('aCopper', new THREE.BufferAttribute(copper, 1))
    // The vertex shader displaces well past the raw attribute bounds — never cull.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0.5), 10)
    return geo
  }, [cols])
  useEffect(() => () => geometry.dispose(), [geometry])

  // Uniform objects are created once (lazy ref, not memo — the initial
  // shared.* reads must not retrigger creation); useFrame writes fresh
  // values into them every frame.
  const uniformsRef = useRef<{
    uTime: { value: number }
    uSpanX: { value: number }
    uElevX: { value: number }
    uPointScale: { value: number }
    uFogScale: { value: number }
    uRipple: { value: THREE.Vector3 }
    uAlpha: { value: number }
    uCopperWeight: { value: number }
    uAccent: { value: THREE.Color }
    uCopper: { value: THREE.Color }
  } | null>(null)
  if (uniformsRef.current === null) {
    uniformsRef.current = {
      uTime: { value: 0 },
      uSpanX: { value: WORLD_X_BASE * shared.spanScale },
      uElevX: { value: ELEV_X_BASE * shared.spanScale },
      uPointScale: { value: 4.6 },
      uFogScale: { value: shared.palette.fogScale },
      uRipple: { value: new THREE.Vector3(0, 0.5, 0) },
      uAlpha: { value: shared.palette.alpha },
      uCopperWeight: { value: shared.palette.copperWeight },
      uAccent: { value: shared.accentTarget.clone() },
      uCopper: { value: shared.copperTarget.clone() },
    }
  }
  const uniforms = uniformsRef.current

  // Construct the material imperatively: R3F v9 CLONES a `uniforms` prop when
  // applying it to a <shaderMaterial>, so the material would render a private
  // copy frozen at the initial values while useFrame mutates an orphan (the
  // frozen-waves bug). Built here, `material.uniforms` IS our object.
  const materialRef = useRef<THREE.ShaderMaterial | null>(null)
  if (materialRef.current === null) {
    materialRef.current = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    })
  }
  const sceneMaterial = materialRef.current
  useEffect(() => () => sceneMaterial.dispose(), [sceneMaterial])

  useFrame(({ gl, size, camera }, delta) => {
    // Clamp so a tab-restore doesn't jump the waves. The 1.35 factor restores
    // the rolling feel of the 2D canvas: dotted rows carry far less contrast
    // per crest than its solid strokes did, so the same wave speeds read
    // noticeably stiller here.
    time.current += Math.min(delta, 0.05) * 1.35
    uniforms.uTime.value = time.current
    uniforms.uSpanX.value = WORLD_X_BASE * shared.spanScale
    uniforms.uElevX.value = ELEV_X_BASE * shared.spanScale
    // Time-of-day light: ease toward the bucket×theme palette (~1s)
    const pal = paletteCur.current
    const kp = 1 - Math.exp(-delta * 3)
    pal.fogScale += (shared.palette.fogScale - pal.fogScale) * kp
    pal.alpha += (shared.palette.alpha - pal.alpha) * kp
    pal.copperWeight += (shared.palette.copperWeight - pal.copperWeight) * kp
    pal.dotScale += (shared.palette.dotScale - pal.dotScale) * kp
    uniforms.uAlpha.value = pal.alpha
    uniforms.uCopperWeight.value = pal.copperWeight

    // Dot size tracks rendered height like the 2D dots tracked H
    uniforms.uPointScale.value = 4.6 * (size.height / 520) * gl.getPixelRatio() * pal.dotScale

    // While a View Transition is running, everything eases to neutral so the
    // frozen snapshot the whoosh grabs is a clean, untilted terrain.
    const vtActive = isVtActive()

    const r = rot.current
    r.yaw += ((vtActive ? 0 : shared.targetYaw) - r.yaw) * 0.04
    r.pitch += ((vtActive ? 0 : shared.targetPitch) - r.pitch) * 0.04
    if (group.current) {
      group.current.rotation.y = r.yaw
      group.current.rotation.x = r.pitch
    }

    // Pointer ripple: spring the strength toward full while the pointer is
    // actively moving, decay once it rests/leaves; the centre keeps tracking
    // the cursor's footprint on the terrain plane while there's any strength
    // left, so a fading swell doesn't jump.
    const msSinceMove = performance.now() - shared.lastMoveAt
    const target = vtActive ? 0 : rippleTarget(msSinceMove)
    rippleStrength.current = stepRipple(rippleStrength.current, target, delta)
    if (rippleStrength.current > 0.001 && Number.isFinite(shared.lastMoveAt)) {
      pick.ndc.set(shared.ndcX, shared.ndcY)
      pick.raycaster.setFromCamera(pick.ndc, camera)
      if (pick.raycaster.ray.intersectPlane(pick.plane, pick.hit)) {
        uniforms.uRipple.value.x = pick.hit.x / uniforms.uSpanX.value
        uniforms.uRipple.value.y = 0.5 - (pick.hit.z - GROUP_Z) / WORLD_Z
      }
    }
    uniforms.uRipple.value.z = rippleStrength.current

    // Scroll dolly: descend past the ridge as the Tools grid takes over.
    // Fog combines the dolly pull-in with the time-of-day mist.
    scrollCur.current += (shared.scroll - scrollCur.current) * (1 - Math.exp(-delta * 6))
    const dolly = dollyFor(scrollCur.current)
    camera.position.y = CAM_Y + dolly.yOffset
    camera.rotation.x = CAM_PITCH + dolly.pitchOffset
    uniforms.uFogScale.value = dolly.fogScale * pal.fogScale

    // Ease theme flips (~600ms) instead of snapping
    const k = 1 - Math.exp(-delta * 8)
    ;(uniforms.uAccent.value as THREE.Color).lerp(shared.accentTarget, k)
    ;(uniforms.uCopper.value as THREE.Color).lerp(shared.copperTarget, k)

    if (!shared.ready) {
      shared.ready = true
      onFirstFrame()
    }
  })

  return (
    <group ref={group} position={[0, GROUP_Y, GROUP_Z]}>
      <points geometry={geometry} material={sceneMaterial} frustumCulled={false} />
    </group>
  )
}

function Aurora({ shared }: { shared: SharedState }) {
  const mesh = useRef<THREE.Mesh>(null)
  const time = useRef(0)
  const intensity = useRef(0)

  const uniformsRef = useRef<{
    uTime: { value: number }
    uIntensity: { value: number }
    uColor1: { value: THREE.Color }
    uColor2: { value: THREE.Color }
  } | null>(null)
  if (uniformsRef.current === null) {
    uniformsRef.current = {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uColor1: { value: shared.accentTarget.clone() },
      uColor2: { value: shared.copperTarget.clone() },
    }
  }
  const uniforms = uniformsRef.current

  // Imperative material — R3F v9 clones a `uniforms` prop (see the terrain
  // material above / PR #202), so it must be constructed with our object.
  const materialRef = useRef<THREE.ShaderMaterial | null>(null)
  if (materialRef.current === null) {
    materialRef.current = new THREE.ShaderMaterial({
      vertexShader: AURORA_VERT,
      fragmentShader: AURORA_FRAG,
      uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    })
  }
  const material = materialRef.current
  useEffect(() => () => material.dispose(), [material])

  useFrame((_, delta) => {
    time.current += Math.min(delta, 0.05)
    uniforms.uTime.value = time.current
    // Slow atmospheric fade (~2s) between themes/buckets.
    intensity.current += (shared.palette.aurora - intensity.current) * (1 - Math.exp(-delta * 1.6))
    uniforms.uIntensity.value = intensity.current
    const k = 1 - Math.exp(-delta * 8)
    uniforms.uColor1.value.lerp(shared.accentTarget, k)
    uniforms.uColor2.value.lerp(shared.copperTarget, k)
    // Additive light against the dark paper; on the light paper additive
    // clamps to white and vanishes, so the veil switches to normal blending
    // (pigment). Blending is pipeline state — no shader recompile.
    const want = shared.isDark ? THREE.AdditiveBlending : THREE.NormalBlending
    if (material.blending !== want) material.blending = want
    if (mesh.current) mesh.current.visible = intensity.current > 0.004
  })

  return (
    // Placed in the visible sky band: at z −3.4 the camera frames roughly
    // y −3 … +1.2, and the terrain silhouette tops out near y 0.2 — so the
    // quad spans −0.25 … 1.75 with its envelope peak just above the ridge.
    <mesh ref={mesh} position={[0, 0.75, -3.4]} material={material} renderOrder={-1} frustumCulled={false} visible={false}>
      <planeGeometry args={[26, 2.0]} />
    </mesh>
  )
}

export default function HeroScene({ wrapRef, onReady, onFail }: {
  wrapRef: React.RefObject<HTMLDivElement | null>
  onReady: () => void
  onFail: () => void
}) {
  const [frameloop, setFrameloop] = useState<'always' | 'never'>('always')
  const [layout, setLayout] = useState(() => overscanGeometry(1200))
  const [cols, setCols] = useState(() => {
    const g = overscanGeometry(1200)
    return terrainGrid(1200, g.spanScale).cols
  })
  const [ready, setReady] = useState(false)

  // R3F calls forceContextLoss() when the Canvas unmounts (route change, HMR),
  // which fires `webglcontextlost` just like a real GPU reset. Defer the
  // failure reaction one tick and only degrade if we're still mounted — a
  // teardown loss must NOT poison the session with the gl-failed flag.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const sharedRef = useRef<SharedState | null>(null)
  if (sharedRef.current === null) {
    sharedRef.current = {
      targetYaw: 0,
      targetPitch: 0,
      accentTarget: new THREE.Color(),
      copperTarget: new THREE.Color(),
      spanScale: overscanGeometry(1200).spanScale,
      ready: false,
      ndcX: 0,
      ndcY: 0,
      lastMoveAt: -Infinity,
      scroll: 0,
      palette: paletteFor(timeBucket(new Date().getHours()), currentTheme()),
      isDark: currentTheme() === 'dark',
    }
    // Read colors before the first render so frame one is on-theme, not a lerp from black
    readTargetColors(sharedRef.current)
  }
  const shared = sharedRef.current

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return

    // Overscan margin in px, shared between measure() and the pointer→NDC
    // math (the canvas is wider than the wrap, so NDC must be computed
    // against the overscanned box, not the hero box).
    let marginX = 0

    const measure = () => {
      const w0 = wrap.clientWidth
      if (w0 === 0) return
      const geo = overscanGeometry(w0)
      shared.spanScale = geo.spanScale
      marginX = geo.marginX
      setLayout(geo)
      setCols(terrainGrid(w0, geo.spanScale).cols)
      // Same values the 2D layer writes — both anchor the mask vignette to
      // the un-overscanned hero edges (see home.css .hero-canvas).
      wrap.style.setProperty('--hc-fade-in', `${geo.fadeInPx}px`)
      wrap.style.setProperty('--hc-fade-out', `${geo.fadeOutPx}px`)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(wrap)

    const onPointerMove = (e: PointerEvent) => {
      const rect = wrap.getBoundingClientRect()
      // Half the 28a parallax — the ripple is the star now (plan 28b).
      shared.targetYaw = ((e.clientX - rect.left) / rect.width - 0.5) * 0.07
      shared.targetPitch = ((e.clientY - rect.top) / rect.height - 0.5) * 0.035
      const canvasW = rect.width + 2 * marginX
      shared.ndcX = ((e.clientX - rect.left + marginX) / canvasW) * 2 - 1
      shared.ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1)
      shared.lastMoveAt = performance.now()
    }
    const onPointerLeave = () => {
      shared.targetYaw = 0
      shared.targetPitch = 0
      shared.lastMoveAt = -Infinity
    }
    wrap.addEventListener('pointermove', onPointerMove)
    wrap.addEventListener('pointerleave', onPointerLeave)

    // Scroll dolly input — raw progress; the frame loop smooths it.
    const onScroll = () => {
      shared.scroll = scrollProgress(window.scrollY, wrap.clientHeight)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })

    // Pause the render loop while the tab is hidden OR the hero is scrolled
    // below the fold — the hub must stay cheap while idle. The last presented
    // frame stays composited, so a paused hero still shows the terrain.
    let heroVisible = true
    const applyLoop = () => setFrameloop(heroVisible && !document.hidden ? 'always' : 'never')
    const io = new IntersectionObserver((entries) => {
      heroVisible = entries[0]?.isIntersecting ?? true
      applyLoop()
    })
    io.observe(wrap)
    const onVisibility = () => applyLoop()
    document.addEventListener('visibilitychange', onVisibility)

    const mo = new MutationObserver(() => {
      readTargetColors(shared)
      readPalette(shared)
    })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    // The hour can roll into a new bucket mid-session — same cadence as the
    // hub greeting's 30s re-render (Home.tsx), so text and light stay in step.
    const paletteTimer = setInterval(() => readPalette(shared), 30_000)

    return () => {
      ro.disconnect()
      io.disconnect()
      mo.disconnect()
      clearInterval(paletteTimer)
      wrap.removeEventListener('pointermove', onPointerMove)
      wrap.removeEventListener('pointerleave', onPointerLeave)
      window.removeEventListener('scroll', onScroll)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [wrapRef, shared])

  return (
    <Canvas
      className={'hero-canvas hero-canvas-gl' + (ready ? ' is-ready' : '')}
      style={{ position: 'absolute', left: -layout.marginX, width: layout.width }}
      frameloop={frameloop}
      dpr={[1, 2]}
      gl={{ antialias: false, alpha: true, powerPreference: 'low-power' }}
      camera={{ fov: 55, near: 0.05, far: 10, position: [0, CAM_Y, 0.6], rotation: [CAM_PITCH, 0, 0] }}
      onCreated={({ gl }) => {
        gl.setClearColor(0x000000, 0)
        gl.domElement.addEventListener('webglcontextlost', (e) => {
          e.preventDefault()
          setTimeout(() => {
            if (mountedRef.current) onFail()
          }, 0)
        })
      }}
    >
      <Aurora shared={shared} />
      <Terrain
        shared={shared}
        cols={cols}
        onFirstFrame={() => {
          setReady(true)
          onReady()
        }}
      />
    </Canvas>
  )
}
