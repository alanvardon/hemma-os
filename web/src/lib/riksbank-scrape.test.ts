// Unit tests for the pure logic of scripts/scrape-riksbank-calendar.mjs.
//
// The scraper exports mergeDecisions + checkGate as network-free pure
// functions and only runs main() (fetch + file I/O) when executed directly,
// so importing it here triggers NO network access. These tests prove the
// accumulate-and-gate invariant with plain data.

import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain ESM script, no type declarations
import { mergeDecisions, checkGate } from '../../../scripts/scrape-riksbank-calendar.mjs'

describe('mergeDecisions', () => {
  it('produces a sorted, de-duped union', () => {
    const existing = ['2026-03-19', '2026-01-29']
    const scraped = ['2026-08-19', '2026-01-29', '2026-05-07']
    expect(mergeDecisions(existing, scraped)).toEqual([
      '2026-01-29',
      '2026-03-19',
      '2026-05-07',
      '2026-08-19',
    ])
  })

  it('never drops existing dates even when the scrape is a subset', () => {
    // The live year page only shows UPCOMING events, so a scrape run mid-year
    // cannot see the year's already-past decisions. Union must preserve them.
    const existing = ['2026-01-29', '2026-03-19', '2026-05-07']
    const scraped = ['2026-08-19']
    const merged = mergeDecisions(existing, scraped)
    for (const d of existing) expect(merged).toContain(d)
    expect(merged).toContain('2026-08-19')
    expect(merged).toEqual([...existing, '2026-08-19'])
  })

  it('tolerates empty / missing inputs', () => {
    expect(mergeDecisions([], ['2026-08-19'])).toEqual(['2026-08-19'])
    expect(mergeDecisions(undefined, undefined)).toEqual([])
  })
})

describe('checkGate', () => {
  const today = '2026-07-18'

  it('REFUSES when zero candidates were scraped', () => {
    const gate = checkGate({
      existing: ['2026-08-19', '2026-09-23'],
      scraped: [],
      today,
    })
    expect(gate.ok).toBe(false)
    expect(gate.reason).toMatch(/zero candidates/i)
  })

  it('REFUSES when the scrape regresses future coverage below the committed file', () => {
    // Committed file already knows 4 upcoming decisions; a degraded scrape
    // (markup drift / partial fetch) only found 1 future date. A healthy
    // listing always re-lists every upcoming decision, so this shortfall must
    // fail the gate and keep CI red rather than silently proceeding.
    const gate = checkGate({
      existing: ['2026-08-19', '2026-09-23', '2026-11-03', '2026-12-15'],
      scraped: ['2026-08-19'],
      today,
    })
    expect(gate.ok).toBe(false)
    expect(gate.reason).toMatch(/regress/i)
  })

  it('does not count past scraped dates toward future coverage', () => {
    // Only 1 of the scraped dates is in the future (2026-09-23); existing has
    // 2 future dates -> regression, refuse.
    const gate = checkGate({
      existing: ['2026-08-19', '2026-09-23'],
      scraped: ['2026-01-29', '2026-09-23'],
      today,
    })
    expect(gate.ok).toBe(false)
    expect(gate.reason).toMatch(/regress/i)
  })

  it('PASSES on a normal superset scrape (equal-or-more future coverage)', () => {
    const gate = checkGate({
      existing: ['2026-08-19', '2026-09-23'],
      scraped: ['2026-08-19', '2026-09-23', '2026-11-03', '2027-02-11'],
      today,
    })
    expect(gate.ok).toBe(true)
    expect(gate.reason).toBe('ok')
  })

  it('PASSES when future coverage is exactly preserved', () => {
    const gate = checkGate({
      existing: ['2026-08-19', '2026-09-23'],
      scraped: ['2026-08-19', '2026-09-23'],
      today,
    })
    expect(gate.ok).toBe(true)
  })
})
