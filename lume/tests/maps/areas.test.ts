import { describe, expect, it } from 'vitest'
import { LA_COUNTY_AREAS, MAPS_REGIONS, pickAreas } from '@/lib/maps/areas'

describe('LA County search areas', () => {
  it('ids are unique, lowercase-hyphen, every area in a known region and in CA', () => {
    const ids = LA_COUNTY_AREAS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const a of LA_COUNTY_AREAS) {
      expect(a.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(MAPS_REGIONS).toContain(a.region)
      expect(a.query).toMatch(/, CA$/)
    }
    for (const r of MAPS_REGIONS) expect(LA_COUNTY_AREAS.some((a) => a.region === r)).toBe(true)
  })

  it('defaults to the whole county', () => {
    expect(pickAreas()).toEqual({ areas: [...LA_COUNTY_AREAS], unknown: [] })
    expect(pickAreas({ ids: [' '], regions: [] }).areas).toHaveLength(LA_COUNTY_AREAS.length)
  })

  it('combines ids and regions, case-insensitive, and reports unknown ones', () => {
    const { areas, unknown } = pickAreas({ ids: ['Pasadena', 'nowhere'], regions: ['westside', 'moon'] })
    expect(unknown).toEqual(['nowhere', 'moon'])
    expect(areas.map((a) => a.id)).toContain('pasadena')
    expect(areas.filter((a) => a.region === 'westside').length).toBeGreaterThan(0)
    expect(areas.every((a) => a.id === 'pasadena' || a.region === 'westside')).toBe(true)
  })
})
