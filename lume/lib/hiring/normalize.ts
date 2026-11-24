/**
 * GTM-19 Hiring Ops Signal: normalisers and the role-tier classifier (pure).
 *
 * normDomain / normCompany mirror `signal_norm_domain` / `signal_norm_company`
 * in supabase/migrations/*_lume_hiring_signal.sql (the exclusion RPC matches
 * on them); tests/hiring/normalize.test.ts checks the SQL keeps the same
 * patterns.
 */

/** Free-mail / platform hosts: never a company's own domain. */
export const NON_COMPANY_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.ca', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'aol.com',
  'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'shaw.ca', 'rogers.com', 'telus.net', 'sympatico.ca', 'comcast.net',
  'linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'youtube.com', 'google.com', 'sites.google.com',
  'linktr.ee', 'bit.ly', 'wixsite.com', 'godaddysites.com', 'indeed.com', 'glassdoor.com', 'ziprecruiter.com',
])

/** Lowercase host without scheme, www, port, path, query or fragment. null when empty or not a host. */
export function normDomain(x: string | null | undefined): string | null {
  if (typeof x !== 'string') return null
  const d = x
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/:?#].*$/, '')
  return d && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null
}

/** A company's own domain from its website (free-mail and platform hosts dropped). */
export function companyDomain(website: string | null | undefined): string | null {
  const d = normDomain(website)
  if (!d || NON_COMPANY_DOMAINS.has(d)) return null
  for (const host of NON_COMPANY_DOMAINS) if (d.endsWith(`.${host}`)) return null
  return d
}

const LEGAL = /\b(inc|llc|ltd|corp|corporation|co|company|limited|lp|llp|pllc)\b/g

/** "Acme Property Management, LLC" → "acme property management". null when nothing is left. */
export function normCompany(x: string | null | undefined): string | null {
  if (typeof x !== 'string') return null
  const n = x
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(LEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return n || null
}

// ── role tiers ─────────────────────────────────────────────────────────────

export type RoleTier = 'leadership' | 'coordinator'

/**
 * Coordinator roles (what Kaspen covers): maintenance / leasing coordinator,
 * leasing agent / consultant, assistant property manager, office admin(istrator),
 * resident services coordinator. Checked before leadership, so "Assistant
 * Property Manager" is never read as "Property Manager".
 */
const COORDINATOR: readonly RegExp[] = [
  /\bmaintenance\s+(coordinator|dispatcher|scheduler)\b/i,
  /\bleasing\s+(coordinator|agent|consultant|specialist|associate)\b/i,
  /\bassistant\s+(property|community|portfolio)\s+manager\b/i,
  /\bAPM\b/,
  /\boffice\s+(admin|administrator|administrative|assistant|coordinator)\b/i,
  /\badministrative\s+(assistant|coordinator)\b/i,
  /\bresident\s+(services?|relations)\s+(coordinator|specialist|associate)\b/i,
  /\btenant\s+(services?|relations)\s+(coordinator|specialist)\b/i,
  /\bproperty\s+management\s+(coordinator|assistant|administrator)\b/i,
]

/**
 * Leadership: COO, VP / Director / Head of Operations, Director of Property
 * Management, Regional / Portfolio Manager, Property Manager.
 */
const LEADERSHIP: readonly RegExp[] = [
  /\bcoo\b/i,
  /\bchief\s+operating\s+officer\b/i,
  /\b(vp|vice\s+president|svp|evp|director|head|senior\s+director)\s*(,|of|-|–)?\s*(property\s+)?operations\b/i,
  /\boperations\s+(director|manager)\b/i,
  /\bdirector\s+(of\s+)?property\s+management\b/i,
  /\b(vp|vice\s+president)\s+(of\s+)?property\s+management\b/i,
  /\bregional\s+(property\s+|portfolio\s+)?(manager|director)\b/i,
  /\bportfolio\s+manager\b/i,
  /\b(senior\s+|community\s+|residential\s+|commercial\s+)?property\s+manager\b/i,
  /\bcommunity\s+manager\b/i,
]

/** The tier a job / profile title belongs to, or null when it is neither. */
export function classifyRole(title: string | null | undefined): RoleTier | null {
  if (typeof title !== 'string' || !title.trim()) return null
  const t = title.replace(/\s+/g, ' ')
  if (COORDINATOR.some((re) => re.test(t))) return 'coordinator'
  if (LEADERSHIP.some((re) => re.test(t))) return 'leadership'
  return null
}

// ── regions ────────────────────────────────────────────────────────────────

const CA_PROVINCES = /\b(AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT|Alberta|British Columbia|Manitoba|New Brunswick|Newfoundland|Nova Scotia|Ontario|Prince Edward Island|Quebec|Québec|Saskatchewan|Yukon)\b/
const US_STATES =
  /\b(AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/

/** 'US' | 'CA' from a free-text location ("Austin, TX", "Toronto, Ontario, Canada"); null when neither. */
export function countryOf(location: string | null | undefined, countryCode?: string | null): 'US' | 'CA' | null {
  const cc = (countryCode ?? '').toUpperCase()
  if (cc === 'US' || cc === 'CA') return cc
  if (typeof location !== 'string' || !location.trim()) return null
  if (/\bcanada\b/i.test(location)) return 'CA'
  if (/\b(united states|usa|u\.s\.)\b/i.test(location)) return 'US'
  // "City, CA" is California; check Canadian provinces first only by full name / unambiguous code.
  if (CA_PROVINCES.test(location) && !/,\s*CA\b/.test(location)) return 'CA'
  if (US_STATES.test(location) || /metropolitan area|metro|greater .+ area/i.test(location)) return 'US'
  return null
}

/** LinkedIn URLs without tracking query strings. */
export function cleanLinkedIn(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || !/linkedin\.com\//i.test(url)) return null
  return url.trim().replace(/[?#].*$/, '').replace(/\/+$/, '')
}

/** A canonical http(s) URL without the fragment; null otherwise. */
export function cleanUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null
  const u = url.trim()
  return /^https?:\/\/\S+$/i.test(u) ? u.replace(/#.*$/, '') : null
}
