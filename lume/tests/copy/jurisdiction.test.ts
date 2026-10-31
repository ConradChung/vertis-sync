import { describe, expect, it } from 'vitest'
import { normalizeCountry, normalizeRegion } from '@/lib/copy/jurisdiction'
import { findClient, loadSopLibrary } from '@/lib/copy/sop'

/**
 * lib/copy/jurisdiction.ts mirrors the edge resolver's normalisation
 * (supabase/functions/_shared/research/jurisdiction.ts) for lead_bank
 * inserts; the edge module also holds the {{compliance_law}} fallback, since edge
 * functions can't read sops/. Both are checked against the edge module here,
 * so a change on one side fails until the other follows.
 */
type Edge = {
  normalizeCountry: (v: string | null | undefined) => string | null
  normalizeRegion: (c: string | null | undefined, v: string | null | undefined) => string | null
  FALLBACK_COMPLIANCE_LAW: string
}
const EDGE_PATH = '../../../supabase/functions/_shared/research/jurisdiction.ts'
const edge = () => import(/* @vite-ignore */ new URL(EDGE_PATH, import.meta.url).href) as Promise<Edge>

const COUNTRIES = [
  'United States', 'united states of america', 'USA', 'US', 'U.S.', 'Canada', 'CA', 'United Kingdom', 'UK', 'GB', 'England',
  'Great Britain', 'United Arab Emirates', 'UAE', 'AE', 'Australia', 'AU', 'Singapore', 'SG', '', ' ', 'Narnia', 'America',
  'North America', 'Texas', 'BC', 'India', 'Scotland',
]
const REGIONS: [string, string][] = [
  ['US', 'TX'], ['US', 'Texas'], ['US', 'CA'], ['US', 'DC'], ['US', 'Washington DC'], ['US', 'D.C.'], ['US', 'Washington'],
  ['US', 'BC'], ['US', 'Atlantis'], ['CA', 'BC'], ['CA', 'british columbia'], ['CA', 'ON'], ['CA', 'Québec'], ['CA', 'PEI'],
  ['CA', 'TX'], ['CA', 'Newfoundland'], ['AU', 'NSW'], ['AU', 'Victoria'], ['AU', 'ACT'], ['AU', 'WA'], ['AE', 'dubai'],
  ['AE', 'Abu Dhabi'], ['GB', 'England'], ['GB', 'Wales'], ['GB', 'Scotland'], ['GB', 'Northern Ireland'], ['GB', 'Greater London'],
  ['GB', 'London'], ['GB', 'Kent'], ['GB', 'Midlothian'], ['SG', 'Central'], ['', 'Texas'], ['US', ''], ['US', 'London'],
]

describe('jurisdiction normalisation (Lume mirror)', () => {
  it('maps names, ISO2 and variants to ISO2; anything uncertain to null', () => {
    expect(['United States', 'USA', 'US', 'U.S.'].map(normalizeCountry)).toEqual(['US', 'US', 'US', 'US'])
    expect(['Canada', 'UK', 'England', 'UAE', 'Australia', 'Singapore'].map(normalizeCountry)).toEqual(['CA', 'GB', 'GB', 'AE', 'AU', 'SG'])
    expect(['', 'Narnia', 'America', 'BC', null, undefined].map(normalizeCountry)).toEqual([null, null, null, null, null, null])
  })

  it('maps regions within their country only', () => {
    expect(normalizeRegion('CA', 'BC')).toBe('British Columbia')
    expect(normalizeRegion('US', 'CA')).toBe('California')
    expect(normalizeRegion('CA', 'TX')).toBeNull()
    expect(normalizeRegion(null, 'Texas')).toBeNull()
    expect(normalizeRegion('GB', 'Greater London')).toBe('England')
    expect(normalizeRegion('GB', 'Scotland')).toBe('Scotland')
  })

  it('agrees with the edge resolver on every input', async () => {
    const e = await edge()
    for (const c of COUNTRIES) expect(normalizeCountry(c), c).toBe(e.normalizeCountry(c))
    for (const [c, r] of REGIONS) expect(normalizeRegion(c, r), `${c}/${r}`).toBe(e.normalizeRegion(c, r))
  })
})

describe('the edge {{compliance_law}} fallback matches the SOPs', () => {
  const lib = loadSopLibrary()

  it('base and every client SOP use the same fallbacks.compliance_law as the edge pushes', async () => {
    const e = await edge()
    expect(e.FALLBACK_COMPLIANCE_LAW).toBe('local landlord-tenant law')
    expect(lib.base.rules.fallbacks.compliance_law).toBe(e.FALLBACK_COMPLIANCE_LAW)
    for (const c of lib.clients) expect(c.rules.fallbacks.compliance_law, c.name).toBe(e.FALLBACK_COMPLIANCE_LAW)
    expect(findClient(lib, 'kaspen')!.rules.fallbacks.compliance_law).toBe(e.FALLBACK_COMPLIANCE_LAW)
  })

  it('no SOP still names {{jurisdiction_line}}', () => {
    for (const sop of [lib.base, ...lib.clients]) {
      expect(sop.rules.personalization_fields).toContain('compliance_law')
      expect(sop.rules.personalization_fields).not.toContain('jurisdiction_line')
      expect(Object.keys(sop.rules.fallbacks)).not.toContain('jurisdiction_line')
    }
  })
})
