import { describe, expect, it } from 'vitest'
import { applyFilter, parseRuleFilter, ruleFilterSchema, summarizeFilter } from '@/lib/rules/filter'

/** Records every builder call so the PostgREST query can be asserted. */
function fakeQuery() {
  const calls: [string, ...string[]][] = []
  const q = {
    calls,
    eq(c: string, v: string) { calls.push(['eq', c, v]); return q },
    neq(c: string, v: string) { calls.push(['neq', c, v]); return q },
    ilike(c: string, v: string) { calls.push(['ilike', c, v]); return q },
    gte(c: string, v: string) { calls.push(['gte', c, v]); return q },
    or(f: string) { calls.push(['or', f]); return q },
  }
  return q
}

const CAMP = '869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d'

describe('applyFilter', () => {
  it('defaults to unassigned validation rows and excludes leads already queued for the campaign', () => {
    const q = applyFilter(fakeQuery(), {}, { campaignId: CAMP })
    expect(q.calls).toEqual([
      ['eq', 'origin', 'validation_rows'],
      ['or', `campaign_id.is.null,campaign_id.neq."${CAMP}"`],
    ])
  })

  it('maps every filter key onto the lume_lead_bank view', () => {
    const q = applyFilter(
      fakeQuery(),
      { source: 'lead_bank', icp_status: 'fit', city: 'Austin', since: '2026-10-01' },
      { campaignId: CAMP }
    )
    expect(q.calls).toEqual([
      ['eq', 'origin', 'lead_bank'],
      ['eq', 'icp_status', 'fit'],
      ['ilike', 'city', '%Austin%'],
      ['gte', 'created_at', '2026-10-01'],
      ['or', `campaign_id.is.null,campaign_id.neq."${CAMP}"`],
    ])
  })

  it('escapes like wildcards in city', () => {
    const q = applyFilter(fakeQuery(), { city: '50%_off' }, { campaignId: CAMP })
    expect(q.calls).toContainEqual(['ilike', 'city', '%50\\%\\_off%'])
  })

  it('without a campaign it only filters', () => {
    const q = applyFilter(fakeQuery(), { icp_status: 'fit' })
    expect(q.calls).toEqual([
      ['eq', 'origin', 'validation_rows'],
      ['eq', 'icp_status', 'fit'],
    ])
  })
})

describe('ruleFilterSchema / parseRuleFilter', () => {
  it('accepts the four keys and trims them', () => {
    expect(parseRuleFilter({ source: 'validation_rows', city: ' Austin ' })).toEqual({ source: 'validation_rows', city: 'Austin' })
  })

  it('drops empty strings', () => {
    expect(parseRuleFilter({ city: '  ', icp_status: '' })).toEqual({})
  })

  it('rejects unknown keys, bad sources and bad dates', () => {
    expect(ruleFilterSchema.safeParse({ foo: 1 }).success).toBe(false)
    expect(ruleFilterSchema.safeParse({ source: 'instantly' }).success).toBe(false)
    expect(ruleFilterSchema.safeParse({ since: 'yesterday' }).success).toBe(false)
  })

  it('a stored filter that no longer parses becomes {} rather than throwing', () => {
    expect(parseRuleFilter({ source: 'nope' })).toEqual({})
    expect(parseRuleFilter(null)).toEqual({})
  })
})

describe('summarizeFilter', () => {
  it('reads like a sentence', () => {
    expect(summarizeFilter({})).toBe('unassigned validated leads')
    expect(summarizeFilter({ icp_status: 'fit', city: 'Austin', since: '2026-10-01' })).toBe(
      'unassigned validated leads · ICP fit · city ~ Austin · since 2026-10-01'
    )
  })
})
