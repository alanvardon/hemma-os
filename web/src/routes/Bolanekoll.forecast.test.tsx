// @vitest-environment jsdom
// Plan 23 — expected next charge, component-level: confirm-to-log writes a
// source:'predicted' row through the store, and a real CSV import supersedes
// it (silently within tolerance, blocked on drift until the user confirms).
// The mock boundary is mortgage-store, matching Bolanekoll.test.tsx — the pure
// forecast math itself is pinned in lib/mortgage-forecast.test.ts.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Bolanekoll from './Bolanekoll'
import * as Store from '../lib/mortgage-store'
import { defaultSettings } from '../lib/mortgage'
import type { LoanPart, Payment, RatePeriod } from '../lib/mortgage'

vi.mock('../lib/mortgage-store')
// NumberFlow's getSnapshotBeforeUpdate needs browser layout APIs jsdom lacks —
// with a seeded ledger the dashboard renders Money/Percent everywhere, so swap
// them for plain spans (these tests assert flows, not number animation).
vi.mock('../components/AnimatedNumber', () => ({
  Money: ({ value }: { value: number }) => <span>{Math.round(value)}</span>,
  Percent: ({ value }: { value: number }) => <span>{value}</span>,
  Num: ({ value }: { value: number }) => <span>{value}</span>,
  MoneyCompact: ({ value }: { value: number }) => <span>{Math.round(value)}</span>,
}))

const PART: LoanPart = {
  id: 'p1', created_at: '', label: 'Lånedel 1', loan_number: '',
  start_balance: 0, start_date: '2026-01-01', archived: false,
}
const PERIOD: RatePeriod = {
  id: 'r1', created_at: '', loan_part_id: 'p1',
  start_date: '2026-01-01', end_date: null, rate: 3.65, rate_type: 'rörlig',
}
// Clean 3.65 % history on the 27th (charge = 100 kr × days, balance 1 000 000 kr
// flat) — forecasts next charge 2026-07-27, 30 days, exactly 3 000 kr.
function interestRow(date: string, amount: number, over: Partial<Payment> = {}): Payment {
  return {
    id: 'i' + date, created_at: '', loan_part_id: 'p1', date, kind: 'interest',
    description: 'Ränta', amount, balance_after: 1_000_000, paid_by: 'joint', source: 'import:bank.csv', ...over,
  }
}
const HISTORY = [
  interestRow('2026-03-27', 3100), interestRow('2026-04-27', 3100),
  interestRow('2026-05-27', 3000), interestRow('2026-06-27', 3100),
]
const PREDICTED: Payment = {
  id: 'pred1', created_at: '', loan_part_id: 'p1', date: '2026-07-27', kind: 'interest',
  description: 'Förväntad avi', amount: 3000, balance_after: 1_000_000, paid_by: 'joint', source: 'predicted',
}

function renderBolanekoll() {
  const router = createMemoryRouter([{ path: '/', element: <Bolanekoll /> }], { initialEntries: ['/'] })
  return render(<RouterProvider router={router} />)
}

function seedStore(payments: Payment[]) {
  vi.mocked(Store.cachedSnapshot).mockReturnValue({
    version: 1,
    loan_parts: [PART], payments, valuations: [], rate_periods: [PERIOD], contributions: [],
    settings: defaultSettings(),
  })
  vi.mocked(Store.listLoanParts).mockResolvedValue([PART])
  vi.mocked(Store.listPayments).mockResolvedValue(payments)
  vi.mocked(Store.listValuations).mockResolvedValue([])
  vi.mocked(Store.listRatePeriods).mockResolvedValue([PERIOD])
  vi.mocked(Store.listContributions).mockResolvedValue([])
  vi.mocked(Store.getSettings).mockResolvedValue(defaultSettings())
}

