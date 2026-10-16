import { describe, expect, it } from 'vitest'
import {
  countDataRows,
  detectEmailColumn,
  detectedEmailColumn,
  headerFromBytes,
  keptColumnIndexes,
  normalizeHeader,
  parseCSVRow,
  sampleCsv,
  sniffCsvHeader,
  toCsv,
} from '@/lib/import/csv'

const enc = (s: string) => new TextEncoder().encode(s)

describe('detectEmailColumn (telegram-inbox parity)', () => {
  it.each([
    [['First Name', 'Email', 'Company'], { column: 'Email' }],
    [['name', 'Work Email'], { column: 'Work Email' }],
    [['name', 'business_email'], { column: 'business_email' }],
    [['  EMAIL  '], { column: '  EMAIL  ' }],
    // tier 1 wins over tier 3
    [['Email', 'Secondary Email'], { column: 'Email' }],
    // two tier-1 names → ambiguous
    [['Email', 'Work Email'], { ambiguous: ['Email', 'Work Email'] }],
    // tier 3: contains "mail" (not just "email")
    [['name', 'E-Mail Address'], { column: 'E-Mail Address' }],
    [['name', 'Mailbox'], { column: 'Mailbox' }],
    // personal is never picked
    [['name', 'Personal Email'], { error: 'No email column found in CSV' }],
    [['Personal Email', 'Contact Email'], { column: 'Contact Email' }],
    // two tier-3 names → ambiguous
    [['Contact Email', 'Secondary Email'], { ambiguous: ['Contact Email', 'Secondary Email'] }],
    [['name', 'company'], { error: 'No email column found in CSV' }],
    [[], { error: 'No email column found in CSV' }],
  ])('%j → %j', (headers, expected) => {
    expect(detectEmailColumn(headers)).toEqual(expected)
  })

  it('a tier-1 "personal" name still counts (personal only filters tier 3, as upstream)', () => {
    // "email" is tier 1 by exact name; the personal filter applies to tier 3 only.
    expect(detectEmailColumn(['Email', 'Personal Email'])).toEqual({ column: 'Email' })
  })

  it('dropped Keywords / Technologies columns never affect detection, and are the ones dropped', () => {
    const headers = ['Name', 'Keywords', 'Email', 'Technologies']
    expect(detectEmailColumn(headers)).toEqual({ column: 'Email' })
    expect(keptColumnIndexes(headers)).toEqual([0, 2])
    expect(keptColumnIndexes([' keywords ', 'TECHNOLOGIES', 'x'])).toEqual([2])
  })

  it('detectedEmailColumn is null when ambiguous or absent', () => {
    expect(detectedEmailColumn(['Email', 'Work Email'])).toBeNull()
    expect(detectedEmailColumn(['a'])).toBeNull()
    expect(detectedEmailColumn(['Email'])).toBe('Email')
  })

  it('normalizeHeader lowercases, trims and joins whitespace with _', () => {
    expect(normalizeHeader('  Work   Email ')).toBe('work_email')
  })
})

describe('row helpers', () => {
  it('parseCSVRow handles quotes, doubled quotes, empty fields', () => {
    expect(parseCSVRow('a,"b,c","d ""q""",,e')).toEqual(['a', 'b,c', 'd "q"', '', 'e'])
    expect(parseCSVRow('a,')).toEqual(['a', ''])
  })
  it('headerFromBytes strips CRLF; countDataRows counts lines minus header', () => {
    expect(headerFromBytes(enc('a,b\r\n1,2\r\n'))).toBe('a,b')
    expect(countDataRows(enc('a,b\n1,2\n3,4\n'))).toBe(2)
    expect(countDataRows(enc('a,b\n1,2\n3,4'))).toBe(2)
    expect(countDataRows(enc('a,b\n'))).toBe(0)
    expect(countDataRows(enc(''))).toBe(0)
  })
  it('sniffCsvHeader rejects binary and blank headers', () => {
    expect(sniffCsvHeader(enc('Email,Name\nx@y.z,A\n'))).toEqual(['Email', 'Name'])
    expect(sniffCsvHeader(enc('﻿Email\n1\n'))).toEqual(['Email'])
    expect(sniffCsvHeader(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBeNull()
    expect(sniffCsvHeader(enc(',,\n1,2,3\n'))).toBeNull()
    expect(sniffCsvHeader(new Uint8Array())).toBeNull()
  })
})

describe('toCsv', () => {
  it('unions keys in first-seen order and leaves missing cells empty', () => {
    expect(toCsv([{ a: 1, b: 'x' }, { b: 'y', c: true }])).toBe('a,b,c\n1,x,\n,y,true\n')
  })
  it('quotes commas and quotes, doubles inner quotes', () => {
    expect(toCsv([{ name: 'Smith, John', q: 'say "hi"' }])).toBe('name,q\n"Smith, John","say ""hi"""\n')
  })
  it('flattens newlines (the pipeline parses line by line) and keeps the row count exact', () => {
    const csv = toCsv([{ bio: 'line one\nline two\r\nthree' }, { bio: 'ok' }])
    expect(csv).toBe('bio\nline one line two three\nok\n')
    expect(countDataRows(enc(csv))).toBe(2)
  })
  it('JSON-stringifies nested objects and arrays; null/undefined are empty', () => {
    const csv = toCsv([{ loc: { city: 'Austin', geo: [1, 2] }, tags: ['a', 'b'], n: null, u: undefined }])
    const [header, row] = csv.trim().split('\n')
    expect(header).toBe('loc,tags,n,u')
    expect(parseCSVRow(row)).toEqual(['{"city":"Austin","geo":[1,2]}', '["a","b"]', '', ''])
  })
  it('quotes values with leading/trailing spaces; empty input → empty string', () => {
    expect(toCsv([{ a: ' x ' }])).toBe('a\n" x "\n')
    expect(toCsv([])).toBe('')
  })
  it('round-trips through the pipeline parser and email detection', () => {
    const csv = toCsv([{ name: 'A', email: 'a@x.com' }])
    const bytes = enc(csv)
    expect(detectedEmailColumn(parseCSVRow(headerFromBytes(bytes)))).toBe('email')
  })
})

describe('sampleCsv', () => {
  it('header + first n rows', () => {
    const text = 'a,b\n1,2\n3,4\n5,6\n'
    expect(sampleCsv(text, 2)).toEqual({ headers: ['a', 'b'], rows: [['1', '2'], ['3', '4']] })
  })
  it('drops a half line when the download was cut off', () => {
    expect(sampleCsv('a,b\n1,2\n3,', 5, true)).toEqual({ headers: ['a', 'b'], rows: [['1', '2']] })
    expect(sampleCsv('a,b\n1,2\n3,4', 5, false).rows).toHaveLength(2)
  })
  it('empty text → empty sample', () => {
    expect(sampleCsv('')).toEqual({ headers: [], rows: [] })
  })
})
