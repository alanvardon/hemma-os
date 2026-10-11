/* salary-reminder-settings-store.ts — the household's on/off + send-day
   choice for the plan 132 monthly salary email reminder
   (salary_reminder_settings, one row or none per household).

   No cache: this is a single small settings row behind a toggle, not data the
   app must keep visible offline. Unlike every other household-owned table in
   this codebase, salary_reminder_settings.household_id has NO column default
   (see the migration) — the client must supply it explicitly. We use the
   same syncCoordinator-held household id already used for cache-key scoping
   elsewhere (sync.ts / storage.ts), rather than adding a second round trip
   just to look it up; it is the same value RLS's `current_household()` would
   resolve to for the same session. */

import { supabase } from './supabase'
import { syncCoordinator } from './sync'

export interface SalaryReminderSettings {
  enabled: boolean
  send_day: number
}

export const DEFAULT_SALARY_REMINDER_SETTINGS: SalaryReminderSettings = { enabled: true, send_day: 25 }

export interface SalaryReminderSettingsLoad {
  settings: SalaryReminderSettings
  /** false for a real row AND for the documented "no row = enabled, day 25"
      default (D10) — both are confirmed server state. true only when the read
      itself failed, so these are a fallback, not a fact: the UI must not
      present them as the saved value (e.g. show them non-committally rather
      than as a confidently-checked toggle). */
  unknown: boolean
}

function isValidSendDay(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 28
}

/** Load the household's reminder setting. No row is the documented default
    (enabled, day 25) — NOT an unknown state. A read failure (offline, RLS,
    down) falls back to the same default but is flagged unknown, since that
    default may not match what is actually saved. */
export async function loadSalaryReminderSettings(): Promise<SalaryReminderSettingsLoad> {
  const { data, error } = await supabase
    .from('salary_reminder_settings')
    .select('enabled, send_day')
    .maybeSingle()
  if (error) return { settings: { ...DEFAULT_SALARY_REMINDER_SETTINGS }, unknown: true }
  if (!data) return { settings: { ...DEFAULT_SALARY_REMINDER_SETTINGS }, unknown: false }
  const enabled = typeof data.enabled === 'boolean' ? data.enabled : DEFAULT_SALARY_REMINDER_SETTINGS.enabled
  const send_day = isValidSendDay(data.send_day) ? data.send_day : DEFAULT_SALARY_REMINDER_SETTINGS.send_day
  return { settings: { enabled, send_day }, unknown: false }
}

/** Upsert the household's reminder setting. Validates send_day (1–28,
    integer) BEFORE touching the network: an invalid value is rejected, never
    clamped or silently corrected, and no request is made. Throws on any
    other failure so the caller can toast and revert the control. */
export async function saveSalaryReminderSettings(settings: SalaryReminderSettings): Promise<void> {
  if (!isValidSendDay(settings.send_day)) {
    throw new Error('send_day must be an integer between 1 and 28')
  }
  const scope = syncCoordinator.captureScope()
  const { error } = await supabase
    .from('salary_reminder_settings')
    .upsert(
      { household_id: scope.identity.householdId, enabled: settings.enabled, send_day: settings.send_day },
      { onConflict: 'household_id' },
    )
  if (error) throw error
}
