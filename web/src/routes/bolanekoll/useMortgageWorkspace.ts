import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSaveFlash } from '../../components/useSaveFlash'
import { useToast } from '../../components/useToast'
import { persistenceErrorMessage } from '../../lib/persistence-error'
import {
  hasChargeInMonth,
  makeBank,
  makePayment,
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

export type PendingChargeKind = 'interest' | 'payment' | 'amortization'

export interface StalePredictedRow {
  payment: Payment
  amount: number
  balance_after: number
}

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
    // The shared catalogue is best-effort and never blocks the household
    // workspace. Its store keeps a defensive cache of the last good result.
    Store.listCatalogBanks()
      .then(catalogBanks => setWorkspace(current => ({ ...current, catalogBanks })))
      .catch(() => setWorkspace(current => ({ ...current, catalogBanks: [] })))
    setLoaded(true)
  }, [])

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

  async function savePeriod(
    partId: string,
    data: Omit<RatePeriod, 'id' | 'created_at'>,
    existingId?: string,
  ): Promise<boolean> {
    try {
      if (existingId) await Store.updateRatePeriod(existingId, data)
      else await Store.addRatePeriod({ ...data, loan_part_id: partId })
      await refresh()
      flashSaved()
      showToast(existingId ? 'Rate period updated.' : 'Rate period added.')
      return true
    } catch (error) {
      saveError(error)
      return false
    }
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

  async function refreshPredicted(staleRows: StalePredictedRow[]): Promise<boolean> {
    if (!staleRows.length) return false
    try {
      for (const stale of staleRows) {
        await Store.updatePayment(stale.payment.id, {
          amount: stale.amount,
          balance_after: stale.balance_after,
        })
      }
      await refresh()
      flashSaved()
      showToast(staleRows.length === 1
        ? '1 godkänd prognosrad uppdaterad till aktuell prognos.'
        : `${staleRows.length} godkända prognosrader uppdaterade till aktuell prognos.`)
      return true
    } catch (error) {
      saveError(error)
      return false
    }
  }

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
      payments: { save: savePayment, remove: removePayment, copy: copyPayment, logPredicted, refreshPredicted, clear: clearPayments },
      settings: { save: saveSettings, enableContributionTracking },
    },
  }
}
