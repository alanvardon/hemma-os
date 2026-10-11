// @vitest-environment jsdom
// Plan 129: Bolånekoll's payment import must tell the owner what happened to a
// dropped file (rejected, unreadable, or read from which sheet/row), and a
// saved column preset must apply to an .xlsx exactly as it does to the CSV.
// The real reader (lib/tabular.ts) runs; only the store is mocked.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Bolanekoll from './Bolanekoll'
import { ConfirmProvider } from '../components/useConfirm'
import * as Store from '../lib/mortgage-store'
import { autoMapColumns, defaultSettings, headerSignature, parseCsv } from '../lib/mortgage'
import type { Bank, LoanPart, Mortgage, RatePeriod } from '../lib/mortgage'
import { readTabular } from '../lib/tabular'

vi.mock('../lib/mortgage-store')
vi.mock('../lib/hushallsbudget-store', () => ({ loadBudget: vi.fn(async () => null) }))
vi.mock('@number-flow/react', () => ({ default: ({ value }: { value: number }) => <span>{value}</span> }))
vi.mock('../lib/riksbank', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/riksbank')>(),
  fetchPolicyRate: vi.fn().mockRejectedValue(new Error('no network in tests')),
}))

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const FIXTURES = resolve(__dirname, '../lib/__fixtures__')

// Same content as statement-clean.xlsx (see tabular.test.ts CLEAN_CSV).
const CLEAN_CSV = [
  'Datum;Beskrivning;Belopp',
  '2026-01-05;ICA Maxi;1234.5',
  '2026-01-12; Pressbyrån ;0',
  '',
  '2026-01-31;Återbetalning SJ;-250',
  '2026-02-01;Hyrbil;1234.565',
].join('\r\n')

// See Manadsavslut.import.test.tsx: copy bytes into this realm's ArrayBuffer.
function fileFromBytes(bytes: Uint8Array, name: string, type: string): File {
  const ab = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(ab).set(bytes)
  const file = new File([ab], name, { type })
  Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.resolve(ab) })
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(new TextDecoder().decode(bytes)) })
  return file
}
const fixture = (name: string) => fileFromBytes(readFileSync(resolve(FIXTURES, name)), name, XLSX_MIME)
const csvFile = (name: string) => fileFromBytes(new TextEncoder().encode(CLEAN_CSV), name, 'text/csv')

const bank: Bank = { id: 'b1', created_at: '2026-01-01', label: 'Danske', year_basis: null, year_basis_source: null, billing: null, billing_source: null, catalog_id: null }
const agreement: Mortgage = { id: 'm1', created_at: '2026-01-01', bank_id: 'b1', label: 'Vårt bolån', start_date: '2024-03-01', archived: false, end_date: null }
const part: LoanPart = {
  id: 'p1', created_at: '2026-01-01', label: 'Rörlig del', loan_number: '9021',
  start_balance: 1_000_000, original_balance: 1_000_000, start_date: '2024-03-01', archived: false, mortgage_id: 'm1',
}
const covering: RatePeriod = { id: 'r1', created_at: '2026-01-01', loan_part_id: 'p1', start_date: '2024-03-01', end_date: null, rate: 3.5, rate_type: 'rörlig' }

function seedStore(settings = defaultSettings()) {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
  vi.mocked(Store.cachedSnapshot).mockReturnValue({
    version: 6, banks: [bank], mortgages: [agreement], loan_parts: [part], payments: [], valuations: [], rate_periods: [covering], contributions: [], settings,
  })
  vi.mocked(Store.listLoanParts).mockResolvedValue([part])
  vi.mocked(Store.listPayments).mockResolvedValue([])
  vi.mocked(Store.listValuations).mockResolvedValue([])
  vi.mocked(Store.listRatePeriods).mockResolvedValue([covering])
  vi.mocked(Store.listContributions).mockResolvedValue([])
  vi.mocked(Store.getSettings).mockResolvedValue(settings)
  vi.mocked(Store.listBanks).mockResolvedValue([bank])
  vi.mocked(Store.listMortgages).mockResolvedValue([agreement])
  vi.mocked(Store.listCatalogBanks).mockResolvedValue([])
}

function renderBolanekoll() {
  const router = createMemoryRouter([{ path: '/', element: <Bolanekoll /> }], { initialEntries: ['/'] })
  return render(<ConfirmProvider><RouterProvider router={router} /></ConfirmProvider>)
}

async function drop(container: HTMLElement, files: File[]) {
  await screen.findByRole('heading', { name: /Importera betalningar/ })
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files } })
}

const XLS_TOAST = '.xls stöds inte. Öppna filen i Excel och spara om den som .xlsx eller .csv.'

beforeEach(() => {
  vi.clearAllMocks()
  seedStore()
})

