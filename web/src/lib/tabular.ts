// tabular.ts — the single entry point every statement import goes through
// (plan 129). CSV keeps its existing byte-for-byte behaviour; .xlsx is unzipped
// and flattened to the SAME string matrix, so every downstream consumer
// (autoMapColumns, deriveTriage, buildTriage, headerSignature, parseAmount) is
// untouched and cannot tell the two formats apart.

/** Structurally assignable to both tools' `CsvResult`, so `deriveTriage` and
 *  `buildTriage` need no signature change. */
export interface TabularResult {
  format: 'csv' | 'xlsx'
  /** CSV only; '' for xlsx (there is no delimiter in a spreadsheet). */
  delimiter: string
  headers: string[]
  rows: string[][]
  /** xlsx only: the sheet these rows came from, and every sheet in the book. */
  sheet: string | null
  sheets: string[]
  /** 0-based index of the header row within the sheet. Always 0 for CSV. */
  headerRow: number
}

export class UnsupportedFileError extends Error {
  readonly reason: 'xls' | 'unknown'
  constructor(reason: 'xls' | 'unknown', message: string) {
    super(message)
    this.reason = reason
    this.name = 'UnsupportedFileError'
  }
}

export interface ReadOptions {
  /** The tool's own CSV parser, passed in so this module never duplicates it. */
  parseCsvText: (text: string) => { delimiter: string; headers: string[]; rows: string[][] }
  /** How well a candidate row reads as a header, per the tool's own column
   *  patterns (e.g. the number of columns its autoMapColumns recognises).
   *  Higher wins. */
  scoreHeaderRow: (headers: string[]) => number
  /** Re-read a multi-sheet workbook on a named sheet. */
  sheet?: string
}

/** A cell as read-excel-file returns it (plus `undefined` for ragged rows). */
export type CellInput = string | number | boolean | Date | null | undefined

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** What the two dropzones will accept. Exported so the `accept` attribute and
 *  Bolånekoll's multi-file filter can never drift apart. */
export const IMPORT_ACCEPT = `.csv,.xlsx,text/csv,text/plain,${XLSX_MIME}`

export function isImportableFile(f: File): boolean {
  const n = f.name.toLowerCase()
  return n.endsWith('.csv') || n.endsWith('.xlsx') ||
    f.type === XLSX_MIME || f.type.includes('csv') || f.type.includes('text')
}

export async function readTabular(file: File, opts: ReadOptions): Promise<TabularResult> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.xls')) {
    throw new UnsupportedFileError('xls',
      '.xls stöds inte. Öppna filen i Excel och spara om den som .xlsx eller .csv.')
  }
  if (name.endsWith('.xlsx') || file.type === XLSX_MIME) return readXlsx(file, opts)

  // CSV: unchanged from what the routes did inline before this module existed.
  const parsed = opts.parseCsvText(await file.text())
  return {
    format: 'csv', delimiter: parsed.delimiter, headers: parsed.headers,
    rows: parsed.rows, sheet: null, sheets: [], headerRow: 0,
  }
}

async function readXlsx(file: File, opts: ReadOptions): Promise<TabularResult> {
  // Lazy: the parser is the single biggest thing either import surface pulls in,
  // and the other tools never touch it. A static import would put it in the
  // entry chunk for every visitor. `/universal` takes an ArrayBuffer and has no
  // Node- or DOM-only imports, so the same specifier works in the Vite browser
  // build and in Vitest's node environment.
  const { default: readExcelFile } = await import('read-excel-file/universal')

  let book: Awaited<ReturnType<typeof readExcelFile>>
  try {
    // trim:false so the xlsx path preserves cell text exactly as the CSV path
    // does — trimming stays where it already is, in clean()/parseAmount().
    book = await readExcelFile(await file.arrayBuffer(), { trim: false })
  } catch {
    throw new UnsupportedFileError('unknown',
      'Kunde inte läsa filen. Kontrollera att det är en giltig .xlsx- eller .csv-fil.')
  }

  const sheets = book.map(s => s.sheet)
  const chosen = (opts.sheet && book.find(s => s.sheet === opts.sheet)) || book[0]
  // read-excel-file's published `CellValue` type says `typeof Date` (the
  // constructor) where it means a `Date` instance; at runtime date cells are
  // `Date` objects (verified against the fixtures), hence the cast.
  const matrix = (chosen?.data ?? []).map(row => row.map(c => cellToString(c as unknown as CellInput)))
  const headerRow = detectHeaderRow(matrix, opts.scoreHeaderRow)
  return {
    format: 'xlsx', delimiter: '',
    headers: matrix[headerRow] ?? [],
    // Drop fully blank rows the way parseCsv drops blank lines.
    rows: matrix.slice(headerRow + 1).filter(r => r.some(c => c.trim() !== '')),
    sheet: chosen?.sheet ?? null, sheets, headerRow,
  }
}

/** One Excel cell → the string the equivalent CSV cell would have held.
 *  This function IS the financial-correctness surface of the xlsx path: an
 *  Excel date is a day-count number underneath, so getting this wrong turns
 *  2026-01-05 into a 46 027 kronor charge that parseAmount accepts happily. */
export function cellToString(v: CellInput): string {
  if (v == null) return ''
  if (v instanceof Date) {
    // Excel serials are calendar day-counts, not instants; read-excel-file
    // builds them on the UTC epoch (midnight UTC). Read them back with UTC
    // getters — a local-time getter shifts the date by a day for every
    // timezone west of Greenwich, and silently, since the wrong date is still
    // a valid date.
    if (Number.isNaN(v.getTime())) return ''
    const y = v.getUTCFullYear()
    const m = String(v.getUTCMonth() + 1).padStart(2, '0')
    const d = String(v.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${d}` // exactly what normalizeMonthEndItemDate wants
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') {
    // NEVER toLocaleString here. parseAmount reads '1 234,50' as 1234.5, but
    // Number.prototype.toString never emits a thousands separator or a decimal
    // comma, so the plain string round-trips through parseAmount exactly.
    return Number.isFinite(v) ? String(v) : ''
  }
  return v
}

const HEADER_SCAN_LIMIT = 15
const MIN_HEADER_SCORE = 2

/** Pick the row that best reads as a header. Ties keep the EARLIEST row (strict
 *  `>`), so a data row that happens to score the same never wins over the real
 *  header above it. Below the threshold we fall back to row 0 and behave exactly
 *  like CSV — a sheet we cannot recognise is not a sheet we should guess at. */
export function detectHeaderRow(
  matrix: string[][],
  score: (headers: string[]) => number,
  limit = HEADER_SCAN_LIMIT,
): number {
  let best = 0, bestScore = -1
  for (let i = 0; i < Math.min(matrix.length, limit); i++) {
    const s = score(matrix[i])
    if (s > bestScore) { bestScore = s; best = i }
  }
  return bestScore >= MIN_HEADER_SCORE ? best : 0
}
