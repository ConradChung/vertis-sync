import { assertEquals } from 'jsr:@std/assert@1'
import { csvShape, parseCsv } from './pure.ts'

const enc = (s: string) => new TextEncoder().encode(s)

Deno.test('csvShape matches parseCsv on headers and row count', () => {
  const cases = [
    '',
    '\n\n',
    'Email,Name\n',
    'Email,Name\na@x.com,A\nb@x.com,B',
    'Email,Name\r\na@x.com,A\r\n\r\nb@x.com,B\r\n',
    '"Em,ail","N""ame"\n"a@x.com","multi\nline\r\ncell"\nb@x.com,"é ünï ✓"\n',
    '\nEmail,Name\na@x.com,A\n\n',
  ]
  for (const c of cases) {
    const full = parseCsv(c)
    assertEquals(csvShape(enc(c)), { headers: full.headers, rowCount: full.rows.length }, JSON.stringify(c))
  }
})

Deno.test('csvShape handles a large export without building rows', () => {
  const header = Array.from({ length: 70 }, (_, i) => `col${i}`).join(',')
  const row = Array.from({ length: 70 }, (_, i) => `"value ${i}, with comma"`).join(',')
  const text = header + '\n' + (row + '\n').repeat(20_000)
  const s = csvShape(enc(text))
  assertEquals(s.headers.length, 70)
  assertEquals(s.rowCount, 20_000)
})
