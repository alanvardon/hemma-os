// Rules check for Vindsplanen (plan 146): the plan measured against the few
// Boverket building rules that the model can actually grade, plus
// informational rows quoting the rules that are judged case by case.
//
// Legal basis (verified 2026-11-26 against the published PDFs from
// rinfo.boverket.se): BBR (BFS 2011:6) is repealed — chapters 3 and 5–8 on
// 2025-07-01 (BFS 2024:14), the rest on 2026-10-01. A permit application filed
// from 2026-07-01 uses "Boverkets nya byggregler":
//   - BFS 2024:7  säkerhet i händelse av brand, in force 2025-07-01, as amended
//                 by BFS 2025:10 (in force 2025-12-01; amends only 2 kap. 6–8 §§,
//                 5 kap. 21 §, 6 kap. 10 § — none of the sections used here).
//                 https://forfattningssamling.boverket.se/detaljer/BFS2024-7
//   - BFS 2024:8  hygien, hälsa och miljö, in force 2025-07-01.
//                 https://forfattningssamling.boverket.se/detaljer/BFS2024-8
//   - BFS 2024:9  säkerhet vid användning, in force 2025-07-01.
//                 https://forfattningssamling.boverket.se/detaljer/BFS2024-9
// Every quotation below is verbatim from those texts (all föreskrifter, not
// allmänna råd). The owner chose the narrow check (decision 2026-11-26 (a)):
// only numeric requirements the model can measure are graded; nothing else is
// ever reported 'ok'.
//
// Pure: no React, three.js or browser APIs. Uses the app's own measures
// (stairInfo, curvedInfo, computeZones, SKY_SIZES, skylight `bottom`).

import { bayAt, clamp, type Geometry } from './attic'
import { skyHolesOk, SKY_SIZES } from './items'
import type { Item, PlanV2 } from './plan'
import { BAL_CC, isUpStair, RAIL_H, stairCorners, toWorld, type Pt } from './stairs'
import { curvedInfo, stairInfo } from './warnings'
import { computeZones } from './zones'

export type RuleStatus = 'ok' | 'fail' | 'unknown' | 'info'

export interface RuleResult {
  /** Rule id (stable, for the UI copy); several rows may share one, told apart by itemId/params. */
  id: RuleId
  /** Citation, e.g. 'BFS 2024:9 2 kap. 25 §'. */
  ref: string
  status: RuleStatus
  /** What the plan has (metres or m²), when measured. */
  have?: number
  /** What the rule requires (metres or m²), when it states a number. */
  need?: number
  /** The plan item the row is about (select / fly to it). */
  itemId?: string
  params?: Record<string, number | string>
}

export type RuleId =
  | 'stair-free-height'
  | 'stair-tread-gaps'
  | 'stair-geometry'
  | 'stair-handrails'
  | 'stair-guards'
  | 'escape-window-sill'
  | 'escape-window-size'
  | 'floor-escape-door'
  | 'room-height'
  | 'alterations'

/** Footer text for the rules check. */
export const RULES_SOURCE =
  "Boverket's building rules BFS 2024:7 (as amended by BFS 2025:10), BFS 2024:8 and BFS 2024:9 — BBR was repealed 1 Oct 2026. Guidance, not a permit decision."

// ---------- Rule constants

/**
 * BFS 2024:9 2 kap. 25 § (föreskrift; BFS 2024:9, in force 2025-07-01,
 * https://forfattningssamling.boverket.se/detaljer/BFS2024-9):
 *   "Den fria höjden ska vara minst 2,00 meter i utrymningspassager, trappor,
 *   dörrar och andra kommunikationsutrymmen."
 * Gloss: the free height must be at least 2.00 m in escape routes, stairs,
 * doors and other circulation spaces. (Separate from the app's 1.90 m
 * comfort warnings.)
 */
export const FREE_HEIGHT_MIN = 2.0
export const REF_FREE_HEIGHT = 'BFS 2024:9 2 kap. 25 §'

