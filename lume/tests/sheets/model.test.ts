import { describe, expect, it } from 'vitest'
import { buildSheet, fileBrief, fileSummary, isSheetFile, pickSheet, readWindow, sheetExt, sheetToIngestCsv, type ParsedWorkbook } from '@/lib/sheets/model'
import { cellText, isDateFormat, isoDate, serialToDate } from '@/lib/sheets/parse'

const FILE = { id: '11111111-2222-4333-8444-555555555555', name: 'leads.xlsx', kind: 'xlsx' as const, size_bytes: 2048 }

const sheet = (n: number, name = 'Leads') => buildSheet(name, false, [['Name', 'Email'], ...Array.from({ length: n }, (_, i) => [`P${i}`, `p${i}@x.com`])])

describe('buildSheet', () => {
  it('names blank and duplicate headers', () => {
    const s = buildSheet('S', false, [['Name', '', 'name'], ['a', 'b', 'c']])
    expect(s.header).toEqual(['Name', 'Column B', 'name (2)'])
  })
  it('without a header, columns are named by letter and every row is data', () => {
    const s = buildSheet('S', false, [['1', '2'], ['3', '4']])
    expect(s.header).toEqual(['Column A', 'Column B'])
    expect(s.header_row).toBeNull()
    expect(s.rows).toHaveLength(2)
  })
})

