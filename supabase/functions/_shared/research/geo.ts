// Country / region lookup for fact verification (research P2). Pure.
// Covers the markets in the design (US, Canada, UK, UAE); anything else is
// unknown here, so a country outside them must be named in its snippet.

// Full names only: adjectives and sub-regions ("British", "Canadian",
// "America", "England", "Wales", "Emirates") name other places too
// (British Columbia, North America, New England, New South Wales).
const COUNTRIES: Array<{ name: string; names: string[]; short: string[] }> = [
  { name: 'United States', names: ['united states', 'united states of america'], short: ['US', 'USA', 'U.S.', 'U.S.A.'] },
  { name: 'Canada', names: ['canada'], short: [] },
  { name: 'United Kingdom', names: ['united kingdom', 'great britain'], short: ['UK', 'U.K.', 'GB'] },
  { name: 'United Arab Emirates', names: ['united arab emirates'], short: ['UAE', 'U.A.E.'] },
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

/** Words that, right before a place name, make it part of a longer one (New England, West Virginia). */
const PLACE_PREFIX = /\b(new|north|south|east|west|northern|southern|greater|upper|lower)\s+$/i

/** Whole-word, case-insensitive, and not the tail of a longer place name. */
export function placeInText(place: string, text: string): boolean {
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${esc(place.trim())})(?![\\p{L}\\p{N}])`, 'giu')
  for (const m of text.matchAll(re)) {
    const start = m.index! + m[1].length
    if (!PLACE_PREFIX.test(text.slice(0, start))) return true
  }
  return false
}

/**
 * An upper-case code (US, ON, BC) standing alone, case-sensitive, and not
 * next to another all-caps word (separated only by spaces), so menu text like
 * "ABOUT US | CONTACT US" or "ON SALE NOW" never counts. "Toronto, ON M5V"
 * and "Austin, TX, US" do.
 */
export function codeInText(code: string, text: string): boolean {
  const re = new RegExp(`(^|[^A-Za-z.])(${esc(code)})(?![A-Za-z])`, 'g')
  for (const m of text.matchAll(re)) {
    const start = m.index! + m[1].length
    const end = start + m[2].length
    if (/\b[A-Z]{2,}\s+$/.test(text.slice(0, start))) continue
    if (/^\s+[A-Z]{2,}\b/.test(text.slice(end))) continue
    return true
  }
  return false
}

/** True when the text names the country: a full name (whole word) or a standalone short alias. */
export function countryInText(country: string, text: string): boolean {
  const c = COUNTRIES.find((x) => x.name === country)
  if (!c) return placeInText(country, text)
  return c.names.some((n) => placeInText(n, text)) || c.short.some((s) => codeInText(s, text))
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

/** A region named in the text: 2-letter codes as standalone upper-case tokens; full names whole-word. */
export function regionInText(region: string, text: string): boolean {
  const r = region.trim()
  if (/^[A-Za-z]{2}$/.test(r)) return codeInText(r.toUpperCase(), text)
  return placeInText(r, text)
}
