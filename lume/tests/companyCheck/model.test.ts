import { describe, expect, it } from 'vitest'
import {
  CHECK_APPROVAL_LIMIT_USD,
  CHECK_USD_PER_COMPANY,
  companyCheckPayloadError,
  DEFAULT_ICP,
  estimateCheck,
  HAIKU_CEILING_USD,
  PPLX_CALL_USD,
} from '@/lib/companyCheck/model'

const JOB = '16f26ffc-f8e5-47a5-9e1b-7532f61dad75'

describe('company check price (parity with the edge function)', () => {
  it('the unit price, its parts and the cap are the edge module\'s own numbers', async () => {
    const edge = (await import(/* @vite-ignore */ new URL('../../../supabase/functions/_shared/company_check/check.ts', import.meta.url).href)) as {
      CHECK_USD_PER_COMPANY: number
      MAX_APPROVAL_USD: number
      haikuCeilingUsd: () => number
    }
    const cost = (await import(/* @vite-ignore */ new URL('../../../supabase/functions/_shared/influencer/cost.ts', import.meta.url).href)) as { PPLX_CALL_USD: number }
    expect(edge.CHECK_USD_PER_COMPANY).toBe(CHECK_USD_PER_COMPANY)
    expect(edge.MAX_APPROVAL_USD).toBe(CHECK_APPROVAL_LIMIT_USD)
    expect(cost.PPLX_CALL_USD).toBe(PPLX_CALL_USD)
    expect(edge.haikuCeilingUsd()).toBeCloseTo(HAIKU_CEILING_USD, 10)
  })
  it('the operating-city enricher\'s default ICP is the fallback', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(new URL('../../../supabase/functions/operating-city-enricher/index.ts', import.meta.url), 'utf8')
    expect(src).toContain(`const DEFAULT_ICP_DESCRIPTION = '${DEFAULT_ICP}'`)
  })
})

describe('estimateCheck', () => {
  it('the leadsfriday-4445 example: 3,140 companies over 4,563 valid leads', () => {
    expect(estimateCheck(3140, 4563)).toEqual({
      companies_to_check: 3140,
      unit_usd: 0.00695,
      usd: 21.82,
      per_lead_usd: 0.00478,
      default_cap_usd: 24.01,
      over_one_approval: false,
    })
  })
  it('caps one approval at $50 and flags the overflow; tiny lists get a $0.10 floor', () => {
    const big = estimateCheck(10_000, 20_000)
    expect([big.usd, big.default_cap_usd, big.over_one_approval]).toEqual([69.5, 50, true])
    expect(estimateCheck(1, 1).default_cap_usd).toBe(0.1)
    expect(estimateCheck(0, 0)).toMatchObject({ usd: 0, per_lead_usd: null })
  })
})

describe('companyCheckPayloadError', () => {
  const ok = { job_id: JOB, icp: DEFAULT_ICP, companies: 3140, max_usd: 24.01, summary: 's' }
  it('accepts the builder\'s snapshot', () => expect(companyCheckPayloadError(ok)).toBeNull())
  it('refuses a bad job id, missing ICP, no companies, or a cap out of (0, 50]', () => {
    expect(companyCheckPayloadError({ ...ok, job_id: JOB.toUpperCase() })).toMatch(/job_id/)
    expect(companyCheckPayloadError({ ...ok, icp: ' ' })).toMatch(/icp/)
    expect(companyCheckPayloadError({ ...ok, companies: 0 })).toMatch(/companies/)
    expect(companyCheckPayloadError({ ...ok, max_usd: 51 })).toMatch(/max_usd/)
    expect(companyCheckPayloadError({ ...ok, max_usd: 0 })).toMatch(/max_usd/)
  })
})
