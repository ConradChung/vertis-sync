import { assertEquals } from 'jsr:@std/assert@1'
import { type Candidate, doorCountCopyValue, normalizeWs, parseDoorCount, verifyCandidates } from './verify.ts'
import type { Page } from './pms.ts'

Deno.test('doorCountCopyValue: rounds down to a clean number', () => {
  const cases: Array<[number, number]> = [
    [1237, 1200],
    [87, 80],
    [350, 350],
    [1, 1],
    [9, 9],
    [10, 10],
    [99, 90],
    [100, 100],
    [149, 140],
    [999, 990],
    [1000, 1000],
    [1999, 1900],
    [12345, 12000],
    [250000, 250000],
    [251999, 250000],
  ]
  for (const [n, want] of cases) assertEquals(doorCountCopyValue(n), want, String(n))
})

Deno.test('doorCountCopyValue: never rounds up', () => {
  for (let n = 1; n < 20000; n += 7) {
    const c = doorCountCopyValue(n)
    if (c > n) throw new Error(`${n} -> ${c}`)
  }
})

Deno.test('parseDoorCount: integers, numeric strings with separators; refuses junk', () => {
  assertEquals(parseDoorCount(1237), 1237)
  assertEquals(parseDoorCount('1,237'), 1237)
  assertEquals(parseDoorCount(' 2 500 '), 2500)
  assertEquals(parseDoorCount('1200+'), 1200)
  assertEquals(parseDoorCount(0), null)
  assertEquals(parseDoorCount(-5), null)
  assertEquals(parseDoorCount(12.5), null)
  assertEquals(parseDoorCount('about a thousand'), null)
  assertEquals(parseDoorCount(5_000_000), null)
  assertEquals(parseDoorCount(null), null)
})

Deno.test('normalizeWs collapses every whitespace run (incl. nbsp, newlines, tabs)', () => {
  assertEquals(normalizeWs('  we manage\n\n 1,237\tdoors  '), 'we manage 1,237 doors')
})

const pages: Page[] = [
  { url: 'https://acme-pm.com/', text: 'Acme Property Management\n\nWe manage   1,237 doors across Greater Vancouver.', links: [] },
  {
    url: 'https://acme-pm.com/contact',
    text: 'Office: 123 Main St, Burnaby, BC V5H 2E2. 24/7 emergency maintenance line: 604-555-0100.',
    links: [],
  },
]
const c = (x: Partial<Candidate>): Candidate => ({
  field: 'door_count',
  value: 1237,
  confidence: 'high',
  snippet: 'We manage 1,237 doors',
  source_url: 'https://acme-pm.com/',
  ...x,
})

Deno.test('verifyCandidates: keeps a value whose snippet is verbatim on its page (after whitespace normalization)', () => {
  const r = verifyCandidates([c({})], pages)
  assertEquals(r.dropped, [])
  assertEquals(r.kept, [{
    field: 'door_count',
    value: 1237,
    copy_value: 1200,
    confidence: 'high',
    snippet: 'We manage 1,237 doors',
    source_url: 'https://acme-pm.com/',
  }])
})

Deno.test('verifyCandidates: a snippet not on the page is dropped with a reason', () => {
  const r = verifyCandidates([c({ snippet: 'We manage 1,500 doors' })], pages)
  assertEquals(r.kept, [])
  assertEquals(r.dropped, [{ field: 'door_count', reason: 'snippet_not_on_page', source_url: 'https://acme-pm.com/' }])
})

Deno.test('verifyCandidates: the snippet must be on the cited page, not another crawled page', () => {
  const r = verifyCandidates([c({ source_url: 'https://acme-pm.com/contact' })], pages)
  assertEquals(r.dropped[0]?.reason, 'snippet_not_on_page')
})

Deno.test('verifyCandidates: a source URL that was not crawled is dropped', () => {
  const r = verifyCandidates([c({ source_url: 'https://elsewhere.com/' })], pages)
  assertEquals(r.dropped[0]?.reason, 'source_not_crawled')
})

