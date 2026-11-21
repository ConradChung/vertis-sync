import { describe, expect, it } from 'vitest'
import {
  CHECK_APPROVAL_LIMIT_USD,
  CHECK_USD_PER_COMPANY,
  companyCheckPayloadError,
  DEFAULT_ICP,
  estimateCheck,
  HAIKU_CEILING_USD,
  isCheckScope,
  isKaspen,
  KASPEN_ICP,
  PPLX_CALL_USD,
  PROPERTY_TYPES,
} from '@/lib/companyCheck/model'

const JOB = '16f26ffc-f8e5-47a5-9e1b-7532f61dad75'

describe('company check price (parity with the edge function)', () => {
  it('the unit price, its parts and the cap are the edge module\'s own numbers', async () => {
    const edge = (await import(/* @vite-ignore */ new URL('../../../supabase/functions/_shared/company_check/check.ts', import.meta.url).href)) as {
      CHECK_USD_PER_COMPANY: number
      MAX_APPROVAL_USD: number
      haikuCeilingUsd: () => number
      PROPERTY_TYPES: readonly string[]
    }
    const cost = (await import(/* @vite-ignore */ new URL('../../../supabase/functions/_shared/influencer/cost.ts', import.meta.url).href)) as { PPLX_CALL_USD: number }
    expect(edge.CHECK_USD_PER_COMPANY).toBe(CHECK_USD_PER_COMPANY)
    expect(edge.MAX_APPROVAL_USD).toBe(CHECK_APPROVAL_LIMIT_USD)
    expect(cost.PPLX_CALL_USD).toBe(PPLX_CALL_USD)
    expect(edge.haikuCeilingUsd()).toBeCloseTo(HAIKU_CEILING_USD, 10)
    expect(CHECK_USD_PER_COMPANY).toBe(0.00706)
    // Same property types (the UI orders them differently).
    expect([...edge.PROPERTY_TYPES].sort()).toEqual([...PROPERTY_TYPES].sort())
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
      unit_usd: 0.00706,
      usd: 22.17,
      per_lead_usd: 0.00486,
      default_cap_usd: 24.39,
      over_one_approval: false,
    })
  })
  it('Kaspen Main, still sending: 2,073 companies over 3,137 leads', () => {
    expect(estimateCheck(2073, 3137)).toMatchObject({ usd: 14.64, per_lead_usd: 0.00467, default_cap_usd: 16.1, over_one_approval: false })
  })
  it('caps one approval at $50 and flags the overflow; tiny lists get a $0.10 floor', () => {
    const big = estimateCheck(10_000, 20_000)
    expect([big.usd, big.default_cap_usd, big.over_one_approval]).toEqual([70.6, 50, true])
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
  it('scope: all or sending; an older snapshot without one is accepted (runs as all)', () => {
    expect(companyCheckPayloadError({ ...ok, scope: 'sending' })).toBeNull()
    expect(companyCheckPayloadError({ ...ok, scope: 'all' })).toBeNull()
    expect(companyCheckPayloadError({ ...ok, scope: 'pulled' })).toMatch(/scope/)
    expect(companyCheckPayloadError({ ...ok, scope: null })).toMatch(/scope/)
    expect([isCheckScope('sending'), isCheckScope('x')]).toEqual([true, false])
  })
})

describe('Kaspen preset', () => {
  it('a job is Kaspen by its campaign or tag name', () => {
    expect(isKaspen('Kaspen', null)).toBe(true)
    expect(isKaspen(null, 'Kaspen / Zenport')).toBe(true)
    expect(isKaspen('Roofers', undefined, null)).toBe(false)
  })
  it('names residential homes as the fit and excludes mainly multifamily / commercial-only managers', () => {
    expect(KASPEN_ICP).toMatch(/single-family, small residential, condos or HOAs/)
    expect(KASPEN_ICP).toMatch(/Mainly multifamily apartment operators and commercial-only property managers are NOT a fit/)
    expect(KASPEN_ICP.length).toBeLessThanOrEqual(500) // the edge question clips the ICP at 500 characters
  })
})
