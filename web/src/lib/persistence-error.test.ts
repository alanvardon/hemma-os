import { describe, expect, it } from 'vitest'
import { persistenceErrorMessage, toPersistenceError } from './persistence-error'

describe('persistence error contract', () => {
  it.each([
    [{ status: 401, message: 'JWT expired' }, 'auth'],
    [{ status: 409, code: '23505', message: 'duplicate' }, 'conflict'],
    [{ code: 'P0003', message: 'private invite details' }, 'invite_ambiguous'],
    [{ code: 'P0004', message: 'private household details' }, 'household_has_data'],
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

  it('gives actionable copy for lifecycle decisions without exposing SQL text', () => {
    expect(persistenceErrorMessage({ code: 'P0003', message: 'ambiguous household invitations' }))
      .toBe('Flera hushåll har bjudit in dig. Be ett hushåll ta bort sin inbjudan innan du fortsätter.')
    expect(persistenceErrorMessage({ code: 'P0004', message: 'household contains persisted data' }))
      .toBe('Du kan inte gå med i ett annat hushåll medan du är ensam i ett hushåll med sparad data.')
  })
})
