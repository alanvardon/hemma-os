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
import { ConfirmProvider } from '../components/useConfirm'
import * as Store from '../lib/mortgage-store'
import { defaultSettings } from '../lib/mortgage'
import type { LoanPart, Mortgage, Payment, RatePeriod } from '../lib/mortgage'

vi.mock('../lib/mortgage-store')
vi.mock('../lib/hushallsbudget-store', () => ({ loadBudget: vi.fn(async () => null) }))
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
  return render(<ConfirmProvider><RouterProvider router={router} /></ConfirmProvider>)
}

function seedStore(payments: Payment[], part: LoanPart = PART, ratePeriods: RatePeriod[] = [PERIOD]) {
  vi.mocked(Store.cachedSnapshot).mockReturnValue({
    version: 1,
    banks: [], mortgages: [],
    loan_parts: [part], payments, valuations: [], rate_periods: ratePeriods, contributions: [],
    settings: defaultSettings(),
  })
  vi.mocked(Store.listLoanParts).mockResolvedValue([part])
  vi.mocked(Store.listPayments).mockResolvedValue(payments)
  vi.mocked(Store.listValuations).mockResolvedValue([])
  vi.mocked(Store.listRatePeriods).mockResolvedValue(ratePeriods)
  vi.mocked(Store.listContributions).mockResolvedValue([])
  vi.mocked(Store.getSettings).mockResolvedValue(defaultSettings())
  vi.mocked(Store.listBanks).mockResolvedValue([])
  vi.mocked(Store.listMortgages).mockResolvedValue([])
  vi.mocked(Store.listCatalogBanks).mockResolvedValue([])
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

    const logBtn = await screen.findByRole('button', { name: 'Godkänn rad' })
    expect(logBtn).toBeEnabled()
    await user.click(logBtn)

    // Interest-only part → one interest row, next month's charge date,
    // source 'predicted', balance carried forward — bank stays ground truth.
    expect(Store.addPayments).toHaveBeenCalledTimes(1)
    expect(Store.addPayments).toHaveBeenCalledWith([expect.objectContaining({
      loan_part_id: 'p1', date: '2026-07-27', kind: 'interest',
      amount: 3000, balance_after: 1_000_000, source: 'predicted',
    })])
    expect(await screen.findByText(/Rad godkänd och tillagd i Betalningar/)).toBeInTheDocument()
    // July is now covered, so the block ROLLS to August instead of going
    // quiet — there is always a next avisering. Pending rows show a MONTH,
    // not a date: the bank sets the exact day, so a date is false precision.
    await waitFor(() =>
      expect(document.querySelector('.prognos-row .col-date')?.textContent).toBe('aug 2026'))
    expect(screen.getByRole('button', { name: 'Godkänn rad' })).toBeEnabled()
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
    await screen.findAllByRole('button', { name: 'Godkänn rad' })
    const rows = document.querySelectorAll('.prognos-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('.kind-interest')?.textContent).toBe('Ränta')
    expect(rows[1].querySelector('.kind-amortization')?.textContent).toBe('Amortering')
    expect(rows[1].querySelector('button')).not.toBeNull()
    // The amortering line shows the amorteringsgrad where ränta lines show
    // the rate — a share of the loan's ORIGINAL size (amorteringskravets bas),
    // not the current balance: 3 000 × 12 / 1 000 000 = 3,60 % per year.
    expect(rows[1].querySelector('.col-rate')?.textContent).toBe('3,60 %')

    await user.click(screen.getByRole('button', { name: 'Godkänn alla rader' }))

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
    const buttons = await screen.findAllByRole('button', { name: 'Godkänn rad' })
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

    await screen.findAllByRole('button', { name: 'Godkänn rad' })
    const rows = document.querySelectorAll('.prognos-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('.kind-interest')?.textContent).toBe('Ränta')
    expect(rows[1].querySelector('.kind-payment')?.textContent).toBe('Betalning')
    // Betalning = predicted ränta + amortering; amorteringsgraden still reads
    // off the principal share: 3 000 × 12 / 1 000 000 = 3,60 %.
    expect(rows[1].querySelector('.col-rate')?.textContent).toBe('3,60 %')

    await user.click(screen.getByRole('button', { name: 'Godkänn alla rader' }))

    // Plan 126: the ränta is the LISTED 3,65 % on the current saldo —
    // 991 000 × 3.65/100 × 30/365 = 2 973,00 (was 2 981,15, priced on the
    // trailing derived 3,66 % this ledger's roundings implied).
    expect(Store.addPayments).toHaveBeenCalledTimes(1)
    expect(Store.addPayments).toHaveBeenCalledWith([
      expect.objectContaining({ kind: 'interest', date: '2026-07-27', amount: 2973, source: 'predicted', balance_after: 988_000 }),
      expect.objectContaining({ kind: 'payment', date: '2026-07-27', amount: 5973, source: 'predicted', balance_after: 988_000 }),
    ])
  })

  // Plan 126 §5 — the acceptance boundary. These two tests REPLACE the pair
  // that used to assert the banner's one-click refresh ("offers a one-click
  // refresh when logged förväntade rows drift from the current forecast" and
  // "a failed refresh surfaces the error toast and keeps the banner"). Settled
  // meaning 7 makes an approved row frozen forever, so the rewrite path — the
  // action, its store method and its failure toast — is gone; what is left must
  // be provably read-only, which is what these assert instead.
  it('reports drifting godkända prognosrader as fact, with no rewrite action', async () => {
    // Flat-monthly bank (4 061 kr every month) + two July förväntad rows
    // logged with an older model (7 565 kr). The banner names the drift and
    // stops there: reality (the bank's next import) supersedes them.
    const B = 1_350_000
    const flatRow = (date: string, kind: Payment['kind'], amount: number, over: Partial<Payment> = {}): Payment => ({
      id: kind[0] + date, created_at: '', loan_part_id: 'p1', date, kind,
      description: kind === 'interest' ? 'Ränta' : 'Betalning', amount, balance_after: B,
      paid_by: 'joint', source: 'import:bank.csv', ...over,
    })
    const ledger = [
      flatRow('2026-03-01', 'interest', 4061), flatRow('2026-04-01', 'interest', 4061),
      flatRow('2026-05-01', 'interest', 4061), flatRow('2026-06-01', 'interest', 4061),
      flatRow('2026-05-01', 'payment', 4061), flatRow('2026-06-01', 'payment', 4061),
      flatRow('2026-07-01', 'interest', 7565, { id: 'stale-i', source: 'predicted', description: 'Förväntad avi' }),
      flatRow('2026-07-01', 'payment', 7565, { id: 'stale-b', source: 'predicted', description: 'Förväntad avi' }),
    ]
    // The listed rate this flat ledger was billed at: 4 061 × 12 / 1 350 000 = 3,61 %.
    seedStore(ledger, PART, [{ ...PERIOD, rate: 3.61 }])
    renderBolanekoll()

    // The banner states a fact and names the self-healing path…
    const banner = await screen.findByText(/godkända prognosrader beräknades med en äldre modell/)
    expect(banner).toHaveTextContent('Bankens nästa import ersätter dem.')
    // …and it is informational markup, announced but not actionable.
    expect(banner).toHaveAttribute('role', 'status')
    expect(banner.querySelector('button')).toBeNull()
    expect(screen.queryByRole('button', { name: /Uppdatera godkända rader/ })).not.toBeInTheDocument()
  })

  it('never rewrites an approved prognosrad — no ledger mutation on visit or interaction', async () => {
    const B = 1_350_000
    const stale: Payment = {
      id: 'stale-i', created_at: '', loan_part_id: 'p1', date: '2026-07-01', kind: 'interest',
      description: 'Förväntad avi', amount: 7565, balance_after: B, paid_by: 'joint', source: 'predicted',
    }
    const ledger = [
      ...['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01'].map((d, i): Payment => ({
        id: 'i' + i, created_at: '', loan_part_id: 'p1', date: d, kind: 'interest',
        description: 'Ränta', amount: 4061, balance_after: B, paid_by: 'joint', source: 'import:bank.csv',
      })),
      stale,
    ]
    seedStore(ledger)
    renderBolanekoll()

    expect(await screen.findByText(/godkänd prognosrad beräknades med en äldre modell/))
      .toHaveTextContent('Bankens nästa import ersätter den.')
    // The approved row keeps the amount it was approved at — nothing in the
    // page's render path writes to it, and no control offers to.
    expect(Store.updatePayment).not.toHaveBeenCalled()
    expect(Store.addPayments).not.toHaveBeenCalled()
    expect(Store.removePayments).not.toHaveBeenCalled()
  })

  it('shows the month AFTER one already covered, without logging anything', async () => {
    seedStore([...HISTORY, PREDICTED])
    renderBolanekoll()
    // Settle on the ledger showing the predicted row's tag…
    expect((await screen.findAllByText('godkänd prognos')).length).toBeGreaterThan(0)
    // …and the block offers August (July is covered by the predicted row).
    await waitFor(() =>
      expect(document.querySelector('.prognos-row .col-date')?.textContent).toBe('aug 2026'))
    expect(screen.getByRole('button', { name: 'Godkänn rad' })).toBeEnabled()
    expect(Store.addPayments).not.toHaveBeenCalled()
  })

  it('filters the expected charges by loan part via the toggle', async () => {
    // Two parts, each with its own ränta history → two pending charges. The
    // block's loan-part toggle should narrow the list to one part.
    const part2: LoanPart = { ...PART, id: 'p2', label: 'Lånedel 2' }
    const period2: RatePeriod = { ...PERIOD, id: 'r2', loan_part_id: 'p2', rate: 4 }
    const p2Rows = HISTORY.map(r => ({ ...r, id: r.id + '-p2', loan_part_id: 'p2' }))
    vi.mocked(Store.cachedSnapshot).mockReturnValue({
      version: 1, banks: [], mortgages: [], loan_parts: [PART, part2], payments: [...HISTORY, ...p2Rows],
      valuations: [], rate_periods: [PERIOD, period2], contributions: [], settings: defaultSettings(),
    })
    vi.mocked(Store.listLoanParts).mockResolvedValue([PART, part2])
    vi.mocked(Store.listPayments).mockResolvedValue([...HISTORY, ...p2Rows])
    vi.mocked(Store.listValuations).mockResolvedValue([])
    vi.mocked(Store.listRatePeriods).mockResolvedValue([PERIOD, period2])
    vi.mocked(Store.listContributions).mockResolvedValue([])
    vi.mocked(Store.getSettings).mockResolvedValue(defaultSettings())
    vi.mocked(Store.listBanks).mockResolvedValue([])
    vi.mocked(Store.listMortgages).mockResolvedValue([])
    const user = userEvent.setup()
    renderBolanekoll()

    // Both parts show up front (All).
    await screen.findAllByRole('button', { name: 'Godkänn rad' })
    const parts = () => [...document.querySelectorAll('.prognos-row .col-part')].map(n => n.textContent)
    expect(parts()).toEqual(['Lånedel 1', 'Lånedel 2'])

    // Scope to the expected-charge toggle (the payments filter carries the same
    // labels) and pick Lånedel 2.
    const filter = screen.getByRole('radiogroup', { name: 'Filter expected charges' })
    await user.click(within(filter).getByRole('radio', { name: 'Lånedel 2' }))
    await waitFor(() => expect(parts()).toEqual(['Lånedel 2']))
  })

  it('excludes an expired part from transaction rows, totals, count, filters and approval actions', async () => {
    const part2: LoanPart = { ...PART, id: 'p2', label: 'Lånedel 2' }
    const part3: LoanPart = { ...PART, id: 'p3', label: 'Lånedel 3' }
    const p2Rows = HISTORY.map(r => ({
      ...r, id: r.id + '-p2', loan_part_id: 'p2',
      amount: r.amount * 2, balance_after: 2_000_000,
    }))
    const p3Rows = HISTORY.map(r => ({
      ...r, id: r.id + '-p3', loan_part_id: 'p3',
      amount: r.amount * 1.5, balance_after: 1_500_000,
    }))
    const allParts = [PART, part2, part3]
    const allPayments = [...HISTORY, ...p2Rows, ...p3Rows]
    const ratePeriods = [
      { ...PERIOD, end_date: '2026-07-26' },
      { ...PERIOD, id: 'r2', loan_part_id: 'p2' },
      { ...PERIOD, id: 'r3', loan_part_id: 'p3' },
    ]
    vi.mocked(Store.cachedSnapshot).mockReturnValue({
      version: 1, banks: [], mortgages: [], loan_parts: allParts, payments: allPayments,
      valuations: [], rate_periods: ratePeriods, contributions: [], settings: defaultSettings(),
    })
    vi.mocked(Store.listLoanParts).mockResolvedValue(allParts)
    vi.mocked(Store.listPayments).mockResolvedValue(allPayments)
    vi.mocked(Store.listValuations).mockResolvedValue([])
    vi.mocked(Store.listRatePeriods).mockResolvedValue(ratePeriods)
    vi.mocked(Store.listContributions).mockResolvedValue([])
    vi.mocked(Store.getSettings).mockResolvedValue(defaultSettings())
    vi.mocked(Store.listBanks).mockResolvedValue([])
    vi.mocked(Store.listMortgages).mockResolvedValue([])

    renderBolanekoll()

    const approveButtons = await screen.findAllByRole('button', { name: 'Godkänn rad' })
    expect(approveButtons).toHaveLength(2)
    const block = document.querySelector('.prognos-block') as HTMLElement
    expect(block).not.toBeNull()
    expect([...block.querySelectorAll('.prognos-row .col-part')].map(n => n.textContent))
      .toEqual(['Lånedel 2', 'Lånedel 3'])
    expect(block.querySelector('.count-pill')?.textContent).toBe('2')
    expect(block.querySelector('.metric-val')?.textContent?.replace(/\s/g, '')).toBe('~10500kr')
    expect(within(block).getByRole('button', { name: 'Godkänn alla rader' })).toBeEnabled()

    const filter = within(block).getByRole('radiogroup', { name: 'Filter expected charges' })
    expect(within(filter).queryByRole('radio', { name: 'Lånedel 1' })).not.toBeInTheDocument()
    expect(within(filter).getByRole('radio', { name: 'Lånedel 2' })).toBeInTheDocument()
    expect(within(filter).getByRole('radio', { name: 'Lånedel 3' })).toBeInTheDocument()
  })

  it('expands a read-only preview of the coming months via Visa kommande månader', async () => {
    seedStore(HISTORY)
    const user = userEvent.setup()
    renderBolanekoll()

    // Collapsed by default: only the next (loggable) month is shown.
    await screen.findByRole('button', { name: 'Godkänn rad' })
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
    expect(screen.getAllByRole('button', { name: 'Godkänn rad' })).toHaveLength(1)

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
    await screen.findAllByText('godkänd prognos') // page settled: accepted prediction visible in the ledger

    await importCsv(CSV(3010)) // drift 10 kr — inside max(50 kr, 1 %)
    // Triage announces the supersede before anything is written.
    expect(await screen.findByText(/ersätter godkänd prognosrad/)).toBeInTheDocument()
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
    const user = userEvent.setup()
    renderBolanekoll()
    await screen.findAllByText('godkänd prognos') // page settled: accepted prediction visible in the ledger

    await importCsv(CSV(3175)) // drift 175 kr — outside max(50 kr, 1 %)
    expect(await screen.findByText(/drift 175 kr/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Add 1 row/ }))

    // The drift guard is now a themed ConfirmDialog (plan 91), not native
    // confirm(): it surfaces the drift and blocks until the user decides.
    const dialog = await screen.findByRole('dialog', { name: 'Räntan avviker från prognosen' })
    await user.click(within(dialog).getByRole('button', { name: 'Behåll' }))

    // Declined → nothing written, prediction untouched.
    expect(Store.removePayments).not.toHaveBeenCalled()
    expect(Store.addPayments).not.toHaveBeenCalled()
  })

  it('shows the read-only reconcile badge when nothing was pre-logged', async () => {
    seedStore(HISTORY) // no predicted row in the ledger
    renderBolanekoll()
    await screen.findByRole('button', { name: 'Godkänn rad' })

    await importCsv(CSV(3010))
    // ✓ matched against expectedCharge, not against a predicted row — the
    // badge shows in the triage row and the summary counts it.
    expect((await screen.findAllByText(/matchar prognosen/)).length).toBeGreaterThan(0)
    expect(Store.removePayments).not.toHaveBeenCalled()
  })
})

