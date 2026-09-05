// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Bank, type LoanPart, type Mortgage, type RatePeriod } from '../../lib/mortgage'
import * as Store from '../../lib/mortgage-store'
import { useMortgageWorkspace } from './useMortgageWorkspace'

vi.mock('../../lib/mortgage-store')

const cachedPart: LoanPart = {
  id: 'cached-part',
  created_at: '2026-01-01',
  label: 'Cached part',
  loan_number: '',
  start_balance: 500_000,
  start_date: '2026-01-01',
  archived: false,
  mortgage_id: 'm1',
}
const cloudPart: LoanPart = { ...cachedPart, id: 'cloud-part', label: 'Cloud part' }
const activeMortgage: Mortgage = {
  id: 'm1',
  created_at: '2026-01-01',
  bank_id: 'b1',
  label: 'Bolån',
  start_date: '2026-01-01',
  archived: false,
  end_date: null,
}
const oldBank: Bank = {
  id: 'b1',
  created_at: '2026-01-01',
  label: 'Old bank',
  year_basis: null,
  year_basis_source: null,
  billing: null,
  billing_source: null,
  catalog_id: null,
}
const newBank: Bank = { ...oldBank, id: 'b2', label: 'New bank' }

function seedReads(parts: LoanPart[] | Promise<LoanPart[]> = [cloudPart], periods: RatePeriod[] = []) {
  vi.mocked(Store.cachedSnapshot).mockReturnValue({
    version: 6,
    banks: [oldBank, newBank],
    mortgages: [activeMortgage],
    loan_parts: [cachedPart],
    payments: [],
    valuations: [],
    rate_periods: periods,
    contributions: [],
    settings: defaultSettings(),
  })
  vi.mocked(Store.listLoanParts).mockImplementation(() => Promise.resolve(parts))
  vi.mocked(Store.listPayments).mockResolvedValue([])
  vi.mocked(Store.listValuations).mockResolvedValue([])
  vi.mocked(Store.listRatePeriods).mockResolvedValue(periods)
  vi.mocked(Store.listContributions).mockResolvedValue([])
  vi.mocked(Store.getSettings).mockResolvedValue(defaultSettings())
  vi.mocked(Store.listBanks).mockResolvedValue([oldBank, newBank])
  vi.mocked(Store.listMortgages).mockResolvedValue([activeMortgage])
  vi.mocked(Store.listCatalogBanks).mockResolvedValue([])
  // Plan 128 §3 — the load-time profile write. Nothing proven by default: the
  // steady state, once every bank is fitted, is an empty result.
  vi.mocked(Store.autoFitBankProfiles).mockResolvedValue([])
}

beforeEach(() => {
  vi.clearAllMocks()
  seedReads()
})

