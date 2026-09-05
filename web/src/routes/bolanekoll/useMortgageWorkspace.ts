import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSaveFlash } from '../../components/useSaveFlash'
import { useToast } from '../../components/useToast'
import { money } from '../../lib/format'
import { persistenceErrorMessage } from '../../lib/persistence-error'
import {
  hasChargeInMonth,
  makeBank,
  makePayment,
  proposeRatePeriodTransition,
  ratePeriodNeighbours,
  type Bank,
  type CatalogBank,
  type Contribution,
  type ExpectedCharge,
  type LoanPart,
  type Mortgage,
  type MortgageSettings,
  type Payment,
  type RatePeriod,
  type Valuation,
} from '../../lib/mortgage'
import * as Store from '../../lib/mortgage-store'
import type { CreateAgreementInput } from './AgreementDialog'
import type { BankProfileSaveInput } from './BankProfileDialog'
import type { BankChangeResult } from './BankChangeWizard'
import type { BankSelection } from './BankPicker'
import {
  predecessorCloseFailedMessage,
  ratePeriodInvalidMessage,
  RATE_PERIOD_CREATED_TOAST,
  RATE_PERIOD_UPDATED_TOAST,
} from './ratePeriodCopy'

export type PendingChargeKind = 'interest' | 'payment' | 'amortization'

// Plan 128 §3 — the one-time, non-modal account of an auto-persisted bank
// profile. It states ONLY the conventions this write actually determined (a
// field the owner already declared is untouched and must not be re-announced)
// and the replay evidence it was proven on, so the owner can see both what
// changed and why it was trusted.
const CHARGE_BASIS_PHRASE = { days: 'ränta per dag', monthly: 'fast månadsränta' } as const
const BILLING_PHRASE = { 'month-end': 'avisering månadsslut', fixed: 'avisering fast dag' } as const

function autoFitMessage(fitted: Store.BankProfileAutoFit): string {
  const determined: string[] = []
  if (fitted.written.year_basis) determined.push(`bankår ${fitted.written.year_basis}`)
  if (fitted.written.charge_basis) determined.push(CHARGE_BASIS_PHRASE[fitted.written.charge_basis])
  if (fitted.written.billing) determined.push(BILLING_PHRASE[fitted.written.billing])
  return `Bankprofil för ${fitted.bank.label} fastställd: ${determined.join(', ')}. `
    + `Återskapar bankens ${fitted.fit.covered} senaste debiteringar inom ${money(fitted.fit.residual)}.`
}

/**
 * A save that the caller must be able to act on: the rate-period dialog stays
 * open with the draft intact and renders `message` inline, because a paired
 * write can fail halfway and leave a repair the owner has to perform by hand
 * (plan 127 §3).
 */
export type SavePeriodResult = { ok: true } | { ok: false; message: string }

interface WorkspaceState {
  banks: Bank[]
  catalogBanks: CatalogBank[]
  mortgages: Mortgage[]
  parts: LoanPart[]
  payments: Payment[]
  valuations: Valuation[]
  periods: RatePeriod[]
  contributions: Contribution[]
  settings: MortgageSettings
}

/**
 * Owns Bolånekoll's persisted workspace boundary: synchronous cached seeding,
 * cloud refreshes, entity state, and the mutation sequences that must refresh
 * that state without weakening mortgage-store's cache/outbox semantics.
 *
 * CSV parsing, mapping, reconciliation, and commit remain in the route as a
 * separate workflow. Financial calculations remain pure in lib/mortgage.
 */
