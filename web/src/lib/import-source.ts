// import-source.ts — how a statement import describes where its rows came from
// (plan 129). Shared by both import surfaces (Månadsavslut, Bolånekoll) so the
// file pill and the persisted `source` text say the same thing in both tools.
// Pure: no React, no browser APIs.

import type { TabularResult } from './tabular'

type SourceShape = Pick<TabularResult, 'format' | 'delimiter' | 'sheet' | 'headerRow'>

/** The `.file-pill` suffix. CSV keeps today's delimiter text exactly; xlsx
 *  names the sheet and, when the header was detected below row 1, says which
 *  row — the one place the owner can notice detection picked the wrong row
 *  before importing. */
export function sourceLabel(p: SourceShape): string {
  if (p.format === 'csv') return `“${p.delimiter === '\t' ? 'tab' : p.delimiter}” delimited`
  return (p.sheet ?? '') + (p.headerRow > 0 ? ` · rubrik på rad ${p.headerRow + 1}` : '')
}

/** The persisted `source` provenance for an imported row: unchanged
 *  `import:<filename>` for CSV, `import:<filename> (<sheet>)` for an xlsx
 *  sheet, so a row imported from the wrong sheet is traceable to it. */
export function importSource(fileName: string, p: Pick<TabularResult, 'format' | 'sheet'>): string {
  const base = 'import:' + fileName
  return p.format === 'xlsx' && p.sheet ? `${base} (${p.sheet})` : base
}
