import { beforeEach, describe, expect, it, vi } from 'vitest'

/** company_check: the paid per-company check of a validation job (approve-to-run). */

const h = vi.hoisted(() => ({
  getCheckJob: vi.fn(),
  checkPlan: vi.fn(),
  getCheckRun: vi.fn(),
  checkSummary: vi.fn(),
  listCheckResults: vi.fn(),
  callInfluencerFn: vi.fn(),
}))
vi.mock('@/lib/companyCheck/store', () => ({
  getCheckJob: h.getCheckJob,
  checkPlan: h.checkPlan,
  getCheckRun: h.getCheckRun,
  checkSummary: h.checkSummary,
  listCheckResults: h.listCheckResults,
}))
vi.mock('@/lib/adapters/influencerFn', () => ({ callInfluencerFn: h.callInfluencerFn }))

import { buildCompanyCheck, companyCheckOverview, executeCompanyCheck, pickIcp } from '@/lib/companyCheck/action'
import { companyCheckPayloadError, DEFAULT_ICP } from '@/lib/companyCheck/model'

const JOB = '16f26ffc-f8e5-47a5-9e1b-7532f61dad75'
const ACTION = '22222222-2222-4222-8222-222222222222'
const RUN = '33333333-3333-4333-8333-333333333333'
const PLAN = {
  icp_key: 'e'.repeat(64),
  columns: { company: 'Company Name', website: 'Website', email: 'Email' },
  valid_leads: 4563,
  leads_without_company: 0,
  companies: 3140,
  companies_by_domain: 3140,
  companies_by_name_only: 0,
  cached: 0,
  enrichment_icp_status: { confirmed: 2761, not_icp: 1425, unconfirmed: 377 },
}

beforeEach(() => {
  vi.resetAllMocks()
  h.getCheckJob.mockResolvedValue({ id: JOB, filename: 'leadsfriday-4445.csv', display_name: null, status: 'completed', icp_description: null })
  h.checkPlan.mockResolvedValue(PLAN)
  h.getCheckRun.mockResolvedValue(null)
  h.callInfluencerFn.mockResolvedValue({ ok: true, status: 202, body: { ok: true, run_id: RUN, max_usd: 24.01 } })
})

describe('pickIcp', () => {
  it('the owner\'s words, else the job\'s ICP, else the enricher default', () => {
    expect(pickIcp(' roofers ', { icp_description: 'x' })).toEqual({ icp: 'roofers', source: 'owner' })
    expect(pickIcp(undefined, { icp_description: 'HOA managers' })).toEqual({ icp: 'HOA managers', source: 'job' })
    expect(pickIcp('', { icp_description: null })).toEqual({ icp: DEFAULT_ICP, source: 'default' })
  })
})

describe('companyCheckOverview (the read tool)', () => {
  it('plan + estimate + pricing sources, the free enrichment status as a note; no run yet', async () => {
    const o = await companyCheckOverview(JOB)
    expect(h.checkPlan).toHaveBeenCalledWith(JOB, DEFAULT_ICP)
    expect(o).toMatchObject({ job: { name: 'leadsfriday-4445.csv' }, icp_source: 'default', unchecked: 3140, estimate: { usd: 21.82, unit_usd: 0.00695, per_lead_usd: 0.00478 }, run: null, results: [] })
    expect(o!.pricing.map((p) => p.usd)).toEqual([0.006, 0.0009401])
    expect(o!.notes.join(' ')).toMatch(/confirmed 2761, not_icp 1425, unconfirmed 377/)
  })
  it('cached companies are not priced; a run brings its summary and results', async () => {
    h.checkPlan.mockResolvedValueOnce({ ...PLAN, cached: 140 })
    h.getCheckRun.mockResolvedValueOnce({ id: RUN, status: 'capped', spent_usd: '10.5', max_usd: '10.5', estimate_usd: '21.82' })
    h.checkSummary.mockResolvedValueOnce({ items: { done: 1500, pending: 1640 }, companies_by_fit: { fit: 1000 }, leads_by_fit: { fit: 1500 } })
    h.listCheckResults.mockResolvedValueOnce([{ company_key: 'acme.com', icp_fit: 'fit' }])
    const o = await companyCheckOverview(JOB, { fit: 'fit' })
    expect(o).toMatchObject({ unchecked: 3000, estimate: { usd: 20.85 }, run: { spent_usd: 10.5, max_usd: 10.5, estimate_usd: 21.82 }, results: [{ company_key: 'acme.com' }] })
    expect(h.listCheckResults).toHaveBeenCalledWith(RUN, { fit: 'fit' })
  })
  it('unknown job -> null', async () => {
    h.getCheckJob.mockResolvedValueOnce(null)
    expect(await companyCheckOverview(JOB)).toBeNull()
  })
})

