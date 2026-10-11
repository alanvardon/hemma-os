import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  IMPORT_ACCEPT, UnsupportedFileError, cellToString, detectHeaderRow, isImportableFile, readTabular,
  type ReadOptions,
} from './tabular'
import * as manadsavslut from './manadsavslut'
import * as mortgage from './mortgage'

// Gate: this suite must pass under TZ=Pacific/Auckland and
// TZ=America/Los_Angeles as well as the default — Excel dates are calendar
// days, and a local-time getter shifts them silently in one direction or the
// other.

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const FIXTURES = resolve(__dirname, '__fixtures__')

function fixtureFile(name: string, type = XLSX_MIME): File {
  return new File([readFileSync(resolve(FIXTURES, name))], name, { type })
}

// The scorers the routes will use (plan 129 Design): count of columns the
// tool's own autoMapColumns recognises.
const scoreManadsavslut = (headers: string[]) => {
  const m = manadsavslut.autoMapColumns(headers)
  return [m.date_purchased, m.description, m.enter_amount].filter(v => v != null).length
}
const scoreBolanekoll = (headers: string[]) => {
  const m = mortgage.autoMapColumns(headers)
  return [m.date, m.specification, m.amount, m.balance, m.loan_number].filter(v => v != null).length
}

const manadsavslutOpts: ReadOptions = {
  parseCsvText: text => manadsavslut.parseCsv(text),
  scoreHeaderRow: scoreManadsavslut,
}

// Same content as __fixtures__/statement-clean.xlsx, the way a bank's CSV
// export of the same statement would hold it (blank line included).
const CLEAN_CSV = [
  'Datum;Beskrivning;Belopp',
  '2026-01-05;ICA Maxi;1234.5',
  '2026-01-12; Pressbyrån ;0',
  '',
  '2026-01-31;Återbetalning SJ;-250',
  '2026-02-01;Hyrbil;1234.565',
].join('\r\n')

describe('cellToString', () => {
  it('formats Date cells as YYYY-MM-DD from the UTC calendar day', () => {
    expect(cellToString(new Date(Date.UTC(2026, 0, 5)))).toBe('2026-01-05')
    expect(cellToString(new Date(Date.UTC(2025, 11, 31)))).toBe('2025-12-31')
    expect(cellToString(new Date(Date.UTC(2026, 0, 1)))).toBe('2026-01-01')
    expect(cellToString(new Date(Date.UTC(2028, 1, 29)))).toBe('2028-02-29')
    expect(cellToString(new Date(Date.UTC(2026, 2, 1)))).toBe('2026-03-01')
  })

  it('emits plain JS number strings, never locale-formatted', () => {
    expect(cellToString(1234.5)).toBe('1234.5')
    expect(cellToString(1234.5)).not.toBe('1 234,5')
    expect(cellToString(2_450_000)).toBe('2450000')
    expect(cellToString(-45.75)).toBe('-45.75')
  })

  it('keeps zero as "0", not blank', () => {
    expect(cellToString(0)).toBe('0')
  })

  it('maps empty and non-finite cells to ""', () => {
    expect(cellToString(null)).toBe('')
    expect(cellToString(undefined)).toBe('')
    expect(cellToString(Number.NaN)).toBe('')
    expect(cellToString(Number.POSITIVE_INFINITY)).toBe('')
    expect(cellToString(new Date(Number.NaN))).toBe('')
  })

  it('maps booleans to TRUE/FALSE', () => {
    expect(cellToString(true)).toBe('TRUE')
    expect(cellToString(false)).toBe('FALSE')
  })

  it('passes strings through untouched, surrounding spaces included', () => {
    expect(cellToString('  ICA Maxi ')).toBe('  ICA Maxi ')
    expect(cellToString('1 234,50')).toBe('1 234,50')
    expect(cellToString('')).toBe('')
  })

  it('round-trips numeric amount cells through both parseAmount implementations exactly', () => {
    for (const n of [1234.565, 2_450_000, 1234.5, -45.75, 0, 0.01]) {
      expect(manadsavslut.parseAmount(cellToString(n))).toBe(n)
      expect(mortgage.parseAmount(cellToString(n))).toBe(n)
    }
  })
})