Deno.test('verifyCandidates: a trailing-slash / fragment difference still finds the page', () => {
  const r = verifyCandidates([c({ source_url: 'https://acme-pm.com/contact/#top', field: 'city', value: 'Burnaby', snippet: '123 Main St, Burnaby, BC' })], pages)
  assertEquals(r.kept.length, 1)
  assertEquals(r.kept[0].source_url, 'https://acme-pm.com/contact')
})

Deno.test('verifyCandidates: case differs = not verbatim', () => {
  const r = verifyCandidates([c({ snippet: 'we manage 1,237 doors' })], pages)
  assertEquals(r.dropped[0]?.reason, 'snippet_not_on_page')
})

Deno.test('verifyCandidates: door_count must be a positive integer present in its snippet', () => {
  const r1 = verifyCandidates([c({ value: 1500 })], pages)
  assertEquals(r1.dropped[0]?.reason, 'value_not_in_snippet')
  const r2 = verifyCandidates([c({ value: 'lots' })], pages)
  assertEquals(r2.dropped[0]?.reason, 'bad_value')
  const r3 = verifyCandidates([c({ value: '1,237' })], pages)
  assertEquals(r3.kept[0]?.value, 1237)
})

Deno.test('verifyCandidates: city / region must appear in the snippet; country may be inferred', () => {
  const r = verifyCandidates([
    c({ field: 'city', value: 'Burnaby', snippet: '123 Main St, Burnaby, BC', source_url: 'https://acme-pm.com/contact' }),
    c({ field: 'region', value: 'BC', snippet: '123 Main St, Burnaby, BC', source_url: 'https://acme-pm.com/contact' }),
    c({ field: 'country', value: 'Canada', snippet: 'Burnaby, BC V5H 2E2', source_url: 'https://acme-pm.com/contact', confidence: 'medium' }),
    c({ field: 'city', value: 'Vancouver', snippet: '123 Main St, Burnaby, BC', source_url: 'https://acme-pm.com/contact' }),
  ], pages)
  assertEquals(r.kept.map((k) => [k.field, k.value]), [['city', 'Burnaby'], ['region', 'BC'], ['country', 'Canada']])
  assertEquals(r.dropped, [{ field: 'city', reason: 'value_not_in_snippet', source_url: 'https://acme-pm.com/contact' }])
})

Deno.test('verifyCandidates: after_hours is a boolean', () => {
  const ok = verifyCandidates([
    c({ field: 'after_hours', value: true, snippet: '24/7 emergency maintenance line', source_url: 'https://acme-pm.com/contact' }),
  ], pages)
  assertEquals(ok.kept[0]?.value, true)
  const bad = verifyCandidates([
    c({ field: 'after_hours', value: 'yes', snippet: '24/7 emergency maintenance line', source_url: 'https://acme-pm.com/contact' }),
  ], pages)
  assertEquals(bad.dropped[0]?.reason, 'bad_value')
})

Deno.test('verifyCandidates: unknown field, bad confidence and empty snippet are dropped', () => {
  const r = verifyCandidates([
    c({ field: 'pms' as Candidate['field'] }),
    c({ confidence: 'certain' as Candidate['confidence'] }),
    c({ snippet: '   ' }),
  ], pages)
  assertEquals(r.dropped.map((d) => d.reason), ['unknown_field', 'bad_confidence', 'empty_snippet'])
})

Deno.test('verifyCandidates: one value per field — highest confidence, then first', () => {
  const r = verifyCandidates([
    c({ confidence: 'medium' }),
    c({ confidence: 'high', value: 1237, snippet: 'manage 1,237 doors across Greater Vancouver' }),
    c({ confidence: 'high' }),
  ], pages)
  assertEquals(r.kept.length, 1)
  assertEquals(r.kept[0].snippet, 'manage 1,237 doors across Greater Vancouver')
  assertEquals(r.dropped.map((d) => d.reason), ['duplicate_field', 'duplicate_field'])
})

Deno.test('verifyCandidates: the stored snippet is whitespace-normalized and capped', () => {
  const r = verifyCandidates([c({ snippet: 'We  manage\n1,237 doors' })], pages)
  assertEquals(r.kept[0]?.snippet, 'We manage 1,237 doors')
})