/**
 * BFS 2024:9 2 kap. 6 § (föreskrift; BFS 2024:9, in force 2025-07-01,
 * https://forfattningssamling.boverket.se/detaljer/BFS2024-9):
 *   "Öppningar i trappor ska vara utformade så att yngre barn inte kan falla
 *   igenom eller fastna i dem. Öppningar mellan plansteg i trappor ska vara
 *   högst 100 mm."
 * Gloss: openings in stairs must stop young children falling through or
 * getting stuck; gaps between treads at most 100 mm. The model has no
 * open-riser data, so this is always 'unknown'.
 */
export const TREAD_GAP_MAX = 0.1
export const REF_TREAD_GAPS = 'BFS 2024:9 2 kap. 6 §'

/**
 * BFS 2024:7 2 kap. 26 § (föreskrift; BFS 2024:7 in force 2025-07-01, section
 * not changed by BFS 2025:10,
 * https://forfattningssamling.boverket.se/detaljer/BFS2024-7):
 *   "Fönster eller motsvarande för utrymning ska
 *   1. vara öppningsbara utan nyckel eller annat redskap,
 *   2. stanna i öppet läge efter öppning,
 *   3. ha en fri öppning med minst 0,50 meter bredd,
 *   4. ha en fri öppning med minst 0,60 meter höjd,
 *   5. ha en summa av bredd och höjd som är minst 1,50 meter, och
 *   6. ha ett avstånd från underkant till golv, plattform eller liknande på
 *   högst 1,20 meter."
 * Gloss: an escape window must open without a key or tool, stay open, have a
 * free opening ≥ 0.50 m wide, ≥ 0.60 m high, width + height ≥ 1.50 m, and its
 * lower edge at most 1.20 m above the floor or a platform. Point 6 is graded
 * from the window's `bottom`; points 3–5 concern the FREE opening, which is
 * smaller than the frame size the model stores, so they are 'unknown' unless
 * even the frame is too small (then the free opening is too, and it fails).
 */
export const ESCAPE_SILL_MAX = 1.2
export const ESCAPE_OPEN_W_MIN = 0.5
export const ESCAPE_OPEN_H_MIN = 0.6
export const ESCAPE_OPEN_SUM_MIN = 1.5
export const REF_ESCAPE_SILL = 'BFS 2024:7 2 kap. 26 § p. 6'
export const REF_ESCAPE_SIZE = 'BFS 2024:7 2 kap. 26 § p. 3–5'

/**
 * BFS 2024:7 7 kap. 16 § (föreskrift; BFS 2024:7 in force 2025-07-01, not
 * changed by BFS 2025:10,
 * https://forfattningssamling.boverket.se/detaljer/BFS2024-7):
 *   "Plan större än 25 m2 ska vara utformade så att personer som vistas där har
 *   tillgång till utrymningsdörr i samma plan.
 *   Plan som är 25 m2 eller mindre ska vara utformade så att personer som
 *   vistas där har tillgång till utrymningsdörr i samma plan eller närmast
 *   angränsande plan.
 *   Trots första stycket får plan vara utformade med tillgång till ett fönster
 *   eller motsvarande för utrymning i samma plan om utrymning via fönster eller
 *   motsvarande får tillämpas enligt 13 § eller 14 §."
 * Gloss: a storey over 25 m² needs an escape door on that storey, or a
 * qualifying escape window (7 kap. 13–14 §§: leads to a safe place, sill at
 * most 2.0 m — or for 3A in building class 2–3, 5.0 m / 8.0 m with a fixed
 * ladder — above the ground outside). A storey of 25 m² or less may use an
 * escape door on the adjacent storey. Informational: the height above the
 * ground outside is not in the model.
 */
export const ESCAPE_DOOR_AREA = 25
export const REF_FLOOR_ESCAPE = 'BFS 2024:7 7 kap. 16 §'

