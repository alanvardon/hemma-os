// English labels, one-line descriptions and the info lines under an item's
// editor, from v41 `TYPES`, `describe` (1578) and `infoHtml` (1636). The
// numbers come from the pure core; only the words are here.

import { cm, type Geometry } from '../../lib/vindsplanen/attic'
import { closetGeom, storageGeom } from '../../lib/vindsplanen/items'
import { isUpStair } from '../../lib/vindsplanen/stairs'
import { curvedInfo, skyInfo, stairInfo } from '../../lib/vindsplanen/warnings'
import type { Item, ItemType, PlanV2 } from '../../lib/vindsplanen/plan'
import { fmt } from './fmt'

export const TYPE_LABEL: Record<ItemType, string> = {
  bed: 'Bed',
  skylight: 'Roof window',
  wall: 'Partition wall',
  stairs: 'Stairs (straight)',
  curved: 'Turning stairs',
  spiral: 'Spiral stairs',
  storage: 'Storage room',
  closet: 'Built-in closet',
  wardrobe: 'Wardrobe',
  desk: 'Desk',
  sofa: 'Sofa',
  dresser: 'Dresser',
  nightstand: 'Nightstand',
  rug: 'Rug',
}

type Slice = Pick<PlanV2, 'items' | 'options'>

export function describeItem(geo: Geometry, plan: Slice, it: Item): string {
  switch (it.type) {
    case 'closet': {
      const C = closetGeom(geo, plan, it)
      return `${cm(C.d)} × ${cm(Math.abs(C.zb - C.zd))} cm · ${it.wall === 'E' ? 'east' : 'west'} gable, ${it.side === 'N' ? 'north' : 'south'}`
    }
    case 'skylight':
      return `${it.size} · ${it.slope === 'S' ? 'south' : 'north'} slope · bay ${it.bay + 1}`
    case 'wall':
      return `${fmt(it.x)} m from west${it.door ? ' · door' : ''}`
    case 'storage':
      return `${cm(it.w)} × ${cm(it.d)} cm · ${it.side === 'N' ? 'north' : 'south'} side`
    case 'bed':
      return `${it.size} · ${fmt(it.x)} m`
    case 'stairs':
      return `${cm(it.w)}×${cm(it.run)} cm opening`
    case 'spiral':
      return `Ø ${cm(it.d)} cm · ${it.deg}° ${it.dir === 'ccw' ? 'anticlockwise' : 'clockwise'}`
    case 'curved':
      return it.turn === 'N' ? 'straight' : `turns ${it.turn === 'L' ? 'left' : 'right'} after ${it.a} steps`
    default:
      return `${cm(it.w)}×${cm(it.d)} cm · ${fmt(it.x)} m`
  }
}

export function infoLines(geo: Geometry, plan: Slice, it: Item, holesOk: ReadonlySet<string>): string[] {
  if (it.type === 'closet') {
    const C = closetGeom(geo, plan, it)
    return [
      `Inside ${cm(C.d - 0.1)} cm wide, ${cm(Math.abs(C.zb - C.zd) - 0.04)} cm deep, ${cm(C.hD)} cm high at the door`,
      `Door ${cm(C.dw)} × ${cm(C.dh)} cm on the end facing the room`,
    ]
  }
  if (it.type === 'storage') {
    const S = storageGeom(geo, plan, it)
    const eaves = Math.abs(S.zb) > geo.KZ + 0.01
    const floor = it.w * it.d + (S.ext ? (S.ext.x2 - S.x1) * Math.abs(S.ext.zn - S.zf) : 0)
    return [
      `Floor ${fmt(floor, 1)} m²${S.ext ? ' including the corner by the stairs' : ''}${eaves ? ` plus ${fmt(it.w * (geo.HALF - geo.KZ), 1)} m² of low eaves storage behind` : ''}`,
      `Height at the front ${cm(S.hF)} cm · door ${cm(S.dw)} × ${cm(S.dh)} cm`,
    ]
  }
  if (isUpStair(it)) {
    const c = curvedInfo(geo, plan, it, new Set())
    const P = c.P
    const out = [
      `${P.n} steps · rise ${fmt(P.r * 100, 1)} cm · going ${fmt(P.g * 100, 0)} cm${P.spiral ? ' along the walking line' : ''} · 2 × rise + going = ${fmt((2 * P.r + P.g) * 100, 0)} cm`,
      `Floor-to-floor ${cm(P.F)} cm (set under Room → Floor below)`,
      `Tightest headroom under the roof: ${cm(c.head)} cm`,
    ]
    if (Number.isFinite(c.downHead)) out.push(`Above the existing stairs: ${cm(c.downHead)} cm`)
    out.push(`Narrowest walkway left in the hallway below: ${cm(c.minFree)} cm`)
    return out
  }
  if (it.type === 'stairs') {
    const s = stairInfo(geo, it)
    return [
      `${s.n} steps · rise ${fmt(s.rise * 100, 1)} cm · going ${fmt(s.going * 100, 1)} cm`,
      `2 × rise + going = ${fmt(s.blondel * 100, 0)} cm (comfortable 60–65)`,
      `Tightest headroom on the flight: ${cm(s.minHead)} cm`,
    ]
  }
  if (it.type === 'skylight') {
    const s = skyInfo(geo, it, holesOk)
    return [`Gap between rafters here: ${fmt(s.bay.clear * 100, 1)} cm`, `Top edge ${cm(s.topY)} cm above floor`]
  }
  return []
}
