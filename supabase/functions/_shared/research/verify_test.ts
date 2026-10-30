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

// --- value support (review item 2) ----------------------------------------------

const p2: Page[] = [
  {
    url: 'https://acme-pm.com/',
    text: 'Since 1998 we have served Vancouver owners. We manage 1,237 doors across 40 buildings. ' +
      'Founded in 2005. Our team of 25 handles 350 residential rental units. Contact us today. ' +
      'Proudly Canadian. Serving the United States and Canada. Offices in Dubai, UAE.',
    links: [],
  },
  {
    url: 'https://acme-pm.com/contact',
    text: 'Office: 123 Main St, Burnaby, BC V5H 2E2. Call 604-555-0100. After-hours emergency line: 604-555-0199. ' +
      'Our answering service picks up at night. Monday to Friday 9am-5pm. Doors under management: 2,400',
    links: [],
  },
]
const at = (x: Partial<Candidate>) => verifyCandidates([c(x)], p2)

Deno.test('door_count: "Since 1998" is not a door count (a year, no unit word)', () => {
  assertEquals(at({ value: 1998, snippet: 'Since 1998 we have served Vancouver owners.' }).dropped[0]?.reason, 'no_unit_word')
  assertEquals(at({ value: 2005, snippet: 'Founded in 2005.' }).dropped[0]?.reason, 'no_unit_word')
})

Deno.test('door_count: a number without a unit word nearby is refused', () => {
  assertEquals(at({ value: 25, snippet: 'Our team of 25 handles 350 residential rental units.' }).dropped[0]?.reason, 'no_unit_word')
  assertEquals(at({ value: 40, snippet: 'We manage 1,237 doors across 40 buildings.' }).dropped[0]?.reason, 'no_unit_word')
})

Deno.test('door_count: unit word within ~3 tokens after or before the number', () => {
  assertEquals(at({ value: 1237, snippet: 'We manage 1,237 doors' }).kept[0]?.value, 1237)
  assertEquals(at({ value: 350, snippet: 'handles 350 residential rental units' }).kept[0]?.value, 350)
  assertEquals(at({ value: 2400, snippet: 'Doors under management: 2,400', source_url: 'https://acme-pm.com/contact' }).kept[0]?.value, 2400)
})

Deno.test('after_hours: the snippet must carry an after-hours keyword', () => {
  const ok = (snippet: string) => at({ field: 'after_hours', value: true, snippet, source_url: 'https://acme-pm.com/contact' })
  assertEquals(ok('After-hours emergency line: 604-555-0199.').kept.length, 1)
  assertEquals(ok('Our answering service picks up at night.').kept.length, 1)
  assertEquals(ok('Call 604-555-0100.').dropped[0]?.reason, 'no_after_hours_keyword')
  assertEquals(ok('Monday to Friday 9am-5pm.').dropped[0]?.reason, 'no_after_hours_keyword')
  assertEquals(at({ field: 'after_hours', value: true, snippet: 'Contact us today.' }).dropped[0]?.reason, 'no_after_hours_keyword')
})

Deno.test('country: named (or a common alias) in the snippet', () => {
  const kept = (value: string, snippet: string) => at({ field: 'country', value, snippet }).kept[0]?.value
  assertEquals(kept('Canada', 'Serving the United States and Canada.'), 'Canada')
  assertEquals(at({ field: 'country', value: 'Canada', snippet: 'Proudly Canadian.' }).kept.length, 0) // adjectives are not countries
  assertEquals(kept('United Arab Emirates', 'Offices in Dubai, UAE.'), 'United Arab Emirates')
  assertEquals(kept('USA', 'Serving the United States and Canada.'), 'United States')
})

Deno.test('country: "Contact us" is not the United States (short aliases are case-sensitive words)', () => {
  assertEquals(at({ field: 'country', value: 'United States', snippet: 'Contact us today.' }).dropped[0]?.reason, 'country_not_supported')
  assertEquals(at({ field: 'country', value: 'US', snippet: 'Contact us today.' }).dropped[0]?.reason, 'country_not_supported')
})

Deno.test('country: derived from a verified region (province/state -> country), else refused', () => {
  const contact = 'https://acme-pm.com/contact'
  const r = verifyCandidates([
    c({ field: 'region', value: 'BC', snippet: '123 Main St, Burnaby, BC', source_url: contact }),
    c({ field: 'country', value: 'Canada', snippet: 'Burnaby, BC V5H 2E2', source_url: contact }),
  ], p2)
  assertEquals(r.kept.map((k) => [k.field, k.value]), [['region', 'BC'], ['country', 'Canada']])
  const wrong = verifyCandidates([
    c({ field: 'region', value: 'BC', snippet: '123 Main St, Burnaby, BC', source_url: contact }),
    c({ field: 'country', value: 'United States', snippet: 'Burnaby, BC V5H 2E2', source_url: contact }),
  ], p2)
  assertEquals(wrong.dropped.map((d) => d.reason), ['country_not_supported'])
  const noRegion = verifyCandidates([c({ field: 'country', value: 'Canada', snippet: 'Burnaby, BC V5H 2E2', source_url: contact })], p2)
  assertEquals(noRegion.dropped.map((d) => d.reason), ['country_not_supported'])
})

