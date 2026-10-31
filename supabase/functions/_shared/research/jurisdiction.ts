// Per-lead compliance law (research P4, minimal). Pure.
//
// A lead's country / region (Apollo's Country / Company Country / State /
// Company State) resolves to one `jurisdictions` row only when the country is
// certain and the row is country-wide or names the same region exactly.
// Only ACTIVE rows WITH a compliance_name take part (that is what activating
// a jurisdiction means; copy_hook is no longer read).
//
// Instantly cannot fall back on its own (a missing custom variable renders
// blank), so the push always sends `compliance_law`: the matched row's
// operator short_name ("RTA", "Chapter 83", "Ejari"), else its
// compliance_name ("Residential Tenancies Act, 2006"), else
// FALLBACK_COMPLIANCE_LAW. A short_name alone never activates a row. A noun phrase used inline after "the":
// "Keeping up with the {{compliance_law}} is ...". Never blank.
//
// Lume mirrors normalizeCountry / normalizeRegion in lume/lib/copy/jurisdiction.ts
// (for lead_bank inserts); lume/tests/copy/jurisdiction.test.ts runs both on
// the same inputs and checks the fallback below against the SOP files.

import { canonicalCountry } from './geo.ts'

const fold = (s: string) => s.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim()

const ISO2_BY_NAME: Record<string, string> = {
  'United States': 'US',
  'Canada': 'CA',
  'United Kingdom': 'GB',
  'United Arab Emirates': 'AE',
}

/** Aliases geo.ts deliberately leaves out of its text matching (England is a country here, not a sub-region). */
const EXTRA_COUNTRIES: Record<string, string> = {
  'us': 'US', 'ca': 'CA', 'gb': 'GB', 'ae': 'AE', 'au': 'AU', 'sg': 'SG',
  'england': 'GB', 'britain': 'GB',
  'australia': 'AU', 'commonwealth of australia': 'AU',
  'singapore': 'SG', 'republic of singapore': 'SG',
}

/** Country name, ISO2 or common variant -> ISO2, or null when not certain. */
export function normalizeCountry(value: string | null | undefined): string | null {
  if (!value || !value.trim()) return null
  const name = canonicalCountry(value)
  if (name && ISO2_BY_NAME[name]) return ISO2_BY_NAME[name]
  return EXTRA_COUNTRIES[fold(value)] ?? null
}

/** Canonical region name -> its codes and other spellings. */
const REGIONS: Record<string, Record<string, string[]>> = {
  US: {
    'Alabama': ['AL'], 'Alaska': ['AK'], 'Arizona': ['AZ'], 'Arkansas': ['AR'], 'California': ['CA'], 'Colorado': ['CO'],
    'Connecticut': ['CT'], 'Delaware': ['DE'], 'District of Columbia': ['DC', 'Washington DC', 'Washington, DC', 'Washington D.C.'],
    'Florida': ['FL'], 'Georgia': ['GA'], 'Hawaii': ['HI'], 'Idaho': ['ID'], 'Illinois': ['IL'], 'Indiana': ['IN'], 'Iowa': ['IA'],
    'Kansas': ['KS'], 'Kentucky': ['KY'], 'Louisiana': ['LA'], 'Maine': ['ME'], 'Maryland': ['MD'], 'Massachusetts': ['MA'],
    'Michigan': ['MI'], 'Minnesota': ['MN'], 'Mississippi': ['MS'], 'Missouri': ['MO'], 'Montana': ['MT'], 'Nebraska': ['NE'],
    'Nevada': ['NV'], 'New Hampshire': ['NH'], 'New Jersey': ['NJ'], 'New Mexico': ['NM'], 'New York': ['NY'],
    'North Carolina': ['NC'], 'North Dakota': ['ND'], 'Ohio': ['OH'], 'Oklahoma': ['OK'], 'Oregon': ['OR'], 'Pennsylvania': ['PA'],
    'Rhode Island': ['RI'], 'South Carolina': ['SC'], 'South Dakota': ['SD'], 'Tennessee': ['TN'], 'Texas': ['TX'], 'Utah': ['UT'],
    'Vermont': ['VT'], 'Virginia': ['VA'], 'Washington': ['WA'], 'West Virginia': ['WV'], 'Wisconsin': ['WI'], 'Wyoming': ['WY'],
  },
  CA: {
    'Alberta': ['AB'], 'British Columbia': ['BC'], 'Manitoba': ['MB'], 'New Brunswick': ['NB'],
    'Newfoundland and Labrador': ['NL', 'Newfoundland'], 'Northwest Territories': ['NT'], 'Nova Scotia': ['NS'],
    'Nunavut': ['NU'], 'Ontario': ['ON'], 'Prince Edward Island': ['PE', 'PEI'], 'Quebec': ['QC', 'Québec'],
    'Saskatchewan': ['SK'], 'Yukon': ['YT', 'Yukon Territory'],
  },
  AU: {
    'New South Wales': ['NSW'], 'Victoria': ['VIC'], 'Queensland': ['QLD'], 'Western Australia': ['WA'],
    'South Australia': ['SA'], 'Tasmania': ['TAS'], 'Australian Capital Territory': ['ACT'], 'Northern Territory': ['NT'],
  },
  // Apollo's State for UK leads is usually "England", sometimes a county or city.
  // Exact matches only; anything not listed falls back.
  GB: {
    'England': [
      'Greater London', 'London', 'City of London', 'Greater Manchester', 'Manchester', 'West Midlands', 'Birmingham',
      'West Yorkshire', 'Leeds', 'South Yorkshire', 'Sheffield', 'North Yorkshire', 'East Riding of Yorkshire', 'Merseyside',
      'Liverpool', 'Tyne and Wear', 'Newcastle upon Tyne', 'Bristol', 'City of Bristol', 'Kent', 'Essex', 'Surrey', 'Hampshire',
      'Hertfordshire', 'Berkshire', 'Buckinghamshire', 'Oxfordshire', 'Cambridgeshire', 'Bedfordshire', 'Northamptonshire',
      'Lancashire', 'Cheshire', 'Cumbria', 'Durham', 'County Durham', 'Northumberland', 'Lincolnshire', 'Nottinghamshire',
      'Nottingham', 'Leicestershire', 'Leicester', 'Derbyshire', 'Staffordshire', 'Warwickshire', 'Worcestershire',
      'Shropshire', 'Herefordshire', 'Gloucestershire', 'Wiltshire', 'Somerset', 'Dorset', 'Devon', 'Cornwall', 'Norfolk',
      'Suffolk', 'East Sussex', 'West Sussex', 'Sussex', 'Isle of Wight', 'Rutland',
    ],
    'Scotland': [], 'Wales': [], 'Northern Ireland': [],
  },
  AE: {
    'Dubai': [], 'Abu Dhabi': [], 'Sharjah': [], 'Ajman': [], 'Umm Al Quwain': [], 'Ras Al Khaimah': [], 'Fujairah': [],
  },
}

