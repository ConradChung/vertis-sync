import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { zipSync, strToU8 } from 'fflate'
import { parseSpreadsheet } from '@/lib/sheets/parse'
import { decodeCsv, detectDelimiter, parseDelimited } from '@/lib/sheets/csv'
import { detectHeader, sniffSpreadsheet } from '@/lib/sheets/model'
import { scanXlsxZip } from '@/lib/sheets/zipGuard'

/** Build a small .xlsx in memory (no committed binaries). */
async function xlsx(build: (wb: ExcelJS.Workbook) => void): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  build(wb)
  return new Uint8Array(await wb.xlsx.writeBuffer())
}

const enc = (s: string) => new TextEncoder().encode(s)

describe('sniffSpreadsheet', () => {
  it('knows xlsx, legacy OLE (.xls / encrypted), binary and text', async () => {
    const book = await xlsx((wb) => wb.addWorksheet('A').addRow(['x']))
    expect(sniffSpreadsheet(book)).toBe('zip')
    expect(sniffSpreadsheet(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]))).toBe('ole')
    expect(sniffSpreadsheet(enc('%PDF-1.7\n'))).toBe('binary')
    expect(sniffSpreadsheet(new Uint8Array([0x61, 0, 0x62]))).toBe('binary')
    expect(sniffSpreadsheet(enc('a,b\n1,2\n'))).toBe('text')
    expect(sniffSpreadsheet(new Uint8Array([0xff, 0xfe, 0x61, 0x00]))).toBe('text') // UTF-16 BOM
  })
})

describe('detectHeader', () => {
  it('skips title rows above the header', () => {
    const grid = [['Leads Q3'], [], ['Name', 'Email', 'Company'], ['Ann', 'a@x.com', 'X'], ['Bo', 'b@y.com', 'Y']]
    expect(detectHeader(grid)).toEqual({ index: 2, detected: true })
  })
  it('falls back to no header for all-numeric data', () => {
    expect(detectHeader([['1', '2'], ['3', '4']])).toEqual({ index: -1, detected: false })
  })
})

describe('parseSpreadsheet (xlsx)', () => {
  it('detects the header, converts dates to ISO and formulas to cached values, notes hidden sheets', async () => {
    const book = await xlsx((wb) => {
      const s = wb.addWorksheet('Leads')
      s.addRow(['Lead list'])
      s.addRow([])
      s.addRow(['Name', 'Signed', 'Deal', 'Total'])
      s.addRow(['Ann', new Date(Date.UTC(2026, 0, 15)), 10, { formula: 'C4*2', result: 20 }])
      s.addRow(['Bo', new Date(Date.UTC(2026, 1, 1, 13, 30)), 0.1, { formula: 'C5*2', result: 0.2 }])
      const h = wb.addWorksheet('Secret')
      h.state = 'hidden'
      h.addRow(['k', 'v'])
      h.addRow(['a', 'b'])
    })
    const r = await parseSpreadsheet(book, 'xlsx')
    if (!r.ok) throw new Error(r.error)
    const [leads, secret] = r.workbook.sheets
    expect(leads.name).toBe('Leads')
    expect(leads.header).toEqual(['Name', 'Signed', 'Deal', 'Total'])
    expect(leads.header_row).toBe(3)
    expect(leads.rows).toEqual([
      ['Ann', '2026-01-15', '10', '20'],
      ['Bo', '2026-02-01T13:30:00', '0.1', '0.2'],
    ])
    expect(leads.hidden).toBe(false)
    expect(secret.hidden).toBe(true)
    expect(secret.rows).toEqual([['a', 'b']])
  })

  it('drops empty and merged-overflow columns; merged cells keep the value once', async () => {
    const book = await xlsx((wb) => {
      const s = wb.addWorksheet('S')
      s.getCell('A1').value = 'Name'
      s.getCell('C1').value = 'Email'
      s.getCell('D1').value = 'Region'
      s.mergeCells('D1:E1')
      s.getCell('A2').value = 'Ann'
      s.getCell('C2').value = 'a@x.com'
      s.getCell('D2').value = 'West'
    })
    const r = await parseSpreadsheet(book, 'xlsx')
    if (!r.ok) throw new Error(r.error)
    const s = r.workbook.sheets[0]
    expect(s.header).toEqual(['Name', 'Email', 'Region'])
    expect(s.rows).toEqual([['Ann', 'a@x.com', 'West']])
    expect(s.dropped_columns).toBe(2)
  })

  it('reads several sheets, rich text, hyperlinks, booleans and errors', async () => {
    const book = await xlsx((wb) => {
      const a = wb.addWorksheet('One')
      a.addRow(['Site', 'Ok', 'Note'])
      a.addRow([{ text: 'acme', hyperlink: 'https://acme.com' }, true, { richText: [{ text: 'hi ' }, { text: 'there' }] }])
      a.addRow(['b.com', false, { error: '#N/A' }])
      wb.addWorksheet('Two').addRow(['x'])
    })
    const r = await parseSpreadsheet(book, 'xlsx')
    if (!r.ok) throw new Error(r.error)
    expect(r.workbook.sheets.map((s) => s.name)).toEqual(['One', 'Two'])
    expect(r.workbook.sheets[0].rows).toEqual([
      ['acme', 'TRUE', 'hi there'],
      ['b.com', 'FALSE', '#N/A'],
    ])
  })

  it('refuses a zip that is not a workbook, and legacy / encrypted files with a clear code', async () => {
    const zip = zipSync({ 'hello.txt': strToU8('hi') })
    expect(await parseSpreadsheet(zip, 'xlsx')).toEqual({ ok: false, error: 'not_xlsx' })
    const ole = new Uint8Array(1024)
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    expect(await parseSpreadsheet(ole, 'xlsx')).toEqual({ ok: false, error: 'legacy_or_encrypted' })
    expect(await parseSpreadsheet(enc('a,b\n'), 'xlsx')).toEqual({ ok: false, error: 'not_xlsx' })
  })

  it('caps sheets and cells', async () => {
    const many = await xlsx((wb) => {
      for (let i = 0; i < 4; i++) wb.addWorksheet(`S${i}`).addRow(['x'])
    })
    expect(await parseSpreadsheet(many, 'xlsx', { maxSheets: 3 })).toEqual({ ok: false, error: 'too_many_sheets' })
    const big = await xlsx((wb) => {
      const s = wb.addWorksheet('S')
      for (let i = 0; i < 30; i++) s.addRow(['a', 'b', 'c', 'd'])
    })
    expect(await parseSpreadsheet(big, 'xlsx', { maxCells: 100 })).toEqual({ ok: false, error: 'too_many_cells' })
  })
})

