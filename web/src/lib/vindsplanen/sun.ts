// Real sun position for Vindsplanen (plan 144): where the sun is for the
// house at a given Swedish clock time, and when it rises and sets.
//
// Pure and deterministic: no three.js, React or browser APIs, and nothing
// depends on the runner's time zone (Swedish clock time is converted with
// Intl and the fixed zone 'Europe/Stockholm').
//
// Algorithm: NOAA General Solar Position (the NOAA Solar Calculator
// spreadsheet equations, after Meeus, "Astronomical Algorithms"). Accurate to
// a few hundredths of a degree for current dates, which is far below what a
// shadow in the 3D view can show. Golden values in sun.test.ts were computed
// with an independent NOAA implementation and cross-checked against NREL SPA
// (pvlib 0.16.1) on 2026-11-26.
//
// Refraction: `solarPosition` returns the GEOMETRIC (true) altitude, without
// atmospheric refraction. Refraction lifts the visible sun by at most ~0.12°
// in the daytime cases that matter here (≈0.5° only at the horizon), which a
// light direction cannot show; leaving it out keeps the function a clean
// match for NREL SPA's topocentric elevation. Sunrise/sunset (`daylight`)
// use the standard zenith 90.833°, which accounts for refraction and the
// sun's semi-diameter, as NOAA and almanacs do.

const RAD = Math.PI / 180
const DEG = 180 / Math.PI
const MIN_MS = 60_000
const DAY_MS = 86_400_000

/** Sun's zenith at sunrise/sunset: 90° + 34′ refraction + 16′ semi-diameter. */
const SUNRISE_ZENITH = 90.833

interface SunCore {
  /** Declination, radians. */
  decl: number
  /** Equation of time, minutes. */
  eot: number
}

/** Declination and equation of time at an instant (NOAA spreadsheet equations). */
function sunCore(ms: number): SunCore {
  const jd = ms / DAY_MS + 2440587.5
  const t = (jd - 2451545) / 36525 // Julian centuries since J2000.0
  const l0 = (((280.46646 + t * (36000.76983 + t * 0.0003032)) % 360) + 360) % 360 // geometric mean longitude
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t) // mean anomaly
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t) // orbit eccentricity
  const mr = m * RAD
  const c = Math.sin(mr) * (1.914602 - t * (0.004817 + 0.000014 * t)) + Math.sin(2 * mr) * (0.019993 - 0.000101 * t) + Math.sin(3 * mr) * 0.000289
  const trueLong = l0 + c
  const omega = (125.04 - 1934.136 * t) * RAD
  const appLong = (trueLong - 0.00569 - 0.00478 * Math.sin(omega)) * RAD
  const meanObliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
  const obliq = (meanObliq + 0.00256 * Math.cos(omega)) * RAD
  const decl = Math.asin(Math.sin(obliq) * Math.sin(appLong))
  const y = Math.tan(obliq / 2) ** 2
  const l0r = l0 * RAD
  const eot =
    4 *
    DEG *
    (y * Math.sin(2 * l0r) -
      2 * e * Math.sin(mr) +
      4 * e * y * Math.sin(mr) * Math.cos(2 * l0r) -
      0.5 * y * y * Math.sin(4 * l0r) -
      1.25 * e * e * Math.sin(2 * mr))
  return { decl, eot }
}

/**
 * The sun's position seen from `lat`/`lon` (degrees; north and east
 * positive) at the instant `utc`.
 *
 * `altitude` is the geometric angle above the horizon in radians, WITHOUT
 * atmospheric refraction (see the file header); negative when the sun is
 * down. `azimuth` is in radians from north, clockwise (east = π/2,
 * south = π, west = 3π/2), in [0, 2π).
 */
