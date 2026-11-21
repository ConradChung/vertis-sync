import type { PortalLead } from '@/lib/portal/types'

/**
 * Best-effort IANA zone for a lead whose row has no `timezone`, derived from
 * country + state. Pure and table-driven: US states, Canadian provinces and
 * Australian states map to their primary zone; single-zone countries map
 * directly. Anything ambiguous (a multi-zone country without a known state,
 * or no country at all) is null rather than a guess.
 */

const norm = (s: string | null | undefined) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim()

// name → [abbreviation, zone]
const US: Record<string, [string, string]> = {
  alabama: ['AL', 'America/Chicago'],
  alaska: ['AK', 'America/Anchorage'],
  arizona: ['AZ', 'America/Phoenix'],
  arkansas: ['AR', 'America/Chicago'],
  california: ['CA', 'America/Los_Angeles'],
  colorado: ['CO', 'America/Denver'],
  connecticut: ['CT', 'America/New_York'],
  delaware: ['DE', 'America/New_York'],
  'district of columbia': ['DC', 'America/New_York'],
  florida: ['FL', 'America/New_York'],
  georgia: ['GA', 'America/New_York'],
  hawaii: ['HI', 'Pacific/Honolulu'],
  idaho: ['ID', 'America/Boise'],
  illinois: ['IL', 'America/Chicago'],
  indiana: ['IN', 'America/Indiana/Indianapolis'],
  iowa: ['IA', 'America/Chicago'],
  kansas: ['KS', 'America/Chicago'],
  kentucky: ['KY', 'America/New_York'],
  louisiana: ['LA', 'America/Chicago'],
  maine: ['ME', 'America/New_York'],
  maryland: ['MD', 'America/New_York'],
  massachusetts: ['MA', 'America/New_York'],
  michigan: ['MI', 'America/Detroit'],
  minnesota: ['MN', 'America/Chicago'],
  mississippi: ['MS', 'America/Chicago'],
  missouri: ['MO', 'America/Chicago'],
  montana: ['MT', 'America/Denver'],
  nebraska: ['NE', 'America/Chicago'],
  nevada: ['NV', 'America/Los_Angeles'],
  'new hampshire': ['NH', 'America/New_York'],
  'new jersey': ['NJ', 'America/New_York'],
  'new mexico': ['NM', 'America/Denver'],
  'new york': ['NY', 'America/New_York'],
  'north carolina': ['NC', 'America/New_York'],
  'north dakota': ['ND', 'America/Chicago'],
  ohio: ['OH', 'America/New_York'],
  oklahoma: ['OK', 'America/Chicago'],
  oregon: ['OR', 'America/Los_Angeles'],
  pennsylvania: ['PA', 'America/New_York'],
  'rhode island': ['RI', 'America/New_York'],
  'south carolina': ['SC', 'America/New_York'],
  'south dakota': ['SD', 'America/Chicago'],
  tennessee: ['TN', 'America/Chicago'],
  texas: ['TX', 'America/Chicago'],
  utah: ['UT', 'America/Denver'],
  vermont: ['VT', 'America/New_York'],
  virginia: ['VA', 'America/New_York'],
  washington: ['WA', 'America/Los_Angeles'],
  'west virginia': ['WV', 'America/New_York'],
  wisconsin: ['WI', 'America/Chicago'],
  wyoming: ['WY', 'America/Denver'],
  'puerto rico': ['PR', 'America/Puerto_Rico'],
}

const CA: Record<string, [string, string]> = {
  alberta: ['AB', 'America/Edmonton'],
  'british columbia': ['BC', 'America/Vancouver'],
  manitoba: ['MB', 'America/Winnipeg'],
  'new brunswick': ['NB', 'America/Moncton'],
  'newfoundland and labrador': ['NL', 'America/St_Johns'],
  newfoundland: ['NL', 'America/St_Johns'],
  'nova scotia': ['NS', 'America/Halifax'],
  ontario: ['ON', 'America/Toronto'],
  'prince edward island': ['PE', 'America/Halifax'],
  quebec: ['QC', 'America/Toronto'],
  saskatchewan: ['SK', 'America/Regina'],
  yukon: ['YT', 'America/Whitehorse'],
  'northwest territories': ['NT', 'America/Yellowknife'],
  nunavut: ['NU', 'America/Iqaluit'],
}