/**
 * BFS 2024:8 5 kap. 1 § (föreskrift; BFS 2024:8, in force 2025-07-01,
 * https://forfattningssamling.boverket.se/detaljer/BFS2024-8):
 *   "Rumshöjden ska vara tillräcklig för att undvika olägenheter för människors
 *   hälsa och vara anpassad till rummets avsedda användning."
 * Gloss: room height must be sufficient to avoid harm to health and suit the
 * room's intended use. No fixed number any more — judged per room. The
 * standing-height area (≥ 1.90 m, `computeZones`) is context only.
 */
export const REF_ROOM_HEIGHT = 'BFS 2024:8 5 kap. 1 §'

/**
 * BFS 2024:9 2 kap. 5 § (föreskrift, https://forfattningssamling.boverket.se/detaljer/BFS2024-9):
 *   "Trappor och ramper ska vara utformade så att personer kan förflytta sig
 *   säkert."
 * Gloss: stairs and ramps must let people move safely. No fixed rise/going —
 * shown with the stair's rise and going as context.
 */
export const REF_STAIR_GEOMETRY = 'BFS 2024:9 2 kap. 5 §'

/**
 * BFS 2024:9 2 kap. 12–13 §§ (föreskrift, https://forfattningssamling.boverket.se/detaljer/BFS2024-9):
 *   12 §: "Trappor och ramper ska ha ledstänger på båda sidor som stöd för
 *   balansen. Det räcker dock med en ledstång på ena sidan om det, med hänsyn
 *   till trappans eller rampens användning eller utformning, är obehövligt med
 *   ledstänger på båda sidor."
 *   13 §: "Ledstänger ska 1. vara placerade och utformade så att de är lätta att
 *   gripa om, 2. löpa kontinuerligt längs med trappan eller rampen, om det inte
 *   skulle motverka utrymmets avsedda användning, och 3. vara utformade så att
 *   de ger stöd innan man påbörjar och när man avslutar förflyttningen i
 *   trappan eller rampen."
 * Gloss: handrails on both sides — one side is enough where both are
 * unnecessary; easy to grip, continuous, and giving support before the first
 * and after the last step.
 */
export const REF_HANDRAILS = 'BFS 2024:9 2 kap. 12–13 §§'

/**
 * BFS 2024:9 2 kap. 10, 11 och 14 §§ (föreskrift, https://forfattningssamling.boverket.se/detaljer/BFS2024-9):
 *   10 §: "Trappor, ramper, balkonger, loftgångar, takterrasser och andra
 *   vistelseytor i eller i anslutning till byggnader, där det finns särskild
 *   risk för personskador till följd av fall, ska ha skydd mot fall. […]"
 *   11 §: "Ett skydd mot fall ska vara utformat och ha sådan höjd att det med
 *   hänsyn till ytans avsedda användning och fallhöjden begränsar risken för
 *   personskador till följd av fall. Skyddet ska tåla dynamisk påverkan av en
 *   människa. Utöver kraven i första stycket gäller följande i utrymmen där
 *   yngre barn kan vistas: 1. 0,8 meter av skyddets höjd ska vara utformat så
 *   att det motverkar klättring. 2. Vertikala öppningar i skyddet ska vara högst
 *   100 mm breda. […]"
 *   14 §: "Öppningar i ytor som är avsedda att gå på ska ha anordningar som
 *   skyddar mot fall. […]"
 * Gloss: stairs and openings in floors need fall protection, its height suited
 * to use and fall height (no fixed number); where young children may be (any
 * dwelling), 0.8 m of it must resist climbing and vertical gaps be ≤ 100 mm.
 */
export const GUARD_CLIMB_H = 0.8
export const GUARD_GAP_MAX = 0.1
export const REF_GUARDS = 'BFS 2024:9 2 kap. 10–11, 14 §§'

