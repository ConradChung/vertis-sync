// Per-lead jurisdiction (research P4, minimal). Pure.
//
// A lead's country / region (Apollo's Country / Company Country / State /
// Company State) resolves to one `jurisdictions` row only when the country is
// certain and the row is country-wide or names the same region exactly.
// Anything else is no match, and the lead gets the SOP's fallback sentence.
//
// Instantly cannot fall back on its own (a missing custom variable renders
// blank), so the push sends a whole sentence as `jurisdiction_line`: the
// row's copy_hook, or the fallback. Never blank.
//
// Lume mirrors normalizeCountry / normalizeRegion in lume/lib/copy/jurisdiction.ts
// (for lead_bank inserts); lume/tests/copy/jurisdiction.test.ts runs both on
// the same inputs and checks the fallbacks below against the SOP files.

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
  GB: { 'England': [], 'Scotland': [], 'Wales': [], 'Northern Ireland': [] },
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
  copy_hook: string | null
  active: boolean
}

/**
 * The matching active row, or null. Matches only when the country is certain
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
  const candidates = rows.filter((x) => x.active && x.country === c && !(x.city_match ?? '').trim())
  if (r) {
    const exact = candidates.find((x) => x.region && (normalizeRegion(c, x.region) ?? x.region.trim()) === r)
    if (exact) return exact
  }
  return candidates.find((x) => !(x.region ?? '').trim()) ?? null
}

/** The row's copy_hook when it exists, is active and has one; otherwise the fallback sentence. */
export function jurisdictionLine(row: JurisdictionRow | null | undefined, fallback: string): string {
  const hook = row?.active ? (row.copy_hook ?? '').trim() : ''
  return hook || fallback
}

// ---- Fallback sentences ----
// Edge functions cannot read Lume's SOP files, so the `fallbacks.jurisdiction_line`
// sentences live here too, keyed by the Instantly campaign ids each client
// overlay pins (`match.campaign_ids`). lume/tests/copy/jurisdiction.test.ts
// fails if these drift from lume/sops/.

/** lume/sops/cold-email-sop.md `fallbacks.jurisdiction_line`. */
export const BASE_FALLBACK_JURISDICTION_LINE = 'Most owners end up as the middle manager of their own portfolio.'

const KASPEN_FALLBACK = 'Without a GM, the owner becomes the middle manager.'

/** lume/sops/clients/*.md `fallbacks.jurisdiction_line`, by pinned campaign id. */
export const CAMPAIGN_FALLBACK_JURISDICTION_LINES: Readonly<Record<string, string>> = {
  '04ca2257-5ea6-434e-bf62-f55add156914': KASPEN_FALLBACK,
  '869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d': KASPEN_FALLBACK,
  'bcf7a6d2-1302-47fc-ae77-9d2a760c91c1': KASPEN_FALLBACK,
}

export function fallbackJurisdictionLine(campaignId: string | null | undefined): string {
  return (campaignId && CAMPAIGN_FALLBACK_JURISDICTION_LINES[campaignId]) || BASE_FALLBACK_JURISDICTION_LINE
}
