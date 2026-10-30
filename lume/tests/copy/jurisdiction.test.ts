import { describe, expect, it } from 'vitest'
import { normalizeCountry, normalizeRegion } from '@/lib/copy/jurisdiction'
import { findClient, loadSopLibrary } from '@/lib/copy/sop'

/**
 * lib/copy/jurisdiction.ts mirrors the edge resolver's normalisation
 * (supabase/functions/_shared/research/jurisdiction.ts) for lead_bank
 * inserts; the edge module also holds the SOP fallback sentences, since edge
 * functions can't read sops/. Both are checked against the edge module here,
 * so a change on one side fails until the other follows.
 */
type Edge = {
  normalizeCountry: (v: string | null | undefined) => string | null
  normalizeRegion: (c: string | null | undefined, v: string | null | undefined) => string | null
  BASE_FALLBACK_JURISDICTION_LINE: string
  CAMPAIGN_FALLBACK_JURISDICTION_LINES: Record<string, string>
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
  ['AE', 'Abu Dhabi'], ['GB', 'England'], ['GB', 'Wales'], ['SG', 'Central'], ['', 'Texas'], ['US', ''],
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
  })

  it('agrees with the edge resolver on every input', async () => {
    const e = await edge()
    for (const c of COUNTRIES) expect(normalizeCountry(c), c).toBe(e.normalizeCountry(c))
    for (const [c, r] of REGIONS) expect(normalizeRegion(c, r), `${c}/${r}`).toBe(e.normalizeRegion(c, r))
  })
})

describe('edge fallback sentences match the SOPs', () => {
  const lib = loadSopLibrary()

  it('base: fallbacks.jurisdiction_line', async () => {
    const e = await edge()
    expect(lib.base.rules.fallbacks.jurisdiction_line).toBeTruthy()
    expect(e.BASE_FALLBACK_JURISDICTION_LINE).toBe(lib.base.rules.fallbacks.jurisdiction_line)
  })

  it("every client's pinned campaign ids map to its fallbacks.jurisdiction_line, and nothing else is pinned", async () => {
    const e = await edge()
    const expected: Record<string, string> = {}
    for (const c of lib.clients) {
      const line = c.rules.fallbacks.jurisdiction_line
      if (line && line !== lib.base.rules.fallbacks.jurisdiction_line) for (const id of c.match.campaign_ids) expected[id] = line
    }
    expect(Object.keys(expected).length).toBeGreaterThan(0)
    expect(e.CAMPAIGN_FALLBACK_JURISDICTION_LINES).toEqual(expected)
    expect(findClient(lib, 'kaspen')!.rules.fallbacks.jurisdiction_line).toBe('Without a GM, the owner becomes the middle manager.')
  })
})