const REGION_INDEX = new Map<string, Map<string, string>>()
for (const [country, regions] of Object.entries(REGIONS)) {
  const idx = new Map<string, string>()
  for (const [name, aliases] of Object.entries(regions)) for (const a of [name, ...aliases]) idx.set(fold(a), name)
  REGION_INDEX.set(country, idx)
}

/** Region name or abbreviation -> canonical name, within an ISO2 country; null when unknown there. */
export function normalizeRegion(country: string | null | undefined, value: string | null | undefined): string | null {
  if (!country || !value || !value.trim()) return null
  return REGION_INDEX.get(country)?.get(fold(value)) ?? null
}

/** The `jurisdictions` columns the resolver reads. */
export interface JurisdictionRow {
  country: string
  region: string | null
  city_match: string | null
  jurisdiction: string
  compliance_name: string | null
  /** Operator shorthand ("RTA", "Chapter 83"), sent instead of compliance_name when set. */
  short_name?: string | null
  active: boolean
}

const hasName = (x: JurisdictionRow) => !!(x.compliance_name ?? '').trim()

/**
 * The matching active row that has a compliance_name, or null. Matches only when the country is certain
 * AND the row has no region or the same region exactly; a region-specific row
 * beats a country-wide one. City-scoped rows never match (no city is passed).
 */
export function resolveJurisdiction<R extends JurisdictionRow>(
  country: string | null | undefined,
  region: string | null | undefined,
  rows: R[],
): R | null {
  const c = normalizeCountry(country)
  if (!c) return null
  const r = normalizeRegion(c, region)
  const candidates = rows.filter((x) => x.active && hasName(x) && x.country === c && !(x.city_match ?? '').trim())
  if (r) {
    const exact = candidates.find((x) => x.region && (normalizeRegion(c, x.region) ?? x.region.trim()) === r)
    if (exact) return exact
  }
  return candidates.find((x) => !(x.region ?? '').trim()) ?? null
}

/**
 * {{compliance_law}}'s value when nothing matches: the same for every client
 * (lume/sops `fallbacks.compliance_law`, checked by
 * lume/tests/copy/jurisdiction.test.ts). Reads right after "the" and without it.
 */
export const FALLBACK_COMPLIANCE_LAW = 'local landlord-tenant law'

/**
 * For an active row: its short_name, else its compliance_name (trimmed, a
 * leading "The " dropped: templates write "the {{compliance_law}}"); else
 * the fallback.
 */
export function complianceLaw(row: JurisdictionRow | null | undefined): string {
  if (!row?.active) return FALLBACK_COMPLIANCE_LAW
  const clean = (v: string | null | undefined) => (v ?? '').trim().replace(/^the\s+/i, '')
  return clean(row.short_name) || clean(row.compliance_name) || FALLBACK_COMPLIANCE_LAW
}
