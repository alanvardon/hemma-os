import { describe, it, expect, vi } from 'vitest'
import {
  collapseChanges, nextDecision, lastDecision, decisionOutcome,
  detectChange, currentPoint, RIKSBANK_DECISIONS, type RatePoint, type PolicyRateData,
} from './riksbank'

describe('RIKSBANK_DECISIONS', () => {
  it('is non-empty and sorted ascending', () => {
    expect(RIKSBANK_DECISIONS.length).toBeGreaterThan(0)
    const sorted = [...RIKSBANK_DECISIONS].sort()
    expect(RIKSBANK_DECISIONS).toEqual(sorted)
  })
})

describe('RIKSBANK_DECISIONS fallback', () => {
  it('falls back to FALLBACK_DECISIONS (not []) when the JSON decisions array is empty', async () => {
    vi.resetModules()
    vi.doMock('./riksbank-decisions.json', () => ({ default: { decisions: [] } }))
    const { RIKSBANK_DECISIONS: fallbackApplied } = await import('./riksbank')
    expect(fallbackApplied).toEqual(['2026-08-19', '2026-09-23', '2026-11-03', '2026-12-15'])
    expect(fallbackApplied.length).toBeGreaterThan(0)
    vi.doUnmock('./riksbank-decisions.json')
    vi.resetModules()
  })
})

describe('collapseChanges', () => {
  it('keeps only rows where the value differs from the previous kept row', () => {
    const series: RatePoint[] = [
      { date: '2026-01-01', value: 2.5 },
      { date: '2026-01-02', value: 2.5 },
      { date: '2026-01-03', value: 2.5 },
      { date: '2026-01-04', value: 2.0 },
      { date: '2026-01-05', value: 2.0 },
      { date: '2026-01-06', value: 1.75 },
    ]
    expect(collapseChanges(series)).toEqual([
      { date: '2026-01-01', value: 2.5 },
      { date: '2026-01-04', value: 2.0 },
      { date: '2026-01-06', value: 1.75 },
    ])
  })

  it('returns an empty array for empty/undefined input', () => {
    expect(collapseChanges([])).toEqual([])
    expect(collapseChanges(undefined as unknown as RatePoint[])).toEqual([])
  })
})

describe('nextDecision', () => {
  const calendar = ['2026-01-29', '2026-03-19', '2026-05-07']

  it('returns the next date on/after today', () => {
    expect(nextDecision('2026-02-01', calendar)).toBe('2026-03-19')
  })

  it('returns the date itself when today is a decision day', () => {
    expect(nextDecision('2026-03-19', calendar)).toBe('2026-03-19')
  })

  it('returns null once the calendar is exhausted', () => {
    expect(nextDecision('2026-12-01', calendar)).toBeNull()
  })
})

describe('lastDecision', () => {
  const calendar = ['2026-01-29', '2026-03-19', '2026-05-07']

  it('returns the most recent date strictly before today', () => {
    expect(lastDecision('2026-04-01', calendar)).toBe('2026-03-19')
  })

  it('does not count today itself — a besked is "last" only once it has passed', () => {
    expect(lastDecision('2026-03-19', calendar)).toBe('2026-01-29')
  })

  it('returns null before the calendar starts', () => {
    expect(lastDecision('2026-01-10', calendar)).toBeNull()
  })
})

describe('decisionOutcome', () => {
  const changes: RatePoint[] = [
    { date: '2025-10-01', value: 1.75 },
    { date: '2026-03-25', value: 1.5 },
  ]

  it('pairs an announcement with the change point that takes effect within 14 days', () => {
    // Announced 19 mar, effective 25 mar — the SWEA series dates the EFFECT.
    expect(decisionOutcome('2026-03-19', changes)).toEqual({ date: '2026-03-25', value: 1.5 })
  })

  it('returns null for a hold (no change point near the announcement)', () => {
    expect(decisionOutcome('2026-01-29', changes)).toBeNull()
  })

  it('never matches a change from before the announcement', () => {
    expect(decisionOutcome('2025-10-05', changes)).toBeNull()
  })
})

describe('currentPoint', () => {
  it('uses the last change point, NOT `latest` — the Riksbank Latest endpoint stamps today\'s date even when the rate hasn\'t moved', () => {
    const data: PolicyRateData = {
      latest: { date: '2026-07-11', value: 1.75 }, // stamped with "today", not the effective date
      changes: [
        { date: '2025-06-25', value: 2.0 },
        { date: '2025-10-01', value: 1.75 },
      ],
    }
    expect(currentPoint(data)).toEqual({ date: '2025-10-01', value: 1.75 })
  })

  it('falls back to `latest` when there is no change history', () => {
    const data: PolicyRateData = { latest: { date: '2026-07-11', value: 1.75 }, changes: [] }
    expect(currentPoint(data)).toEqual({ date: '2026-07-11', value: 1.75 })
  })
})

describe('detectChange', () => {
  const latest: RatePoint = { date: '2026-06-17', value: 1.75 }

  it('is true when nothing has been acknowledged yet', () => {
    expect(detectChange(latest, null)).toBe(true)
  })

  it('is false once the exact latest point has been acknowledged', () => {
    expect(detectChange(latest, { date: '2026-06-17', value: 1.75 })).toBe(false)
  })

  it('is true when the acknowledged point is stale', () => {
    expect(detectChange(latest, { date: '2026-03-19', value: 2.0 })).toBe(true)
  })

  it('is false when there is no latest point', () => {
    expect(detectChange(null, null)).toBe(false)
  })
})
