// Plan 144: the real sun's text and inputs, pure. The time control's readout
// ("21 Dec 12:00 · sun 7° high", sunrise and sunset) and the compass label of
// the house orientation. English copy, Swedish clock time (Europe/Stockholm).

import type { Site } from '../../lib/vindsplanen/plan'
import { daylight, solarPosition, stockholmWallTimeToUtc } from '../../lib/vindsplanen/sun'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const
const DEG = 180 / Math.PI

const pad = (n: number): string => String(n).padStart(2, '0')

/** Compass label (N, NE, E, SE, S, SW, W, NW) for a bearing in degrees; 8 sectors of 45° centred on each point. */
export function compassLabel(bearing: number): string {
  const b = ((bearing % 360) + 360) % 360
  return COMPASS[Math.round(b / 45) % 8]
}

/** The current year on Swedish clocks. */
export function stockholmYear(now: Date = new Date()): number {
  try {
    const y = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Stockholm', year: 'numeric' }).format(now)
    return Number(y) || now.getUTCFullYear()
  } catch {
    return now.getUTCFullYear()
  }
}

/** 'MM-DD' → [month 1–12, day], or null when it is not a real date in `year`. */
export function parseMonthDay(md: string, year: number): [number, number] | null {
  const m = /^(\d{2})-(\d{2})$/.exec(md)
  if (!m) return null
  const [mo, d] = [Number(m[1]), Number(m[2])]
  const probe = new Date(Date.UTC(year, mo - 1, d))
  return probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d ? [mo, d] : null
}

/** The sun at a Swedish date ('MM-DD' in `year`, 21 Jun when malformed) and clock time (minutes after midnight). */
export function sunAt(year: number, monthDay: string, minutes: number, site: Site): { altitude: number; azimuth: number } {
  const md = parseMonthDay(monthDay, year) ?? [6, 21]
  return solarPosition(stockholmWallTimeToUtc(year, md[0], md[1], minutes), site.lat, site.lon)
}

const HM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Stockholm', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
/** HH:MM Swedish clock time of an instant. */
const hhmm = (d: Date): string => HM.format(d)

export interface SunReadout {
  /** "21 Dec 12:00 · sun 7° high", or "21 Dec 22:00 · The sun is down". */
  label: string
  /** "Sunrise 08:43 · Sunset 14:48", "The sun doesn’t rise" or "The sun doesn’t set". */
  daylight: string
  up: boolean
}

/** The control's text for a date, clock time and site. A malformed date falls back to 21 Jun. */
export function sunReadout(year: number, monthDay: string, minutes: number, site: Site): SunReadout {
  const [mo, d] = parseMonthDay(monthDay, year) ?? [6, 21]
  const md = `${pad(mo)}-${pad(d)}`
  const when = `${d} ${MONTHS[mo - 1]} ${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
  const alt = sunAt(year, md, minutes, site).altitude * DEG
  const up = alt > 0
  const label = up ? `${when} · sun ${Math.round(alt)}° high` : `${when} · The sun is down`

  const { sunrise, sunset } = daylight(`${year}-${md}`, site.lat, site.lon)
  let text: string
  if (sunrise && sunset) text = `Sunrise ${hhmm(sunrise)} · Sunset ${hhmm(sunset)}`
  else {
    // no crossing: polar day (up at midnight or noon) or polar night
    const high = Math.max(sunAt(year, md, 0, site).altitude, sunAt(year, md, 720, site).altitude)
    text = high > 0 ? 'The sun doesn’t set' : 'The sun doesn’t rise'
  }
  return { label, daylight: text, up }
}
