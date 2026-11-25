// Vindsplanen photo mode (plan 143): a progressive path tracer over the live
// scene. Its own lazy chunk (`import('./photo')` from Scene), fetched only when
// the user enters photo mode, so the path tracer never weighs on the 3D view.
//
// CSP: import only from the 'three-gpu-pathtracer' main entry and build the
// scene synchronously (`setScene`). Never import 'three-mesh-bvh/worker' or
// call `setSceneAsync`/`setBVHWorker` — those spawn blob: workers, which the
// production CSP forbids.

import type * as THREE from 'three'
import { WebGLPathTracer } from 'three-gpu-pathtracer'

/** One tracer per scene lifetime, reusing R3F's renderer (Stage 2 builds on this). */
export function createTracer(gl: THREE.WebGLRenderer): WebGLPathTracer {
  return new WebGLPathTracer(gl)
}
