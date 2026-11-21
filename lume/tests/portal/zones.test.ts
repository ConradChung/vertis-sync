import { describe, expect, it } from 'vitest'
import { stateAbbr, zoneFor } from '@/components/portal/zones'

const z = (country: string | null, state: string | null = null, extra: { timezone?: string | null; city?: string | null } = {}) =>
  zoneFor({ timezone: extra.timezone ?? null, country, state, city: extra.city ?? null })

describe('zoneFor', () => {
  it("keeps the row's own zone when set", () => {
    expect(z('United States', 'Texas', { timezone: 'America/Denver' })).toBe('America/Denver')
    expect(z(null, null, { timezone: 'Asia/Tokyo' })).toBe('Asia/Tokyo')
  })
  it('maps US states by name or abbreviation', () => {
    expect(z('United States', 'Texas')).toBe('America/Chicago')
    expect(z('USA', 'CA')).toBe('America/Los_Angeles')
    expect(z('US', 'New York')).toBe('America/New_York')
    expect(z('United States', 'Arizona')).toBe('America/Phoenix')
    expect(z('United States', 'District of Columbia')).toBe('America/New_York')
  })
  it('maps Canadian provinces and Australian states', () => {
    expect(z('Canada', 'Ontario')).toBe('America/Toronto')
    expect(z('Canada', 'Alberta')).toBe('America/Edmonton')
    expect(z('Canada', 'Québec')).toBe('America/Toronto')
    expect(z('Australia', 'Western Australia')).toBe('Australia/Perth')
    expect(z('Australia', 'Tasmania')).toBe('Australia/Hobart')
    expect(z('Australia', 'Australian Capital Territory')).toBe('Australia/Sydney')
  })
  it('maps single-zone countries, by name or ISO code', () => {
    expect(z('United Kingdom', 'England')).toBe('Europe/London')
    expect(z('GB')).toBe('Europe/London')
    expect(z('Ireland', 'County Galway')).toBe('Europe/Dublin')
    expect(z('United Arab Emirates', 'Dubai')).toBe('Asia/Dubai')
    expect(z('AE')).toBe('Asia/Dubai')
    expect(z('New Zealand')).toBe('Pacific/Auckland')
    expect(z('Singapore')).toBe('Asia/Singapore')
    expect(z('Hong Kong')).toBe('Asia/Hong_Kong')
    expect(z('Germany', 'Hesse')).toBe('Europe/Berlin')
  })
  it('uses a big-city fallback only when a multi-zone country has no state', () => {
    expect(z('Canada', null, { city: 'Calgary' })).toBe('America/Edmonton')
    expect(z('United States', null, { city: 'Los Angeles' })).toBe('America/Los_Angeles')
    expect(z('Canada', null, { city: 'Smalltown' })).toBeNull()
  })
  it('returns null when ambiguous or unknown', () => {
    expect(z(null)).toBeNull()
    expect(z('United States')).toBeNull()
    expect(z('Australia')).toBeNull()
    expect(z('Canada', 'Atlantis')).toBeNull()
    expect(z('Russia')).toBeNull()
    expect(z('Mexico')).toBeNull()
    expect(z('Mexico', 'Jalisco')).toBe('America/Mexico_City')
  })
})

describe('stateAbbr', () => {
  it('abbreviates only US / CA / AU states', () => {
    expect(stateAbbr('United States', 'Texas')).toBe('TX')
    expect(stateAbbr('Canada', 'British Columbia')).toBe('BC')
    expect(stateAbbr('Australia', 'Queensland')).toBe('QLD')
    expect(stateAbbr('United Kingdom', 'England')).toBeNull()
    expect(stateAbbr('United States', null)).toBeNull()
  })
})
