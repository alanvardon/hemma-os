// ratePeriodCopy.ts — the Swedish copy for the rate-period save contract
// (plan 127 §3), kept in one place so the dialog's live validation, the
// workspace's save failures and the tests all quote the same sentences.
//
// Every message names the concrete repair where one exists: a rate-period
// conflict is always fixable by hand, and a message that only says "kunde inte
// spara" leaves the owner with an overlapping timeline and no instruction.
import { addDaysISO, dayBefore } from '../../lib/mortgage'
import type { RatePeriod, RatePeriodNeighbours, RatePeriodStatus, RatePeriodTransitionReason } from '../../lib/mortgage'
import { fmtPct } from './shared'

const RATE_TYPE_LABEL: Record<RatePeriod['rate_type'], string> = {
  rörlig: 'rörlig',
  bunden: 'bunden',
}

/** Plan 127 §5 — the word shown next to an open-ended period in the history
 * list, replacing the old "nu · now" placeholder. */
export const RATE_PERIOD_STATUS_LABEL: Record<RatePeriodStatus, string> = {
  past: 'Tidigare',
  current: 'Aktuell',
  upcoming: 'Kommande',
}

/**
 * Swedish copy for a rejected draft. `neighbours` lets the two timeline
 * reasons name the exact date to use; without it they fall back to wording
 * that still tells the owner what to change.
 */
export function ratePeriodInvalidMessage(
  reason: RatePeriodTransitionReason,
  neighbours?: RatePeriodNeighbours | null,
): string {
  switch (reason) {
    case 'invalid-date':
      return 'Kontrollera datumen. Ange giltiga datum i formatet ÅÅÅÅ-MM-DD.'
    case 'invalid-rate':
      return 'Ange en räntesats i procent, noll eller högre.'
    case 'start-after-end':
      return 'Villkorsändringsdagen kan inte infalla före startdatumet.'
    case 'duplicate-start':
      return 'Det finns redan en ränteperiod som börjar detta datum. Redigera den befintliga perioden i stället.'
    case 'gap-before': {
      // The predecessor closed before the draft starts, so the days between are
      // uncovered. Plan 127 §2 is explicit: do NOT offer to stretch the old
      // rate over days it never governed — name the contiguous date instead.
      const contiguous = neighbours?.previous?.end_date
        ? addDaysISO(neighbours.previous.end_date, 1)
        : null
      return contiguous
        ? `Perioderna lämnar ett glapp. Den nya perioden måste börja ${contiguous} eller så behöver den föregående perioden korrigeras.`
        : 'Perioderna lämnar ett glapp. Justera startdatumet eller korrigera den föregående perioden.'
    }
    case 'overlap-after': {
      const required = neighbours?.next?.start_date ? dayBefore(neighbours.next.start_date) : null
      return required
        ? `Villkorsändringsdagen krockar med nästa ränteperiod. Den måste vara ${required}.`
        : 'Villkorsändringsdagen krockar med nästa ränteperiod. Den måste vara dagen före nästa periods startdatum.'
    }
  }
}

/** Disclosed before saving, so the write matches what the owner was shown. */
export function predecessorCloseDisclosure(previous: RatePeriod, endDate: string): string {
  const rate = previous.rate != null ? fmtPct(previous.rate) : '—'
  return `Föregående period (${rate} · ${RATE_TYPE_LABEL[previous.rate_type] ?? 'rörlig'}) avslutas ${endDate}.`
}

/**
 * The one failure the deliberately non-atomic write (plan 127 Fix 3) can leave
 * behind: the new period is stored but its predecessor still runs past it. The
 * message must name the date, because repairing it by hand is the whole reason
 * the atomic RPC was cut.
 */
export function predecessorCloseFailedMessage(endDate: string): string {
  return 'Den nya perioden sparades, men den föregående kunde inte avslutas. '
    + `Perioderna överlappar — öppna föregående period och sätt slutdatum ${endDate}.`
}

export const RATE_PERIOD_CREATED_TOAST = 'Ny räntesats sparad.'
export const RATE_PERIOD_UPDATED_TOAST = 'Ränteperioden uppdaterad.'

/** Shared by the standalone dialog's own delete button and PartDialog's
 * per-row delete, so the two confirmations never drift apart. */
export const RATE_PERIOD_DELETE_CONFIRM_TITLE = 'Ta bort ränteperioden?'

/**
 * Plan 127 §2 — the delta shown beside the new rate once a valid number is
 * entered, e.g. "+0,36 pp". Built on `fmtPct` (never re-derives Swedish
 * number formatting) with its " %" suffix swapped for " pp" (percentage
 * points, not a percentage), and an explicit sign so the meaning never rests
 * on colour alone.
 */
export function rateDeltaLabel(currentRate: number, enteredRate: number): string {
  const delta = enteredRate - currentRate
  const magnitude = fmtPct(Math.abs(delta)).replace(' %', ' pp')
  if (delta > 0) return `+${magnitude}`
  if (delta < 0) return `−${magnitude}`
  return `±${magnitude}`
}
