import { describe, expect, it } from 'vitest'
import { extractText } from '@/lib/agent/projectExtract'
import { CSV_MAX_ROWS, MAX_TEXT_CHARS } from '@/lib/agent/projectModel'

const enc = (s: string) => new TextEncoder().encode(s)

/** A minimal one-page PDF whose text layer says `text` (xref offsets computed). */
function pdfWith(text: string): Uint8Array {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return enc(out)
}

describe('extractText', () => {
  it('CSV: the header plus the first 200 rows, marked truncated beyond that', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => `r${i}@x.co,"Acme, Inc ${i}"`)
    const r = await extractText(enc(`﻿email,company\n${rows.join('\n')}\n`), 'csv')
    expect(r.readable).toBe(true)
    expect(r.truncated).toBe(true)
    const lines = r.text!.split('\n')
    expect(lines[0]).toBe('email,company')
    expect(lines).toHaveLength(1 + CSV_MAX_ROWS)
    expect(lines.at(-1)).toBe(`r${CSV_MAX_ROWS - 1}@x.co,"Acme, Inc ${CSV_MAX_ROWS - 1}"`)
  })

  it('CSV: a quoted field with a newline counts as one row; a short file is not truncated', async () => {
    const r = await extractText(enc('a,b\r\n1,"two\nlines"\r\n3,4'), 'csv')
    expect(r.truncated).toBe(false)
    expect(r.text).toBe('a,b\n1,"two\nlines"\n3,4')
  })

  it('MD / TXT / JSON: as-is', async () => {
    expect(await extractText(enc('# Title\n\n- a'), 'text')).toEqual({ text: '# Title\n\n- a', readable: true, truncated: false })
    expect((await extractText(enc('{"a": 1}'), 'json')).text).toBe('{"a": 1}')
  })

  it('caps stored text at 200k characters', async () => {
    const r = await extractText(enc('x'.repeat(MAX_TEXT_CHARS + 50)), 'text')
    expect(r.text!.length).toBe(MAX_TEXT_CHARS)
    expect(r.truncated).toBe(true)
  })

  it('PDF: the text layer', async () => {
    const r = await extractText(pdfWith('Roofers in Austin price list'), 'pdf')
    expect(r.readable).toBe(true)
    expect(r.text).toContain('Roofers in Austin price list')
  })

  it('a broken PDF, an empty text layer or binary in a text file: stored but not readable', async () => {
    expect(await extractText(enc('%PDF-1.4 garbage'), 'pdf')).toEqual({ text: null, readable: false, truncated: false })
    expect(await extractText(new Uint8Array([0, 1, 2, 0, 0, 255, 254, 0]), 'text')).toEqual({ text: null, readable: false, truncated: false })
    expect(await extractText(enc('   \n  '), 'text')).toEqual({ text: null, readable: false, truncated: false })
  })

  it('images are never extracted', async () => {
    expect(await extractText(new Uint8Array([137, 80, 78, 71]), 'image')).toEqual({ text: null, readable: false, truncated: false })
  })
})

describe('csvHead row counting', () => {
  it('blank lines are not rows; exactly 200 rows (trailing newline) is not truncated; 201 is', async () => {
    const { csvHead } = await import('@/lib/agent/projectExtract')
    const rows = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`)
    expect(csvHead(`h\n${rows(200).join('\n')}\n`).more).toBe(false)
    expect(csvHead(`h\n${rows(201).join('\n')}`).more).toBe(true)
    const gappy = csvHead(`h\n\n\nr0\n\r\nr1\n`)
    expect(gappy).toEqual({ text: 'h\nr0\nr1', more: false })
    const withBlanks = csvHead(`h\n${rows(200).join('\n\n')}\n\n\n`)
    expect(withBlanks.more).toBe(false)
    expect(withBlanks.text.split('\n')).toHaveLength(201)
  })

  it('a lone \\r ends a row too; escaped quotes stay in their field', async () => {
    const { csvHead } = await import('@/lib/agent/projectExtract')
    expect(csvHead('a,b\r1,"say ""hi""\nthere"\r2,3').text).toBe('a,b\n1,"say ""hi""\nthere"\n2,3')
  })
})
