import { describe, expect, it } from 'vitest'
import { daylight, solarPosition, stockholmWallTimeToUtc, sunVector } from './sun'

// Golden values: plan 144 "Stage 1 golden values (verified 2026-11-26)". An
// independent NOAA implementation, cross-checked against NREL SPA (pvlib
// 0.16.1) and astral 3.2 (altitude within 0.005°, azimuth within 0.003°).
// solarPosition returns GEOMETRIC altitude (no refraction), so these use the
// "without refraction" column. Degrees; azimuth from north, clockwise.
const DEG = Math.PI / 180

interface Golden {
  name: string
  utc: string
  /** The Swedish clock time the UTC instant stands for. */
  local: [number, number, number, number]
  lat: number
  lon: number
  noaa: { alt: number; az: number }
  spa: { alt: number; az: number }
}

const GOLDEN: Golden[] = [
  { name: 'Stockholm 06-21 13:00 CEST', utc: '2026-06-21T11:00:00Z', local: [2026, 6, 21, 780], lat: 59.33, lon: 18.07, noaa: { alt: 54.06, az: 184.092 }, spa: { alt: 54.059, az: 184.094 } },
  { name: 'Stockholm 12-21 12:00 CET', utc: '2026-12-21T11:00:00Z', local: [2026, 12, 21, 720], lat: 59.33, lon: 18.07, noaa: { alt: 7.181, az: 183.288 }, spa: { alt: 7.179, az: 183.291 } },
  { name: 'Stockholm 03-20 12:00 CET', utc: '2026-03-20T11:00:00Z', local: [2026, 3, 20, 720], lat: 59.33, lon: 18.07, noaa: { alt: 30.603, az: 181.404 }, spa: { alt: 30.598, az: 181.403 } },
  { name: 'default site 06-21 13:00 CEST', utc: '2026-06-21T11:00:00Z', local: [2026, 6, 21, 780], lat: 59.3, lon: 18.0, noaa: { alt: 54.093, az: 183.985 }, spa: { alt: 54.091, az: 183.988 } },
  { name: 'default site 12-21 12:00 CET', utc: '2026-12-21T11:00:00Z', local: [2026, 12, 21, 720], lat: 59.3, lon: 18.0, noaa: { alt: 7.213, az: 183.224 }, spa: { alt: 7.211, az: 183.226 } },
  { name: 'default site 03-20 12:00 CET', utc: '2026-03-20T11:00:00Z', local: [2026, 3, 20, 720], lat: 59.3, lon: 18.0, noaa: { alt: 30.634, az: 181.323 }, spa: { alt: 30.629, az: 181.322 } },
  { name: 'Kiruna 12-21 12:00 CET (polar night)', utc: '2026-12-21T11:00:00Z', local: [2026, 12, 21, 720], lat: 67.86, lon: 20.23, noaa: { alt: -1.396, az: 185.245 }, spa: { alt: -1.398, az: 185.247 } },
  { name: 'Kiruna 06-21 00:00 CEST (midnight sun)', utc: '2026-06-20T22:00:00Z', local: [2026, 6, 21, 0], lat: 67.86, lon: 20.23, noaa: { alt: 1.61, az: 350.651 }, spa: { alt: 1.608, az: 350.653 } },
]

const deg = (r: number) => r / DEG

describe('solarPosition — golden values (geometric altitude, no refraction)', () => {
  it.each(GOLDEN)('$name', (g) => {
    const p = solarPosition(new Date(g.utc), g.lat, g.lon)
    expect(Math.abs(deg(p.altitude) - g.noaa.alt)).toBeLessThan(0.02)
    expect(Math.abs(deg(p.azimuth) - g.noaa.az)).toBeLessThan(0.02)
    expect(Math.abs(deg(p.altitude) - g.spa.alt)).toBeLessThan(0.05)
    expect(Math.abs(deg(p.azimuth) - g.spa.az)).toBeLessThan(0.05)
  })

  it.each(GOLDEN)('$name: the Swedish clock time maps to the golden UTC instant', (g) => {
    const [y, m, d, min] = g.local
    expect(stockholmWallTimeToUtc(y, m, d, min).toISOString()).toBe(new Date(g.utc).toISOString())
  })

  it('Kiruna: the sun is down at midwinter noon and up at midsummer midnight', () => {
    expect(solarPosition(stockholmWallTimeToUtc(2026, 12, 21, 720), 67.86, 20.23).altitude).toBeLessThan(0)
    expect(solarPosition(stockholmWallTimeToUtc(2026, 6, 21, 0), 67.86, 20.23).altitude).toBeGreaterThan(0)
  })

  it('azimuth is in [0, 2π) and the sun is east in the morning, west in the evening', () => {
    const am = solarPosition(new Date('2026-06-21T04:00:00Z'), 59.3, 18.0)
    const pm = solarPosition(new Date('2026-06-21T17:00:00Z'), 59.3, 18.0)
    expect(deg(am.azimuth)).toBeGreaterThan(45)
    expect(deg(am.azimuth)).toBeLessThan(135)
    expect(deg(pm.azimuth)).toBeGreaterThan(225)
    expect(deg(pm.azimuth)).toBeLessThan(315)
    for (let h = 0; h < 24; h++) {
      const a = solarPosition(new Date(Date.UTC(2026, 11, 21, h)), 59.3, 18.0).azimuth
      expect(a).toBeGreaterThanOrEqual(0)
      expect(a).toBeLessThan(2 * Math.PI)
    }
  })
})

