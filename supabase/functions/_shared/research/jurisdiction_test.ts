import { assertEquals } from 'jsr:@std/assert@1'
import {
  complianceLaw,
  FALLBACK_COMPLIANCE_LAW,
  type JurisdictionRow,
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
  country: 'US', region: null, city_match: null, jurisdiction: 'x', compliance_name: null, active: true, ...o,
})
const ROWS: JurisdictionRow[] = [
  row({ country: 'CA', region: 'British Columbia', jurisdiction: 'British Columbia', compliance_name: 'Residential Tenancy Act' }),
  row({ country: 'CA', region: 'Ontario', jurisdiction: 'Ontario', compliance_name: 'Residential Tenancies Act, 2006', active: false }),
  row({ country: 'US', region: 'Texas', jurisdiction: 'Texas', compliance_name: 'Texas Property Code' }),
  row({ country: 'GB', region: null, jurisdiction: 'England and Wales', compliance_name: 'Housing Act 1988' }),
  row({ country: 'AE', region: 'Dubai', jurisdiction: 'Dubai', compliance_name: 'Ejari tenancy registration' }),
  row({ country: 'AE', region: 'Dubai', city_match: 'Jebel Ali', jurisdiction: 'JAFZA', compliance_name: 'JAFZA rules' }),
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
  const onlyCity = [row({ country: 'AE', region: 'Dubai', city_match: 'Jebel Ali', compliance_name: 'JAFZA rules' })]
  assertEquals(resolveJurisdiction('UAE', 'Dubai', onlyCity), null)
})

Deno.test('complianceLaw: the active row\'s compliance_name, trimmed, without a leading "the"; else the generic fallback', () => {
  assertEquals(complianceLaw(row({ compliance_name: '  Residential Tenancies Act, 2006  ' })), 'Residential Tenancies Act, 2006')
  // Templates write "the {{compliance_law}}", so a stored "The ..." never renders "the The ...".
  assertEquals(complianceLaw(row({ compliance_name: 'The Housing Act 1988' })), 'Housing Act 1988')
  assertEquals(complianceLaw(row({ compliance_name: null })), FALLBACK_COMPLIANCE_LAW)
  assertEquals(complianceLaw(row({ compliance_name: '   ' })), FALLBACK_COMPLIANCE_LAW)
  assertEquals(complianceLaw(row({ compliance_name: 'Act', active: false })), FALLBACK_COMPLIANCE_LAW)
  assertEquals(complianceLaw(null), FALLBACK_COMPLIANCE_LAW)
})

Deno.test('FALLBACK_COMPLIANCE_LAW: one generic noun phrase for every client, reads after "the" and without it', () => {
  assertEquals(FALLBACK_COMPLIANCE_LAW, 'local landlord-tenant law')
})

Deno.test('resolveJurisdiction: an active row with no compliance_name is no match (activation = active + a name)', () => {
  const rows = [row({ country: 'CA', region: 'Ontario', compliance_name: null }), row({ country: 'CA', region: null, compliance_name: 'Canada-wide Act' })]
  assertEquals(resolveJurisdiction('Canada', 'ON', rows)?.compliance_name, 'Canada-wide Act')
  assertEquals(resolveJurisdiction('Canada', 'ON', [rows[0]]), null)
})

// The seeded UK row after lume_jurisdictions_seed_fixes: England only.
const UK_ROWS: JurisdictionRow[] = [
  row({ country: 'GB', region: 'England', jurisdiction: 'England', compliance_name: "Renters' Rights Act 2025" }),
]

Deno.test('normalizeRegion: English counties and cities are England; the other nations stay themselves', () => {
  for (const v of ['England', 'england', 'Greater London', 'London', 'City of London', 'Greater Manchester', 'West Yorkshire', 'Kent', 'Bristol']) {
    assertEquals(normalizeRegion('GB', v), 'England', v)
  }
  assertEquals(normalizeRegion('GB', 'Scotland'), 'Scotland')
  assertEquals(normalizeRegion('GB', 'Wales'), 'Wales')
  assertEquals(normalizeRegion('GB', 'Northern Ireland'), 'Northern Ireland')
  assertEquals(normalizeRegion('GB', 'Midlothian'), null)
  assertEquals(normalizeRegion('US', 'London'), null)
})

Deno.test('resolveJurisdiction (UK): England and English regions match; Scotland, Wales, NI, unknown or none fall back', () => {
  for (const r of ['England', 'Greater London', 'London', 'Greater Manchester']) {
    assertEquals(resolveJurisdiction('United Kingdom', r, UK_ROWS)?.jurisdiction, 'England', r)
  }
  for (const r of ['Scotland', 'Wales', 'Northern Ireland', 'Midlothian', 'Cardiff', '', null]) {
    assertEquals(resolveJurisdiction('UK', r, UK_ROWS), null, String(r))
  }
})