describe('Bolånekoll payment import — formats', () => {
  it('advertises .xlsx on the dropzone input', async () => {
    const { container } = renderBolanekoll()
    await screen.findByRole('heading', { name: /Importera betalningar/ })
    expect(container.querySelector('input[type="file"]')!.getAttribute('accept')).toContain('.xlsx')
  })

  it('toasts instead of silently ignoring a file that is neither .csv nor .xlsx', async () => {
    const { container } = renderBolanekoll()
    await drop(container, [fileFromBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46]), 'utdrag.pdf', 'application/pdf')])

    expect(await screen.findByText('Bara .csv och .xlsx kan importeras.')).toBeInTheDocument()
    expect(container.querySelector('.import-config')).not.toBeInTheDocument()
  })

  it('rejects a lone legacy .xls with the specific Swedish toast', async () => {
    const { container } = renderBolanekoll()
    await drop(container, [fileFromBytes(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), 'lan.xls', 'application/vnd.ms-excel')])

    expect(await screen.findByText(XLS_TOAST)).toBeInTheDocument()
    expect(container.querySelector('.import-config')).not.toBeInTheDocument()
    expect(container.querySelector('.dropzone')).toBeInTheDocument()
  })

  it('shows "Kunde inte läsa filen" for a corrupt .xlsx and opens no config panel', async () => {
    const { container } = renderBolanekoll()
    await drop(container, [fileFromBytes(new TextEncoder().encode('inte en zip-fil'), 'trasig.xlsx', XLSX_MIME)])

    expect(await screen.findByText(/^Kunde inte läsa filen/)).toBeInTheDocument()
    expect(container.querySelector('.import-config')).not.toBeInTheDocument()
    expect(container.querySelector('.dropzone')).toBeInTheDocument()
  })

  it('opens the import config for an .xlsx with columns mapped and a sheet-aware file pill', async () => {
    const { container } = renderBolanekoll()
    await drop(container, [fixture('statement-preamble.xlsx')])

    await waitFor(() => expect(container.querySelector('.import-config')).toBeInTheDocument())
    expect(container.querySelector('.file-pill')!.textContent).toBe('statement-preamble.xlsx · 4 rows · Kontoutdrag · rubrik på rad 4')
    expect(screen.getByLabelText('Date column')).toHaveDisplayValue('Bokföringsdatum')
    expect(screen.getByLabelText('Type column (Specifikation)')).toHaveDisplayValue('Text')
    expect(screen.getByLabelText('Amount column (Belopp)')).toHaveDisplayValue('Belopp')
    expect(screen.queryByLabelText('Vilket blad?')).not.toBeInTheDocument()
  })

  it('offers a sheet picker for a two-sheet book and re-reads on Blad2', async () => {
    const { container } = renderBolanekoll()
    await drop(container, [fixture('statement-two-sheets.xlsx')])

    const picker = await screen.findByLabelText('Vilket blad?')
    expect(within(picker).getAllByRole('option').map(o => o.textContent)).toEqual(['Blad1', 'Blad2'])
    expect(container.querySelector('.file-pill')!.textContent).toBe('statement-two-sheets.xlsx · 2 rows · Blad1')

    fireEvent.change(picker, { target: { value: 'Blad2' } })
    await waitFor(() => expect(container.querySelector('.file-pill')!.textContent).toBe('statement-two-sheets.xlsx · 1 rows · Blad2'))
    expect(screen.getByLabelText('Vilket blad?')).toHaveDisplayValue('Blad2')
  })

  it('still reads a CSV as before: delimiter pill, and the queue of further files is kept', async () => {
    const { container } = renderBolanekoll()
    await drop(container, [csvFile('lan.csv'), csvFile('lan2.csv')])

    await waitFor(() => expect(container.querySelector('.import-config')).toBeInTheDocument())
    expect(container.querySelector('.file-pill')!.textContent).toBe('lan.csv · 4 rows · “;” delimited')
    expect(container.querySelector('.queue-info')!.textContent).toBe('+1 file queued')
  })
})

describe('Bolånekoll payment import — saved column presets', () => {
  const opts = {
    parseCsvText: (t: string) => parseCsv(t),
    scoreHeaderRow: (h: string[]) => Object.values(autoMapColumns(h)).filter(v => v != null).length,
  }

  it('keys a preset on the same header signature for the .xlsx and its CSV equivalent', async () => {
    const csv = await readTabular(csvFile('lan.csv'), opts)
    const xlsx = await readTabular(fixture('statement-clean.xlsx'), opts)
    expect(xlsx.headers).toEqual(csv.headers)
    expect(headerSignature(xlsx.headers)).toBe(headerSignature(csv.headers))
  })

  it('applies a preset saved for the CSV headers when the equivalent .xlsx is dropped', async () => {
    // Deliberately differs from autoMapColumns (which picks Beskrivning for the
    // type): the preset maps the type column to Belopp.
    const settings = defaultSettings()
    settings.import_presets = {
      [headerSignature(['Datum', 'Beskrivning', 'Belopp'])]: { date: 'Datum', specification: 'Belopp', amount: 'Belopp', balance: null, loan_number: null },
    }
    seedStore(settings)
    const { container } = renderBolanekoll()
    await drop(container, [fixture('statement-clean.xlsx')])

    await waitFor(() => expect(container.querySelector('.import-config')).toBeInTheDocument())
    expect(screen.getByLabelText('Type column (Specifikation)')).toHaveDisplayValue('Belopp')
  })
})