describe('fileSummary', () => {
  it('lists sheets, the header and the first 50 rows as CSV, and says how to page the rest', () => {
    const wb: ParsedWorkbook = { kind: 'xlsx', sheets: [sheet(120), { ...buildSheet('Notes', true, [['k'], ['v']]) }] }
    const text = fileSummary(FILE, wb)
    expect(text).toContain('File: leads.xlsx (xlsx, 2.0 KB) · file_id 11111111-2222-4333-8444-555555555555')
    expect(text).toContain('- "Leads": 120 rows × 2 columns (header on row 1)')
    expect(text).toContain('- "Notes": 1 row × 1 column (hidden; header on row 1)')
    expect(text).toContain('Name,Email\nP0,p0@x.com')
    expect(text).toContain('P49,p49@x.com')
    expect(text).not.toContain('P50,')
    expect(text).toContain('[70 more rows not shown — read_attachment(file_id: "11111111-2222-4333-8444-555555555555", sheet: "Leads", offset: 50)]')
  })
  it('stays within the cap and names sheets it could not preview', () => {
    const big = (name: string) => buildSheet(name, false, [['A', 'B'], ...Array.from({ length: 50 }, () => ['x'.repeat(100), 'y'.repeat(100)])])
    const wb: ParsedWorkbook = { kind: 'xlsx', sheets: Array.from({ length: 6 }, (_, i) => big(`S${i}`)) }
    const text = fileSummary(FILE, wb, 20_000)
    expect(text.length).toBeLessThanOrEqual(20_000)
    expect(text).toMatch(/more rows not shown/)
    expect(text).toMatch(/\[Not previewed for length: .*"S5"/)
  })
  it('notes the CSV encoding and delimiter', () => {
    const wb: ParsedWorkbook = { kind: 'csv', sheets: [sheet(1, 'Sheet1')], encoding: 'latin1', delimiter: ';' }
    expect(fileSummary({ ...FILE, kind: 'csv', name: 'a.csv' }, wb)).toContain('CSV read as latin1, delimiter ";".')
  })
})

describe('readWindow / pickSheet', () => {
  it('pages rows with the header first', () => {
    const s = sheet(250)
    const a = readWindow(s, 0)
    expect(a).toMatchObject({ offset: 0, returned: 100, total_rows: 250, next_offset: 100 })
    expect(a.csv.split('\n')[0]).toBe('Name,Email')
    const b = readWindow(s, 200, 500)
    expect(b).toMatchObject({ offset: 200, returned: 50, next_offset: null })
    expect(readWindow(s, 9999)).toMatchObject({ offset: 250, returned: 0, next_offset: null })
  })
  it('stops at the character cap', () => {
    const s = buildSheet('S', false, [['A'], ...Array.from({ length: 50 }, () => ['z'.repeat(1000)])])
    // Each 1,000-char cell is clipped to 500 (+ a note), so nine rows fit in 5k.
    const w = readWindow(s, 0, 500, 5000)
    expect(w.returned).toBe(9)
    expect(w.next_offset).toBe(9)
    expect(w.csv.length).toBeLessThanOrEqual(5000)
  })
  it('picks by name, case-insensitive name or 1-based index; default the first visible sheet with rows', () => {
    const sheets = [{ ...sheet(0, 'Empty') }, { ...sheet(2, 'Hidden'), hidden: true }, sheet(3, 'Data')]
    expect(pickSheet(sheets)?.name).toBe('Data')
    expect(pickSheet(sheets, 'hidden')?.name).toBe('Hidden')
    expect(pickSheet(sheets, 2)?.name).toBe('Hidden')
    expect(pickSheet(sheets, '3')?.name).toBe('Data')
    expect(pickSheet(sheets, 'nope')).toBeNull()
  })
})

describe('ingest CSV', () => {
  it('quotes fields and flattens line breaks so the pipeline reads one row per line', () => {
    const csv = sheetToIngestCsv({ header: ['Name', 'Note'], rows: [['Ann, A', 'two\nlines'], ['Bo "B"', '']] })
    expect(csv).toBe('Name,Note\n"Ann, A",two lines\n"Bo ""B""",\n')
  })
})

describe('names', () => {
  it('recognises spreadsheet files', () => {
    expect(sheetExt('a.XLSX')).toBe('xlsx')
    expect(sheetExt('a.xls')).toBe('xls')
    expect(sheetExt('a.png')).toBeNull()
    expect(isSheetFile({ name: 'export', type: 'text/csv' })).toBe(true)
    expect(isSheetFile({ name: 'shot.png', type: 'image/png' })).toBe(false)
  })
})

describe('cell values', () => {
  it('dates from formulas with a date format, the 1904 system, and plain numbers', () => {
    expect(isDateFormat('yyyy-mm-dd')).toBe(true)
    expect(isDateFormat('"Total" 0.00')).toBe(false)
    expect(isDateFormat('[Red]0.00')).toBe(false)
    expect(isoDate(serialToDate(46037))).toBe('2026-01-15')
    expect(isoDate(serialToDate(44575, true))).toBe('2026-01-15')
    expect(cellText({ value: { formula: 'A1+1', result: 46037 }, numFmt: 'dd/mm/yyyy' })).toBe('2026-01-15')
    expect(cellText({ value: { sharedFormula: 'A1', result: 0.1 + 0.2 } })).toBe('0.3')
    // No cached value: the formula text, so the data is not silently blank.
    expect(cellText({ value: { formula: 'X()' } })).toBe('=X()')
  })
  it('time-only cells are HH:MM:SS', () => {
    expect(cellText({ value: new Date(Date.UTC(1899, 11, 30, 13, 30, 5)), numFmt: 'h:mm:ss' })).toBe('13:30:05')
    expect(cellText({ value: 0.5, numFmt: 'hh:mm' })).toBe('12:00:00')
    expect(cellText({ value: { formula: 'A1', result: 0.75 }, numFmt: '[h]:mm:ss' })).toBe('18:00:00')
    // A Date before 1900 can only be a time of day (Excel's day 0).
    expect(cellText({ value: new Date(Date.UTC(1899, 11, 30, 9, 5, 0)) })).toBe('09:05:00')
    expect(cellText({ value: new Date(Date.UTC(2026, 0, 15, 9, 5, 0)), numFmt: 'yyyy-mm-dd h:mm' })).toBe('2026-01-15T09:05:00')
  })
})

describe('readWindow caps the whole answer (review)', () => {
  it('never returns more than maxChars, header included; wide cells are clipped; paging still advances', () => {
    const header = Array.from({ length: 1000 }, (_, i) => `Column number ${i} with a long name`)
    const row = Array.from({ length: 1000 }, () => 'v'.repeat(100))
    const s = buildSheet('W', false, [header, row, row, row])
    const w = readWindow(s, 0, 500)
    expect(w.csv.length).toBeLessThanOrEqual(20_000)
    expect(w.csv).toMatch(/\[header cut: 1,000 columns\]/)
    expect(w.returned).toBe(1)
    expect(w.next_offset).toBe(1)
    expect(readWindow(s, 1, 500).offset).toBe(1)
  })
  it('a cell over 500 chars is clipped with a note', () => {
    const s = buildSheet('C', false, [['A'], ['z'.repeat(5000)]])
    const w = readWindow(s, 0)
    expect(w.csv).toContain(`${'z'.repeat(500)}…[+4500 chars]`)
    expect(w.csv).not.toContain('z'.repeat(501))
  })
})

describe('fileBrief (what later turns replay)', () => {
  it('names the file, the sheets with counts and the headers, never the rows', () => {
    const wb: ParsedWorkbook = { kind: 'xlsx', sheets: [sheet(120)] }
    const b = fileBrief(FILE, wb)
    expect(b).toContain('- "Leads": 120 rows × 2 columns')
    expect(b).toContain('Header of "Leads": Name,Email')
    expect(b).not.toContain('p0@x.com')
    expect(b).toMatch(/read_attachment/)
    expect(fileBrief(FILE, { kind: 'xlsx', sheets: Array.from({ length: 20 }, (_, i) => buildSheet(`S${i}`, false, [Array.from({ length: 200 }, (_, k) => `h${k}`)])) }).length).toBeLessThanOrEqual(4000)
  })
  it('the summary clips wide cells too', () => {
    const wb: ParsedWorkbook = { kind: 'xlsx', sheets: [buildSheet('C', false, [['A'], ['z'.repeat(5000)]])] }
    expect(fileSummary(FILE, wb)).not.toContain('z'.repeat(501))
  })
})