const AU: Record<string, [string, string]> = {
  'new south wales': ['NSW', 'Australia/Sydney'],
  victoria: ['VIC', 'Australia/Melbourne'],
  queensland: ['QLD', 'Australia/Brisbane'],
  'western australia': ['WA', 'Australia/Perth'],
  'south australia': ['SA', 'Australia/Adelaide'],
  tasmania: ['TAS', 'Australia/Hobart'],
  'australian capital territory': ['ACT', 'Australia/Sydney'],
  'northern territory': ['NT', 'Australia/Darwin'],
}

/** Countries on one zone (or where one zone covers essentially everyone). Keys are normalised names and ISO codes. */
const SINGLE: Record<string, string> = {}
const single = (zone: string, ...names: string[]) => names.forEach((n) => (SINGLE[norm(n)] = zone))
single('Europe/London', 'United Kingdom', 'UK', 'GB', 'Great Britain', 'England', 'Scotland', 'Wales', 'Northern Ireland')
single('Europe/Dublin', 'Ireland', 'IE')
single('Asia/Dubai', 'United Arab Emirates', 'UAE', 'AE')
single('Pacific/Auckland', 'New Zealand', 'NZ')
single('Asia/Singapore', 'Singapore', 'SG')
single('Asia/Hong_Kong', 'Hong Kong', 'HK')
single('Europe/Berlin', 'Germany', 'DE')
single('Europe/Paris', 'France', 'FR')
single('Europe/Madrid', 'Spain', 'ES')
single('Europe/Rome', 'Italy', 'IT')
single('Europe/Amsterdam', 'Netherlands', 'NL')
single('Europe/Brussels', 'Belgium', 'BE')
single('Europe/Zurich', 'Switzerland', 'CH')
single('Europe/Vienna', 'Austria', 'AT')
single('Europe/Stockholm', 'Sweden', 'SE')
single('Europe/Oslo', 'Norway', 'NO')
single('Europe/Copenhagen', 'Denmark', 'DK')
single('Europe/Helsinki', 'Finland', 'FI')
single('Europe/Warsaw', 'Poland', 'PL')
single('Europe/Lisbon', 'Portugal', 'PT')
single('Europe/Athens', 'Greece', 'GR')
single('Europe/Prague', 'Czech Republic', 'Czechia', 'CZ')
single('Europe/Istanbul', 'Turkey', 'Turkiye', 'TR')
single('Asia/Jerusalem', 'Israel', 'IL')
single('Asia/Riyadh', 'Saudi Arabia', 'SA')
single('Asia/Qatar', 'Qatar', 'QA')
single('Asia/Bahrain', 'Bahrain', 'BH')
single('Asia/Kuwait', 'Kuwait', 'KW')
single('Asia/Muscat', 'Oman', 'OM')
single('Asia/Kolkata', 'India', 'IN')
single('Asia/Karachi', 'Pakistan', 'PK')
single('Asia/Dhaka', 'Bangladesh', 'BD')
single('Asia/Manila', 'Philippines', 'PH')
single('Asia/Tokyo', 'Japan', 'JP')
single('Asia/Seoul', 'South Korea', 'Korea', 'KR')
single('Asia/Shanghai', 'China', 'CN')
single('Asia/Taipei', 'Taiwan', 'TW')
single('Asia/Bangkok', 'Thailand', 'TH')
single('Asia/Kuala_Lumpur', 'Malaysia', 'MY')
single('Asia/Ho_Chi_Minh', 'Vietnam', 'Viet Nam', 'VN')
single('Africa/Johannesburg', 'South Africa', 'ZA')
single('Africa/Cairo', 'Egypt', 'EG')
single('Africa/Lagos', 'Nigeria', 'NG')
single('Africa/Nairobi', 'Kenya', 'KE')
single('America/Lima', 'Peru', 'PE')
single('America/Bogota', 'Colombia', 'CO')
single('America/Argentina/Buenos_Aires', 'Argentina', 'AR')
single('America/El_Salvador', 'El Salvador', 'SV')
single('America/Costa_Rica', 'Costa Rica', 'CR')
single('America/Panama', 'Panama', 'PA')
single('America/Guatemala', 'Guatemala', 'GT')
single('America/Puerto_Rico', 'Puerto Rico', 'PR')

