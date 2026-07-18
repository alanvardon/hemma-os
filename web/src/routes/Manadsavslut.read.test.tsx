// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Item } from '../lib/manadsavslut'
import * as Store from '../lib/manadsavslut-store'
import Manadsavslut from './Manadsavslut'

vi.mock('../lib/manadsavslut-store')

const settings = defaultSettings()
const item = (id: string, description = 'Fiktiv mat'): Item => ({
  id,
  created_at: '2026-07-17T10:00:00.000Z',
  date_purchased: '2026-07-16',
  description,
  enter_amount: 240,
  split: true,
  amount: 120,
  fronted_by: 'a',
  owed_by: 'b',
  paid: false,
  pending: false,
  payment_id: null,
  note: '',
  personal_items: [],
  personal_a: 0,
  personal_b: 0,
  source: 'manual',
})

const cloudResult = (rows: Item[] = []): Store.MonthEndItemReadResult => ({
  rows,
  source: 'cloud',
  degraded: false,
  rejectedRowCount: 0,
  diagnostics: [],
  allCloudRowsRejected: false,
})

function renderRoute() {
  const router = createMemoryRouter([
    { path: '/manadsavslut', element: <Manadsavslut /> },
    { path: '/', element: <div>Home</div> },
  ], { initialEntries: ['/manadsavslut'] })
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(Store.cachedSnapshot).mockReturnValue({ items: [], payments: [], settings })
  vi.mocked(Store.listItemsDetailed).mockResolvedValue(cloudResult())
  vi.mocked(Store.listPayments).mockResolvedValue([])
  vi.mocked(Store.getSettings).mockResolvedValue(settings)
})

describe('Månadsavslut item read states', () => {
  it('holds back the first-run import state while the detailed read is loading', async () => {
    let resolveRead!: (result: Store.MonthEndItemReadResult) => void
    vi.mocked(Store.listItemsDetailed).mockReturnValue(new Promise((resolve) => { resolveRead = resolve }))

    renderRoute()

    expect(screen.getByText('Läser in sparade poster…')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Importera kontoutdrag/ })).not.toBeInTheDocument()

    await act(async () => { resolveRead(cloudResult()) })
    expect(await screen.findByRole('heading', { name: /Importera kontoutdrag/ })).toBeInTheDocument()
  })

  it('shows cached rows immediately and labels them degraded when cloud is unavailable', async () => {
    const cached = item('cached')
    vi.mocked(Store.cachedSnapshot).mockReturnValue({ items: [cached], payments: [], settings })
    vi.mocked(Store.listItemsDetailed).mockResolvedValue({
      rows: [cached],
      source: 'cache',
      degraded: true,
      rejectedRowCount: 0,
      diagnostics: [],
      allCloudRowsRejected: false,
    })

    renderRoute()

    expect(screen.getByText('Fiktiv mat')).toBeInTheDocument()
    expect(await screen.findByText(/Poster från den senast sparade kopian visas/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Försök igen' })).toBeInTheDocument()
  })

  it('shows all-rejected cold-cache recovery instead of the ordinary empty import flow', async () => {
    vi.mocked(Store.listItemsDetailed).mockResolvedValue({
      rows: [],
      source: 'unavailable',
      degraded: true,
      rejectedRowCount: 2,
      diagnostics: [
        { fieldPath: 'items[0]', code: 'invalid_date' },
        { fieldPath: 'items[1]', code: 'invalid_number' },
      ],
      allCloudRowsRejected: true,
    })

    renderRoute()

    expect(await screen.findByText('Sparade poster finns i molnet men kunde inte läsas säkert.')).toBeInTheDocument()
    expect(screen.getByText(/Diagnos: 2 poster avvisades · ogiltigt datum, ogiltigt tal/)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Importera kontoutdrag/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Försök igen' })).toBeInTheDocument()
  })

  it('keeps last-known-good rows visible when every cloud row is rejected', async () => {
    const cached = item('cached-after-rejection', 'Fiktiv cachepost')
    vi.mocked(Store.cachedSnapshot).mockReturnValue({ items: [cached], payments: [], settings })
    vi.mocked(Store.listItemsDetailed).mockResolvedValue({
      rows: [cached],
      source: 'cache',
      degraded: true,
      rejectedRowCount: 1,
      diagnostics: [{ fieldPath: 'items[0]', code: 'invalid_date' }],
      allCloudRowsRejected: true,
    })

    renderRoute()

    expect(screen.getByText('Fiktiv cachepost')).toBeInTheDocument()
    expect(await screen.findByText('Sparade poster finns i molnet men kunde inte läsas säkert.')).toBeInTheDocument()
    expect(screen.getByText('Den senast läsbara kopian visas tills molnposterna kan läsas igen.')).toBeInTheDocument()
  })

  it('keeps a valid sibling visible during partial salvage', async () => {
    const valid = item('valid', 'Fiktiv bussbiljett')
    vi.mocked(Store.listItemsDetailed).mockResolvedValue({
      rows: [valid],
      source: 'cloud',
      degraded: true,
      rejectedRowCount: 1,
      diagnostics: [{ fieldPath: 'items[1]', code: 'invalid_number' }],
      allCloudRowsRejected: false,
    })

    renderRoute()

    expect(await screen.findByText('Fiktiv bussbiljett')).toBeInTheDocument()
    expect(screen.getByText('En sparad post kunde inte läsas säkert. Övriga poster visas.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Importera kontoutdrag/ })).toBeInTheDocument()
  })

  it('retry replaces unavailable state with a healthy cloud result', async () => {
    const recovered = item('recovered', 'Fiktiv återställd post')
    vi.mocked(Store.listItemsDetailed)
      .mockResolvedValueOnce({
        rows: [],
        source: 'unavailable',
        degraded: true,
        rejectedRowCount: 0,
        diagnostics: [],
        allCloudRowsRejected: false,
      })
      .mockResolvedValueOnce(cloudResult([recovered]))

    const user = userEvent.setup()
    renderRoute()
    expect(await screen.findByText('Kunde inte hämta sparade poster. Försök igen för att avgöra vilka poster som finns.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Importera kontoutdrag/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Försök igen' }))

    expect(await screen.findByText('Fiktiv återställd post')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByText('Kunde inte hämta sparade poster. Försök igen för att avgöra vilka poster som finns.')).not.toBeInTheDocument()
    })
  })
})