// Route a CSV through the hidden dropzone input. jsdom's File may lack .text(),
// which loadFile() awaits — pin it on the instance either way.
async function importCsv(csv: string) {
  const file = new File([csv], 'bank.csv', { type: 'text/csv' })
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) })
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  expect(input).not.toBeNull()
  fireEvent.change(input, { target: { files: [file] } })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Bolånekoll forecast — confirm-to-log (plan 23 phase C)', () => {
  it('logs the expected charge as a predicted row and then disables the button', async () => {
    seedStore(HISTORY)
    // Echo the logged rows back through the store so the post-save refresh()
    // sees them — that flips the button to its logged/disabled state.
    vi.mocked(Store.addPayments).mockImplementation(async (records) => {
      const saved = records.map((r, i) => ({ ...r, id: 'new' + i, created_at: '' } as Payment))
      vi.mocked(Store.listPayments).mockResolvedValue([...HISTORY, ...saved])
      return saved
    })
    const user = userEvent.setup()
    renderBolanekoll()

    const logBtn = await screen.findByRole('button', { name: 'Logga förväntad avi' })
    expect(logBtn).toBeEnabled()
    await user.click(logBtn)

    // One interest row, next month's charge date, source 'predicted',
    // balance carried forward — bank stays ground truth.
    expect(Store.addPayments).toHaveBeenCalledTimes(1)
    expect(Store.addPayments).toHaveBeenCalledWith([expect.objectContaining({
      loan_part_id: 'p1', date: '2026-07-27', kind: 'interest',
      amount: 3000, balance_after: 1_000_000, source: 'predicted',
    })])
    expect(await screen.findByText(/Förväntad avi loggad/)).toBeInTheDocument()
    // Double-log guard: the row for the month now exists, so the button locks.
    expect(await screen.findByRole('button', { name: 'Loggad' })).toBeDisabled()
  })

  it('never double-logs when an interest row already covers the month', async () => {
    seedStore([...HISTORY, PREDICTED])
    renderBolanekoll()
    expect(await screen.findByRole('button', { name: 'Loggad' })).toBeDisabled()
    expect(Store.addPayments).not.toHaveBeenCalled()
  })
})

describe('Bolånekoll forecast — import supersede (plan 23 phase C)', () => {
  const CSV = (amount: number) =>
    'Datum;Specifikation;Belopp;Saldo\n2026-07-27;Ränta;' + amount + ';1000000\n'

  it('silently replaces the predicted row when the import matches within tolerance', async () => {
    seedStore([...HISTORY, PREDICTED])
    vi.mocked(Store.addPayments).mockImplementation(async (records) =>
      records.map((r, i) => ({ ...r, id: 'new' + i, created_at: '' } as Payment)))
    const user = userEvent.setup()
    renderBolanekoll()
    await screen.findByRole('button', { name: 'Loggad' }) // page settled

    await importCsv(CSV(3010)) // drift 10 kr — inside max(50 kr, 1 %)
    // Triage announces the supersede before anything is written.
    expect(await screen.findByText(/ersätter förväntad avi/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Add 1 row/ }))

    await waitFor(() => expect(Store.addPayments).toHaveBeenCalledTimes(1))
    // The predicted placeholder goes, the actual (source import:…) stays.
    expect(Store.removePayments).toHaveBeenCalledWith(['pred1'])
    expect(Store.addPayments).toHaveBeenCalledWith([expect.objectContaining({
      loan_part_id: 'p1', date: '2026-07-27', kind: 'interest', amount: 3010,
      source: 'import:bank.csv',
    })])
    expect(await screen.findByText(/replaced 1 predicted row/)).toBeInTheDocument()
  })

  it('blocks the import on drift outside tolerance until the user confirms', async () => {
    seedStore([...HISTORY, PREDICTED])
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const user = userEvent.setup()
    renderBolanekoll()
    await screen.findByRole('button', { name: 'Loggad' })

    await importCsv(CSV(3175)) // drift 175 kr — outside max(50 kr, 1 %)
    expect(await screen.findByText(/drift 175 kr/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Add 1 row/ }))

    // Declined → nothing written, prediction untouched.
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy.mock.calls[0][0]).toMatch(/avviker från prognosen/)
    expect(Store.removePayments).not.toHaveBeenCalled()
    expect(Store.addPayments).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('shows the read-only reconcile badge when nothing was pre-logged', async () => {
    seedStore(HISTORY) // no predicted row in the ledger
    renderBolanekoll()
    await screen.findByRole('button', { name: 'Logga förväntad avi' })

    await importCsv(CSV(3010))
    // ✓ matched against expectedCharge, not against a predicted row — the
    // badge shows in the triage row and the summary counts it.
    expect((await screen.findAllByText(/matchar prognosen/)).length).toBeGreaterThan(0)
    expect(Store.removePayments).not.toHaveBeenCalled()
  })
})
