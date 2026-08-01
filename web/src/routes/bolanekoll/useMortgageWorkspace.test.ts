// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Bank, type LoanPart, type Mortgage } from '../../lib/mortgage'
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

function seedReads(parts: LoanPart[] | Promise<LoanPart[]> = [cloudPart]) {
  vi.mocked(Store.cachedSnapshot).mockReturnValue({
    version: 6,
    banks: [oldBank, newBank],
    mortgages: [activeMortgage],
    loan_parts: [cachedPart],
    payments: [],
    valuations: [],
    rate_periods: [],
    contributions: [],
    settings: defaultSettings(),
  })
  vi.mocked(Store.listLoanParts).mockImplementation(() => Promise.resolve(parts))
  vi.mocked(Store.listPayments).mockResolvedValue([])
  vi.mocked(Store.listValuations).mockResolvedValue([])
  vi.mocked(Store.listRatePeriods).mockResolvedValue([])
  vi.mocked(Store.listContributions).mockResolvedValue([])
  vi.mocked(Store.getSettings).mockResolvedValue(defaultSettings())
  vi.mocked(Store.listBanks).mockResolvedValue([oldBank, newBank])
  vi.mocked(Store.listMortgages).mockResolvedValue([activeMortgage])
  vi.mocked(Store.listCatalogBanks).mockResolvedValue([])
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
