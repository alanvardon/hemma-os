// Parsing pasted plan text: a v41 artifact "Copy plan" export (through
// legacy.ts) or this tool's own export (a PlanV2, `v: 2`). Pure; the Spara tab
// shows the message for a failure.

import { importV1Text } from '../../lib/vindsplanen/legacy'
import { sanitizePlan, type PlanV2 } from '../../lib/vindsplanen/plan'

export const IMPORT_MESSAGE = {
  empty: 'Klistra in en kopierad plan först.',
  'not-object': 'Texten är ingen plan från Vindsplanen. Kopiera hela planen och försök igen.',
  'too-old': 'Öppna planen i artefakten först och kopiera den igen.',
  invalid: 'Planen kunde inte läsas. Kontrollera att hela texten kopierades.',
} as const

export type ParsedPlan = { ok: true; plan: PlanV2 } | { ok: false; message: string }

export function parsePlanText(text: string): ParsedPlan {
  const t = text.trim()
  if (!t) return { ok: false, message: IMPORT_MESSAGE.empty }
  try {
    const raw: unknown = JSON.parse(t)
    if (raw && typeof raw === 'object' && (raw as { v?: unknown }).v === 2) {
      const plan = sanitizePlan(raw)
      return plan ? { ok: true, plan } : { ok: false, message: IMPORT_MESSAGE.invalid }
    }
  } catch {
    return { ok: false, message: IMPORT_MESSAGE['not-object'] }
  }
  const r = importV1Text(t)
  return r.ok ? { ok: true, plan: r.plan } : { ok: false, message: IMPORT_MESSAGE[r.reason] }
}

/** Offer `data` as a downloaded .json file. */
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
