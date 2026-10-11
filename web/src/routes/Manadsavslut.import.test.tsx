// @vitest-environment jsdom
// Plan 129: the statement import surface must tell the owner what happened to
// a dropped file — rejected, unreadable, or read (and from which sheet/row).
// The real reader (lib/tabular.ts) and its lazy read-excel-file import run
// here; only the store is mocked.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type Item } from '../lib/manadsavslut'
import * as Store from '../lib/manadsavslut-store'
import Manadsavslut from './Manadsavslut'

vi.mock('../lib/manadsavslut-store')

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const FIXTURES = resolve(__dirname, '../lib/__fixtures__')
const settings = defaultSettings()

const cloudResult = (rows: Item[] = []): Store.MonthEndItemReadResult => ({
  rows, source: 'cloud', degraded: false, rejectedRowCount: 0, diagnostics: [], allCloudRowsRejected: false,
})

// jsdom's Blob may not implement arrayBuffer()/text(), and a Node Buffer's
// backing store comes from another realm, failing read-excel-file's
// `instanceof ArrayBuffer`. Copy the bytes into an ArrayBuffer of the test's
// own realm (what a browser's File.arrayBuffer() returns).
function fileFromBytes(bytes: Uint8Array, name: string, type: string): File {
  const ab = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(ab).set(bytes)
  const file = new File([ab], name, { type })
  Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.resolve(ab) })
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(new TextDecoder().decode(bytes)) })
  return file
}
const fixture = (name: string) => fileFromBytes(readFileSync(resolve(FIXTURES, name)), name, XLSX_MIME)

function renderRoute() {
  const router = createMemoryRouter([
    { path: '/manadsavslut', element: <Manadsavslut /> },
    { path: '/', element: <div>Home</div> },
  ], { initialEntries: ['/manadsavslut'] })
  return render(<RouterProvider router={router} />)
}

async function drop(container: HTMLElement, file: File) {
  await screen.findByRole('heading', { name: /Importera kontoutdrag/ })
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } })
}

const triageTable = () => document.querySelector('table.triage-table') as HTMLTableElement | null
const triageDescriptions = () =>
  Array.from(triageTable()!.querySelectorAll('tbody td.col-desc')).map(td => td.firstChild?.textContent ?? '')

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(Store.cachedSnapshot).mockReturnValue({ items: [], payments: [], settings })
  vi.mocked(Store.listItemsDetailed).mockResolvedValue(cloudResult())
  vi.mocked(Store.listPayments).mockResolvedValue([])
  vi.mocked(Store.getSettings).mockResolvedValue(settings)
})

