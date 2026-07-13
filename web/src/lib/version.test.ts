import { describe, it, expect } from 'vitest'
import { parseVersionJson, isUpdateAvailable } from './version'

describe('parseVersionJson', () => {
  it('accepts the emitted shape', () => {
    expect(parseVersionJson({ sha: 'abc123', builtAt: '2026-07-13T10:43:00.000Z' }))
      .toEqual({ sha: 'abc123', builtAt: '2026-07-13T10:43:00.000Z' })
  })

  it('tolerates a missing or non-string builtAt', () => {
    expect(parseVersionJson({ sha: 'abc123' })).toEqual({ sha: 'abc123', builtAt: null })
    expect(parseVersionJson({ sha: 'abc123', builtAt: 42 })).toEqual({ sha: 'abc123', builtAt: null })
  })

  it('rejects malformed payloads', () => {
    expect(parseVersionJson(null)).toBeNull()
    expect(parseVersionJson('abc123')).toBeNull()
    expect(parseVersionJson({})).toBeNull()
    expect(parseVersionJson({ sha: '' })).toBeNull()
    expect(parseVersionJson({ sha: 123 })).toBeNull()
    expect(parseVersionJson([])).toBeNull()
  })
})

describe('isUpdateAvailable', () => {
  const deployed = { sha: 'new456', builtAt: null }

  it('true only for a differing non-empty pair', () => {
    expect(isUpdateAvailable('old123', deployed)).toBe(true)
  })

  it('false when this build has no stamp (dev/local)', () => {
    expect(isUpdateAvailable('', deployed)).toBe(false)
  })

  it('false without deployed info', () => {
    expect(isUpdateAvailable('old123', null)).toBe(false)
  })

  it('false when already on the deployed build', () => {
    expect(isUpdateAvailable('new456', deployed)).toBe(false)
  })
})
