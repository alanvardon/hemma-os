import { describe, expect, it } from 'vitest'
import { persistenceErrorMessage, toPersistenceError } from './persistence-error'

describe('persistence error contract', () => {
  it.each([
    [{ status: 401, message: 'JWT expired' }, 'auth'],
    [{ status: 409, code: '23505', message: 'duplicate' }, 'conflict'],
    [{ code: '23514', message: 'constraint private_schema_name' }, 'validation'],
    [new TypeError('Failed to fetch'), 'offline'],
    [{ message: 'private backend details' }, 'unknown'],
  ] as const)('classifies %o as %s without exposing backend text', (backend, category) => {
    const error = toPersistenceError(backend)
    expect(error.category).toBe(category)
    expect(error.message).not.toContain('private')
    expect(error.message).not.toContain('JWT')
  })

  it('returns stable Swedish user copy', () => {
    expect(persistenceErrorMessage(new TypeError('network payload details')))
      .toBe('Ingen anslutning. Ändringen sparades inte i molnet.')
  })
})
