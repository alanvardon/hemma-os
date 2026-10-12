// auth-otp.ts — pure helpers for the 6-digit email-code sign-in (plan 136).
// Kept free of React and Supabase so the error mapping is testable in node.

export const OTP_LENGTH = 6
// Matches Supabase's per-email resend interval, so the button never offers a
// send the server would refuse.
export const OTP_RESEND_COOLDOWN_MS = 60_000

export const OTP_INVALID_MESSAGE =
  'Koden stämmer inte eller har gått ut. Kontrollera mejlet eller skicka en ny kod.'
export const OTP_RATE_LIMIT_MESSAGE = 'För många försök. Vänta en stund och försök igen.'
export const OTP_NETWORK_MESSAGE =
  'Kunde inte logga in. Kontrollera anslutningen och försök igen.'

// Digits only, capped at the code length, so a pasted "123 456" becomes "123456".
export function sanitizeOtpInput(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, OTP_LENGTH)
}

// Maps a verifyOtp error (returned or thrown) to user copy. Never echoes the
// backend message: AuthApiError text is English and unstable.
//
// auth-js returns fetch failures as `{ error }` rather than throwing: an
// AuthRetryableFetchError with status 0 (no response) or a 5xx gateway status.
// Those, and anything thrown or without a status, are connection problems, not
// a wrong code.
export function otpErrorMessage(error: unknown): string {
  if (typeof error !== 'object' || error === null) return OTP_NETWORK_MESSAGE
  const { name, status } = error as { name?: unknown; status?: unknown }
  if (name === 'AuthRetryableFetchError') return OTP_NETWORK_MESSAGE
  if (typeof status !== 'number' || status === 0 || status >= 500) return OTP_NETWORK_MESSAGE
  if (status === 429) return OTP_RATE_LIMIT_MESSAGE
  return OTP_INVALID_MESSAGE
}

// Whole seconds until resend unlocks, rounded up; 0 once it is available.
export function resendSecondsLeft(resendAt: number, now: number): number {
  return Math.max(0, Math.ceil((resendAt - now) / 1000))
}
