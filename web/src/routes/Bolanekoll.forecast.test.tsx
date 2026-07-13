// @vitest-environment jsdom
// Plan 23 — expected next charge, component-level: confirm-to-log writes a
// source:'predicted' row through the store, and a real CSV import supersedes
// it (silently within tolerance, blocked on drift until the user confirms).
// The mock boundary is mortgage-store, matching Bolanekoll.test.tsx — the pure
// forecast math itself is pinned in lib/mortgage-forecast.test.ts.
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Bolanekoll from './Bolanekoll'
import * as Store from '../lib/mortgage-store'
import { defaultSettings } from '../lib/mortgage'
import type { LoanPart, Payment, RatePeriod } from '../lib/mortgage'

vi.mock('../lib/mortgage-store')
// The Riksbank strip fetches via the local Supabase Edge Function — with the
// local stack running, live data reaches the test and renders a visx chart
// jsdom can't host (no ResizeObserver). Reject the fetch so the strip stays
// quietly absent and the test is deterministic with or without local services.
vi.mock('../lib/riksbank', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/riksbank')>(),
  fetchPolicyRate: vi.fn().mockRejectedValue(new Error('no network in tests')),
}))
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

function seedStore(payments: Payment[], part: LoanPart = PART) {
  vi.mocked(Store.cachedSnapshot).mockReturnValue({
    version: 1,
    loan_parts: [part], payments, valuations: [], rate_periods: [PERIOD], contributions: [],
    settings: defaultSettings(),
  })
  vi.mocked(Store.listLoanParts).mockResolvedValue([part])
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
  it('logs the expected charge as a predicted row; the block rolls to the next month', async () => {
    seedStore(HISTORY)
    // Echo the logged rows back through the store so the post-save refresh()
    // sees them — that advances the Nästa avisering block to the month after.
    vi.mocked(Store.addPayments).mockImplementation(async (records) => {
      const saved = records.map((r, i) => ({ ...r, id: 'new' + i, created_at: '' } as Payment))
      vi.mocked(Store.listPayments).mockResolvedValue([...HISTORY, ...saved])
      return saved
    })
    const user = userEvent.setup()
    renderBolanekoll()

    const logBtn = await screen.findByRole('button', { name: 'Logga förväntad rad' })
    expect(logBtn).toBeEnabled()
    await user.click(logBtn)

    // Interest-only part → one interest row, next month's charge date,
    // source 'predicted', balance carried forward — bank stays ground truth.
    expect(Store.addPayments).toHaveBeenCalledTimes(1)
    expect(Store.addPayments).toHaveBeenCalledWith([expect.objectContaining({
      loan_part_id: 'p1', date: '2026-07-27', kind: 'interest',
      amount: 3000, balance_after: 1_000_000, source: 'predicted',
    })])
    expect(await screen.findByText(/Förväntad rad loggad/)).toBeInTheDocument()
    // July is now covered, so the block ROLLS to August instead of going
    // quiet — there is always a next avisering. Pending rows show a MONTH,
    // not a date: the bank sets the exact day, so a date is false precision.
    await waitFor(() =>
      expect(document.querySelector('.prognos-row .col-date')?.textContent).toBe('aug 2026'))
    expect(screen.getByRole('button', { name: 'Logga förväntad rad' })).toBeEnabled()
  })

  it('renders ränta and amortering as separate line items and logs both via Logga alla', async () => {
    // Saldo steps down 3 000 kr/month → the amortering is its own pending
    // line item, and both rows carry the post-charge saldo (988 000 kr).
    const amortizing = [
      interestRow('2026-03-27', 3100, { balance_after: 1_000_000 }),
      interestRow('2026-04-27', 3100, { balance_after: 997_000 }),
      interestRow('2026-05-27', 3000, { balance_after: 994_000 }),
      interestRow('2026-06-27', 3100, { balance_after: 991_000 }),
    ]
    // Anchor the part where the history starts so the balance timeline has no
    // leading zero-months (start_balance 0 would zero out the observed drop).
    seedStore(amortizing, { ...PART, start_date: '2026-03-01', start_balance: 1_000_000 })
    vi.mocked(Store.addPayments).mockImplementation(async (records) =>
      records.map((r, i) => ({ ...r, id: 'new' + i, created_at: '' } as Payment)))
    const user = userEvent.setup()
    renderBolanekoll()

    // Ränta and amortering are SEPARATE line items, each with its own kind
    // chip and its own log button.
    await screen.findAllByRole('button', { name: 'Logga förväntad rad' })
    const rows = document.querySelectorAll('.prognos-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('.kind-interest')?.textContent).toBe('Ränta')
    expect(rows[1].querySelector('.kind-amortization')?.textContent).toBe('Amortering')
    expect(rows[1].querySelector('button')).not.toBeNull()
    // The amortering line shows the amorteringsgrad where ränta lines show
    // the rate — a share of the loan's ORIGINAL size (amorteringskravets bas),
    // not the current balance: 3 000 × 12 / 1 000 000 = 3,60 % per year.
    expect(rows[1].querySelector('.col-rate')?.textContent).toBe('3,60 %')

    await user.click(screen.getByRole('button', { name: 'Logga alla förväntade rader' }))

    expect(Store.addPayments).toHaveBeenCalledTimes(1)
    expect(Store.addPayments).toHaveBeenCalledWith([
      expect.objectContaining({ kind: 'interest', date: '2026-07-27', source: 'predicted', balance_after: 988_000 }),
      expect.objectContaining({ kind: 'amortization', date: '2026-07-27', source: 'predicted', amount: 3000, balance_after: 988_000 }),
    ])
  })

  it('logging a single line leaves the other line pending', async () => {
    const amortizing = [
      interestRow('2026-03-27', 3100, { balance_after: 1_000_000 }),
      interestRow('2026-04-27', 3100, { balance_after: 997_000 }),
      interestRow('2026-05-27', 3000, { balance_after: 994_000 }),
      interestRow('2026-06-27', 3100, { balance_after: 991_000 }),
    ]
    seedStore(amortizing, { ...PART, start_date: '2026-03-01', start_balance: 1_000_000 })
    vi.mocked(Store.addPayments).mockImplementation(async (records) => {
      const saved = records.map((r, i) => ({ ...r, id: 'new' + i, created_at: '' } as Payment))
      vi.mocked(Store.listPayments).mockResolvedValue([...amortizing, ...saved])
      return saved
    })
    const user = userEvent.setup()
    renderBolanekoll()

    // Click the ränta line's own button — only the interest row is written…
    const buttons = await screen.findAllByRole('button', { name: 'Logga förväntad rad' })
    await user.click(buttons[0])
    expect(Store.addPayments).toHaveBeenCalledWith([expect.objectContaining({ kind: 'interest' })])
    expect(vi.mocked(Store.addPayments).mock.calls[0][0]).toHaveLength(1)

    // …and the amortering line item stays pending for the SAME month (the
    // block must not roll past a half-logged month).
    await waitFor(() => {
      const rows = document.querySelectorAll('.prognos-row')
      expect(rows).toHaveLength(1)
      expect(rows[0].querySelector('.kind-amortization')?.textContent).toBe('Amortering')
    })
    expect(document.querySelector('.prognos-row .col-date')?.textContent).toBe('juli 2026')
  })

  it('bank shape: renders a Ränta and a Betalning (total) row per part and logs the pair', async () => {
    // The bank reports per part a Ränta row and a Betalning row that is the
    // TOTAL debited (ränta included): betalning − ränta = 3 000 amortering,
    // saldo stepping down accordingly. Nästa avisering mirrors that shape —
    // the Betalning line carries the full debit, not the bare amortering.
    const betalningRow = (date: string, amount: number, balance: number): Payment => ({
      id: 'b' + date, created_at: '', loan_part_id: 'p1', date, kind: 'payment',
      description: 'Betalning', amount, balance_after: balance, paid_by: 'joint', source: 'import:bank.csv',
    })
    const paired = [
      interestRow('2026-03-27', 3100, { balance_after: 1_000_000 }),
      interestRow('2026-04-27', 3100, { balance_after: 997_000 }),
      interestRow('2026-05-27', 3000, { balance_after: 994_000 }),
      interestRow('2026-06-27', 3100, { balance_after: 991_000 }),
      betalningRow('2026-04-27', 6100, 997_000),
      betalningRow('2026-05-27', 6000, 994_000),
      betalningRow('2026-06-27', 6100, 991_000),
    ]
    seedStore(paired, { ...PART, start_date: '2026-03-01', start_balance: 1_000_000 })
    vi.mocked(Store.addPayments).mockImplementation(async (records) =>
      records.map((r, i) => ({ ...r, id: 'new' + i, created_at: '' } as Payment)))
    const user = userEvent.setup()
    renderBolanekoll()

    await screen.findAllByRole('button', { name: 'Logga förväntad rad' })
    const rows = document.querySelectorAll('.prognos-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('.kind-interest')?.textContent).toBe('Ränta')
    expect(rows[1].querySelector('.kind-payment')?.textContent).toBe('Betalning')
    // Betalning = predicted ränta + amortering; amorteringsgraden still reads
    // off the principal share: 3 000 × 12 / 1 000 000 = 3,60 %.
    expect(rows[1].querySelector('.col-rate')?.textContent).toBe('3,60 %')

    await user.click(screen.getByRole('button', { name: 'Logga alla förväntade rader' }))

    expect(Store.addPayments).toHaveBeenCalledTimes(1)
    expect(Store.addPayments).toHaveBeenCalledWith([
      expect.objectContaining({ kind: 'interest', date: '2026-07-27', amount: 2981.15, source: 'predicted', balance_after: 988_000 }),
      expect.objectContaining({ kind: 'payment', date: '2026-07-27', amount: 5981.15, source: 'predicted', balance_after: 988_000 }),
    ])
  })

  it('shows the month AFTER one already covered, without logging anything', async () => {
    seedStore([...HISTORY, PREDICTED])
    renderBolanekoll()
    // Settle on the ledger showing the predicted row's tag…
    expect((await screen.findAllByText('förväntad')).length).toBeGreaterThan(0)
    // …and the block offers August (July is covered by the predicted row).
    await waitFor(() =>
      expect(document.querySelector('.prognos-row .col-date')?.textContent).toBe('aug 2026'))
    expect(screen.getByRole('button', { name: 'Logga förväntad rad' })).toBeEnabled()
    expect(Store.addPayments).not.toHaveBeenCalled()
  })

  it('filters the expected charges by loan part via the toggle', async () => {
    // Two parts, each with its own ränta history → two pending charges. The
    // block's loan-part toggle should narrow the list to one part.
    const part2: LoanPart = { ...PART, id: 'p2', label: 'Lånedel 2' }
    const period2: RatePeriod = { ...PERIOD, id: 'r2', loan_part_id: 'p2', rate: 4 }
    const p2Rows = HISTORY.map(r => ({ ...r, id: r.id + '-p2', loan_part_id: 'p2' }))
    vi.mocked(Store.cachedSnapshot).mockReturnValue({
      version: 1, loan_parts: [PART, part2], payments: [...HISTORY, ...p2Rows],
      valuations: [], rate_periods: [PERIOD, period2], contributions: [], settings: defaultSettings(),
    })
    vi.mocked(Store.listLoanParts).mockResolvedValue([PART, part2])
    vi.mocked(Store.listPayments).mockResolvedValue([...HISTORY, ...p2Rows])
    vi.mocked(Store.listValuations).mockResolvedValue([])
    vi.mocked(Store.listRatePeriods).mockResolvedValue([PERIOD, period2])
    vi.mocked(Store.listContributions).mockResolvedValue([])
    vi.mocked(Store.getSettings).mockResolvedValue(defaultSettings())
    const user = userEvent.setup()
    renderBolanekoll()

    // Both parts show up front (All).
    await screen.findAllByRole('button', { name: 'Logga förväntad rad' })
    const parts = () => [...document.querySelectorAll('.prognos-row .col-part')].map(n => n.textContent)
    expect(parts()).toEqual(['Lånedel 1', 'Lånedel 2'])

    // Scope to the expected-charge toggle (the payments filter carries the same
    // labels) and pick Lånedel 2.
    const filter = screen.getByRole('radiogroup', { name: 'Filter expected charges' })
    await user.click(within(filter).getByRole('radio', { name: 'Lånedel 2' }))
    await waitFor(() => expect(parts()).toEqual(['Lånedel 2']))
  })

  it('expands a read-only preview of the coming months via Visa kommande månader', async () => {
    seedStore(HISTORY)
    const user = userEvent.setup()
    renderBolanekoll()

    // Collapsed by default: only the next (loggable) month is shown.
    await screen.findByRole('button', { name: 'Logga förväntad rad' })
    expect(document.querySelectorAll('.prognos-row')).toHaveLength(1)

    const toggle = screen.getByRole('button', { name: /Visa kommande månader/ })
    await user.click(toggle)

    // 12-month horizon on a monthly interest-only part → 11 future rows after
    // the pending July one, month labels only, and NO log buttons — only the
    // next month is due.
    const future = document.querySelectorAll('.prognos-row.is-future')
    expect(future).toHaveLength(11)
    expect(future[0].querySelector('.col-date')?.textContent).toBe('aug 2026')
    expect(future[0].querySelector('button')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Logga förväntad rad' })).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Dölj kommande månader' }))
    expect(document.querySelectorAll('.prognos-row.is-future')).toHaveLength(0)
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
    await screen.findAllByText('förväntad') // page settled: predicted row visible in the ledger

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
    await screen.findAllByText('förväntad') // page settled: predicted row visible in the ledger

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
    await screen.findByRole('button', { name: 'Logga förväntad rad' })

    await importCsv(CSV(3010))
    // ✓ matched against expectedCharge, not against a predicted row — the
    // badge shows in the triage row and the summary counts it.
    expect((await screen.findAllByText(/matchar prognosen/)).length).toBeGreaterThan(0)
    expect(Store.removePayments).not.toHaveBeenCalled()
  })
})