describe('Månadsavslut item date write boundaries', () => {
  it('passes the manual date input to addItem as canonical ISO', async () => {
    vi.mocked(Store.addItem).mockResolvedValue(item('manual-saved'))
    const user = userEvent.setup()
    renderRoute()

    await screen.findByRole('heading', { name: /Importera kontoutdrag/ })
    await user.click(screen.getByRole('button', { name: '+ Add item manually' }))
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-02-01' } })
    await user.type(screen.getByLabelText('Description'), 'Fiktivt manuellt köp')
    await user.type(screen.getByLabelText('Charge — minus for a refund'), '100')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(Store.addItem).toHaveBeenCalledWith(expect.objectContaining({
        date_purchased: '2026-02-01',
        description: 'Fiktivt manuellt köp',
      }))
    })
  })

  it('previews an exact day-first CSV date as canonical ISO and persists that previewed value', async () => {
    vi.mocked(Store.addItems).mockResolvedValue([item('csv-saved')])
    const user = userEvent.setup()
    const { container } = renderRoute()

    await screen.findByRole('heading', { name: /Importera kontoutdrag/ })
    const csv = 'Date,Description,Amount\n01/02/2026,Fiktivt CSV-köp,-100\n'
    const file = new File([csv], 'statement.csv', { type: 'text/csv' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) })
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } })

    expect(await screen.findByText('2026-02-01')).toBeInTheDocument()
    expect(screen.queryByText('01/02/2026')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add 1 item' }))

    await waitFor(() => {
      expect(Store.addItems).toHaveBeenCalledWith([
        expect.objectContaining({ date_purchased: '2026-02-01', description: 'Fiktivt CSV-köp' }),
      ])
    })
  })

  it('marks an unsupported CSV date invalid and prevents it from being added', async () => {
    const { container } = renderRoute()

    await screen.findByRole('heading', { name: /Importera kontoutdrag/ })
    const csv = 'Date,Description,Amount\n2026/02/01,Fiktivt ogiltigt köp,-100\n'
    const file = new File([csv], 'unsupported-date.csv', { type: 'text/csv' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) })
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } })

    expect(await screen.findByText('Ogiltigt datum')).toBeInTheDocument()
    expect(screen.getByText('invalid date')).toBeInTheDocument()
    expect(screen.getByText(/1 with an invalid date/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Nothing to add' })).toBeDisabled()
    expect(Store.addItems).not.toHaveBeenCalled()
  })
})
