/**
 * Country / region normalisation for lead_bank inserts (country ISO2, region
 * canonical name, only when the country is certain). A mirror of
 * supabase/functions/_shared/research/jurisdiction.ts, which edge functions use
 * to resolve {{compliance_law}} at push time; edge functions don't share
 * code with the Next.js apps. tests/copy/jurisdiction.test.ts runs both on the
 * same inputs, so the copies can't drift silently.
 */

const fold = (s: string) => s.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim()

/** Folded name / alias -> ISO2. Same set as the edge resolver (geo.ts names + its extras). */
const COUNTRIES: Record<string, string> = {
  'united states': 'US', 'united states of america': 'US', 'us': 'US', 'usa': 'US',
  'canada': 'CA', 'ca': 'CA',
  'united kingdom': 'GB', 'great britain': 'GB', 'uk': 'GB', 'gb': 'GB', 'england': 'GB', 'britain': 'GB',
  'united arab emirates': 'AE', 'uae': 'AE', 'ae': 'AE',
  'australia': 'AU', 'commonwealth of australia': 'AU', 'au': 'AU',
  'singapore': 'SG', 'republic of singapore': 'SG', 'sg': 'SG',
}

/** Country name, ISO2 or common variant -> ISO2, or null when not certain. */
export function normalizeCountry(value: string | null | undefined): string | null {
  if (!value || !value.trim()) return null
  return COUNTRIES[fold(value)] ?? null
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


/** Raw country / region (lume_lead_bank) -> what lead_bank stores: both only when the country is certain. */
export function leadGeo(
  country: string | null | undefined,
  region: string | null | undefined
): { country: string | null; region: string | null } {
  const c = normalizeCountry(country)
  return { country: c, region: c ? normalizeRegion(c, region) : null }
}
