// Country / region lookup for fact verification (research P2). Pure.
// Covers the markets in the design (US, Canada, UK, UAE); anything else is
// unknown here, so a country outside them must be named in its snippet.

const COUNTRIES: Array<{ name: string; names: string[]; short: string[] }> = [
  { name: 'United States', names: ['united states', 'united states of america', 'america'], short: ['US', 'USA', 'U.S.', 'U.S.A.'] },
  { name: 'Canada', names: ['canada', 'canadian'], short: [] },
  {
    name: 'United Kingdom',
    names: ['united kingdom', 'great britain', 'britain', 'british', 'england', 'scotland', 'wales', 'northern ireland'],
    short: ['UK', 'U.K.', 'GB'],
  },
  { name: 'United Arab Emirates', names: ['united arab emirates', 'emirates'], short: ['UAE', 'U.A.E.'] },
]

const fold = (s: string) => s.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim()

/** Country name or alias -> canonical English name, or null. */
export function canonicalCountry(value: string): string | null {
  const v = fold(value)
  for (const c of COUNTRIES) {
    if (c.names.some((n) => fold(n) === v) || c.short.some((s) => fold(s) === v)) return c.name
  }
  return null
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * True when the text names the country: a full name / adjective anywhere
 * (case-insensitive, word-bounded), or a short alias as an upper-case word
 * ("US" yes, "Contact us" no).
 */
export function countryInText(country: string, text: string): boolean {
  const c = COUNTRIES.find((x) => x.name === country)
  if (!c) return new RegExp(`\\b${esc(country)}\\b`, 'i').test(text)
  if (c.names.some((n) => new RegExp(`\\b${esc(n)}\\b`, 'i').test(text))) return true
  return c.short.some((s) => new RegExp(`(^|[^A-Za-z.])${esc(s)}(?![A-Za-z])`).test(text))
}

const REGIONS: Record<string, string[]> = {
  'Canada': [
    'AB', 'Alberta', 'BC', 'British Columbia', 'MB', 'Manitoba', 'NB', 'New Brunswick', 'NL', 'Newfoundland and Labrador',
    'Newfoundland', 'NS', 'Nova Scotia', 'NT', 'Northwest Territories', 'NU', 'Nunavut', 'ON', 'Ontario', 'PE', 'PEI',
    'Prince Edward Island', 'QC', 'Quebec', 'Québec', 'SK', 'Saskatchewan', 'YT', 'Yukon',
  ],
  'United States': [
    'AL', 'Alabama', 'AK', 'Alaska', 'AZ', 'Arizona', 'AR', 'Arkansas', 'CA', 'California', 'CO', 'Colorado', 'CT', 'Connecticut',
    'DE', 'Delaware', 'DC', 'District of Columbia', 'Washington DC', 'FL', 'Florida', 'GA', 'Georgia', 'HI', 'Hawaii', 'ID', 'Idaho',
    'IL', 'Illinois', 'IN', 'Indiana', 'IA', 'Iowa', 'KS', 'Kansas', 'KY', 'Kentucky', 'LA', 'Louisiana', 'ME', 'Maine',
    'MD', 'Maryland', 'MA', 'Massachusetts', 'MI', 'Michigan', 'MN', 'Minnesota', 'MS', 'Mississippi', 'MO', 'Missouri',
    'MT', 'Montana', 'NE', 'Nebraska', 'NV', 'Nevada', 'NH', 'New Hampshire', 'NJ', 'New Jersey', 'NM', 'New Mexico',
    'NY', 'New York', 'NC', 'North Carolina', 'ND', 'North Dakota', 'OH', 'Ohio', 'OK', 'Oklahoma', 'OR', 'Oregon',
    'PA', 'Pennsylvania', 'RI', 'Rhode Island', 'SC', 'South Carolina', 'SD', 'South Dakota', 'TN', 'Tennessee', 'TX', 'Texas',
    'UT', 'Utah', 'VT', 'Vermont', 'VA', 'Virginia', 'WA', 'Washington', 'WV', 'West Virginia', 'WI', 'Wisconsin', 'WY', 'Wyoming',
  ],
  'United Kingdom': ['England', 'Scotland', 'Wales', 'Northern Ireland', 'Greater London'],
  'United Arab Emirates': ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'],
}

const REGION_INDEX = new Map<string, string>()
for (const [country, regions] of Object.entries(REGIONS)) for (const r of regions) REGION_INDEX.set(fold(r), country)

/** Province / state / emirate / UK nation (name or postal abbreviation) -> country, or null. */
export function regionCountry(region: string): string | null {
  return REGION_INDEX.get(fold(region)) ?? null
}
