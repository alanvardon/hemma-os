// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import StudentLoan from './StudentLoan'
import * as Store from '../lib/studentloan-store'
import { computeStudentLoan, defaultStudentLoanInputs, type StudentLoanInputs } from '../lib/studentloan'

vi.mock('../lib/studentloan-store')
vi.mock('../App', () => ({ useTheme: () => ({ theme: 'light' }) }))
vi.mock('../lib/toolTransition', () => ({ useToolPageActive: () => false }))
vi.mock('../components/AnimatedNumber', () => ({
  Money: ({ value, currencySuffix = '' }: { value: number, currencySuffix?: string }) => <span>{`£${Math.round(value)}${currencySuffix}`}</span>,
  Num: ({ value }: { value: number }) => <span>{value}</span>,
}))
vi.mock('../components/charts/ExpandableChartCard', () => ({ default: ({ preview, children }: { preview: React.ReactNode, children: React.ReactNode }) => <section>{preview}{children}</section> }))
vi.mock('../components/charts/ChartLegend', () => ({ default: () => null }))
vi.mock('../components/charts/StudentLoanChart', () => ({ default: () => <div data-testid="student-loan-chart" /> }))
vi.mock('../components/Collapse', () => ({ default: ({ open, children }: { open: boolean, children: React.ReactNode }) => open ? <>{children}</> : null }))
vi.mock('../components/PageHeader', () => ({ default: ({ title, saveVisible, actions }: { title: string, saveVisible: boolean, actions: React.ReactNode }) => <header><h1>{title}</h1>{saveVisible && <span>Saved</span>}{actions}</header> }))
vi.mock('../components/ThemeToggle', () => ({ default: () => null }))
vi.mock('../components/useSaveFlash', () => ({ useSaveFlash: () => ({ saveVisible: false, flashSaved: vi.fn() }) }))
vi.mock('../lib/persistence-error', () => ({ reportPersistenceError: vi.fn() }))
vi.mock('motion/react', () => ({ motion: { span: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }, useReducedMotion: () => false }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const savedInputs: StudentLoanInputs = {
  balance_gbp: 12_345,
  interest_rate: 4.25,
  rate_stress: 1.5,
  first_due_year: 2011,
  current_year: 2026,
  income_sek: 654_321,
  fx_sek_per_gbp: 12.34,
  salary_growth_pct: 3.5,
  se_threshold_gbp: 31_234,
  hold_threshold_flat: true,
  opportunity_rate_pct: 5.25,
  slc_monthly_gbp: 456,
}

function openAdvanced(user: ReturnType<typeof userEvent.setup>) {
  return user.click(screen.getByRole('button', { name: /Advanced/i }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(Store.save).mockResolvedValue()
})

describe('StudentLoan hydration', () => {
  it('keeps fields blank and disabled while a delayed read is unresolved, then shows every saved value and matching figures without a write', async () => {
    const load = deferred<StudentLoanInputs | null>()
    vi.mocked(Store.load).mockReturnValue(load.promise)
    const user = userEvent.setup()
    render(<StudentLoan />)

    expect(screen.getByLabelText('Current balance')).toHaveValue('')
    expect(screen.getByLabelText('Current balance')).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Loading saved loan…')

    await act(async () => { load.resolve(savedInputs) })

    expect(screen.getByLabelText('Current balance')).toHaveValue('12 345')
    expect(screen.getByLabelText('First due (April)')).toHaveValue('2011')
    expect(screen.getByLabelText('Base interest rate')).toHaveValue('4,25')
    expect(screen.getByLabelText('Gross income')).toHaveValue('654 321')
    expect(screen.getByLabelText('FX rate')).toHaveValue('12,34')
    expect(screen.getByLabelText('Salary growth')).toHaveValue('3,5')
    expect(screen.getByLabelText('Threshold')).toHaveValue('31 234')
    expect(screen.getByLabelText('Interest rate stress')).toHaveValue('1.5')
    expect(screen.getByLabelText('Hold Sweden threshold flat instead of growing with salary')).toBeChecked()
    await openAdvanced(user)
    expect(screen.getByLabelText('Opportunity rate')).toHaveValue('5,25')
    expect(screen.getByLabelText('SLC letter monthly (optional)')).toHaveValue('456')

    const result = computeStudentLoan(savedInputs)
    expect(document.querySelector('.hero-card')).toHaveTextContent(`£${Math.round(result.savings_gbp)}`)
    expect(Store.save).not.toHaveBeenCalled()
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
  })

  it('shows defaults only after a null load resolves and does not save them', async () => {
    const load = deferred<StudentLoanInputs | null>()
    vi.mocked(Store.load).mockReturnValue(load.promise)
    render(<StudentLoan />)

    expect(screen.getByLabelText('Current balance')).toHaveValue('')
    await act(async () => { load.resolve(null) })

    expect(screen.getByLabelText('Current balance')).toHaveValue('20 000')
    expect(screen.getByLabelText('Current balance')).not.toBeDisabled()
    expect(Store.save).not.toHaveBeenCalled()
  })

  it('keeps incomplete decimal text while editing and formats the committed value on blur', async () => {
    vi.mocked(Store.load).mockResolvedValue(null)
    const user = userEvent.setup()
    render(<StudentLoan />)
    const input = await screen.findByLabelText('Base interest rate')
    await waitFor(() => expect(input).not.toBeDisabled())

    await user.clear(input)
    await user.type(input, '3.')
    expect(input).toHaveValue('3.')
    await user.tab()
    expect(input).toHaveValue('3')
  })

  it('hydrates both the empty and populated optional SLC repayment states', async () => {
    vi.mocked(Store.load).mockResolvedValue({ ...savedInputs, slc_monthly_gbp: undefined })
    const user = userEvent.setup()
    const { unmount } = render(<StudentLoan />)
    await screen.findByDisplayValue('12 345')
    await openAdvanced(user)
    expect(screen.getByLabelText('SLC letter monthly (optional)')).toHaveValue('')
    unmount()

    vi.mocked(Store.load).mockResolvedValue({ ...savedInputs, slc_monthly_gbp: 456 })
    render(<StudentLoan />)
    await screen.findByDisplayValue('12 345')
    await openAdvanced(user)
    expect(screen.getByLabelText('SLC letter monthly (optional)')).toHaveValue('456')
  })

  it('resets every visible field and saves exactly once through the existing path', async () => {
    vi.mocked(Store.load).mockResolvedValue(savedInputs)
    const user = userEvent.setup()
    render(<StudentLoan />)
    await screen.findByDisplayValue('12 345')
    await user.click(screen.getByRole('button', { name: 'Reset' }))

    expect(screen.getByLabelText('Current balance')).toHaveValue('20 000')
    expect(screen.getByLabelText('Base interest rate')).toHaveValue('3,2')
    expect(Store.save).toHaveBeenCalledTimes(1)
    expect(Store.save).toHaveBeenCalledWith(defaultStudentLoanInputs())
  })

  it('does not update after a rejected late load once unmounted', async () => {
    const load = deferred<StudentLoanInputs | null>()
    vi.mocked(Store.load).mockReturnValue(load.promise)
    const { unmount } = render(<StudentLoan />)
    unmount()

    await act(async () => { load.reject(new Error('read failed')) })
    await waitFor(() => expect(Store.save).not.toHaveBeenCalled())
  })
})