/**
 * Alterations (all föreskrifter):
 *   BFS 2024:9 3 kap. 1 §: "Vid ändring av byggnad ska den ändrade delen uppfylla
 *   kraven i 2 kap. Kraven får dock anpassas om risken för människors säkerhet
 *   vid användning ändå blir godtagbar, och […]" (seven grounds, e.g. 3. "det är
 *   oskäligt med hänsyn till ändringens omfattning", 6. "det finns tekniska skäl").
 *   BFS 2024:9 1 kap. 11 §: "Om anpassning enligt 3 kap. 1 § görs ska en
 *   riskbedömning göras. […] Riskbedömningen ska dokumenteras."
 *   (Same structure: BFS 2024:8 12 kap. 1 §, BFS 2024:7 9 kap. 1 §.)
 *   BFS 2024:7 10 kap. 4 §: "Avsteg från säkerhetsnivån avseende antalet
 *   utrymningsdörrar får inte göras om ett utrymme efter ändrad användning
 *   omfattas av verksamhetsklass 2B, 2C, 3A, 3B, 3C eller 5B."
 * Gloss: the altered part must meet the new-build rules, but they may be
 * adapted with a documented risk assessment; no deviation on the number of
 * escape doors when a space's use changes to 3A (dwellings). Whether
 * converting an attic counts as changed use is for the kommun to decide.
 */
export const REF_ALTERATIONS = 'BFS 2024:9 3 kap. 1 §, 1 kap. 11 §; BFS 2024:7 10 kap. 4 §'

// ---------- Grading

/** Float-noise tolerance (1 nm): a value meant to sit exactly on a limit is graded as on it. */
const EPS = 1e-9

/** 'ok' when `have` ≥ `need` (boundary inclusive), 'fail' below, 'unknown' when not a finite number. */
export function gradeAtLeast(have: number, need: number): RuleStatus {
  if (typeof have !== 'number' || !Number.isFinite(have)) return 'unknown'
  return have >= need - EPS ? 'ok' : 'fail'
}

/** 'ok' when `have` ≤ `need` (boundary inclusive), 'fail' above, 'unknown' when not a finite number. */
export function gradeAtMost(have: number, need: number): RuleStatus {
  if (typeof have !== 'number' || !Number.isFinite(have)) return 'unknown'
  return have <= need + EPS ? 'ok' : 'fail'
}

type PlanSlice = Pick<PlanV2, 'items' | 'options'>
type StairItem = Extract<Item, { type: 'stairs' | 'curved' | 'spiral' }>

const isStair = (it: Item): it is StairItem => it.type === 'stairs' || isUpStair(it)

/** Whether any of these plan points lies in an insulated (plasterboarded) bay. */
function touchesBoarded(geo: Geometry, board: readonly number[], pts: readonly Pt[]): boolean {
  if (!board.length || !pts.length) return false
  const xs = pts.map((p) => p[0])
  const b0 = bayAt(geo, clamp(Math.min(...xs), 0, geo.L - 1e-6))
  const b1 = bayAt(geo, clamp(Math.max(...xs), 0, geo.L - 1e-6))
  return board.some((b) => b >= b0 && b <= b1)
}

/**
 * Free height over one stair (2:25). Straight (hatch) stairs: `stairInfo`
 * minHead (worst tread corner to the roof). Curved/spiral: the worst of
 * curvedInfo `head` (tread to the roof), `landingHead` (spiral: step to the
 * underside of the top landing) and `downHead` (someone on the old stairs
 * under the new ones). Those measure to the roof panelling; in an insulated
 * bay the plasterboard sits lower, so an 'ok' there is downgraded to
 * 'unknown' (a 'fail' stands — boarding only lowers it).
 */
function freeHeight(geo: Geometry, plan: PlanSlice, it: StairItem): RuleResult {
  let have: number
  let limit: string
  let pts: Pt[]
  if (it.type === 'stairs') {
    have = stairInfo(geo, it).minHead
    limit = 'roof'
    pts = stairCorners(it)
  } else {
    const c = curvedInfo(geo, plan, it, new Set())
    const cands: [number, string][] = [
      [c.head, 'roof'],
      [c.landingHead, 'landing'],
      [c.downHead, 'below'],
    ]
    const worst = cands.reduce((a, b) => (b[0] < a[0] || Number.isNaN(b[0]) ? b : a))
    have = worst[0]
    limit = worst[1]
    pts = c.P.treads.flatMap((t) => t.poly.map(([a, b]) => toWorld(it, a, b)))
  }
  const res: RuleResult = { id: 'stair-free-height', ref: REF_FREE_HEIGHT, status: 'unknown', need: FREE_HEIGHT_MIN, itemId: it.id }
  if (typeof have !== 'number' || !Number.isFinite(have)) return { ...res, params: { reason: 'not-measured' } }
  let status = gradeAtLeast(have, FREE_HEIGHT_MIN)
  const params: Record<string, number | string> = { limit }
  if (status === 'ok' && touchesBoarded(geo, plan.options.board, pts)) {
    status = 'unknown'
    params.reason = 'boarded'
  }
  return { ...res, status, have, params }
}

