import { describe, expect, it } from 'vitest'
import {
  checkQuestion,
  CONTACT_QUESTION,
  hiringCheckQuestion,
  HIRING_PARSE_SCHEMA,
  HIRING_PARSE_SYSTEM,
  parseHiringCheck,
  parseRequest,
  PARSE_SCHEMA,
  PARSE_SYSTEM,
  PPLX_CALL_USD,
  DOOR_CITE_QUESTION,
  NO_DOORS,
  doorQuestion,
  groundDoors,
} from '@/lib/hiring/checkPrompt'

interface Edge {
  checkQuestion: typeof checkQuestion
  PARSE_SYSTEM: string
  PARSE_SCHEMA: unknown
}

const edge = async () => (await import(/* @vite-ignore */ new URL('../../../supabase/functions/_shared/company_check/check.ts', import.meta.url).href)) as Edge

describe('per-domain check (parity with the job-level edge checker)', () => {
  it('the question, parse system and schema are the edge module\'s own', async () => {
    const e = await edge()
    const c = { company_name: 'Sunbelt Property Management', website: 'sunbeltpm.com', company_key: 'sunbeltpm.com' }
    expect(checkQuestion(c, 'a PM')).toBe(e.checkQuestion(c, 'a PM'))
    const byName = { company_name: null, website: null, company_key: 'name:acme pm' }
    expect(checkQuestion(byName, 'a PM')).toBe(e.checkQuestion(byName, 'a PM'))
    expect(PARSE_SYSTEM).toBe(e.PARSE_SYSTEM)
    expect(PARSE_SCHEMA).toEqual(e.PARSE_SCHEMA)
    const cost = (await import(/* @vite-ignore */ new URL('../../../supabase/functions/_shared/influencer/cost.ts', import.meta.url).href)) as { PPLX_CALL_USD: number }
    expect(PPLX_CALL_USD).toBe(cost.PPLX_CALL_USD)
  })
  it('the hiring check only appends the phone / website question and fields', () => {
    const c = { company_name: 'X', website: 'x.com', company_key: 'x.com' }
    expect(hiringCheckQuestion(c).includes(CONTACT_QUESTION)).toBe(true)
    expect(hiringCheckQuestion(c).endsWith(DOOR_CITE_QUESTION)).toBe(true)
    expect(HIRING_PARSE_SYSTEM.startsWith(PARSE_SYSTEM)).toBe(true)
    expect(HIRING_PARSE_SCHEMA.required).toEqual([...PARSE_SCHEMA.required, 'doors_source', 'doors_confidence', 'phone', 'website'])
    const req = parseRequest(c, 'answer', ['https://x.com'])
    expect(req.model).toBe('claude-haiku-5-5')
    expect(req.output_config.format.schema).toBe(HIRING_PARSE_SCHEMA)
  })
  it('parses fit, phone and website; drops a phone that is not one', () => {
    expect(parseHiringCheck({ icp_fit: 'fit', property_type: 'residential', evidence: 'Manages 300 rentals', phone: '(512) 555-0142', website: 'https://sunbeltpm.com' })).toEqual({
      icp_fit: 'fit',
      property_type: 'residential',
      evidence: 'Manages 300 rentals',
      phone: '(512) 555-0142',
      website: 'https://sunbeltpm.com',
      door_count: null,
      door_count_source: null,
      door_count_confidence: null,
    })
    expect(parseHiringCheck({ icp_fit: 'not_fit', phone: 'call us', website: 'unknown' })).toMatchObject({ phone: null, website: null })
    expect(() => parseHiringCheck({ icp_fit: 'maybe' })).toThrow()
  })
  describe('door count (port of the signal lane\'s groundDoorCount)', () => {
    const base = { icp_fit: 'fit', property_type: 'residential', evidence: 'x', phone: '', website: '' }
    const cites = ['https://sunbeltpm.com/about', 'https://example.org/dir']
    it('keeps a count whose source is one of the cited pages', () => {
      expect(parseHiringCheck({ ...base, doors: 1200, doors_source: 'https://sunbeltpm.com/about', doors_confidence: 'high' }, cites)).toMatchObject({ door_count: 1200, door_count_source: 'https://sunbeltpm.com/about', door_count_confidence: 'high' })
    })
    it('drops an uncited count: no source, a source that is not a citation, or no confidence', () => {
      for (const d of [{ doors_source: '', doors_confidence: 'high' }, { doors_source: 'https://made-up.com/x', doors_confidence: 'high' }, { doors_source: 'https://sunbeltpm.com/about', doors_confidence: '' }]) {
        expect(parseHiringCheck({ ...base, doors: 1200, ...d }, cites)).toMatchObject({ door_count: null, door_count_source: null, door_count_confidence: null })
      }
      expect(parseHiringCheck({ ...base, doors: 1200, doors_source: 'https://sunbeltpm.com/about', doors_confidence: 'high' })).toMatchObject({ door_count: null })
    })
    it('no count (0, missing, junk) is null, never a guess', () => {
      for (const doors of [0, undefined, -4, '900', null]) expect(groundDoors({ doors, doors_source: cites[0], doors_confidence: 'high' }, cites)).toEqual(NO_DOORS)
    })
    it('the hiring parse schema asks for the source and confidence', () => {
      expect(HIRING_PARSE_SYSTEM).toContain('doors_source')
      expect(doorQuestion('Acme "PM"', 'Austin, TX')).toBe(`How many doors or units under management does the property management company "Acme 'PM'" (Austin, TX) have? Quote the exact number and cite the page.`)
    })
  })
})
