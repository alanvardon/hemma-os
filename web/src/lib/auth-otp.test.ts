import { describe, expect, it } from 'vitest'
import {
  OTP_INVALID_MESSAGE,
  OTP_NETWORK_MESSAGE,
  OTP_RATE_LIMIT_MESSAGE,
  otpErrorMessage,
  resendSecondsLeft,
  sanitizeOtpInput,
} from './auth-otp'

describe('sanitizeOtpInput', () => {
  it.each([
    ['123456', '123456'],
    ['123 456', '123456'],
    [' 12-34 56 ', '123456'],
    ['abc', ''],
    ['', ''],
    ['1234567890', '123456'],
    ['12 34', '1234'],
  ])('turns %j into %j', (raw, expected) => {
    expect(sanitizeOtpInput(raw)).toBe(expected)
  })
})

describe('otpErrorMessage', () => {
  it('maps HTTP 429 to the rate-limit copy', () => {
    expect(otpErrorMessage({ name: 'AuthApiError', status: 429, message: 'Too many requests' }))
      .toBe(OTP_RATE_LIMIT_MESSAGE)
  })

  it.each([400, 401, 403, 422])('maps API status %i to the invalid/expired copy', (status) => {
    expect(otpErrorMessage({ name: 'AuthApiError', status, message: 'Token has expired or is invalid' }))
      .toBe(OTP_INVALID_MESSAGE)
  })

  it('maps auth-js retryable fetch errors (status 0) to the network copy', () => {
    expect(otpErrorMessage({ name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' }))
      .toBe(OTP_NETWORK_MESSAGE)
  })

  it('maps retryable 5xx gateway errors to the network copy', () => {
    expect(otpErrorMessage({ name: 'AuthRetryableFetchError', status: 503, message: 'Bad gateway' }))
      .toBe(OTP_NETWORK_MESSAGE)
  })

  it.each([
    new TypeError('Failed to fetch'),
    new Error('An error occurred on token verification.'),
    { message: 'no status' },
    null,
    undefined,
    'boom',
  ])('maps a thrown or status-less error %o to the network copy', (error) => {
    expect(otpErrorMessage(error)).toBe(OTP_NETWORK_MESSAGE)
  })

  it('never echoes the backend message', () => {
    for (const status of [0, 400, 429, 500]) {
      expect(otpErrorMessage({ status, message: 'private backend detail' })).not.toContain('private')
    }
  })
})

describe('resendSecondsLeft', () => {
  it('rounds the remaining cooldown up to whole seconds', () => {
    expect(resendSecondsLeft(60_000, 0)).toBe(60)
    expect(resendSecondsLeft(60_000, 18_001)).toBe(42)
    expect(resendSecondsLeft(60_000, 59_999)).toBe(1)
  })

  it('is zero once the cooldown has passed or was never set', () => {
    expect(resendSecondsLeft(60_000, 60_000)).toBe(0)
    expect(resendSecondsLeft(60_000, 90_000)).toBe(0)
    expect(resendSecondsLeft(0, 1_000)).toBe(0)
  })
})