// Plan 126 §2 — the missing-terms split, at the component level. Two distinct
// states, two distinct messages, and a part is never in both:
//
//   no rate period at all          → "Räntevillkor saknas." + Lägg till räntevillkor
//   periods exist, none covers today → "Räntevillkor saknas för idag."
//
// The second class is what the plan closes: such a part shows no Nästa
// avisering, no rate badge and sits in the catch-all group, so without this
// warning it is silently rateless with no explanation anywhere on the page.
//
// Every fixture below lapses in 2025 or is open-ended, so the assertions hold
// on any real clock from 2026 onwards rather than only on the day written.
describe('Bolånekoll — missing current rate terms (plan 126 §2)', () => {
  const AGREEMENT: Mortgage = {
    id: 'm1', created_at: '', bank_id: null, label: 'Vårt bolån', start_date: '2024-01-01', archived: false,
  }
  const p1: LoanPart = { ...PART, id: 'p1', label: 'Lånedel 1', mortgage_id: 'm1', start_balance: 1_000_000, start_date: '2024-01-01' }
  const p2: LoanPart = { ...PART, id: 'p2', label: 'Lånedel 2', mortgage_id: 'm1', start_balance: 500_000, start_date: '2024-01-01' }
  const covering = (id: string, loan_part_id: string, rate: number): RatePeriod =>
    ({ id, created_at: '', loan_part_id, start_date: '2024-01-01', end_date: null, rate, rate_type: 'rörlig' })
  const lapsed = (id: string, loan_part_id: string, rate: number): RatePeriod =>
    ({ id, created_at: '', loan_part_id, start_date: '2024-01-01', end_date: '2025-06-01', rate, rate_type: 'bunden' })

  function seedAgreement(parts: LoanPart[], ratePeriods: RatePeriod[]) {
    vi.mocked(Store.cachedSnapshot).mockReturnValue({
      version: 1, banks: [], mortgages: [AGREEMENT], loan_parts: parts, payments: [],
      valuations: [], rate_periods: ratePeriods, contributions: [], settings: defaultSettings(),
    })
    vi.mocked(Store.listLoanParts).mockResolvedValue(parts)
    vi.mocked(Store.listPayments).mockResolvedValue([])
    vi.mocked(Store.listValuations).mockResolvedValue([])
    vi.mocked(Store.listRatePeriods).mockResolvedValue(ratePeriods)
    vi.mocked(Store.listContributions).mockResolvedValue([])
    vi.mocked(Store.getSettings).mockResolvedValue(defaultSettings())
    vi.mocked(Store.listBanks).mockResolvedValue([])
    vi.mocked(Store.listMortgages).mockResolvedValue([AGREEMENT])
    vi.mocked(Store.listCatalogBanks).mockResolvedValue([])
  }

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  })

  it('names only the part whose periods no longer reach today', async () => {
    // Lånedel 1 is open-ended (covered); Lånedel 2's only period lapsed in 2025.
    seedAgreement([p1, p2], [covering('r1', 'p1', 3.5), lapsed('r2', 'p2', 4.0)])
    renderBolanekoll()

    const warning = await screen.findByText(/Räntevillkor saknas för idag/)
    const banner = warning.closest('.missing-rate-prompt') as HTMLElement
    expect(banner).not.toBeNull()
    expect(banner).toHaveTextContent('Kontrollera perioderna för Lånedel 2.')
    expect(banner).not.toHaveTextContent('Lånedel 1')
    // Announced, and the fix is reachable by keyboard — a real button, not a
    // colour-only cue.
    expect(banner).toHaveAttribute('role', 'status')
    expect(within(banner).getByRole('button', { name: 'Öppna Lånedel 2' })).toBeInTheDocument()
    // The OTHER message is for parts with nothing entered at all, so it stays
    // silent here: Lånedel 2 has villkor, they just need correcting.
    expect(screen.queryByRole('button', { name: /Lägg till räntevillkor/ })).not.toBeInTheDocument()
  })

  it('stays silent when every active part has a period covering today', async () => {
    seedAgreement([p1, p2], [covering('r1', 'p1', 3.5), covering('r2', 'p2', 4.0)])
    renderBolanekoll()

    // Both parts are loaded and grouped (rörlig, so the catch-all group)…
    const group = await screen.findByText('No reprice date set')
    expect(group.closest('tr')?.querySelector('.ld-count')?.textContent).toBe('2 parts')
    // …and neither triggers the warning.
    expect(screen.queryByText(/Räntevillkor saknas för idag/)).not.toBeInTheDocument()
  })

  it('leaves a part with no villkor at all to the Lägg till räntevillkor prompt', async () => {
    // p2 has NO rate period. The two messages must not both claim it.
    seedAgreement([p1, p2], [covering('r1', 'p1', 3.5)])
    renderBolanekoll()

    expect(await screen.findByRole('button', { name: '+ Lägg till räntevillkor: Lånedel 2' })).toBeInTheDocument()
    expect(screen.queryByText(/Räntevillkor saknas för idag/)).not.toBeInTheDocument()
  })
})
