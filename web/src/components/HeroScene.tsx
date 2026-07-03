import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame } from '@react-three/fiber'
import { overscanGeometry, parseHexColor, isCopperRow, terrainGrid } from '../lib/heroScene'

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

const VERT = /* glsl */ `
  uniform float uTime;
  uniform float uSpanX;
  uniform float uElevX;
  uniform float uPointScale;
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
    vFog = mix(0.3, 1.0, smoothstep(3.6, 0.8, dist));
    vCopper = aCopper;
  }
`

const FRAG = /* glsl */ `
  precision mediump float;
  uniform vec3 uAccent;
  uniform vec3 uCopper;
  varying float vCopper;
  varying float vFog;

  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d2 = dot(c, c);
    if (d2 > 0.25) discard;
    float edge = smoothstep(0.25, 0.14, d2);
    vec3 col = mix(uAccent, uCopper, vCopper);
    float a = 0.68 * mix(1.0, 0.85, vCopper) * vFog * vFog * edge;
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
  const material = useRef<THREE.ShaderMaterial>(null)
  const group = useRef<THREE.Group>(null)
  const time = useRef(0)
  const rot = useRef({ yaw: 0, pitch: 0 })

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
    uAccent: { value: THREE.Color }
    uCopper: { value: THREE.Color }
  } | null>(null)
  if (uniformsRef.current === null) {
    uniformsRef.current = {
      uTime: { value: 0 },
      uSpanX: { value: WORLD_X_BASE * shared.spanScale },
      uElevX: { value: ELEV_X_BASE * shared.spanScale },
      uPointScale: { value: 4.6 },
      uAccent: { value: shared.accentTarget.clone() },
      uCopper: { value: shared.copperTarget.clone() },
    }
  }
  const uniforms = uniformsRef.current

  useFrame(({ gl, size }, delta) => {
    // Clamp so a tab-restore doesn't jump the waves. The 1.35 factor restores
    // the rolling feel of the 2D canvas: dotted rows carry far less contrast
    // per crest than its solid strokes did, so the same wave speeds read
    // noticeably stiller here.
    time.current += Math.min(delta, 0.05) * 1.35
    uniforms.uTime.value = time.current
    uniforms.uSpanX.value = WORLD_X_BASE * shared.spanScale
    uniforms.uElevX.value = ELEV_X_BASE * shared.spanScale
    // Dot size tracks rendered height like the 2D dots tracked H
    uniforms.uPointScale.value = 4.6 * (size.height / 520) * gl.getPixelRatio()

    const r = rot.current
    r.yaw += (shared.targetYaw - r.yaw) * 0.04
    r.pitch += (shared.targetPitch - r.pitch) * 0.04
    if (group.current) {
      group.current.rotation.y = r.yaw
      group.current.rotation.x = r.pitch
    }

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
    <group ref={group} position={[0, -0.12, -1.35]}>
      <points geometry={geometry} frustumCulled={false}>
        <shaderMaterial
          ref={material}
          vertexShader={VERT}
          fragmentShader={FRAG}
          uniforms={uniforms}
          transparent
          depthWrite={false}
          depthTest={false}
        />
      </points>
    </group>
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
    }
    // Read colors before the first render so frame one is on-theme, not a lerp from black
    readTargetColors(sharedRef.current)
  }
  const shared = sharedRef.current

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return

    const measure = () => {
      const w0 = wrap.clientWidth
      if (w0 === 0) return
      const geo = overscanGeometry(w0)
      shared.spanScale = geo.spanScale
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
      shared.targetYaw = ((e.clientX - rect.left) / rect.width - 0.5) * 0.14
      shared.targetPitch = ((e.clientY - rect.top) / rect.height - 0.5) * 0.07
    }
    const onPointerLeave = () => {
      shared.targetYaw = 0
      shared.targetPitch = 0
    }
    wrap.addEventListener('pointermove', onPointerMove)
    wrap.addEventListener('pointerleave', onPointerLeave)

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

    const mo = new MutationObserver(() => readTargetColors(shared))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    return () => {
      ro.disconnect()
      io.disconnect()
      mo.disconnect()
      wrap.removeEventListener('pointermove', onPointerMove)
      wrap.removeEventListener('pointerleave', onPointerLeave)
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
      camera={{ fov: 55, near: 0.05, far: 10, position: [0, 0.55, 0.6], rotation: [-0.35, 0, 0] }}
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