describe('useMortgageWorkspace', () => {
  it('renders the synchronous cache seed while cloud hydration is pending, then replaces it with the refreshed workspace', async () => {
    let resolveParts!: (parts: LoanPart[]) => void
    const pendingParts = new Promise<LoanPart[]>(resolve => { resolveParts = resolve })
    seedReads(pendingParts)
    vi.mocked(Store.listCatalogBanks).mockResolvedValue([
      { id: 'catalog-1', slug: 'bank', label: 'Catalogue bank', year_basis: null, billing: null },
    ])

    const { result } = renderHook(() => useMortgageWorkspace())

    expect(result.current.state.loaded).toBe(false)
    expect(result.current.state.parts).toEqual([cachedPart])
    expect(result.current.selection.activeMortgage?.id).toBe('m1')
    expect(result.current.selection.activeBank?.id).toBe('b1')

    await act(async () => { resolveParts([cloudPart]) })

    await waitFor(() => expect(result.current.state.loaded).toBe(true))
    expect(result.current.state.parts).toEqual([cloudPart])
    await waitFor(() => expect(result.current.state.catalogBanks).toHaveLength(1))
  })

  it('turns an ordinary workspace write rejection into a failed result and visible route toast', async () => {
    vi.mocked(Store.addLoanPart).mockRejectedValueOnce({ message: 'Failed to fetch' })
    const { result } = renderHook(() => useMortgageWorkspace())
    await waitFor(() => expect(result.current.state.loaded).toBe(true))

    let saved = true
    await act(async () => {
      saved = await result.current.actions.parts.save({
        label: 'New part',
        loan_number: '',
        start_balance: 400_000,
        start_date: '2026-02-01',
        archived: false,
      }, null)
    })

    expect(saved).toBe(false)
    expect(Store.addLoanPart).toHaveBeenCalledWith(expect.objectContaining({ mortgage_id: 'm1' }))
    expect(result.current.feedback.toast).toEqual({
      msg: 'Ingen anslutning. Ändringen sparades inte i molnet.',
      show: true,
    })
  })

  it('surfaces and rethrows an atomic bank-change failure so the wizard can stay open', async () => {
    vi.mocked(Store.changeMortgageBank).mockRejectedValueOnce({ message: 'Failed to fetch' })
    const { result } = renderHook(() => useMortgageWorkspace())
    await waitFor(() => expect(result.current.state.loaded).toBe(true))

    await act(async () => {
      await expect(result.current.actions.agreements.changeBank({
        selection: { kind: 'existing', bankId: 'b2' },
        label: 'New mortgage',
        effective_date: '2026-02-01',
        parts: [{ label: 'Part', balance: 500_000, planned_amortization: null }],
      })).rejects.toMatchObject({ message: 'Failed to fetch' })
    })

    expect(result.current.feedback.toast.msg).toBe('Ingen anslutning. Ändringen sparades inte i molnet.')
    expect(Store.changeMortgageBank).toHaveBeenCalledWith(expect.objectContaining({
      old_mortgage_id: 'm1',
      bank_id: 'b2',
    }))
  })

  // Plan 126 §5, the acceptance boundary. A row the owner approved
  // (source: 'predicted', "Godkänd prognos") is frozen FOREVER — only the
  // bank's next real import may replace it. The workspace used to expose
  // `payments.refreshPredicted`, which rewrote exactly those rows from a newer
  // model; it is removed rather than merely unwired, so the route cannot
  // reintroduce the write by calling it. This pins the absence at the store
  // layer, where the mutation lived.
  it('exposes no predicted-row rewrite action — approved rows are frozen', async () => {
    const { result } = renderHook(() => useMortgageWorkspace())
    await waitFor(() => expect(result.current.state.loaded).toBe(true))

    const payments = result.current.actions.payments as Record<string, unknown>
    expect(payments).not.toHaveProperty('refreshPredicted')
    expect(Object.keys(payments).sort())
      .toEqual(['clear', 'copy', 'logPredicted', 'remove', 'save'])
  })
})

// ── Plan 128 §3 — the auto-persisted bank profile ────────────────────────────
// A background write the owner did not ask for. It must reach the rendered
// workspace immediately (the UI has to read the STORED profile, not a re-derived
// one), be accounted for exactly once in Swedish, state only the conventions it
// actually determined, and stay silent when nothing was written.
function autoFit(over: Partial<Store.BankProfileAutoFit> = {}): Store.BankProfileAutoFit {
  return {
    bank: {
      ...oldBank,
      year_basis: 360, year_basis_source: 'detected',
      billing: 'month-end', billing_source: 'detected',
      charge_basis: 'days', charge_basis_source: 'detected',
    },
    written: { year_basis: 360, billing: 'month-end', charge_basis: 'days' },
    fit: {
      year_basis: 360, charge_basis: 'days', billing: 'month-end',
      covered: 7, residual: 2, runner_up_residual: 300, proven: true,
    },
    ...over,
  }
}