function stairGeometry(geo: Geometry, plan: PlanSlice, it: StairItem): RuleResult {
  const params: Record<string, number | string> = {}
  if (it.type === 'stairs') {
    const s = stairInfo(geo, it)
    params.rise = s.rise
    params.going = s.going
    params.risers = s.n
  } else {
    const P = curvedInfo(geo, plan, it, new Set()).P
    params.rise = P.r
    params.going = P.g
    params.risers = P.n
  }
  return { id: 'stair-geometry', ref: REF_STAIR_GEOMETRY, status: 'info', itemId: it.id, params }
}

/**
 * The plan's escape-window sill (2:26 p6). 'unknown' when the height is not a
 * finite number, when the window gets no real opening in the roof
 * (`skyHolesOk`: overlaps another or runs off the slope), or when its lower
 * edge is below the knee-wall top in a bay whose knee wall is kept — it then
 * starts in the knee-wall void, not in the room.
 */
function roofWindowSill(geo: Geometry, plan: PlanSlice, it: Extract<Item, { type: 'skylight' }>, holesOk: ReadonlySet<string>): RuleResult {
  const res: RuleResult = { id: 'escape-window-sill', ref: REF_ESCAPE_SILL, status: 'unknown', need: ESCAPE_SILL_MAX, itemId: it.id, params: { window: 'roof' } }
  const have = it.bottom
  if (typeof have !== 'number' || !Number.isFinite(have)) return { ...res, params: { window: 'roof', reason: 'not-measured' } }
  if (!holesOk.has(it.id)) return { ...res, have, params: { window: 'roof', reason: 'not-placed' } }
  const kneeKept = !plan.options.knee[it.slope].includes(it.bay)
  if (kneeKept && have < geo.KNEE_H - EPS) return { ...res, have, params: { window: 'roof', reason: 'behind-knee-wall', kneeH: geo.KNEE_H } }
  return { ...res, status: gradeAtMost(have, ESCAPE_SILL_MAX), have }
}

/** Free-opening size (2:26 p3–5): the model holds the frame size only. */
function windowSize(frameW: number, frameH: number, base: Pick<RuleResult, 'itemId'> & { params: Record<string, number | string> }): RuleResult {
  const params = { ...base.params, frameW, frameH, needW: ESCAPE_OPEN_W_MIN, needH: ESCAPE_OPEN_H_MIN, needSum: ESCAPE_OPEN_SUM_MIN }
  const finite = Number.isFinite(frameW) && Number.isFinite(frameH)
  // the free opening is never larger than the frame: a frame below a minimum is a definite fail
  const tooSmall = finite && (frameW < ESCAPE_OPEN_W_MIN - EPS || frameH < ESCAPE_OPEN_H_MIN - EPS || frameW + frameH < ESCAPE_OPEN_SUM_MIN - EPS)
  return {
    id: 'escape-window-size',
    ref: REF_ESCAPE_SIZE,
    status: tooSmall ? 'fail' : 'unknown',
    ...(base.itemId ? { itemId: base.itemId } : {}),
    params: { ...params, reason: tooSmall ? 'frame-too-small' : 'frame-not-free-opening' },
  }
}

