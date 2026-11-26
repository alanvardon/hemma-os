// Plan 144: the sun control's text. Stockholm golden values: sunrise/sunset
// 2026-12-21 08:43 / 14:48 CET and 2026-06-21 03:30 / 22:08 CEST (NREL SPA,
// see sun.test.ts); altitude 7.2° at 12:00 on 21 Dec.
import { describe, expect, it } from 'vitest'
import { SITE_DEF } from '../../lib/vindsplanen/plan'
import { compassLabel, parseMonthDay, stockholmYear, sunReadout } from './sunText'

const KIRUNA = { ridgeBearing: 90, lat: 67.9, lon: 20.2 }

describe('sunReadout', () => {
  it('Stockholm 21 Dec noon: low sun, short day, in Swedish clock time', () => {
    expect(sunReadout(2026, '12-21', 720, SITE_DEF)).toEqual({
      label: '21 Dec 12:00 · sun 7° high',
      daylight: 'Sunrise 08:43 · Sunset 14:48',
      up: true,
    })
  })
  it('Stockholm 21 Jun 13:00: high sun, summer clocks (CEST)', () => {
    const r = sunReadout(2026, '06-21', 780, SITE_DEF)
    expect(r.label).toBe('21 Jun 13:00 · sun 54° high')
    expect(r.daylight).toMatch(/^Sunrise 03:3\d · Sunset 22:0\d$/)
  })
  it('says the sun is down at night, still giving the day’s sunrise and sunset', () => {
    const r = sunReadout(2026, '12-21', 1320, SITE_DEF)
    expect(r.label).toBe('21 Dec 22:00 · The sun is down')
    expect(r.up).toBe(false)
    expect(r.daylight).toBe('Sunrise 08:43 · Sunset 14:48')
  })
  it('polar night: the sun does not rise', () => {
    const r = sunReadout(2026, '12-21', 720, KIRUNA)
    expect(r.daylight).toBe('The sun doesn’t rise')
    expect(r.up).toBe(false)
  })
  it('midnight sun: the sun does not set', () => {
    const r = sunReadout(2026, '06-21', 0, KIRUNA)
    expect(r.daylight).toBe('The sun doesn’t set')
    expect(r.up).toBe(true)
  })
  it('a malformed date falls back to 21 Jun instead of throwing', () => {
    expect(sunReadout(2026, 'nope', 720, SITE_DEF).label).toMatch(/^21 Jun 12:00/)
    expect(sunReadout(2026, '02-30', 720, SITE_DEF).label).toMatch(/^21 Jun 12:00/)
  })
  it('pads minutes on a quarter hour', () => {
    expect(sunReadout(2026, '03-20', 495, SITE_DEF).label).toMatch(/^20 Mar 08:15 · /)
  })
})

describe('compassLabel', () => {
  it('names the eight points and wraps', () => {
    expect([0, 45, 90, 135, 180, 225, 270, 315].map(compassLabel)).toEqual(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'])
    expect(compassLabel(359)).toBe('N')
    expect(compassLabel(22)).toBe('N')
    expect(compassLabel(23)).toBe('NE')
    expect(compassLabel(-90)).toBe('W')
  })
})

describe('parseMonthDay / stockholmYear', () => {
  it('accepts real dates only', () => {
    expect(parseMonthDay('12-21', 2026)).toEqual([12, 21])
    expect(parseMonthDay('02-29', 2026)).toBeNull()
    expect(parseMonthDay('02-29', 2028)).toEqual([2, 29])
    expect(parseMonthDay('13-01', 2026)).toBeNull()
  })
  it('uses the Swedish year at New Year', () => {
    expect(stockholmYear(new Date('2026-12-31T23:30:00Z'))).toBe(2027)
    expect(stockholmYear(new Date('2026-12-31T22:30:00Z'))).toBe(2026)
  })
})