describe('detectHeaderRow', () => {
  // Scores a row by how many cells start with "h" — a stand-in for a tool's
  // column patterns.
  const score = (row: string[]) => row.filter(c => c.startsWith('h')).length
  const data = ['1', '2', '3']

  it('skips preamble rows to the best-scoring header', () => {
    const m = [['Titel', '', ''], ['Konto 1', '', ''], ['', '', ''], ['h1', 'h2', 'h3'], data]
    expect(detectHeaderRow(m, score)).toBe(3)
  })

  it('keeps the earliest row on a tie', () => {
    const m = [['x', '', ''], ['h1', 'h2', 'x'], data, ['h1', 'h2', 'x'], data]
    expect(detectHeaderRow(m, score)).toBe(1)
  })

  it('returns 0 for an unrecognisable sheet rather than guessing', () => {
    const m = [['x', 'y', 'z'], ['h1', 'x', 'y'], data, data]
    expect(detectHeaderRow(m, score)).toBe(0)
    expect(detectHeaderRow([], score)).toBe(0)
  })

  it('scans at most 15 rows', () => {
    const header = ['h1', 'h2', 'h3']
    const filler = (n: number) => Array.from({ length: n }, () => ['x', 'y', 'z'])
    expect(detectHeaderRow([...filler(14), header], score)).toBe(14)
    expect(detectHeaderRow([...filler(15), header], score)).toBe(0)
  })

  it('finds the real header with the tools’ own scorers', () => {
    const m = [['Kontoutdrag kreditkort', '', ''], ['', '', ''], ['Bokföringsdatum', 'Text', 'Belopp'], ['2026-01-05', 'ICA', '10']]
    expect(detectHeaderRow(m, scoreManadsavslut)).toBe(2)
    expect(detectHeaderRow(m, scoreBolanekoll)).toBe(2)
  })
})

describe('isImportableFile / IMPORT_ACCEPT', () => {
  it('accepts csv and xlsx by name or MIME type', () => {
    expect(isImportableFile(new File([''], 'a.csv'))).toBe(true)
    expect(isImportableFile(new File([''], 'A.XLSX'))).toBe(true)
    expect(isImportableFile(new File([''], 'blob', { type: XLSX_MIME }))).toBe(true)
    expect(isImportableFile(new File([''], 'blob', { type: 'text/csv' }))).toBe(true)
    expect(isImportableFile(new File([''], 'a.pdf', { type: 'application/pdf' }))).toBe(false)
    expect(isImportableFile(new File([''], 'a.xls', { type: 'application/vnd.ms-excel' }))).toBe(false)
  })

  it('lists both extensions and the xlsx MIME type', () => {
    expect(IMPORT_ACCEPT.split(',')).toEqual(expect.arrayContaining(['.csv', '.xlsx', 'text/csv', XLSX_MIME]))
  })
})

describe('readTabular — CSV', () => {
  it('delegates to parseCsvText and reports header row 0, no sheets', async () => {
    const parseCsvText = vi.fn((text: string) => manadsavslut.parseCsv(text))
    const scoreHeaderRow = vi.fn(scoreManadsavslut)
    const res = await readTabular(new File([CLEAN_CSV], 'kontoutdrag.csv', { type: 'text/csv' }), { parseCsvText, scoreHeaderRow })
    expect(parseCsvText).toHaveBeenCalledWith(CLEAN_CSV)
    expect(scoreHeaderRow).not.toHaveBeenCalled()
    expect(res).toEqual({ ...manadsavslut.parseCsv(CLEAN_CSV), format: 'csv', sheet: null, sheets: [], headerRow: 0 })
    expect(res.delimiter).toBe(';')
  })
})

describe('readTabular — rejected files', () => {
  it('throws UnsupportedFileError(xls) for .xls without reading the file', async () => {
    const file = new File(['whatever'], 'Kontoutdrag.XLS', { type: 'application/vnd.ms-excel' })
    const text = vi.spyOn(file, 'text').mockRejectedValue(new Error('must not read'))
    const buf = vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('must not read'))
    const err = await readTabular(file, manadsavslutOpts).catch(e => e)
    expect(err).toBeInstanceOf(UnsupportedFileError)
    expect(err.reason).toBe('xls')
    expect(err.message).toBe('.xls stöds inte. Öppna filen i Excel och spara om den som .xlsx eller .csv.')
    expect(text).not.toHaveBeenCalled()
    expect(buf).not.toHaveBeenCalled()
  })

  it('throws UnsupportedFileError(unknown) for a corrupt .xlsx', async () => {
    const err = await readTabular(new File(['not a zip'], 'trasig.xlsx', { type: XLSX_MIME }), manadsavslutOpts).catch(e => e)
    expect(err).toBeInstanceOf(UnsupportedFileError)
    expect(err.reason).toBe('unknown')
    expect(err.message).toMatch(/^Kunde inte läsa filen/)
  })

  it('throws UnsupportedFileError(unknown) for a truncated .xlsx', async () => {
    const bytes = readFileSync(resolve(FIXTURES, 'statement-clean.xlsx'))
    const err = await readTabular(new File([bytes.subarray(0, 600)], 'kort.xlsx'), manadsavslutOpts).catch(e => e)
    expect(err).toBeInstanceOf(UnsupportedFileError)
    expect(err.reason).toBe('unknown')
  })
})

