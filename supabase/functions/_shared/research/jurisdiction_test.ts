import { assertEquals } from 'jsr:@std/assert@1'
import {
  BASE_FALLBACK_JURISDICTION_LINE,
  fallbackJurisdictionLine,
  type JurisdictionRow,
  jurisdictionLine,
  normalizeCountry,
  normalizeRegion,
  resolveJurisdiction,
} from './jurisdiction.ts'

Deno.test('normalizeCountry: names, ISO2 and common variants -> ISO2', () => {
  for (const v of ['United States', 'united states of america', 'USA', 'US', 'U.S.', 'u.s.a.']) assertEquals(normalizeCountry(v), 'US', v)
  for (const v of ['Canada', 'CA', 'ca']) assertEquals(normalizeCountry(v), 'CA', v)
  for (const v of ['United Kingdom', 'UK', 'U.K.', 'GB', 'Great Britain', 'England']) assertEquals(normalizeCountry(v), 'GB', v)
  for (const v of ['United Arab Emirates', 'UAE', 'U.A.E.', 'AE']) assertEquals(normalizeCountry(v), 'AE', v)
  for (const v of ['Australia', 'AU']) assertEquals(normalizeCountry(v), 'AU', v)
  for (const v of ['Singapore', 'SG']) assertEquals(normalizeCountry(v), 'SG', v)
  assertEquals(normalizeCountry('  united   kingdom '), 'GB')
})

Deno.test('normalizeCountry: unknown, blank or ambiguous -> null', () => {
  for (const v of ['', '   ', 'Narnia', 'America', 'North America', 'Europe', 'Texas', 'BC', null, undefined]) {
    assertEquals(normalizeCountry(v), null, String(v))
  }
})

Deno.test('normalizeRegion: names and abbreviations within the country', () => {
  assertEquals(normalizeRegion('US', 'TX'), 'Texas')
  assertEquals(normalizeRegion('US', 'texas'), 'Texas')
  assertEquals(normalizeRegion('US', 'CA'), 'California')
  assertEquals(normalizeRegion('US', 'DC'), 'District of Columbia')
  assertEquals(normalizeRegion('US', 'Washington DC'), 'District of Columbia')
  assertEquals(normalizeRegion('US', 'D.C.'), 'District of Columbia')
  assertEquals(normalizeRegion('US', 'Washington'), 'Washington')
  assertEquals(normalizeRegion('CA', 'BC'), 'British Columbia')
  assertEquals(normalizeRegion('CA', 'british columbia'), 'British Columbia')
  assertEquals(normalizeRegion('CA', 'ON'), 'Ontario')
  assertEquals(normalizeRegion('CA', 'Québec'), 'Quebec')
  assertEquals(normalizeRegion('CA', 'PEI'), 'Prince Edward Island')
  assertEquals(normalizeRegion('AU', 'NSW'), 'New South Wales')
  assertEquals(normalizeRegion('AU', 'Victoria'), 'Victoria')
  assertEquals(normalizeRegion('AU', 'ACT'), 'Australian Capital Territory')
  assertEquals(normalizeRegion('AE', 'dubai'), 'Dubai')
  assertEquals(normalizeRegion('GB', 'England'), 'England')
})

Deno.test('normalizeRegion: a region of another country, unknown, or no country -> null', () => {
  assertEquals(normalizeRegion('CA', 'TX'), null)
  assertEquals(normalizeRegion('US', 'BC'), null)
  assertEquals(normalizeRegion('US', 'Atlantis'), null)
  assertEquals(normalizeRegion('SG', 'Central'), null)
  assertEquals(normalizeRegion(null, 'Texas'), null)
  assertEquals(normalizeRegion('US', ''), null)
  assertEquals(normalizeRegion('US', null), null)
})

const row = (o: Partial<JurisdictionRow>): JurisdictionRow => ({
  country: 'US', region: null, city_match: null, jurisdiction: 'x', copy_hook: null, active: true, ...o,
})
const ROWS: JurisdictionRow[] = [
  row({ country: 'CA', region: 'British Columbia', jurisdiction: 'British Columbia', copy_hook: 'BC hook.' }),
  row({ country: 'CA', region: 'Ontario', jurisdiction: 'Ontario', copy_hook: 'ON hook.', active: false }),
  row({ country: 'US', region: 'Texas', jurisdiction: 'Texas' }),
  row({ country: 'GB', region: null, jurisdiction: 'England and Wales', copy_hook: 'UK hook.' }),
  row({ country: 'AE', region: 'Dubai', jurisdiction: 'Dubai', copy_hook: 'Dubai hook.' }),
  row({ country: 'AE', region: 'Dubai', city_match: 'Jebel Ali', jurisdiction: 'JAFZA', copy_hook: 'city hook.' }),
]