describe('useMortgageWorkspace — auto-persisted bank profile', () => {
  it('patches the written bank into the workspace and accounts for it once, in Swedish', async () => {
    vi.mocked(Store.autoFitBankProfiles).mockResolvedValue([autoFit()])
    const result = await mountWorkspace()

    await waitFor(() => expect(result.current.state.banks[0].year_basis).toBe(360))
    // The stored profile is visible without a second refresh…
    expect(result.current.state.banks[0]).toMatchObject({
      id: 'b1', year_basis_source: 'detected', billing: 'month-end', charge_basis: 'days',
    })
    // …and the untouched bank is left exactly as the cloud returned it.
    expect(result.current.state.banks[1]).toEqual(newBank)
    expect(result.current.feedback.toast).toEqual({
      msg: 'Bankprofil för Old bank fastställd: bankår 360, ränta per dag, avisering månadsslut. '
        + 'Återskapar bankens 7 senaste debiteringar inom 2 kr.',
      show: true,
    })
    expect(Store.autoFitBankProfiles).toHaveBeenCalledWith([oldBank, newBank], [activeMortgage], [cloudPart], [], [])
  })

  it('names only the conventions it actually wrote, never a field the owner already declared', async () => {
    vi.mocked(Store.autoFitBankProfiles).mockResolvedValue([autoFit({
      bank: { ...oldBank, year_basis: 365, year_basis_source: 'declared', charge_basis: 'days', charge_basis_source: 'detected' },
      written: { charge_basis: 'days' },
    })])
    const result = await mountWorkspace()

    await waitFor(() => expect(result.current.feedback.toast.show).toBe(true))
    expect(result.current.feedback.toast.msg).toBe(
      'Bankprofil för Old bank fastställd: ränta per dag. '
      + 'Återskapar bankens 7 senaste debiteringar inom 2 kr.',
    )
    // The declared year basis is neither re-announced nor implied.
    expect(result.current.feedback.toast.msg).not.toContain('bankår')
  })

  it('combines several fitted banks into the one toast the route can show', async () => {
    vi.mocked(Store.autoFitBankProfiles).mockResolvedValue([
      autoFit(),
      autoFit({
        bank: { ...newBank, charge_basis: 'monthly', charge_basis_source: 'detected' },
        written: { charge_basis: 'monthly' },
        fit: { year_basis: 365, charge_basis: 'monthly', billing: 'fixed', covered: 5, residual: 0, runner_up_residual: 400, proven: true },
      }),
    ])
    const result = await mountWorkspace()

    await waitFor(() => expect(result.current.feedback.toast.show).toBe(true))
    expect(result.current.feedback.toast.msg).toContain('Bankprofil för Old bank fastställd')
    expect(result.current.feedback.toast.msg).toContain(
      'Bankprofil för New bank fastställd: fast månadsränta. Återskapar bankens 5 senaste debiteringar inom 0 kr.',
    )
    await waitFor(() => expect(result.current.state.banks[1].charge_basis).toBe('monthly'))
  })

  it('says nothing and flashes no save when nothing was written', async () => {
    const result = await mountWorkspace()

    expect(Store.autoFitBankProfiles).toHaveBeenCalled()
    expect(result.current.feedback.toast).toEqual({ msg: '', show: false })
    // The "saved" pulse means "your save landed"; the owner saved nothing here.
    expect(result.current.feedback.saved).toBe(false)
    expect(result.current.state.banks).toEqual([oldBank, newBank])
  })

  it('never lets a failed profile write reach the page', async () => {
    vi.mocked(Store.autoFitBankProfiles).mockRejectedValue(new Error('offline'))
    const result = await mountWorkspace()

    expect(result.current.state.loaded).toBe(true)
    expect(result.current.state.banks).toEqual([oldBank, newBank])
    // Nothing was stored, so the owner is told nothing — not even an error.
    expect(result.current.feedback.toast).toEqual({ msg: '', show: false })
  })
})

// ── Plan 127 §3 — the sequential rate-period write ───────────────────────────
// Creating a rate period is the one workspace write that touches two rows: the
// new period, then the predecessor it supersedes. The atomic RPC was cut
// deliberately (plan 127 Fix 3), so the whole safety argument rests on step 2
// failing LOUDLY and naming the repair. These pin the order of the writes, that
// nothing is written when the draft is rejected, and that a half-completed
// transition comes back as a specific, dated instruction rather than
// "kunde inte spara".
function ratePeriod(p: Partial<RatePeriod>): RatePeriod {
  return {
    id: 'rp-prev', created_at: '2026-05-01T00:00:00Z', loan_part_id: 'part-1',
    start_date: '2026-05-01', end_date: null, rate: 3.93, rate_type: 'rörlig', ...p,
  }
}
const newRate = {
  loan_part_id: 'part-1', start_date: '2026-08-01', end_date: null,
  rate: 4.29, rate_type: 'rörlig' as const,
}

