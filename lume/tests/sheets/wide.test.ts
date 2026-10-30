import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { parseSpreadsheet } from '@/lib/sheets/parse'
import { parseDelimited, CsvLimitError } from '@/lib/sheets/csv'
import { extractText } from '@/lib/agent/projectExtract'
import { LIMITS } from '@/lib/sheets/model'

/**
 * Wide-sheet DoS (review item 1): the cell cap counted filled cells only, so a
 * few sparse cells far to the right were densified into gigabytes. Each repro
 * must now be refused fast, without building the wide rows.
 */

const enc = (s: string) => new TextEncoder().encode(s)
const heapMb = () => process.memoryUsage().heapUsed / 1e6

async function timed<T>(fn: () => Promise<T>) {
  const t = performance.now()
  const before = heapMb()
  const value = await fn()
  return { value, ms: performance.now() - t, heapGrowthMb: heapMb() - before }
}

describe('width caps', () => {
  it('the cap is 1,000 columns', () => {
    expect(LIMITS.maxColumns).toBe(1000)
  })

  it('CSV repro: one 200k-column row (404 KB) is refused while streaming, fast and small', async () => {
    const text = Array(200_000).fill('a').join(',') + '\n' + Array(2000).fill('x').join('\n') + '\n'
    const r = await timed(() => parseSpreadsheet(enc(text), 'csv'))
    expect(r.value).toEqual({ ok: false, error: 'too_many_columns' })
    expect(r.ms).toBeLessThan(1000)
    expect(r.heapGrowthMb).toBeLessThan(150)
  })

  it('the CSV reader stops at the first row past the width cap without building it', () => {
    expect(() => parseDelimited('a,b,c,d\n', ',', Infinity, { maxCols: 3 })).toThrow(CsvLimitError)
    expect(parseDelimited('a,b,c\n', ',', Infinity, { maxCols: 3 })).toEqual([['a', 'b', 'c']])
    expect(() => parseDelimited('a\nb\nc\n', ',', Infinity, { maxCells: 2 })).toThrow(CsvLimitError)
  })

  it('XLSX repro: 3,000 rows with one cell at column 16000 (≈33 KB) is refused fast and small', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('S')
    ws.getCell(1, 1).value = 'email'
    for (let r = 2; r <= 3000; r++) {
      ws.getCell(r, 1).value = 'x'
      ws.getCell(r, 16000).value = 'y'
    }
    const buf = new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer)
    const r = await timed(() => parseSpreadsheet(buf, 'xlsx'))
    expect(r.value).toEqual({ ok: false, error: 'too_many_columns' })
    expect(r.ms).toBeLessThan(3000)
    expect(r.heapGrowthMb).toBeLessThan(200)
    // Project files use the same parser: not readable, never a crash.
    const p = await timed(() => extractText(buf, 'xlsx'))
    expect(p.value).toEqual({ text: null, readable: false, truncated: false })
    expect(p.ms).toBeLessThan(3000)
  }, 20_000)

  it('width × rows is capped before anything is densified (a ragged CSV)', async () => {
    const text = Array(500).fill('h').join(',') + '\n' + Array(200).fill('x').join('\n') + '\n'
    expect(await parseSpreadsheet(enc(text), 'csv', { maxGridCells: 50_000 })).toEqual({ ok: false, error: 'too_many_cells' })
    expect((await parseSpreadsheet(enc(text), 'csv')).ok).toBe(true)
  })

  it('a sparse xlsx row far down keeps its source row number without allocating the rows above it', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('S')
    ws.getCell(500_000, 1).value = 'Name'
    ws.getCell(500_001, 1).value = 'Ann'
    const buf = new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer)
    const r = await parseSpreadsheet(buf, 'xlsx')
    if (!r.ok) throw new Error(r.error)
    expect(r.workbook.sheets[0]).toMatchObject({ header: ['Name'], header_row: 500_000, rows: [['Ann']] })
  })
})
