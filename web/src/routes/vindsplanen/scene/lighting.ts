// Image-based light and the evening lamps for the Vindsplanen scene (plan 141).
//
// The sky gradient (materials.ts `skyTexture`) stays the visible background;
// what surfaces *reflect* and are lit by indirectly is three's RoomEnvironment
// (a neutral, softly lit studio box) prefiltered with PMREM, so metal, brass
// and glass have something to mirror and wood and paint read as materials
// rather than flat plastic.

import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { LampSpot } from '../../../lib/vindsplanen/lamps'

/** A PMREM of three's RoomEnvironment. `dispose()` frees its render target. */
export function roomEnvMap(gl: THREE.WebGLRenderer): { texture: THREE.Texture; dispose(): void } {
  const pmrem = new THREE.PMREMGenerator(gl)
  const room = new RoomEnvironment()
  const rt = pmrem.fromScene(room, 0.04)
  room.dispose()
  pmrem.dispose()
  return { texture: rt.texture, dispose: () => rt.dispose() }
}

/** 2700 K, a warm incandescent/LED bulb. */
export const LAMP_COLOR = '#ffb46b'
/** Point-light intensity (candela) per lamp kind: the room pendants light the room, the small lamps their corner. */
export const LAMP_INTENSITY: Readonly<Record<LampSpot['kind'], number>> = { pendant: 2.4, table: 1.0, floor: 1.6 }

/**
 * Warm point lights (with a small glowing bulb each) at `spots`. In `nice`
 * quality the first lamp — a room pendant, the brightest — casts shadows.
 */
export function buildLamps(spots: readonly LampSpot[], nice: boolean): { group: THREE.Group; dispose(): void } {
  const group = new THREE.Group()
  const bulbGeo = new THREE.SphereGeometry(0.035, 16, 12)
  // over 1 in linear light, so the bloom pass picks the bulbs up
  const bulbMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(LAMP_COLOR).multiplyScalar(4) })
  const lights: THREE.PointLight[] = []
  spots.forEach((s, i) => {
    const l = new THREE.PointLight(LAMP_COLOR, LAMP_INTENSITY[s.kind], 0, 2)
    l.position.set(...s.at)
    if (nice && i === 0) {
      l.castShadow = true
      l.shadow.mapSize.set(512, 512)
      l.shadow.bias = -0.002
      l.shadow.normalBias = 0.02
      l.shadow.camera.near = 0.05
      l.shadow.camera.far = 12
      l.shadow.camera.layers.enableAll() // cut-away surfaces still cast shadows (see Scene)
    }
    lights.push(l)
    group.add(l)
    const bulb = new THREE.Mesh(bulbGeo, bulbMat)
    bulb.position.set(...s.at)
    bulb.userData.overlay = true // not pickable, not a surface
    group.add(bulb)
  })
  return {
    group,
    dispose() {
      lights.forEach((l) => l.dispose())
      bulbGeo.dispose()
      bulbMat.dispose()
    },
  }
}
