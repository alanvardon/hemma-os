// Swedish labels, one-line descriptions and the info lines under an item's
// editor, from v41 `TYPES`, `describe` (1578) and `infoHtml` (1636). The
// numbers come from the pure core; only the words are here.

import { cm, type Geometry } from '../../lib/vindsplanen/attic'
import { closetGeom, storageGeom } from '../../lib/vindsplanen/items'
import { isUpStair } from '../../lib/vindsplanen/stairs'
import { curvedInfo, skyInfo, stairInfo } from '../../lib/vindsplanen/warnings'
import type { Item, ItemType, PlanV2 } from '../../lib/vindsplanen/plan'
import { fmt } from './fmt'

export const TYPE_LABEL: Record<ItemType, string> = {
  bed: 'Säng',
  skylight: 'Takfönster',
  wall: 'Mellanvägg',
  stairs: 'Trappa (rak)',
  curved: 'Svängd trappa',
  spiral: 'Spiraltrappa',
  storage: 'Förråd',
  closet: 'Inbyggd garderob',
  wardrobe: 'Garderob',
  desk: 'Skrivbord',
  sofa: 'Soffa',
  dresser: 'Byrå',
  nightstand: 'Sängbord',
  rug: 'Matta',
}

type Slice = Pick<PlanV2, 'items' | 'options'>

export function describeItem(geo: Geometry, plan: Slice, it: Item): string {
  switch (it.type) {
    case 'closet': {
      const C = closetGeom(geo, plan, it)
      return `${cm(C.d)} × ${cm(Math.abs(C.zb - C.zd))} cm · ${it.wall === 'E' ? 'östra' : 'västra'} gaveln, ${it.side === 'N' ? 'norr' : 'söder'}`
    }
    case 'skylight':
      return `${it.size} · ${it.slope === 'S' ? 'södra' : 'norra'} sidan · fack ${it.bay + 1}`
    case 'wall':
      return `${fmt(it.x)} m från väst${it.door ? ' · dörr' : ''}`
    case 'storage':
      return `${cm(it.w)} × ${cm(it.d)} cm · ${it.side === 'N' ? 'norra' : 'södra'} sidan`
    case 'bed':
      return `${it.size} · ${fmt(it.x)} m`
    case 'stairs':
      return `${cm(it.w)}×${cm(it.run)} cm öppning`
    case 'spiral':
      return `Ø ${cm(it.d)} cm · ${it.deg}° ${it.dir === 'ccw' ? 'moturs' : 'medurs'}`
    case 'curved':
      return it.turn === 'N' ? 'rak' : `svänger ${it.turn === 'L' ? 'vänster' : 'höger'} efter ${it.a} steg`
    default:
      return `${cm(it.w)}×${cm(it.d)} cm · ${fmt(it.x)} m`
  }
}

export function infoLines(geo: Geometry, plan: Slice, it: Item, holesOk: ReadonlySet<string>): string[] {
  if (it.type === 'closet') {
    const C = closetGeom(geo, plan, it)
    return [
      `Invändigt ${cm(C.d - 0.1)} cm brett, ${cm(Math.abs(C.zb - C.zd) - 0.04)} cm djupt, ${cm(C.hD)} cm högt vid dörren`,
      `Dörr ${cm(C.dw)} × ${cm(C.dh)} cm på kortsidan mot rummet`,
    ]
  }
  if (it.type === 'storage') {
    const S = storageGeom(geo, plan, it)
    const eaves = Math.abs(S.zb) > geo.KZ + 0.01
    const floor = it.w * it.d + (S.ext ? (S.ext.x2 - S.x1) * Math.abs(S.ext.zn - S.zf) : 0)
    return [
      `Golvyta ${fmt(floor, 1)} m²${S.ext ? ' inklusive hörnet vid trappan' : ''}${eaves ? ` plus ${fmt(it.w * (geo.HALF - geo.KZ), 1)} m² lågt förråd i takfoten bakom` : ''}`,
      `Höjd framtill ${cm(S.hF)} cm · dörr ${cm(S.dw)} × ${cm(S.dh)} cm`,
    ]
  }
  if (isUpStair(it)) {
    const c = curvedInfo(geo, plan, it, new Set())
    const P = c.P
    const out = [
      `${P.n} steg · stighöjd ${fmt(P.r * 100, 1)} cm · stegdjup ${fmt(P.g * 100, 0)} cm${P.spiral ? ' längs gånglinjen' : ''} · 2 × stighöjd + stegdjup = ${fmt((2 * P.r + P.g) * 100, 0)} cm`,
      `Våning till våning ${cm(P.F)} cm (ställs in under Rummet → Våningen under)`,
      `Trängsta takhöjd under taket: ${cm(c.head)} cm`,
    ]
    if (Number.isFinite(c.downHead)) out.push(`Över den befintliga trappan: ${cm(c.downHead)} cm`)
    out.push(`Smalaste gångväg kvar i hallen under: ${cm(c.minFree)} cm`)
    return out
  }
  if (it.type === 'stairs') {
    const s = stairInfo(geo, it)
    return [
      `${s.n} steg · stighöjd ${fmt(s.rise * 100, 1)} cm · stegdjup ${fmt(s.going * 100, 1)} cm`,
      `2 × stighöjd + stegdjup = ${fmt(s.blondel * 100, 0)} cm (bekvämt 60–65)`,
      `Trängsta takhöjd i trappan: ${cm(s.minHead)} cm`,
    ]
  }
  if (it.type === 'skylight') {
    const s = skyInfo(geo, it, holesOk)
    return [`Öppning mellan sparrarna här: ${fmt(s.bay.clear * 100, 1)} cm`, `Överkant ${cm(s.topY)} cm över golvet`]
  }
  return []
}