/**
 * The storey's area for 7:16: the whole floor inside the knee walls
 * (A1 × A2, the box `computeZones` grids — stair openings included, since the
 * stairwell is part of the storey's plan), plus the floored eaves of every
 * opened knee-wall bay out to where the roof meets the floor. This is the
 * larger of the app's figures, so a borderline plan lands on the stricter
 * (> 25 m²) branch; the kommun may measure to the outside of the walls.
 */
export function storeyArea(geo: Geometry, plan: PlanSlice): number {
  const eaves = (['N', 'S'] as const).reduce(
    (sum, s) =>
      sum +
      [...new Set(plan.options.knee[s])].reduce((a, i) => {
        const w = geo.EDGES[i + 1] - geo.EDGES[i]
        return a + (Number.isFinite(w) ? w * (geo.HALF - geo.KZ) : 0)
      }, 0),
    0,
  )
  return geo.L * 2 * geo.KZ + eaves
}

// ---------- The check

/**
 * Every rules-check row for the plan, in display order: stairs (free height,
 * tread gaps, geometry, handrails, guards — only when the plan has stairs),
 * escape windows (sill, size — per roof window, then the gable window when
 * on), the storey-area escape-door note, room height and alterations.
 */
export function checkRules(geo: Geometry, plan: PlanSlice): RuleResult[] {
  const out: RuleResult[] = []
  const stairs = plan.items.filter(isStair)

  // stairs
  stairs.forEach((it) => out.push(freeHeight(geo, plan, it)))
  if (stairs.length) out.push({ id: 'stair-tread-gaps', ref: REF_TREAD_GAPS, status: 'unknown', need: TREAD_GAP_MAX, params: { reason: 'no-riser-data' } })
  stairs.forEach((it) => out.push(stairGeometry(geo, plan, it)))
  if (stairs.length) {
    out.push({ id: 'stair-handrails', ref: REF_HANDRAILS, status: 'info' })
    out.push({
      id: 'stair-guards',
      ref: REF_GUARDS,
      status: 'info',
      params: { climbH: GUARD_CLIMB_H, gapMax: GUARD_GAP_MAX, modelRailH: RAIL_H, modelBalusterCc: BAL_CC },
    })
  }

  // escape windows
  const holesOk = skyHolesOk(geo, plan.items)
  plan.items.forEach((it) => {
    if (it.type !== 'skylight') return
    out.push(roofWindowSill(geo, plan, it, holesOk))
    const sz = SKY_SIZES[it.size]
    out.push(windowSize(sz ? sz.w : NaN, sz ? sz.h : NaN, { itemId: it.id, params: { window: 'roof', size: String(it.size) } }))
  })
  const g = plan.options.gable
  if (g.on) {
    const sill = g.sill
    out.push({
      id: 'escape-window-sill',
      ref: REF_ESCAPE_SILL,
      status: gradeAtMost(sill, ESCAPE_SILL_MAX),
      ...(Number.isFinite(sill) ? { have: sill } : {}),
      need: ESCAPE_SILL_MAX,
      params: Number.isFinite(sill) ? { window: 'gable' } : { window: 'gable', reason: 'not-measured' },
    })
    out.push(windowSize(g.w, g.h, { params: { window: 'gable' } }))
  }

  // storey area (7:16)
  const zones = computeZones(geo, plan)
  const area = storeyArea(geo, plan)
  out.push({
    id: 'floor-escape-door',
    ref: REF_FLOOR_ESCAPE,
    status: 'info',
    have: area,
    need: ESCAPE_DOOR_AREA,
    params: {
      branch: Number.isFinite(area) ? (area > ESCAPE_DOOR_AREA ? 'over' : 'atMost') : 'unknown',
      floorInsideKnee: zones.floor * zones.cellArea,
    },
  })

  // room height (context only)
  out.push({
    id: 'room-height',
    ref: REF_ROOM_HEIGHT,
    status: 'info',
    params: { standArea: zones.stand * zones.cellArea, floorArea: zones.floor * zones.cellArea, standHeight: geo.STAND },
  })

  out.push({ id: 'alterations', ref: REF_ALTERATIONS, status: 'info' })
  return out
}
