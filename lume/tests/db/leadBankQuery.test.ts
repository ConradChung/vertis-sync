import { describe, expect, it } from 'vitest'
import {
  applyLeadBankFilter,
  pageRange,
  parseLeadBankParams,
  type LeadBankFilter,
  type LeadBankQuery,
} from '@/lib/db/leadBankQuery'

/** Records the PostgREST filter calls instead of running them. */
class FakeQuery implements LeadBankQuery<FakeQuery> {
  calls: Array<[string, ...unknown[]]> = []
  eq(column: string, value: unknown) {
    this.calls.push(['eq', column, value])
    return this
  }
  ilike(column: string, pattern: string) {
    this.calls.push(['ilike', column, pattern])
    return this
  }
  gte(column: string, value: unknown) {
    this.calls.push(['gte', column, value])
    return this
  }
}

const apply = (filter: LeadBankFilter) => applyLeadBankFilter(new FakeQuery(), filter).calls

describe('applyLeadBankFilter', () => {
  it('adds nothing for an empty filter', () => {
    expect(apply({})).toEqual([])
    expect(apply({ city: '', icp_status: undefined })).toEqual([])
  })

  it('pushes origin/source down as eq on origin', () => {
    expect(apply({ origin: 'lead_bank' })).toEqual([['eq', 'origin', 'lead_bank']])
    expect(apply({ source: 'validation_rows' })).toEqual([['eq', 'origin', 'validation_rows']])
    // `origin` wins when both are present
    expect(apply({ source: 'validation_rows', origin: 'lead_bank' })).toEqual([['eq', 'origin', 'lead_bank']])
  })

  it('pushes icp_status as eq, city as a contains-ilike, since as gte created_at', () => {
    expect(apply({ icp_status: 'yes', city: 'San Francisco', since: '2026-10-01' })).toEqual([
      ['eq', 'icp_status', 'yes'],
      ['ilike', 'city', '%San Francisco%'],
      ['gte', 'created_at', '2026-10-01'],
    ])
  })

  it('escapes PostgREST pattern characters in the city', () => {
    expect(apply({ city: '50% off_' })).toEqual([['ilike', 'city', '%50\\% off\\_%']])
  })
})

describe('pageRange', () => {
  it('is zero-based and inclusive', () => {
    expect(pageRange(1, 100)).toEqual([0, 99])
    expect(pageRange(3, 25)).toEqual([50, 74])
  })

  it('clamps page and pageSize to sane bounds', () => {
    expect(pageRange(0, 100)).toEqual([0, 99])
    expect(pageRange(-4, 100)).toEqual([0, 99])
    expect(pageRange(1, 0)).toEqual([0, 0])
    expect(pageRange(1, 10_000)).toEqual([0, 499])
  })
})

describe('parseLeadBankParams', () => {
  it('reads filter, page and pageSize from a query string', () => {
    const p = parseLeadBankParams(new URLSearchParams('origin=lead_bank&icp_status=yes&city=Austin&since=2026-10-01&page=2&pageSize=50'))
    expect(p).toEqual({
      filter: { origin: 'lead_bank', icp_status: 'yes', city: 'Austin', since: '2026-10-01' },
      page: 2,
      pageSize: 50,
    })
  })

  it('defaults to page 1, 100 per page and drops junk', () => {
    const p = parseLeadBankParams(new URLSearchParams('page=abc&pageSize=-1&since=not-a-date'))
    expect(p.page).toBe(1)
    expect(p.pageSize).toBe(100)
    expect(p.filter).toEqual({})
  })
})