// --- round-2 review I1: country / region / city ---------------------------------------

const one = (text: string, cands: Partial<Candidate>[]) => {
  const pages: Page[] = [{ url: 'https://x.com/', text, links: [] }]
  const r = verifyCandidates(cands.map((x) => c({ source_url: 'https://x.com/', confidence: 'high', snippet: text, ...x })), pages)
  return r.kept.map((k) => `${k.field}=${k.value}`)
}

Deno.test('I1 probe cases are all rejected', () => {
  assertEquals(one('ABOUT US | CONTACT US', [{ field: 'country', value: 'United States' }]), [])
  assertEquals(one('Vancouver, British Columbia', [{ field: 'country', value: 'United Kingdom' }]), [])
  assertEquals(one('Serving New England since 1990', [{ field: 'country', value: 'UK' }]), [])
  assertEquals(one('Serving clients across North America', [{ field: 'country', value: 'USA' }]), [])
  assertEquals(one('Sydney, New South Wales', [{ field: 'country', value: 'United Kingdom' }]), [])
  assertEquals(one('Contact our team today', [{ field: 'region', value: 'ON' }, { field: 'country', value: 'Canada' }]), [])
  assertEquals(one('Homes in Toronto', [{ field: 'region', value: 'IN' }, { field: 'country', value: 'United States' }]), [])
})

Deno.test('I1 positives are kept', () => {
  assertEquals(one('Toronto, ON M5V 2T6', [{ field: 'city', value: 'Toronto' }, { field: 'region', value: 'ON' }, { field: 'country', value: 'Canada' }]),
    ['city=Toronto', 'region=ON', 'country=Canada'])
  assertEquals(one('Vancouver, BC', [{ field: 'region', value: 'BC' }, { field: 'country', value: 'Canada' }]), ['region=BC', 'country=Canada'])
  assertEquals(one('Austin, Texas, USA', [{ field: 'city', value: 'Austin' }, { field: 'region', value: 'Texas' }, { field: 'country', value: 'USA' }]),
    ['city=Austin', 'region=Texas', 'country=United States'])
  assertEquals(one('London, United Kingdom', [{ field: 'city', value: 'London' }, { field: 'country', value: 'United Kingdom' }]),
    ['city=London', 'country=United Kingdom'])
})

Deno.test('city matches whole words only', () => {
  assertEquals(one('Read the New Yorker', [{ field: 'city', value: 'York' }]), [])
})


// --- round-2 review minors -----------------------------------------------------------

Deno.test('door_count: "properties" is not a unit word (40 properties totaling 2,400 units keeps 2,400 only)', () => {
  const t = 'We manage 40 properties totaling 2,400 units'
  assertEquals(one(t, [{ field: 'door_count', value: 40 }]), [])
  assertEquals(one(t, [{ field: 'door_count', value: 2400 }]), ['door_count=2400'])
})

Deno.test('door_count: the unit window stops at sentence punctuation', () => {
  assertEquals(one('Founded in 1998. Units available now', [{ field: 'door_count', value: 1998 }]), [])
  assertEquals(one('Est. 2001 | Homes for rent', [{ field: 'door_count', value: 2001 }]), [])
  assertEquals(one('Our 25 property managers', [{ field: 'door_count', value: 25 }]), [])
})

Deno.test('after_hours: bare "nights" is not after-hours coverage; specific phrasing is', () => {
  const ah = (t: string) => one(t, [{ field: 'after_hours', value: true }])
  assertEquals(ah('Open Saturday nights for showings'), [])
  assertEquals(ah('Overnight parking available'), [])
  assertEquals(ah('Emergency exits are marked'), [])
  assertEquals(ah('24/7 maintenance'), ['after_hours=true'])
  assertEquals(ah('Maintenance available 24 hours a day'), ['after_hours=true'])
  assertEquals(ah('Call our emergency maintenance line'), ['after_hours=true'])
  assertEquals(ah('An on-call technician handles urgent repairs'), ['after_hours=true'])
  assertEquals(ah('Maintenance requests answered evenings and weekends'), ['after_hours=true'])
  assertEquals(ah('Our office is open evenings and weekends'), [])
})
