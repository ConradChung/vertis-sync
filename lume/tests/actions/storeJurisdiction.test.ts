import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * resolveLeadsByRefs / resolveLeadsByFilter carry country, region and
 * compliance_law from lume_lead_bank into the lead_bank inserts: country
 * as ISO2 and region as its canonical name, only when the country is certain.
 */
const results: { data: unknown; error: unknown }[] = []
const selects: unknown[] = []

function client() {
  return {
    from: () => {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'is', 'or', 'not', 'gte', 'lte', 'ilike', 'order', 'range', 'limit', 'neq']) {
        b[m] = (...args: unknown[]) => {
          if (m === 'select') selects.push(args[0])
          return b
        }
      }
      b.then = (resolve: (v: unknown) => unknown) => resolve(results.shift() ?? { data: [], error: null })
      return b
    },
  }
}
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => client() }))

import { resolveLeadsByFilter, resolveLeadsByRefs } from '@/lib/actions/store'

const view = (o: Record<string, unknown>) => ({
  origin: 'validation_rows', id: 'r1', email: 'A@acme.com', first_name: 'Ann', last_name: 'Lee', company_name: 'Acme',
  city: 'Vancouver', campaign_id: null, country: null, region: null, compliance_law: null, ...o,
})

beforeEach(() => {
  results.length = 0
  selects.length = 0
})

describe('lead_bank inserts carry jurisdiction data', () => {
  it('selects the new view columns', async () => {
    results.push({ data: [], error: null })
    await resolveLeadsByRefs([{ origin: 'validation_rows', id: 'r1' }], 'camp')
    expect(String(selects[0])).toContain('country,region,compliance_law')
    // The deprecated always-null column is never read.
    expect(String(selects[0])).not.toContain('jurisdiction_line')
  })

  it('normalises raw Apollo country / state from validation rows', async () => {
    results.push({
      data: [
        view({ id: 'r1', email: 'a@x.com', country: 'Canada', region: 'BC' }),
        view({ id: 'r2', email: 'b@x.com', country: 'United States', region: 'Texas' }),
        view({ id: 'r3', email: 'c@x.com', country: 'Canada', region: 'Texas' }),
        view({ id: 'r4', email: 'd@x.com', country: 'India', region: 'Karnataka' }),
        view({ id: 'r5', email: 'e@x.com', country: null, region: 'BC' }),
      ],
      error: null,
    })
    const out = await resolveLeadsByRefs(
      ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => ({ origin: 'validation_rows' as const, id })),
      'camp'
    )
    expect(out.map((r) => [r.email, r.country, r.region, r.compliance_law])).toEqual([
      ['a@x.com', 'CA', 'British Columbia', null],
      ['b@x.com', 'US', 'Texas', null],
      ['c@x.com', 'CA', null, null],
      ['d@x.com', null, null, null],
      ['e@x.com', null, null, null],
    ])
  })

  it('keeps a lead_bank row\'s country, region and explicit compliance_law', async () => {
    results.push({
      data: [view({ origin: 'lead_bank', id: '7', country: 'GB', region: null, compliance_law: 'Residential Tenancies Act, 2006', campaign_id: 'old' })],
      error: null,
    })
    const out = await resolveLeadsByFilter({}, 'camp', 10)
    expect(out).toEqual([
      {
        campaign_id: 'camp', email: 'a@acme.com', first_name: 'Ann', last_name: 'Lee', company_name: 'Acme', location: 'Vancouver',
        country: 'GB', region: null, compliance_law: 'Residential Tenancies Act, 2006',
      },
    ])
  })
})