type Multi = 'us' | 'ca' | 'au' | 'mx'
const MULTI: Record<string, Multi> = {}
const multi = (k: Multi, ...names: string[]) => names.forEach((n) => (MULTI[norm(n)] = k))
multi('us', 'United States', 'United States of America', 'USA', 'US')
multi('ca', 'Canada', 'CA')
multi('au', 'Australia', 'AU')
multi('mx', 'Mexico', 'MX')

const TABLES = { us: US, ca: CA, au: AU } as const

/** [abbreviation, zone] for a state/province by name or abbreviation within one of the tables. */
function lookupState(table: Record<string, [string, string]>, state: string | null | undefined): [string, string] | null {
  const s = norm(state)
  if (!s) return null
  if (table[s]) return table[s]
  for (const v of Object.values(table)) if (norm(v[0]) === s) return v
  return null
}

function countryKind(country: string | null | undefined): Multi | 'single' | null {
  const c = norm(country)
  if (!c) return null
  if (MULTI[c]) return MULTI[c]
  return SINGLE[c] ? 'single' : null
}

/** Big cities, for rows in a multi-zone country that name a city but no state. */
const CITY: Record<'us' | 'ca' | 'au', Record<string, string>> = {
  us: {
    'new york': 'America/New_York',
    boston: 'America/New_York',
    miami: 'America/New_York',
    atlanta: 'America/New_York',
    washington: 'America/New_York',
    philadelphia: 'America/New_York',
    chicago: 'America/Chicago',
    dallas: 'America/Chicago',
    houston: 'America/Chicago',
    austin: 'America/Chicago',
    'san antonio': 'America/Chicago',
    nashville: 'America/Chicago',
    denver: 'America/Denver',
    phoenix: 'America/Phoenix',
    'los angeles': 'America/Los_Angeles',
    'san francisco': 'America/Los_Angeles',
    'san diego': 'America/Los_Angeles',
    seattle: 'America/Los_Angeles',
    portland: 'America/Los_Angeles',
    'las vegas': 'America/Los_Angeles',
  },
  ca: {
    toronto: 'America/Toronto',
    ottawa: 'America/Toronto',
    montreal: 'America/Toronto',
    mississauga: 'America/Toronto',
    vancouver: 'America/Vancouver',
    calgary: 'America/Edmonton',
    edmonton: 'America/Edmonton',
    winnipeg: 'America/Winnipeg',
    halifax: 'America/Halifax',
    regina: 'America/Regina',
    saskatoon: 'America/Regina',
  },
  au: {
    sydney: 'Australia/Sydney',
    bankstown: 'Australia/Sydney',
    parramatta: 'Australia/Sydney',
    canberra: 'Australia/Sydney',
    newcastle: 'Australia/Sydney',
    melbourne: 'Australia/Melbourne',
    brisbane: 'Australia/Brisbane',
    'gold coast': 'Australia/Brisbane',
    perth: 'Australia/Perth',
    adelaide: 'Australia/Adelaide',
    hobart: 'Australia/Hobart',
    darwin: 'Australia/Darwin',
  },
}

/** The lead's IANA zone: its own `timezone` when set, else derived from country + state, else null. */
export function zoneFor(lead: Pick<PortalLead, 'timezone' | 'country' | 'state'> & Partial<Pick<PortalLead, 'city'>>): string | null {
  if (lead.timezone) return lead.timezone
  const kind = countryKind(lead.country)
  if (!kind) return null
  if (kind === 'single') return SINGLE[norm(lead.country)]
  if (kind === 'mx') {
    const s = norm(lead.state)
    if (!s) return null
    return s === 'baja california' ? 'America/Tijuana' : s === 'baja california sur' || s === 'sonora' || s === 'sinaloa' ? null : 'America/Mexico_City'
  }
  return lookupState(TABLES[kind], lead.state)?.[1] ?? (lead.state ? null : (CITY[kind][norm(lead.city)] ?? null))
}

/** "TX" for Texas (US), "ON" for Ontario, "NSW" for New South Wales; null when not one of those countries/states. */
export function stateAbbr(country: string | null | undefined, state: string | null | undefined): string | null {
  const kind = countryKind(country)
  if (kind !== 'us' && kind !== 'ca' && kind !== 'au') return null
  return lookupState(TABLES[kind], state)?.[0] ?? null
}

/** True for the United States in any of its usual spellings. */
export const isUS = (country: string | null | undefined) => countryKind(country) === 'us'
