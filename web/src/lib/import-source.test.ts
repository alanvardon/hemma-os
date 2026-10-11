import { describe, expect, it } from 'vitest'
import { importSource, sourceLabel } from './import-source'

describe('sourceLabel', () => {
  it('keeps the CSV delimiter text exactly as before', () => {
    expect(sourceLabel({ format: 'csv', delimiter: ';', sheet: null, headerRow: 0 })).toBe('“;” delimited')
    expect(sourceLabel({ format: 'csv', delimiter: ',', sheet: null, headerRow: 0 })).toBe('“,” delimited')
    expect(sourceLabel({ format: 'csv', delimiter: '\t', sheet: null, headerRow: 0 })).toBe('“tab” delimited')
  })

  it('names the sheet, and the header row only when it is not the first', () => {
    expect(sourceLabel({ format: 'xlsx', delimiter: '', sheet: 'Blad1', headerRow: 0 })).toBe('Blad1')
    expect(sourceLabel({ format: 'xlsx', delimiter: '', sheet: 'Kontoutdrag', headerRow: 3 })).toBe('Kontoutdrag · rubrik på rad 4')
  })
})

describe('importSource', () => {
  it('is unchanged for CSV', () => {
    expect(importSource('kontoutdrag.csv', { format: 'csv', sheet: null })).toBe('import:kontoutdrag.csv')
  })

  it('records the sheet for xlsx', () => {
    expect(importSource('kontoutdrag.xlsx', { format: 'xlsx', sheet: 'Blad2' })).toBe('import:kontoutdrag.xlsx (Blad2)')
  })

  it('falls back to the bare file name for a sheetless xlsx result', () => {
    expect(importSource('tom.xlsx', { format: 'xlsx', sheet: null })).toBe('import:tom.xlsx')
  })
})