describe('Månadsavslut statement import — formats', () => {
  it('advertises .xlsx on the dropzone input', async () => {
    const { container } = renderRoute()
    await screen.findByRole('heading', { name: /Importera kontoutdrag/ })
    expect(container.querySelector('input[type="file"]')!.getAttribute('accept')).toContain('.xlsx')
  })

  it('rejects a legacy .xls with the Swedish toast and keeps the dropzone', async () => {
    const { container } = renderRoute()
    await drop(container, fileFromBytes(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), 'kontoutdrag.xls', 'application/vnd.ms-excel'))

    expect(await screen.findByText('.xls stöds inte. Öppna filen i Excel och spara om den som .xlsx eller .csv.')).toBeInTheDocument()
    expect(container.querySelector('.dropzone')).toBeInTheDocument()
    expect(container.querySelector('.import-config')).not.toBeInTheDocument()
  })

  it('shows "Kunde inte läsa filen" for a corrupt .xlsx and opens no config panel', async () => {
    const { container } = renderRoute()
    await drop(container, fileFromBytes(new TextEncoder().encode('inte en zip-fil'), 'trasig.xlsx', XLSX_MIME))

    expect(await screen.findByText(/^Kunde inte läsa filen/)).toBeInTheDocument()
    expect(container.querySelector('.import-config')).not.toBeInTheDocument()
    expect(triageTable()).toBeNull()
    expect(container.querySelector('.dropzone')).toBeInTheDocument()
  })

  it('reads an .xlsx with preamble rows: maps columns, triages rows and says which row the header was on', async () => {
    vi.mocked(Store.addItems).mockResolvedValue([])
    const user = userEvent.setup()
    const { container } = renderRoute()
    await drop(container, fixture('statement-preamble.xlsx'))

    expect(await screen.findByText(/rubrik på rad 4/)).toBeInTheDocument()
    expect(container.querySelector('.file-pill')!.textContent).toBe('statement-preamble.xlsx · 4 rows · Kontoutdrag · rubrik på rad 4')
    expect(screen.getByLabelText('Date column')).toHaveDisplayValue('Bokföringsdatum')
    expect(screen.getByLabelText('Description column')).toHaveDisplayValue('Text')
    expect(screen.getByLabelText('Amount column')).toHaveDisplayValue('Belopp')
    // Single-sheet book: no picker.
    expect(screen.queryByLabelText('Vilket blad?')).not.toBeInTheDocument()

    expect(triageDescriptions()).toEqual(['Nyårsmiddag', 'Taxi Stockholm', 'Apotek Hjärtat', 'Biltvätt'])
    const dates = Array.from(triageTable()!.querySelectorAll('tbody td.col-date')).map(td => td.textContent)
    expect(dates).toEqual(['2025-12-31', '2026-01-01', '2026-02-28', '2026-03-01'])

    await user.click(screen.getByRole('button', { name: /^Add \d+ items?$/ }))
    await waitFor(() => expect(Store.addItems).toHaveBeenCalled())
    const drafts = vi.mocked(Store.addItems).mock.calls[0][0]
    expect(drafts.map(d => d.source)).toEqual(Array(drafts.length).fill('import:statement-preamble.xlsx (Kontoutdrag)'))
    expect(drafts.find(d => d.description === 'Nyårsmiddag')).toMatchObject({ date_purchased: '2025-12-31', enter_amount: 899 })
  })

  it('offers a sheet picker for a two-sheet book and re-derives rows when switching to Blad2', async () => {
    const user = userEvent.setup()
    const { container } = renderRoute()
    await drop(container, fixture('statement-two-sheets.xlsx'))

    const picker = await screen.findByLabelText('Vilket blad?')
    expect(picker).toHaveDisplayValue('Blad1')
    expect(within(picker).getAllByRole('option').map(o => o.textContent)).toEqual(['Blad1', 'Blad2'])
    expect(triageDescriptions()).toEqual(['Blad1 Coop', 'Blad1 Systembolaget'])
    expect(container.querySelector('.file-pill')!.textContent).toBe('statement-two-sheets.xlsx · 2 rows · Blad1')

    await user.selectOptions(picker, 'Blad2')

    await waitFor(() => expect(triageDescriptions()).toEqual(['Blad2 Hemköp']))
    expect(screen.getByLabelText('Vilket blad?')).toHaveDisplayValue('Blad2')
    expect(container.querySelector('.file-pill')!.textContent).toBe('statement-two-sheets.xlsx · 1 rows · Blad2')
  })

  it('still imports a CSV exactly as before: delimiter pill and unchanged provenance', async () => {
    vi.mocked(Store.addItems).mockResolvedValue([])
    const user = userEvent.setup()
    const { container } = renderRoute()
    const csv = 'Datum;Beskrivning;Belopp\n2026-03-04;Fiktiv CSV-butik;-123,45\n'
    await drop(container, fileFromBytes(new TextEncoder().encode(csv), 'kontoutdrag.csv', 'text/csv'))

    expect(await screen.findByText('Fiktiv CSV-butik')).toBeInTheDocument()
    expect(container.querySelector('.file-pill')!.textContent).toBe('kontoutdrag.csv · 1 rows · “;” delimited')
    expect(screen.queryByLabelText('Vilket blad?')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add 1 item' }))
    await waitFor(() => expect(Store.addItems).toHaveBeenCalledWith([
      expect.objectContaining({ date_purchased: '2026-03-04', description: 'Fiktiv CSV-butik', enter_amount: 123.45, source: 'import:kontoutdrag.csv' }),
    ]))
  })
})
