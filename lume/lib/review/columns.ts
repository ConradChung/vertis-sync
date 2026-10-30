/**
 * Column mapping for a spreadsheet that becomes a lead review set (pure).
 * The review set normalises each row with `normaliseLead` (the same
 * normalisation load_actor_results uses), which picks fields by key
 * aliases. A spreadsheet's headers are free-form, so the mapping is detected
 * here, shown to the agent, and applied by writing each mapped value under
 * the key `normaliseLead` reads first; every original column stays in `raw`.
 */

export const LEAD_FIELDS = [
  'full_name',
  'first_name',
  'last_name',
  'title',
  'company',
  'website',
  'email',
  'phone',
  'linkedin_url',
  'city',
  'state',
  'country',
] as const
export type LeadField = (typeof LEAD_FIELDS)[number]

/** Header aliases (lowercase, no spaces / _ . -), most specific first. */
const ALIASES: Record<LeadField, string[]> = {
  full_name: ['fullname', 'name', 'personname', 'contactname', 'contact'],
  first_name: ['firstname', 'first', 'givenname', 'fname'],
  last_name: ['lastname', 'last', 'surname', 'familyname', 'lname'],
  title: ['jobtitle', 'persontitle', 'position', 'role', 'title'],
  company: ['companyname', 'company', 'organizationname', 'organisationname', 'organization', 'organisation', 'businessname', 'accountname', 'account', 'employer'],
  website: ['website', 'websiteurl', 'companywebsite', 'companydomain', 'domain', 'url', 'site', 'web'],
  email: ['email', 'emailaddress', 'workemail', 'businessemail', 'contactemail', 'emails', 'mail'],
  phone: ['phone', 'phonenumber', 'mobile', 'mobilephone', 'directphone', 'workphone', 'telephone', 'companyphone', 'tel'],
  linkedin_url: ['linkedinurl', 'personlinkedinurl', 'linkedinprofile', 'linkedinprofileurl', 'linkedin', 'profileurl'],
  city: ['city', 'town', 'locality'],
  state: ['state', 'stateregion', 'province', 'region', 'county'],
  country: ['country', 'countrycode', 'countryname'],
}

/** The key normaliseLead / normaliseRecord look at first for each field. */
export const CANONICAL_KEY: Record<LeadField, string> = {
  full_name: 'fullname',
  first_name: 'firstname',
  last_name: 'lastname',
  title: 'jobtitle',
  company: 'companyname',
  website: 'website',
  email: 'email',
  phone: 'phone',
  linkedin_url: 'linkedinurl',
  city: 'city',
  state: 'state',
  country: 'country',
}

const norm = (h: string) => h.toLowerCase().replace(/[\s_.\-/()]/g, '')

export type ColumnMapping = Partial<Record<LeadField, string>>

/**
 * Field → header, detected from aliases, with `overrides` (field → header
 * name, as the agent passes them) winning. A header feeds one field at most.
 * "Title" counts as the job title (a lead list), never the company.
 * Throws `UnknownColumnError` for an override naming a header that is not there.
 */
export function leadColumnMapping(header: readonly string[], overrides: ColumnMapping = {}): { mapping: ColumnMapping; unmapped: string[] } {
  const used = new Set<string>()
  const mapping: ColumnMapping = {}
  for (const [field, h] of Object.entries(overrides) as [LeadField, string][]) {
    if (!h) continue
    const found = header.find((x) => x === h) ?? header.find((x) => x.toLowerCase() === h.trim().toLowerCase())
    if (!found) throw new UnknownColumnError(field, h)
    mapping[field] = found
    used.add(found)
  }
  for (const field of LEAD_FIELDS) {
    if (mapping[field]) continue
    for (const alias of ALIASES[field]) {
      const hit = header.find((x) => !used.has(x) && norm(x) === alias)
      if (hit) {
        mapping[field] = hit
        used.add(hit)
        break
      }
    }
  }
  return { mapping, unmapped: header.filter((x) => !used.has(x)) }
}

export class UnknownColumnError extends Error {
  constructor(
    readonly field: string,
    readonly column: string
  ) {
    super(`unknown_column: ${field} → "${column}"`)
    this.name = 'UnknownColumnError'
  }
}

/** One sheet row → the record a review item stores as `raw`: the original columns. */
export function rowRecord(header: readonly string[], row: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  header.forEach((h, i) => {
    out[h] = row[i] ?? ''
  })
  return out
}

/**
 * The record normaliseLead reads: the original columns, then each mapped
 * value again under its canonical key (added last, so it wins over any other
 * column that happens to share the alias, e.g. a "Title" column the company
 * aliases would otherwise read as a business name).
 */
export function mappedRecord(raw: Record<string, string>, mapping: ColumnMapping): Record<string, string> {
  const out: Record<string, string> = {}
  const canon = new Set(Object.values(CANONICAL_KEY))
  // Drop original keys that collide with a canonical key or the "title" alias, so only the mapping speaks for them.
  for (const [k, v] of Object.entries(raw)) {
    const n = norm(k)
    if (canon.has(n) || n === 'title' || n === 'name') continue
    out[k] = v
  }
  for (const [field, h] of Object.entries(mapping) as [LeadField, string][]) out[CANONICAL_KEY[field]] = raw[h] ?? ''
  return out
}