async function mountWorkspace() {
  const { result } = renderHook(() => useMortgageWorkspace())
  await waitFor(() => expect(result.current.state.loaded).toBe(true))
  return result
}

describe('useMortgageWorkspace.savePeriod — sequential create with a visible failure', () => {
  it('inserts the new period first, then closes the predecessor on the day before', async () => {
    seedReads([cloudPart], [ratePeriod({ id: 'rp-prev', end_date: null })])
    const result = await mountWorkspace()

    let outcome!: Awaited<ReturnType<typeof result.current.actions.parts.savePeriod>>
    await act(async () => { outcome = await result.current.actions.parts.savePeriod('part-1', newRate) })

    expect(outcome).toEqual({ ok: true })
    expect(Store.addRatePeriod).toHaveBeenCalledWith({
      loan_part_id: 'part-1', start_date: '2026-08-01', end_date: null, rate: 4.29, rate_type: 'rörlig',
    })
    expect(Store.updateRatePeriod).toHaveBeenCalledWith('rp-prev', { end_date: '2026-07-31' })
    // The insert must land before the close: the reverse order would leave the
    // part with no rate at all if the second write failed.
    expect(vi.mocked(Store.addRatePeriod).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(Store.updateRatePeriod).mock.invocationCallOrder[0])
    expect(result.current.feedback.toast).toEqual({ msg: 'Ny räntesats sparad.', show: true })
  })

  it('reports the exact date to set by hand when closing the predecessor fails', async () => {
    seedReads([cloudPart], [ratePeriod({ id: 'rp-prev', end_date: null })])
    vi.mocked(Store.updateRatePeriod).mockRejectedValueOnce({ message: 'Failed to fetch' })
    const result = await mountWorkspace()
    const readsBeforeSave = vi.mocked(Store.listRatePeriods).mock.calls.length

    let outcome!: Awaited<ReturnType<typeof result.current.actions.parts.savePeriod>>
    await act(async () => { outcome = await result.current.actions.parts.savePeriod('part-1', newRate) })

    expect(outcome).toEqual({
      ok: false,
      message: 'Den nya perioden sparades, men den föregående kunde inte avslutas. '
        + 'Perioderna överlappar — öppna föregående period och sätt slutdatum 2026-07-31.',
    })
    // Not the generic persistence copy: that would hide the outstanding repair.
    expect(outcome.ok === false && outcome.message).not.toBe('Ingen anslutning. Ändringen sparades inte i molnet.')
    // The new period IS persisted; only the close is missing.
    expect(Store.addRatePeriod).toHaveBeenCalledTimes(1)
    expect(result.current.feedback.toast.msg).toContain('sätt slutdatum 2026-07-31')
    // Refreshed anyway, so the page shows the overlap the owner must repair.
    expect(vi.mocked(Store.listRatePeriods).mock.calls.length).toBeGreaterThan(readsBeforeSave)
  })

  it('writes nothing further when the insert itself fails', async () => {
    seedReads([cloudPart], [ratePeriod({ id: 'rp-prev', end_date: null })])
    vi.mocked(Store.addRatePeriod).mockRejectedValueOnce({ message: 'Failed to fetch' })
    const result = await mountWorkspace()

    let outcome!: Awaited<ReturnType<typeof result.current.actions.parts.savePeriod>>
    await act(async () => { outcome = await result.current.actions.parts.savePeriod('part-1', newRate) })

    expect(outcome).toEqual({ ok: false, message: 'Ingen anslutning. Ändringen sparades inte i molnet.' })
    expect(Store.updateRatePeriod).not.toHaveBeenCalled()
  })

  it('performs exactly one write when the predecessor is already contiguous', async () => {
    seedReads([cloudPart], [ratePeriod({ id: 'rp-prev', end_date: '2026-07-31' })])
    const result = await mountWorkspace()

    let outcome!: Awaited<ReturnType<typeof result.current.actions.parts.savePeriod>>
    await act(async () => { outcome = await result.current.actions.parts.savePeriod('part-1', newRate) })

    expect(outcome).toEqual({ ok: true })
    expect(Store.addRatePeriod).toHaveBeenCalledTimes(1)
    expect(Store.updateRatePeriod).not.toHaveBeenCalled()
  })

  it('writes nothing at all when the draft leaves a gap after the predecessor', async () => {
    seedReads([cloudPart], [ratePeriod({ id: 'rp-prev', end_date: '2026-07-31' })])
    const result = await mountWorkspace()

    let outcome!: Awaited<ReturnType<typeof result.current.actions.parts.savePeriod>>
    await act(async () => {
      outcome = await result.current.actions.parts.savePeriod('part-1', { ...newRate, start_date: '2026-08-05' })
    })

    expect(outcome).toEqual({
      ok: false,
      message: 'Perioderna lämnar ett glapp. Den nya perioden måste börja 2026-08-01 '
        + 'eller så behöver den föregående perioden korrigeras.',
    })
    expect(Store.addRatePeriod).not.toHaveBeenCalled()
    expect(Store.updateRatePeriod).not.toHaveBeenCalled()
  })

  it('writes nothing at all when the draft duplicates an existing start date', async () => {
    seedReads([cloudPart], [ratePeriod({ id: 'rp-prev', start_date: '2026-08-01', end_date: null })])
    const result = await mountWorkspace()

    let outcome!: Awaited<ReturnType<typeof result.current.actions.parts.savePeriod>>
    await act(async () => { outcome = await result.current.actions.parts.savePeriod('part-1', newRate) })

    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.message).toContain('Redigera den befintliga perioden')
    expect(Store.addRatePeriod).not.toHaveBeenCalled()
    expect(Store.updateRatePeriod).not.toHaveBeenCalled()
  })

  it('writes nothing at all when the rate is missing', async () => {
    seedReads([cloudPart], [])
    const result = await mountWorkspace()

    let outcome!: Awaited<ReturnType<typeof result.current.actions.parts.savePeriod>>
    await act(async () => {
      outcome = await result.current.actions.parts.savePeriod('part-1', { ...newRate, rate: null })
    })

    expect(outcome).toEqual({ ok: false, message: 'Ange en räntesats i procent, noll eller högre.' })
    expect(Store.addRatePeriod).not.toHaveBeenCalled()
  })

  it('keeps editing on the plain update path without re-resolving neighbours', async () => {
    // The predecessor overlaps the edited row on purpose: an edit must not
    // silently close it (plan 127 §1 cut that deliberately).
    seedReads([cloudPart], [
      ratePeriod({ id: 'rp-prev', end_date: null }),
      ratePeriod({ id: 'rp-edit', start_date: '2026-08-01', end_date: null, rate: 4.29 }),
    ])
    const result = await mountWorkspace()

    let outcome!: Awaited<ReturnType<typeof result.current.actions.parts.savePeriod>>
    await act(async () => {
      outcome = await result.current.actions.parts.savePeriod('part-1', { ...newRate, rate: 4.35 }, 'rp-edit')
    })

    expect(outcome).toEqual({ ok: true })
    expect(Store.updateRatePeriod).toHaveBeenCalledTimes(1)
    expect(Store.updateRatePeriod).toHaveBeenCalledWith('rp-edit', { ...newRate, rate: 4.35 })
    expect(Store.addRatePeriod).not.toHaveBeenCalled()
    expect(result.current.feedback.toast).toEqual({ msg: 'Ränteperioden uppdaterad.', show: true })
  })

  it('rejects an edit whose villkorsändringsdag precedes its start date', async () => {
    seedReads([cloudPart], [ratePeriod({ id: 'rp-edit', start_date: '2026-08-01', end_date: null })])
    const result = await mountWorkspace()

    let outcome!: Awaited<ReturnType<typeof result.current.actions.parts.savePeriod>>
    await act(async () => {
      outcome = await result.current.actions.parts.savePeriod(
        'part-1', { ...newRate, end_date: '2026-07-01' }, 'rp-edit',
      )
    })

    expect(outcome).toEqual({ ok: false, message: 'Villkorsändringsdagen kan inte infalla före startdatumet.' })
    expect(Store.updateRatePeriod).not.toHaveBeenCalled()
  })
})
