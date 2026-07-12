// Deno unit tests for the pure helpers in logic.ts.
// Run with: deno test --allow-none supabase/functions/policy-rate-notify/logic.test.ts
// (Deno was not available in the environment this was written in — verify
// locally or in CI with a Deno step before relying on this passing.)

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  RIKSBANK_DECISIONS_2026,
  buildNotificationEmail,
  isDecisionDate,
  parsePoint,
  serializePoint,
  shouldNotify,
} from './logic.ts'

Deno.test('isDecisionDate — true on a published decision date', () => {
  assertEquals(isDecisionDate('2026-03-19', RIKSBANK_DECISIONS_2026), true)
})

Deno.test('isDecisionDate — false on a non-decision date', () => {
  assertEquals(isDecisionDate('2026-03-20', RIKSBANK_DECISIONS_2026), false)
  assertEquals(isDecisionDate('2026-12-25', RIKSBANK_DECISIONS_2026), false)
})

Deno.test('shouldNotify — no stored value means always notify (first run)', () => {
  assertEquals(shouldNotify(null, { date: '2026-03-19', value: 2.25 }), true)
  assertEquals(shouldNotify(undefined, { date: '2026-03-19', value: 2.25 }), true)
})

Deno.test('shouldNotify — same stored value means skip (idempotent)', () => {
  const point = { date: '2026-03-19', value: 2.25 }
  assertEquals(shouldNotify(serializePoint(point), point), false)
})

Deno.test('shouldNotify — different value means notify', () => {
  const stored = serializePoint({ date: '2026-01-29', value: 2.0 })
  assertEquals(shouldNotify(stored, { date: '2026-03-19', value: 2.25 }), true)
})

Deno.test('shouldNotify — same value but a new effective date still notifies', () => {
  const stored = serializePoint({ date: '2026-01-29', value: 2.25 })
  assertEquals(shouldNotify(stored, { date: '2026-03-19', value: 2.25 }), true)
})

Deno.test('shouldNotify — malformed stored JSON is treated as no prior record', () => {
  assertEquals(shouldNotify('not-json', { date: '2026-03-19', value: 2.25 }), true)
})

Deno.test('parsePoint — round-trips through serializePoint', () => {
  const point = { date: '2026-03-19', value: 2.25 }
  assertEquals(parsePoint(serializePoint(point)), point)
})

Deno.test('buildNotificationEmail — includes old and new rate when a previous point exists', () => {
  const email = buildNotificationEmail(
    { date: '2026-01-29', value: 2.0 },
    { date: '2026-03-19', value: 2.25 },
    'https://hemma-os.se/bolanekoll',
  )
  assertEquals(email.subject, 'Riksbanken ändrade styrräntan till 2,25 %')
  assertEquals(email.text.includes('från 2,00 % till 2,25 %'), true)
  assertEquals(email.html.includes('hemma-os.se/bolanekoll'), true)
})

Deno.test('buildNotificationEmail — first-run framing when there is no previous point', () => {
  const email = buildNotificationEmail(null, { date: '2026-01-29', value: 2.0 }, 'https://hemma-os.se/bolanekoll')
  assertEquals(email.subject, 'Riksbanken ändrade styrräntan till 2,00 %')
  assertEquals(email.text.includes('är nu 2,00 %'), true)
})