describe('buildCompanyCheck', () => {
  it('prices the unchecked companies (count x $0.00695) with a hard cap (default +10 %)', async () => {
    const b = await buildCompanyCheck({ job_id: JOB.toUpperCase() })
    if (!b.ok) throw new Error(b.error)
    expect(b.kind).toBe('company_check')
    expect(b.payload).toMatchObject({ job_id: JOB, icp: DEFAULT_ICP, companies: 3140, estimate_usd: 21.82, per_lead_usd: 0.00478, max_usd: 24.01, unit_usd: 0.00695 })
    expect(b.payload.summary).toMatch(/3140 companies in "leadsfriday-4445\.csv".*~\$21\.82 \(3140 × \$0\.00695, about \$0\.0048 per lead over 4563 valid leads\), hard cap \$24\.01/)
    expect(companyCheckPayloadError(b.payload)).toBeNull()
  })
  it('a smaller cap says how many companies it covers', async () => {
    const b = await buildCompanyCheck({ job_id: JOB, max_usd: 10 })
    expect(b.ok && b.payload.summary).toMatch(/covers about 1438 companies/)
    expect(await buildCompanyCheck({ job_id: JOB, max_usd: 0.001 })).toMatchObject({ ok: false, status: 400 })
  })
  it('refuses a missing job, an unfinished job, a running check, and nothing left to check', async () => {
    h.getCheckJob.mockResolvedValueOnce(null)
    expect(await buildCompanyCheck({ job_id: JOB })).toEqual({ ok: false, status: 404, error: 'job_not_found' })
    h.getCheckJob.mockResolvedValueOnce({ id: JOB, filename: 'f', display_name: null, status: 'processing', icp_description: null })
    expect(await buildCompanyCheck({ job_id: JOB })).toMatchObject({ ok: false, status: 409 })
    h.getCheckRun.mockResolvedValueOnce({ id: RUN, status: 'running', spent_usd: 0 })
    expect(await buildCompanyCheck({ job_id: JOB })).toMatchObject({ ok: false, status: 409, error: 'check_running' })
    h.checkPlan.mockResolvedValueOnce({ ...PLAN, cached: 3140 })
    expect(await buildCompanyCheck({ job_id: JOB })).toMatchObject({ ok: false, status: 409, error: 'nothing_to_check' })
  })
})

describe('executeCompanyCheck (after the tap)', () => {
  const approved = { job_id: JOB, icp: DEFAULT_ICP, companies: 3140, max_usd: 24.01, summary: 's' }
  it('re-checks the plan, then starts company-check with the approved cap and this action id', async () => {
    const out = await executeCompanyCheck(approved, ACTION)
    expect(out).toEqual({ ok: true, result: { job_id: JOB, run_id: RUN, status: 'running', max_usd: 24.01, companies: 3140 } })
    expect(h.callInfluencerFn).toHaveBeenCalledWith({ action: 'start', job_id: JOB, max_usd: 24.01, action_id: ACTION }, 'company-check')
  })
  it('refuses without calling when the job is gone, a check runs, or everything is cached', async () => {
    h.getCheckJob.mockResolvedValueOnce(null)
    expect(await executeCompanyCheck(approved, ACTION)).toMatchObject({ ok: false })
    h.getCheckRun.mockResolvedValueOnce({ id: RUN, status: 'running', spent_usd: 0 })
    expect(await executeCompanyCheck(approved, ACTION)).toMatchObject({ ok: false })
    h.checkPlan.mockResolvedValueOnce({ ...PLAN, cached: 3140 })
    expect(await executeCompanyCheck(approved, ACTION)).toMatchObject({ ok: false })
    expect(h.callInfluencerFn).not.toHaveBeenCalled()
  })
  it('an unreachable function is reported as uncertain', async () => {
    h.callInfluencerFn.mockResolvedValueOnce({ ok: false, status: 0, error: 'timeout' })
    expect(await executeCompanyCheck(approved, ACTION)).toMatchObject({ ok: false, result: { uncertain: true } })
  })
})