describe('formulas without a saved value', () => {
  it('keep their formula text and are noted on the sheet and in the summary', async () => {
    const { fileSummary } = await import('@/lib/sheets/model')
    const book = await xlsx((wb) => {
      const s = wb.addWorksheet('S')
      s.addRow(['Price', 'Double'])
      s.addRow([2, { formula: 'A2*2' }])
      s.addRow([3, { formula: 'A3*2', result: 6 }])
    })
    const r = await parseSpreadsheet(book, 'xlsx')
    if (!r.ok) throw new Error(r.error)
    const sh = r.workbook.sheets[0]
    expect(sh.rows).toEqual([['2', '=A2*2'], ['3', '6']])
    expect(sh.uncached_formulas).toBe(1)
    expect(fileSummary({ id: 'i', name: 'n.xlsx', kind: 'xlsx', size_bytes: 1 }, r.workbook)).toContain('1 formula with no saved value, shown as its formula')
  })
})

describe('zip-bomb guard', () => {
  it('stops at the uncompressed cap without inflating the whole archive', () => {
    // 5 MB of zeros compresses to a few KB.
    const bomb = zipSync({ '[Content_Types].xml': strToU8('<x/>'), 'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="a"/></sheets></workbook>'), 'xl/worksheets/sheet1.xml': new Uint8Array(5 * 1024 * 1024) }, { level: 9 })
    expect(bomb.length).toBeLessThan(100_000)
    expect(scanXlsxZip(bomb, { maxUncompressed: 1024 * 1024 })).toEqual({ ok: false, error: 'too_large_uncompressed' })
    const ok = scanXlsxZip(bomb, { maxUncompressed: 10 * 1024 * 1024 })
    expect(ok).toMatchObject({ ok: true, sheets: 1 })
  })

  it('counts sheets and cells from the XML', () => {
    const z = zipSync({
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="a" sheetId="1"/><sheet name="b" sheetId="2"/></sheets></workbook>'),
      'xl/worksheets/sheet1.xml': strToU8('<sheetData><row><c r="A1"><v>1</v></c><c r="B1" t="s"><v>0</v></c></row></sheetData>'),
      'xl/worksheets/sheet2.xml': strToU8('<sheetData><row><c r="A1"/></row></sheetData>'),
    })
    expect(scanXlsxZip(z)).toEqual({ ok: true, sheets: 2, cells: 3 })
  })
})

describe('parseSpreadsheet (csv)', () => {
  it('detects ; and tab delimiters, quoted newlines and a UTF-8 BOM', async () => {
    const semi = await parseSpreadsheet(enc('﻿Name;Email;City\n"Ann ""A""";a@x.com;"New\nYork"\nBo;b@y.com;Paris\n'), 'csv')
    if (!semi.ok) throw new Error(semi.error)
    const s = semi.workbook.sheets[0]
    expect(s.name).toBe('Sheet1')
    expect(s.header).toEqual(['Name', 'Email', 'City'])
    expect(s.rows).toEqual([
      ['Ann "A"', 'a@x.com', 'New\nYork'],
      ['Bo', 'b@y.com', 'Paris'],
    ])
    expect(semi.workbook.encoding).toBe('utf-8')
    const tab = await parseSpreadsheet(enc('a\tb\n1\t2\n'), 'csv')
    expect(tab.ok && tab.workbook.sheets[0].header).toEqual(['a', 'b'])
  })

  it('falls back to latin1 when the bytes are not UTF-8', async () => {
    const latin = new Uint8Array([...enc('Name,City\nRen'), 0xe9, ...enc(',Montr'), 0xe9, ...enc('al\n')])
    const r = await parseSpreadsheet(latin, 'csv')
    if (!r.ok) throw new Error(r.error)
    expect(r.workbook.encoding).toBe('latin1')
    expect(r.workbook.sheets[0].rows).toEqual([['René', 'Montréal']])
  })

  it('refuses binary and empty files', async () => {
    expect(await parseSpreadsheet(new Uint8Array([1, 0, 2, 3]), 'csv')).toEqual({ ok: false, error: 'not_csv' })
    expect(await parseSpreadsheet(enc('  \n\n'), 'csv')).toEqual({ ok: false, error: 'empty' })
  })

  it('helpers', () => {
    expect(detectDelimiter('a|b|c\n1|2|3\n')).toBe('|')
    expect(detectDelimiter('just one column\nx\n')).toBe(',')
    expect(parseDelimited('a,"b,c"\r\n1,2', ',')).toEqual([['a', 'b,c'], ['1', '2']])
    expect(decodeCsv(new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x2c, 0x00, 0x62, 0x00]))).toEqual({ text: 'a,b', encoding: 'utf-16le' })
  })
})
