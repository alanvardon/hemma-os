// Generates the .xlsx fixtures in this directory that src/lib/tabular.test.ts
// reads (plan 129).
//
// The fixtures are committed binaries; this script exists so they stay
// reproducible instead of being hand-zipped OOXML nobody can regenerate. It
// depends on `write-excel-file`, which is deliberately NOT a permanent
// dependency. To re-run, from web/:
//
//   npm i -D write-excel-file
//   node src/lib/__fixtures__/make-xlsx-fixtures.mjs
//   npm un -D write-excel-file      # keep it out of package.json/lock
//
// All data is fictional. Headers are ones Månadsavslut's autoMapColumns
// (src/lib/manadsavslut.ts) recognises. Date cells are written as real Excel
// dates (numeric serial + a date numFmt), because that is what a bank export
// contains and it is the case a reader is most likely to get wrong.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import writeExcelFile from 'write-excel-file/node'

const outDir = dirname(fileURLToPath(import.meta.url))

// Calendar dates are built on the UTC epoch so the written serial does not
// depend on the machine's timezone.
const day = (y, m, d) => ({ value: new Date(Date.UTC(y, m - 1, d)), type: Date, format: 'yyyy-mm-dd' })
const amount = v => ({ value: v, type: Number, format: '#,##0.00' })
const blankRow = [null, null, null]

// 1. Clean single sheet: header on row 0, one blank row between data rows.
//    tabular.test.ts holds a CSV with the same content (CLEAN_CSV) and asserts
//    both formats produce identical headers, rows and mapping.
const clean = [
  ['Datum', 'Beskrivning', 'Belopp'],
  [day(2026, 1, 5), 'ICA Maxi', amount(1234.5)],
  [day(2026, 1, 12), ' Pressbyrån ', amount(0)],
  blankRow,
  [day(2026, 1, 31), 'Återbetalning SJ', amount(-250)],
  [day(2026, 2, 1), 'Hyrbil', amount(1234.565)],
]

// 2. Bank-style preamble: title, card number, blank line, then the header on
//    sheet row index 3 ("rubrik på rad 4"). Dates straddle a year boundary and
//    month ends.
const preamble = [
  ['Kontoutdrag kreditkort', null, null],
  ['Kortnummer **** 4242', null, null],
  blankRow,
  ['Bokföringsdatum', 'Text', 'Belopp'],
  [day(2025, 12, 31), 'Nyårsmiddag', amount(899)],
  [day(2026, 1, 1), 'Taxi Stockholm', amount(312.4)],
  [day(2026, 2, 28), 'Apotek Hjärtat', amount(2450000)],
  blankRow,
  [day(2026, 3, 1), 'Biltvätt', amount(-45.75)],
]

// 3. Two sheets with distinguishable data.
const blad1 = [
  ['Datum', 'Beskrivning', 'Belopp'],
  [day(2026, 4, 2), 'Blad1 Coop', amount(101)],
  [day(2026, 4, 3), 'Blad1 Systembolaget', amount(102)],
]
const blad2 = [
  ['Datum', 'Beskrivning', 'Belopp'],
  [day(2026, 5, 2), 'Blad2 Hemköp', amount(201)],
]

await writeExcelFile([{ sheet: 'Blad1', data: clean }]).toFile(resolve(outDir, 'statement-clean.xlsx'))
await writeExcelFile([{ sheet: 'Kontoutdrag', data: preamble }]).toFile(resolve(outDir, 'statement-preamble.xlsx'))
await writeExcelFile([
  { sheet: 'Blad1', data: blad1 },
  { sheet: 'Blad2', data: blad2 },
]).toFile(resolve(outDir, 'statement-two-sheets.xlsx'))

console.log('Wrote fixtures to', outDir)
