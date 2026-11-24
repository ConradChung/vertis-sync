import { describe, expect, it } from 'vitest'
import { LA_COUNTY_AREAS } from '@/lib/maps/areas'
import { ACTOR_RUN_CAP_USD } from '@/lib/apify/pricing'
import { buildMapsScrapeRequest, fitToSchema, MAPS_ACTOR_ID, MAPS_DEFAULT_PER_SEARCH } from '@/lib/maps/scrape'

describe('buildMapsScrapeRequest', () => {
  it('the default: every LA County area, 80 per search, paid add-ons off, capped at the run cap', () => {
    const p = buildMapsScrapeRequest()
    if (!p.ok) throw new Error(p.error)
    expect(p.request.actor_id).toBe(MAPS_ACTOR_ID)
    expect(p.request.max_charge_usd).toBe(ACTOR_RUN_CAP_USD)
    expect(p.request.expected_items).toBe(LA_COUNTY_AREAS.length * MAPS_DEFAULT_PER_SEARCH)
    const input = p.request.input as Record<string, unknown>
    expect(input.searchStringsArray).toHaveLength(LA_COUNTY_AREAS.length)
    expect((input.searchStringsArray as string[])[0]).toBe(`property management in ${LA_COUNTY_AREAS[0].query}`)
    expect(input).toMatchObject({ maxCrawledPlacesPerSearch: 80, skipClosedPlaces: true, scrapeContacts: false, scrapePlaceDetailPage: false, maxReviews: 0, maxImages: 0, maxQuestions: 0 })
  })

  it('a region at a lower cap and a custom phrase', () => {
    const p = buildMapsScrapeRequest({ regions: ['south-bay'], per_search: 20, query: '  HOA   management ', max_charge_usd: 3 })
    if (!p.ok) throw new Error(p.error)
    expect(p.areas.every((a) => a.region === 'south-bay')).toBe(true)
    expect((p.request.input.searchStringsArray as string[]).every((s) => s.startsWith('HOA management in '))).toBe(true)
    expect(p.request).toMatchObject({ max_charge_usd: 3, expected_items: p.areas.length * 20 })
  })

  it('refuses unknown areas, bad limits and a cap above the run cap', () => {
    expect(buildMapsScrapeRequest({ areas: ['atlantis'] })).toEqual({ ok: false, error: 'unknown_area: atlantis' })
    expect(buildMapsScrapeRequest({ per_search: 0 }).ok).toBe(false)
    expect(buildMapsScrapeRequest({ per_search: 121 }).ok).toBe(false)
    expect(buildMapsScrapeRequest({ per_search: 2.5 }).ok).toBe(false)
    expect(buildMapsScrapeRequest({ query: 'pm' }).ok).toBe(false)
    expect(buildMapsScrapeRequest({ max_charge_usd: ACTOR_RUN_CAP_USD + 1 }).ok).toBe(false)
    expect(buildMapsScrapeRequest({ max_charge_usd: 0 }).ok).toBe(false)
  })
})

describe('fitToSchema', () => {
  it('drops only optional fields the live schema lacks; search strings and limits always stay', () => {
    const p = buildMapsScrapeRequest({ areas: ['pasadena'] })
    if (!p.ok) throw new Error(p.error)
    const { input, dropped } = fitToSchema(p.request.input, ['searchStringsArray', 'language', 'scrapeContacts', 'maxReviews'])
    expect(dropped.sort()).toEqual(['maxImages', 'maxQuestions', 'scrapePlaceDetailPage', 'skipClosedPlaces'])
    expect(Object.keys(input).sort()).toEqual(['language', 'maxCrawledPlacesPerSearch', 'maxReviews', 'scrapeContacts', 'searchStringsArray'])
  })
})
