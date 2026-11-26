// Which Vindsplanen variant this device has open (plan 149). A per-device
// viewing choice like viewPrefs.ts, so it lives in localStorage, never in the
// shared plan rows. Every storage access is guarded: private mode / blocked
// storage must never break the page — it just falls back to the oldest row.

export const ACTIVE_PLAN_KEY = 'vp-active-plan-v1'

/** The stored variant id, or null when none (or storage is unreadable). */
export function activePlanId(): string | null {
  try {
    const id = localStorage.getItem(ACTIVE_PLAN_KEY)
    return id ? id : null
  } catch {
    return null
  }
}

/** Remember the open variant; null forgets it. Best effort. */
export function setActivePlanId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_PLAN_KEY, id)
    else localStorage.removeItem(ACTIVE_PLAN_KEY)
  } catch {
    /* best effort */
  }
}

/**
 * The variant to open: the stored one when it still exists, otherwise the
 * oldest (`rows` come oldest first from loadPlans) — today's single-plan
 * behaviour. null only when there are no rows.
 */
export function resolveActivePlan<T extends { id: string }>(rows: readonly T[], stored: string | null = activePlanId()): T | null {
  return (stored ? rows.find((row) => row.id === stored) : undefined) ?? rows[0] ?? null
}