describe('readTabular — xlsx fixtures', () => {
  it('reads a clean single-sheet statement with header on row 0 and blank rows dropped', async () => {
    const res = await readTabular(fixtureFile('statement-clean.xlsx'), manadsavslutOpts)
    expect(res).toEqual({
      format: 'xlsx', delimiter: '', sheet: 'Blad1', sheets: ['Blad1'], headerRow: 0,
      headers: ['Datum', 'Beskrivning', 'Belopp'],
      rows: [
        ['2026-01-05', 'ICA Maxi', '1234.5'],
        ['2026-01-12', ' Pressbyrån ', '0'],
        ['2026-01-31', 'Återbetalning SJ', '-250'],
        ['2026-02-01', 'Hyrbil', '1234.565'],
      ],
    })
  })

  it('is detected as xlsx by extension alone, without a MIME type', async () => {
    const res = await readTabular(fixtureFile('statement-clean.xlsx', ''), manadsavslutOpts)
    expect(res.format).toBe('xlsx')
    expect(res.rows).toHaveLength(4)
  })

  it('produces the same headers, rows and mapping as the equivalent CSV', async () => {
    const csv = await readTabular(new File([CLEAN_CSV], 'kontoutdrag.csv', { type: 'text/csv' }), manadsavslutOpts)
    const xlsx = await readTabular(fixtureFile('statement-clean.xlsx'), manadsavslutOpts)
    expect(xlsx.headers).toEqual(csv.headers)
    expect(xlsx.rows).toEqual(csv.rows)
    expect(manadsavslut.autoMapColumns(xlsx.headers)).toEqual(manadsavslut.autoMapColumns(csv.headers))
    expect(manadsavslut.autoMapColumns(xlsx.headers)).toEqual({ date_purchased: 0, description: 1, enter_amount: 2 })
    expect(xlsx.rows.map(r => manadsavslut.parseAmount(r[2]))).toEqual(csv.rows.map(r => manadsavslut.parseAmount(r[2])))
  })

  it('skips a bank preamble, keeps real date cells as calendar dates, and parses amounts exactly', async () => {
    const res = await readTabular(fixtureFile('statement-preamble.xlsx'), manadsavslutOpts)
    expect(res.sheet).toBe('Kontoutdrag')
    expect(res.sheets).toEqual(['Kontoutdrag'])
    expect(res.headerRow).toBe(3)
    expect(res.headers).toEqual(['Bokföringsdatum', 'Text', 'Belopp'])
    expect(res.rows).toEqual([
      ['2025-12-31', 'Nyårsmiddag', '899'],
      ['2026-01-01', 'Taxi Stockholm', '312.4'],
      ['2026-02-28', 'Apotek Hjärtat', '2450000'],
      ['2026-03-01', 'Biltvätt', '-45.75'],
    ])
    expect(manadsavslut.autoMapColumns(res.headers)).toEqual({ date_purchased: 0, description: 1, enter_amount: 2 })
    expect(res.rows.map(r => manadsavslut.parseAmount(r[2]))).toEqual([899, 312.4, 2_450_000, -45.75])
  })

  it('finds the same preamble header with the Bolånekoll scorer', async () => {
    const res = await readTabular(fixtureFile('statement-preamble.xlsx'), {
      parseCsvText: text => mortgage.parseCsv(text), scoreHeaderRow: scoreBolanekoll,
    })
    expect(res.headerRow).toBe(3)
  })

  it('falls back to row 0 when no row scores as a header', async () => {
    const res = await readTabular(fixtureFile('statement-preamble.xlsx'), { ...manadsavslutOpts, scoreHeaderRow: () => 0 })
    expect(res.headerRow).toBe(0)
    expect(res.headers).toEqual(['Kontoutdrag kreditkort', '', ''])
    // Blank rows are still dropped below the fallback header.
    expect(res.rows).toHaveLength(6)
  })

  it('lists every sheet, defaults to the first, and reads a named sheet on request', async () => {
    const first = await readTabular(fixtureFile('statement-two-sheets.xlsx'), manadsavslutOpts)
    expect(first.sheets).toEqual(['Blad1', 'Blad2'])
    expect(first.sheet).toBe('Blad1')
    expect(first.rows).toEqual([
      ['2026-04-02', 'Blad1 Coop', '101'],
      ['2026-04-03', 'Blad1 Systembolaget', '102'],
    ])

    const second = await readTabular(fixtureFile('statement-two-sheets.xlsx'), { ...manadsavslutOpts, sheet: 'Blad2' })
    expect(second.sheets).toEqual(['Blad1', 'Blad2'])
    expect(second.sheet).toBe('Blad2')
    expect(second.headers).toEqual(['Datum', 'Beskrivning', 'Belopp'])
    expect(second.rows).toEqual([['2026-05-02', 'Blad2 Hemköp', '201']])
  })
})
