// Mounts the lazy 3D scene behind a Suspense fallback and an error boundary.
// WebGL missing, a context failure or a render error replaces the scene with a
// notice; the panels (and saving) keep working either way. Only type imports
// from ./scene/Scene here, so three.js stays out of the route's own chunk.

import { Component, lazy, Suspense, useState, type ReactNode, type Ref } from 'react'
import type { SceneHandle, SceneProps } from './scene/Scene'

const Scene = lazy(() => import('./scene/Scene'))

export const NO_3D_TEXT = '3D-vyn kan inte visas i den här webbläsaren'

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    return false
  }
}

class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function Unavailable() {
  return (
    <div className="vp-no3d" role="status">
      <p>{NO_3D_TEXT}</p>
      <p>Allt annat fungerar som vanligt: du kan redigera, mäta och spara planen.</p>
    </div>
  )
}

export default function SceneHost(props: Omit<SceneProps, 'ref'> & { sceneRef?: Ref<SceneHandle> }) {
  const { sceneRef, ...rest } = props
  const [gl] = useState(webglAvailable)
  if (!gl) return <Unavailable />
  return (
    <Boundary fallback={<Unavailable />}>
      <Suspense fallback={<div className="vp-loading3d" role="status">Laddar 3D-vyn…</div>}>
        <Scene {...rest} ref={sceneRef} className="vp-scene" />
      </Suspense>
    </Boundary>
  )
}