describe('daylight — sunrise/sunset at zenith 90.833° (±2 min)', () => {
  const near = (actual: Date | null, iso: string) => {
    expect(actual).not.toBeNull()
    expect(Math.abs((actual as Date).getTime() - new Date(iso).getTime())).toBeLessThan(2 * 60_000)
  }

  it('Stockholm midsummer: 03:30:51 / 22:08:11 CEST', () => {
    const d = daylight('2026-06-21', 59.33, 18.07)
    near(d.sunrise, '2026-06-21T03:30:51+02:00')
    near(d.sunset, '2026-06-21T22:08:11+02:00')
  })

  it('Stockholm midwinter: 08:43:23 / 14:48:08 CET', () => {
    const d = daylight('2026-12-21', 59.33, 18.07)
    near(d.sunrise, '2026-12-21T08:43:23+01:00')
    near(d.sunset, '2026-12-21T14:48:08+01:00')
  })

  it('Kiruna has no sunrise or sunset at midsummer (polar day) or midwinter (polar night)', () => {
    expect(daylight('2026-06-21', 67.86, 20.23)).toEqual({ sunrise: null, sunset: null })
    expect(daylight('2026-12-21', 67.86, 20.23)).toEqual({ sunrise: null, sunset: null })
  })

  it('rejects malformed or impossible dates', () => {
    expect(() => daylight('2026-6-21', 59.3, 18)).toThrow(RangeError)
    expect(() => daylight('2026-02-30', 59.3, 18)).toThrow(RangeError)
    expect(() => daylight('xx', 59.3, 18)).toThrow(RangeError)
  })
})

describe('stockholmWallTimeToUtc', () => {
  const iso = (y: number, m: number, d: number, min: number) => stockholmWallTimeToUtc(y, m, d, min).toISOString()

  it('uses CET in winter and CEST in summer', () => {
    expect(iso(2026, 1, 15, 720)).toBe('2026-01-15T11:00:00.000Z')
    expect(iso(2026, 7, 15, 720)).toBe('2026-07-15T10:00:00.000Z')
  })

  it('spring forward (2026-03-29 01:00Z): around and inside the gap', () => {
    expect(iso(2026, 3, 29, 1 * 60 + 59)).toBe('2026-03-29T00:59:00.000Z') // 01:59 CET
    expect(iso(2026, 3, 29, 2 * 60 + 30)).toBe('2026-03-29T01:30:00.000Z') // 02:30 never happens → 03:30 CEST
    expect(iso(2026, 3, 29, 2 * 60)).toBe('2026-03-29T01:00:00.000Z') // 02:00 → 03:00 CEST
    expect(iso(2026, 3, 29, 3 * 60)).toBe('2026-03-29T01:00:00.000Z') // 03:00 CEST
    expect(iso(2026, 3, 29, 3 * 60 + 30)).toBe('2026-03-29T01:30:00.000Z')
  })

  it('fall back (2026-10-25 01:00Z): an ambiguous time takes the earlier (CEST) instant', () => {
    expect(iso(2026, 10, 25, 2 * 60 + 30)).toBe('2026-10-25T00:30:00.000Z')
    expect(iso(2026, 10, 25, 1 * 60 + 59)).toBe('2026-10-24T23:59:00.000Z')
    expect(iso(2026, 10, 25, 3 * 60)).toBe('2026-10-25T02:00:00.000Z') // 03:00 CET
  })

  it('handles midnight and the last minute of the day', () => {
    expect(iso(2026, 12, 31, 0)).toBe('2026-12-30T23:00:00.000Z')
    expect(iso(2026, 12, 31, 1439)).toBe('2026-12-31T22:59:00.000Z')
  })
})

describe('sunVector — [cos h·cos(A−B), sin h, cos h·sin(A−B)]', () => {
  const june = solarPosition(new Date('2026-06-21T11:00:00Z'), 59.33, 18.07)

  const close = (v: number[], e: number[], tol = 5e-4) => e.forEach((x, i) => expect(Math.abs(v[i] - x)).toBeLessThan(tol))

  it('Stockholm June, ridge east–west (B = 90): sun south, slightly west', () => {
    close(sunVector(june.altitude, june.azimuth, 90), [-0.0419, 0.8096, 0.5854])
  })

  it('Stockholm June, ridge north–south (B = 0)', () => {
    close(sunVector(june.altitude, june.azimuth, 0), [-0.5854, 0.8096, -0.0419])
  })

  it('sanity: sun due south, east, north on the horizon with B = 90', () => {
    close(sunVector(0, 180 * DEG, 90), [0, 0, 1], 1e-12)
    close(sunVector(0, 90 * DEG, 90), [1, 0, 0], 1e-12)
    close(sunVector(0, 0, 90), [0, 0, -1], 1e-12)
    close(sunVector(90 * DEG, 123 * DEG, 90), [0, 1, 0], 1e-12)
  })

  it('is a unit vector', () => {
    const v = sunVector(0.3, 2.1, 37)
    expect(Math.hypot(...v)).toBeCloseTo(1, 12)
  })
})