Deno.test('resolveJurisdiction: certain country + exact region', () => {
  assertEquals(resolveJurisdiction('Canada', 'BC', ROWS)?.jurisdiction, 'British Columbia')
  assertEquals(resolveJurisdiction('CA', 'British Columbia', ROWS)?.jurisdiction, 'British Columbia')
  assertEquals(resolveJurisdiction('USA', 'tx', ROWS)?.jurisdiction, 'Texas')
  assertEquals(resolveJurisdiction('UAE', 'Dubai', ROWS)?.jurisdiction, 'Dubai')
})

Deno.test('resolveJurisdiction: a country-level row (no region) matches any region of that country', () => {
  assertEquals(resolveJurisdiction('United Kingdom', null, ROWS)?.jurisdiction, 'England and Wales')
  assertEquals(resolveJurisdiction('UK', 'England', ROWS)?.jurisdiction, 'England and Wales')
  assertEquals(resolveJurisdiction('England', '', ROWS)?.jurisdiction, 'England and Wales')
})

Deno.test('resolveJurisdiction: anything uncertain -> null', () => {
  assertEquals(resolveJurisdiction(null, 'BC', ROWS), null, 'no country')
  assertEquals(resolveJurisdiction('', 'BC', ROWS), null, 'blank country')
  assertEquals(resolveJurisdiction('North America', 'BC', ROWS), null, 'unknown country')
  assertEquals(resolveJurisdiction('Canada', null, ROWS), null, 'no region and no country-level row')
  assertEquals(resolveJurisdiction('Canada', 'Alberta', ROWS), null, 'no row for that region')
  assertEquals(resolveJurisdiction('Canada', 'TX', ROWS), null, "another country's region")
  assertEquals(resolveJurisdiction('Canada', 'ON', ROWS), null, 'inactive row')
  assertEquals(resolveJurisdiction('Singapore', null, ROWS), null, 'no row for the country')
  assertEquals(resolveJurisdiction('US', 'Texas', []), null, 'no rows')
})

Deno.test('resolveJurisdiction: never picks a city-scoped row (no city is passed)', () => {
  const onlyCity = [row({ country: 'AE', region: 'Dubai', city_match: 'Jebel Ali', copy_hook: 'city hook.' })]
  assertEquals(resolveJurisdiction('UAE', 'Dubai', onlyCity), null)
})

Deno.test('jurisdictionLine: hook when the row is active and has one, else the fallback', () => {
  assertEquals(jurisdictionLine(row({ copy_hook: '  BC hook.  ' }), 'fb'), 'BC hook.')
  assertEquals(jurisdictionLine(row({ copy_hook: null }), 'fb'), 'fb')
  assertEquals(jurisdictionLine(row({ copy_hook: '   ' }), 'fb'), 'fb')
  assertEquals(jurisdictionLine(row({ copy_hook: 'hook', active: false }), 'fb'), 'fb')
  assertEquals(jurisdictionLine(null, 'fb'), 'fb')
})

Deno.test('fallbackJurisdictionLine: Kaspen campaigns get the Kaspen SOP line, anything else the base SOP line', () => {
  const kaspen = 'Without a GM, the owner becomes the middle manager.'
  assertEquals(fallbackJurisdictionLine('869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d'), kaspen)
  assertEquals(fallbackJurisdictionLine('04ca2257-5ea6-434e-bf62-f55add156914'), kaspen)
  assertEquals(fallbackJurisdictionLine('bcf7a6d2-1302-47fc-ae77-9d2a760c91c1'), kaspen)
  assertEquals(fallbackJurisdictionLine('some-other-campaign'), BASE_FALLBACK_JURISDICTION_LINE)
  assertEquals(fallbackJurisdictionLine(null), BASE_FALLBACK_JURISDICTION_LINE)
  assertEquals(BASE_FALLBACK_JURISDICTION_LINE, 'Most owners end up as the middle manager of their own portfolio.')
})