export function useMortgageWorkspace() {
  const [workspace, setWorkspace] = useState<WorkspaceState>(() => {
    const seed = Store.cachedSnapshot()
    return {
      banks: seed.banks,
      catalogBanks: [],
      mortgages: seed.mortgages,
      parts: seed.loan_parts,
      payments: seed.payments,
      valuations: seed.valuations,
      periods: seed.rate_periods,
      contributions: seed.contributions,
      settings: seed.settings,
    }
  })
  // False until the first cloud refresh resolves. Cached rows may render
  // immediately, but a cold cache must not flash the genuinely-empty state.
  const [loaded, setLoaded] = useState(false)
  const { toast, showToast } = useToast()
  const { saveVisible: saved, flashSaved } = useSaveFlash()

  const refresh = useCallback(async () => {
    const [parts, payments, valuations, periods, contributions, settings, banks, mortgages] = await Promise.all([
      Store.listLoanParts(),
      Store.listPayments(),
      Store.listValuations(),
      Store.listRatePeriods(),
      Store.listContributions(),
      Store.getSettings(),
      Store.listBanks(),
      Store.listMortgages(),
    ])
    setWorkspace(current => ({
      ...current,
      banks,
      mortgages,
      parts,
      payments,
      valuations,
      periods,
      contributions,
      settings,
    }))
    // Plan 128 §3 — auto-persist any bank profile the ledger now proves. This
    // is a background write the owner did not ask for, so it is fire-and-forget
    // like the catalogue read below: it must not delay the page, and a failure
    // is safe to lose (nothing was stored, so the next load simply retries).
    // Deliberately NOT flashSaved() — that pulse means "your save landed", and
    // firing it on load, when the owner did nothing, would misreport the write.
    Promise.resolve()
      .then(() => Store.autoFitBankProfiles(banks, mortgages, parts, periods, payments))
      .then(fitted => {
        if (!fitted?.length) return
        // Patch the freshly-written banks into state so the profile the UI
        // reads is the stored one immediately, without a second refresh.
        setWorkspace(current => ({
          ...current,
          banks: current.banks.map(bank => fitted.find(result => result.bank.id === bank.id)?.bank ?? bank),
        }))
        // One toast holds one message, so several banks share one string.
        showToast(fitted.map(autoFitMessage).join(' '))
      })
      .catch(() => { /* nothing was written; the next load retries */ })
    // The shared catalogue is best-effort and never blocks the household
    // workspace. Its store keeps a defensive cache of the last good result.
    Store.listCatalogBanks()
      .then(catalogBanks => setWorkspace(current => ({ ...current, catalogBanks })))
      .catch(() => setWorkspace(current => ({ ...current, catalogBanks: [] })))
    setLoaded(true)
  }, [showToast])

  useEffect(() => { refresh() }, [refresh])

  // Preserve the route's legacy-tolerant selection: when every agreement is
  // archived, still surface the first one rather than making its rows vanish.
  const activeMortgage = useMemo<Mortgage | null>(
    () => workspace.mortgages.find(mortgage => mortgage && !mortgage.archived) ?? workspace.mortgages[0] ?? null,
    [workspace.mortgages],
  )
  const activeBank = useMemo<Bank | null>(
    () => activeMortgage?.bank_id
      ? (workspace.banks.find(bank => bank.id === activeMortgage.bank_id) ?? null)
      : null,
    [activeMortgage, workspace.banks],
  )

  function saveError(error: unknown): void {
    showToast(persistenceErrorMessage(error))
  }

  async function savePart(
    data: Omit<LoanPart, 'id' | 'created_at'>,
    existingId: string | null,
  ): Promise<boolean> {
    try {
      if (existingId) await Store.updateLoanPart(existingId, data)
      else await Store.addLoanPart({ ...data, mortgage_id: activeMortgage?.id ?? null })
      await refresh()
      flashSaved()
      showToast(existingId ? 'Loan part updated.' : 'Loan part added.')
      return true
    } catch (error) {
      saveError(error)
      return false
    }
  }

  async function removePart(id: string): Promise<boolean> {
    try {
      await Store.removeLoanPart(id)
      await refresh()
      flashSaved()
      showToast('Loan part deleted.')
      return true
    } catch (error) {
      saveError(error)
      return false
    }
  }

  async function resolveBankSelection(selection: BankSelection, current: Bank | null): Promise<string | null> {
    if (!selection) return current?.id ?? null
    if (selection.kind === 'existing') return selection.bankId
    if (selection.kind === 'catalog') {
      const existing = workspace.banks.find(bank => bank.catalog_id === selection.catalogId)
      if (existing) return existing.id
      const created = await Store.addBank(makeBank({ label: selection.label, catalog_id: selection.catalogId }))
      return created.id
    }
    const created = await Store.addBank(makeBank({ label: selection.label.trim() || 'Egen bank' }))
    return created.id
  }

  // These dialog-owned writes deliberately reject. The dialogs catch the
  // rejection, keep their form open, and render the stable persistence error.
  async function saveBankProfile(input: BankProfileSaveInput): Promise<void> {
    const bankId = await resolveBankSelection(input.selection, activeBank)
    if (activeMortgage && bankId && activeMortgage.bank_id !== bankId) {
      await Store.updateMortgage(activeMortgage.id, { bank_id: bankId })
    }
    const targetBankId = bankId ?? activeBank?.id ?? null
    if (targetBankId) {
      await Store.updateBank(targetBankId, {
        year_basis: input.year_basis,
        year_basis_source: input.year_basis == null ? null : 'declared',
        billing: input.billing,
        billing_source: input.billing == null ? null : 'declared',
      })
    }
    await refresh()
    flashSaved()
    showToast('Bankprofil sparad.')
  }

  async function createAgreement(input: CreateAgreementInput): Promise<void> {
    const bankId = await resolveBankSelection(input.selection, null)
    await Store.addMortgage({
      bank_id: bankId,
      label: input.label || 'Bolån',
      start_date: input.start_date || null,
      archived: false,
      end_date: null,
    })
    await refresh()
    flashSaved()
    showToast('Bolåneavtal skapat.')
  }

  // Atomic agreement transitions surface both through the route toast and by
  // rejection, so the wizard/history dialog can also stay open with its alert.
  async function changeBank(result: BankChangeResult): Promise<void> {
    if (!activeMortgage) throw new Error('no active agreement')
    try {
      const bankId = await resolveBankSelection(result.selection, null)
      if (!bankId) throw new Error('no bank selected')
      await Store.changeMortgageBank({
        old_mortgage_id: activeMortgage.id,
        bank_id: bankId,
        label: result.label,
        parts: result.parts,
        effective_date: result.effective_date,
      })
      await refresh()
      flashSaved()
      showToast('Bankbyte genomfört. Lägg till räntevillkor för de nya lånedelarna.')
    } catch (error) {
      saveError(error)
      throw error
    }
  }

  async function revertBankChange(): Promise<void> {
    if (!activeMortgage) throw new Error('no active agreement')
    try {
      await Store.revertMortgageBankChange(activeMortgage.id)
      await refresh()
      flashSaved()
      showToast('Bankbytet ångrades.')
    } catch (error) {
      saveError(error)
      throw error
    }
  }

  // Plan 127 §3. Creating a rate period is the one workspace write that may
  // have to touch a SECOND row — the predecessor it supersedes — so it reports
  // a result rather than a bare boolean: the dialog has to stay open with the
  // draft intact and show which repair is outstanding.
  async function savePeriod(
    partId: string,
    data: Omit<RatePeriod, 'id' | 'created_at'>,
    existingId?: string,
  ): Promise<SavePeriodResult> {
    // Both paths run the same pure proposal, but an edit is a correction of one
    // row and deliberately keeps today's plain update path (plan 127 §1): with
    // an empty timeline the proposal applies exactly the date/rate rules and no
    // neighbour rules, so an edit is validated without re-resolving neighbours.
    const proposal = proposeRatePeriodTransition(partId, existingId ? [] : workspace.periods, data)
    if (proposal.status === 'invalid') {
      const neighbours = existingId ? null : ratePeriodNeighbours(partId, workspace.periods, data.start_date)
      const message = ratePeriodInvalidMessage(proposal.reason, neighbours)
      showToast(message)
      return { ok: false, message }
    }

    if (existingId) {
      try {
        await Store.updateRatePeriod(existingId, data)
        await refresh()
        flashSaved()
        showToast(RATE_PERIOD_UPDATED_TOAST)
        return { ok: true }
      } catch (error) {
        saveError(error)
        return { ok: false, message: persistenceErrorMessage(error) }
      }
    }

    const { successor, close } = proposal.transition

    // Step 1 — insert. Nothing is written yet, so a failure here leaves the
    // stored timeline exactly as it was.
    try {
      await Store.addRatePeriod(successor)
    } catch (error) {
      saveError(error)
      return { ok: false, message: persistenceErrorMessage(error) }
    }

    // Step 2 — close the predecessor. Deliberately NOT atomic: plan 127 Fix 3
    // cut the security-definer RPC (migration, row locking, server-side
    // revalidation, replay idempotence) because this is a low-frequency
    // single-user write whose failure mode is a visible, repairable overlap —
    // plan 126's strict resolution renders an overlapping timeline as "no
    // current rate" on a named part, never as a wrong figure. The price of that
    // cut is this branch: the owner must be told the exact date to set by hand.
    if (close) {
      try {
        await Store.updateRatePeriod(close.id, { end_date: close.end_date })
      } catch {
        // The new period IS persisted, so refresh anyway — the page has to show
        // the overlap the owner is being asked to repair. A refresh that itself
        // fails must not swallow the repair instruction.
        await refresh().catch(() => {})
        const message = predecessorCloseFailedMessage(close.end_date)
        showToast(message)
        return { ok: false, message }
      }
    }

    await refresh()
    flashSaved()
    showToast(RATE_PERIOD_CREATED_TOAST)
    return { ok: true }
  }

  async function removePeriod(id: string): Promise<boolean> {
    try {
      await Store.removeRatePeriod(id)
      await refresh()
      flashSaved()
      return true
    } catch (error) {
      saveError(error)
      return false
    }
  }

  async function enableContributionTracking(): Promise<boolean> {
    try {
      await Store.saveSettings({ track_contributions: true })
      await refresh()
      flashSaved()
      showToast('Ägarfördelning från insatt kapital är påslagen.')
      return true
    } catch (error) {
      saveError(error)
      return false
    }
  }

  async function saveValuation(
    data: Omit<Valuation, 'id' | 'created_at'>,
    existingId: string | null,
  ): Promise<boolean> {
    try {
      let savedId = existingId
      if (existingId) await Store.updateValuation(existingId, data)
      else {
        const saved = await Store.addValuation(data)
        savedId = saved.id
      }
      if (data.is_purchase && savedId) {
        for (const valuation of workspace.valuations) {
          if (valuation.id !== savedId && valuation.is_purchase) {
            await Store.updateValuation(valuation.id, { is_purchase: false })
          }
        }
      }
      await refresh()
      flashSaved()
      showToast(data.is_purchase ? 'Köpeskilling set.' : 'Valuation saved.')
      return true
    } catch (error) {
      saveError(error)
      return false
    }
  }

  async function removeValuation(id: string): Promise<boolean> {
    try {
      await Store.removeValuation(id)
      await refresh()
      flashSaved()
      showToast('Valuation deleted.')
      return true
    } catch (error) {
      saveError(error)
      return false
    }
  }

  async function savePayment(
    data: Omit<Payment, 'id' | 'created_at'>,
    existingId: string | null,
  ): Promise<boolean> {
    try {
      if (existingId) await Store.updatePayment(existingId, data)
      else await Store.addPayment(data)
      await refresh()
      flashSaved()
      showToast('Payment saved.')
      return true
    } catch (error) {
      saveError(error)
      return false
    }
  }

  async function removePayment(id: string): Promise<boolean> {
    try {
      await Store.removePayment(id)
      await refresh()
      flashSaved()
      showToast('Payment deleted.')
      return true
    } catch (error) {
      saveError(error)
      return false
    }
  }

  async function copyPayment(source: Payment, targetIds: string[]): Promise<boolean> {
    try {
      await Store.addPayments(targetIds.map(partId => makePayment({
        ...source,
        loan_part_id: partId,
        balance_after: null,
      })))
      await refresh()
      flashSaved()
      showToast(`Copied to ${targetIds.length} part${targetIds.length === 1 ? '' : 's'}.`)
      return true
    } catch (error) {
      saveError(error)
      return false
    }
  }

  async function saveSettings(patch: Partial<MortgageSettings>): Promise<boolean> {
    try {
      await Store.saveSettings(patch)
      await refresh()
      flashSaved()
      showToast('Settings saved.')
      return true
    } catch (error) {
      saveError(error)
      return false
    }
  }

  async function logPredicted(
    entries: Array<{ charge: ExpectedCharge; kind: PendingChargeKind; amount: number }>,
  ): Promise<boolean> {
    const toLog = entries.filter(entry =>
      entry.amount > 0
      && !hasChargeInMonth(
        workspace.payments,
        entry.charge.loan_part_id,
        entry.charge.next_date,
        entry.kind,
      ))
    if (!toLog.length) return false
    try {
      await Store.addPayments(toLog.map(entry => makePayment({
        loan_part_id: entry.charge.loan_part_id,
        date: entry.charge.next_date,
        kind: entry.kind,
        description: 'Godkänd prognos',
        amount: entry.amount,
        balance_after: entry.charge.balance - entry.charge.amortization,
        source: 'predicted',
      })))
      await refresh()
      flashSaved()
      showToast(toLog.length === 1
        ? 'Rad godkänd och tillagd i Betalningar.'
        : `${toLog.length} rader godkända och tillagda i Betalningar.`)
      return true
    } catch (error) {
      saveError(error)
      return false
    }
  }

  // Plan 126 §5 — there is deliberately NO refreshPredicted here. A row the
  // owner approved (source: 'predicted', "Godkänd prognos") is frozen forever;
  // the only thing that may replace it is the bank's next real import. Adding a
  // model-driven rewrite back would breach the acceptance boundary.

  async function clearPayments(payments: Payment[]): Promise<boolean> {
    if (!payments.length) return false
    try {
      for (const payment of payments) await Store.removePayment(payment.id)
      await refresh()
      flashSaved()
      showToast('Payments deleted.')
      return true
    } catch (error) {
      saveError(error)
      return false
    }
  }

  return {
    state: { ...workspace, loaded },
    selection: { activeMortgage, activeBank },
    feedback: { toast, saved, showToast, flashSaved, showError: saveError },
    actions: {
      refresh,
      parts: { save: savePart, remove: removePart, savePeriod, removePeriod },
      agreements: { saveBankProfile, create: createAgreement, changeBank, revertBankChange },
      valuations: { save: saveValuation, remove: removeValuation },
      payments: { save: savePayment, remove: removePayment, copy: copyPayment, logPredicted, clear: clearPayments },
      settings: { save: saveSettings, enableContributionTracking },
    },
  }
}
