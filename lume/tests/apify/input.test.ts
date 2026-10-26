import { describe, expect, it } from 'vitest'
import { describeInput, parseInputSchema, summarizeSchema, validateActorInput } from '@/lib/apify/input'

const RAW = {
  title: 'Google Maps Scraper',
  type: 'object',
  properties: {
    searchStringsArray: { title: '🔍 Search term(s)', type: 'array', description: 'What you would <b>search</b> for', prefill: ['restaurant'] },
    locationQuery: { title: 'Location', type: 'string' },
    maxCrawledPlacesPerSearch: { title: 'Number of places', type: 'integer', minimum: 1, maximum: 5000 },
    language: { title: 'Language', type: 'string', enum: ['en', 'de'], default: 'en' },
    scrapeContacts: { title: 'Contacts ($)', type: 'boolean', default: false },
    proxyConfig: { title: 'Proxy', type: 'object', editor: 'proxy' },
  },
  required: ['searchStringsArray', 'locationQuery'],
}

describe('actor input schema', () => {
  const schema = parseInputSchema(JSON.stringify(RAW))!

  it('parses the build schema string or object', () => {
    expect(schema.required).toEqual(['searchStringsArray', 'locationQuery'])
    expect(parseInputSchema(RAW)?.title).toBe('Google Maps Scraper')
    expect(parseInputSchema('not json')).toBeNull()
  })

  it('summarizes required first, then suggested, with HTML stripped and extra-cost fields flagged', () => {
    const f = summarizeSchema(schema)
    expect(f.slice(0, 2).map((x) => x.name)).toEqual(['searchStringsArray', 'locationQuery'])
    expect(f[0]).toMatchObject({ required: true, important: true, prefill: ['restaurant'], description: 'What you would search for' })
    expect(f.find((x) => x.name === 'scrapeContacts')?.costsExtra).toBe(true)
    expect(f.find((x) => x.name === 'language')?.enum).toEqual(['en', 'de'])
  })

  it('accepts a valid input', () => {
    expect(validateActorInput(schema, { searchStringsArray: ['roofers'], locationQuery: 'Austin, TX', maxCrawledPlacesPerSearch: 500 })).toEqual([])
  })

  it('refuses missing required, wrong types, enum, range and invented fields', () => {
    const errs = validateActorInput(schema, {
      searchStringsArray: 'roofers',
      maxCrawledPlacesPerSearch: 9000,
      language: 'fr',
      madeUpField: 1,
    })
    expect(errs).toEqual(
      expect.arrayContaining([
        'locationQuery is required',
        'searchStringsArray must be an array',
        'maxCrawledPlacesPerSearch must be at most 5000',
        expect.stringContaining('language must be one of'),
        'madeUpField is not an input of this actor',
      ])
    )
    expect(validateActorInput(schema, { searchStringsArray: [], locationQuery: 'x' })).toContain('searchStringsArray is required')
    expect(validateActorInput(schema, { searchStringsArray: ['a'], locationQuery: 'x', maxCrawledPlacesPerSearch: 1.5 })).toContain(
      'maxCrawledPlacesPerSearch must be a whole number'
    )
    expect(validateActorInput(schema, [])).toEqual(['input must be a JSON object'])
  })

  it('refuses residential proxy when asked to (billed per GB, uncappable)', () => {
    const input = { searchStringsArray: ['a'], locationQuery: 'x', proxyConfig: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] } }
    expect(validateActorInput(schema, input, { noResidentialProxy: true })[0]).toMatch(/residential/)
    expect(validateActorInput(schema, input)).toEqual([])
  })

  it('describes an input in one line', () => {
    expect(describeInput({ searchStringsArray: ['roofers', 'solar'], locationQuery: 'Austin, TX', max: 5 })).toBe(
      'searchStringsArray: roofers, solar · locationQuery: Austin, TX · max: 5'
    )
  })
})
