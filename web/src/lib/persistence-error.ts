export type PersistenceErrorCategory =
  | 'offline'
  | 'auth'
  | 'conflict'
  | 'validation'
  | 'invite_ambiguous'
  | 'household_has_data'
  | 'unknown'

interface BackendErrorLike {
  code?: string
  message?: string
  status?: number
}

const USER_MESSAGES: Record<PersistenceErrorCategory, string> = {
  offline: 'Ingen anslutning. Ändringen sparades inte i molnet.',
  auth: 'Din session har gått ut. Logga in igen.',
  conflict: 'Ändringen krockade med en nyare version. Ladda om och försök igen.',
  validation: 'Ändringen kunde inte sparas. Kontrollera uppgifterna och försök igen.',
  invite_ambiguous: 'Flera hushåll har bjudit in dig. Be ett hushåll ta bort sin inbjudan innan du fortsätter.',
  household_has_data: 'Du kan inte gå med i ett annat hushåll medan du är ensam i ett hushåll med sparad data.',
  unknown: 'Kunde inte spara ändringen. Försök igen.',
}

export class PersistenceError extends Error {
  readonly category: PersistenceErrorCategory

  constructor(category: PersistenceErrorCategory) {
    super(USER_MESSAGES[category])
    this.name = 'PersistenceError'
    this.category = category
  }
}

function classify(error: unknown): PersistenceErrorCategory {
  if (error instanceof PersistenceError) return error.category
  if (error instanceof TypeError) return 'offline'

  const backend = (error && typeof error === 'object' ? error : {}) as BackendErrorLike
  const code = backend.code?.toUpperCase() ?? ''
  const message = backend.message?.toLowerCase() ?? ''

  if (code === 'P0003') return 'invite_ambiguous'
  if (code === 'P0004') return 'household_has_data'
  if (backend.status === 401 || backend.status === 403 || code.includes('JWT') || message.includes('jwt')) return 'auth'
  if (backend.status === 409 || code === '23505') return 'conflict'
  if (backend.status === 0 || message.includes('fetch') || message.includes('network') || message.includes('offline')) return 'offline'
  if (backend.status === 400 || code.startsWith('22') || code.startsWith('23')) return 'validation'
  return 'unknown'
}

export function toPersistenceError(error: unknown): PersistenceError {
  return error instanceof PersistenceError ? error : new PersistenceError(classify(error))
}

export function persistenceErrorMessage(error: unknown): string {
  return toPersistenceError(error).message
}

export const PERSISTENCE_ERROR_EVENT = 'hemma:persistence-error'

/** Report an already-handled background write failure to the app-level notice. */
export function reportPersistenceError(error: unknown): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(PERSISTENCE_ERROR_EVENT, {
    detail: { message: persistenceErrorMessage(error) },
  }))
}

/** Report recoverable invalid persisted data while keeping the valid records visible. */
export function reportPersistenceWarning(message: string): void {
  if (typeof window === 'undefined') return
  // The app-level notice already handles this event. Warnings are recoverable
  // but still need to be visible, rather than disappearing in a console log.
  window.dispatchEvent(new CustomEvent(PERSISTENCE_ERROR_EVENT, { detail: { message } }))
}