export function solarPosition(utc: Date, lat: number, lon: number): { altitude: number; azimuth: number } {
  const ms = utc.getTime()
  const { decl, eot } = sunCore(ms)
  const utcMinutes = (((ms % DAY_MS) + DAY_MS) % DAY_MS) / MIN_MS
  const trueSolarMinutes = (((utcMinutes + eot + 4 * lon) % 1440) + 1440) % 1440
  const ha = (trueSolarMinutes / 4 - 180) * RAD // hour angle: 0 at solar noon, positive in the afternoon
  const phi = lat * RAD
  const sinAlt = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha)
  const altitude = Math.asin(Math.max(-1, Math.min(1, sinAlt)))
  // Azimuth measured from south, westward positive, then turned to "from north, clockwise".
  const fromSouth = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi))
  const azimuth = (((fromSouth + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  return { altitude, azimuth }
}

/**
 * Unit vector from the scene origin towards the sun, in scene axes:
 * x along the compass bearing `ridgeBearingDeg` (B, degrees; the +x axis of
 * the model, west gable → east gable when B = 90), y up, z along B + 90°.
 * With A the azimuth: [cos h·cos(A−B), sin h, cos h·sin(A−B)].
 * `altitude` and `azimuth` are radians, as from `solarPosition`.
 */
export function sunVector(altitude: number, azimuth: number, ridgeBearingDeg: number): [number, number, number] {
  const rel = azimuth - ridgeBearingDeg * RAD
  const ch = Math.cos(altitude)
  return [ch * Math.cos(rel), Math.sin(altitude), ch * Math.sin(rel)]
}

/**
 * Sunrise and sunset on a Swedish calendar day `dateYMD` ('YYYY-MM-DD',
 * Europe/Stockholm) at `lat`/`lon`, using zenith 90.833°. Both are null when
 * the sun does not cross the horizon that day (polar day or polar night).
 * Throws RangeError for a malformed date.
 */
export function daylight(dateYMD: string, lat: number, lon: number): { sunrise: Date | null; sunset: Date | null } {
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYMD)
  if (!ymd) throw new RangeError(`daylight: expected YYYY-MM-DD, got ${dateYMD}`)
  const [y, m, d] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])]
  const probe = new Date(Date.UTC(y, m - 1, d))
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) throw new RangeError(`daylight: no such date ${dateYMD}`)
  // Start from Swedish local noon; the events lie within a few hours of solar noon.
  const noonGuess = stockholmWallTimeToUtc(y, m, d, 720).getTime()
  return { sunrise: crossing(noonGuess, lat, lon, -1), sunset: crossing(noonGuess, lat, lon, 1) }
}

/**
 * The instant the sun crosses zenith 90.833° before (sign −1) or after
 * (sign +1) the solar noon nearest `startMs`, refined by re-evaluating the
 * sun at the estimate. Null when the sun stays above or below that zenith.
 */
function crossing(startMs: number, lat: number, lon: number, sign: -1 | 1): Date | null {
  const phi = lat * RAD
  const cosZ = Math.cos(SUNRISE_ZENITH * RAD)
  let at = startMs
  for (let i = 0; i < 4; i++) {
    const { decl, eot } = sunCore(at)
    const cosH = (cosZ - Math.sin(phi) * Math.sin(decl)) / (Math.cos(phi) * Math.cos(decl))
    if (cosH > 1 || cosH < -1) return null // polar night (> 1) or polar day (< −1)
    const haDeg = Math.acos(cosH) * DEG
    // Solar noon (UTC) on the UTC day of the start instant, then shifted by the hour angle.
    const dayStart = Math.floor(startMs / DAY_MS) * DAY_MS
    const noon = dayStart + (720 - 4 * lon - eot) * MIN_MS
    at = noon + sign * 4 * haDeg * MIN_MS
  }
  return new Date(Math.round(at / 1000) * 1000)
}

// --- Swedish clock time -------------------------------------------------

const STOCKHOLM = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Stockholm',
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
})

/** Stockholm wall-clock time at `ms`, expressed as if it were UTC milliseconds. */
function stockholmWallMs(ms: number): number {
  const p: Record<string, number> = {}
  for (const part of STOCKHOLM.formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second)
}

/** Stockholm's UTC offset at `ms`, milliseconds (CET +1 h, CEST +2 h). */
const offsetAt = (ms: number): number => stockholmWallMs(Math.floor(ms / 1000) * 1000) - Math.floor(ms / 1000) * 1000

/**
 * The instant that Swedish clocks (Europe/Stockholm) show `minutes` past
 * midnight on y-m-d (month 1–12). Independent of the runner's time zone.
 *
 * - A time in the spring-forward gap (e.g. 2026-03-29 02:30, which never
 *   happens) is shifted forward by the gap: 03:30 CEST (01:30Z), as JS Date,
 *   Temporal 'compatible' and zoneinfo fold=0 do.
 * - A time that happens twice in autumn (e.g. 2026-10-25 02:30) resolves to
 *   the earlier instant (still CEST, 00:30Z).
 */
export function stockholmWallTimeToUtc(y: number, m: number, d: number, minutes: number): Date {
  const wall = Date.UTC(y, m - 1, d, 0, minutes)
  // The offsets a day before and after cover both sides of any transition.
  const before = offsetAt(wall - DAY_MS)
  const after = offsetAt(wall + DAY_MS)
  const valid = [...new Set([before, after])].map((o) => wall - o).filter((t) => stockholmWallMs(t) === wall)
  if (valid.length) return new Date(Math.min(...valid))
  // In the gap: read the wall time with the offset in force before the jump.
  return new Date(wall - before)
}
