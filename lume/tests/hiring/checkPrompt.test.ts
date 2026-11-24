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
    expect(hiringCheckQuestion(c).endsWith(CONTACT_QUESTION)).toBe(true)
    expect(HIRING_PARSE_SYSTEM.startsWith(PARSE_SYSTEM)).toBe(true)
    expect(HIRING_PARSE_SCHEMA.required).toEqual([...PARSE_SCHEMA.required, 'phone', 'website'])
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
    })
    expect(parseHiringCheck({ icp_fit: 'not_fit', phone: 'call us', website: 'unknown' })).toMatchObject({ phone: null, website: null })
    expect(() => parseHiringCheck({ icp_fit: 'maybe' })).toThrow()
  })
})
