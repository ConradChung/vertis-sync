import { describe, expect, it } from 'vitest'
import type { GateRow } from '@/lib/db/types'
import { checkGateFor, companyCheckUrl, defaultScope, doorsText, fitRows, requestOutcome, runProgress, typeRows } from '@/lib/companyCheck/view'
import { runOfGate, runStatus, stepOfGate } from '@/lib/progress/runs'

const JOB = '16f26ffc-f8e5-47a5-9e1b-7532f61dad75'
const gate = (o: Partial<GateRow>): GateRow =>
  ({ kind: 'lume_action', target_table: 'pending_actions', target_id: 'a1', title: 'company_check', subtitle: 's', actions: ['lume_ok', 'lume_no'], counts: { job_id: JOB }, telegram_message_id: null, created_at: '2026-11-12T00:00:00Z', ...o }) as GateRow

describe('ICP check panel logic', () => {
  it('defaults to "still sending" only when the job has banked leads', () => {
    expect(defaultScope(3136)).toBe('sending')
    expect([defaultScope(0), defaultScope(null), defaultScope(undefined)]).toEqual(['all', 'all', 'all'])
  })

  it('builds the quote URL: scope always, ICP only once known, filters and paging', () => {
    expect(companyCheckUrl({ jobId: JOB, icp: null, scope: 'sending' })).toBe(`/api/company-check?job_id=${JOB}&scope=sending&limit=50`)
    expect(companyCheckUrl({ jobId: JOB, icp: '  residential PMs ', scope: 'all', fit: 'not_fit', type: 'multifamily', offset: 50 })).toBe(
      `/api/company-check?job_id=${JOB}&scope=all&icp=residential+PMs&fit=not_fit&type=multifamily&limit=50&offset=50`
    )
  })

  it("finds this job's awaiting company_check approval and nothing else", () => {
    const mine = gate({})
    expect(checkGateFor([gate({ title: 'push_to_instantly' }), gate({ counts: { job_id: 'other' } }), mine], JOB)).toBe(mine)
    expect(checkGateFor(undefined, JOB)).toBeNull()
  })

  it('a company_check approval belongs to its job run (decided in the panel, not the side list), with no flow step', () => {
    const g = gate({})
    expect(runOfGate(g)).toBe(JOB)
    expect(stepOfGate(g)).toBeNull()
    expect(runStatus({ id: JOB, status: 'completed', instantly_status: 'done' }, [g])).toBe('needs_you')
  })

  it('breakdowns: fixed order, zero rows dropped, residential first', () => {
    const s = { companies_by_fit: { unclear: 2, fit: 10 }, leads_by_fit: { fit: 30, unclear: 2 }, companies_by_type: { commercial: 1, residential: 9, unknown: 2 }, leads_by_type: { residential: 28, commercial: 2, unknown: 2 } }
    expect(fitRows(s).map((r) => [r.key, r.companies, r.leads])).toEqual([['fit', 10, 30], ['unclear', 2, 2]])
    expect(typeRows(s).map((r) => [r.key, r.label, r.companies, r.leads])).toEqual([['residential', 'Residential', 9, 28], ['commercial', 'Commercial', 1, 2], ['unknown', 'Unknown', 2, 2]])
    expect(fitRows(null)).toEqual([])
  })

  it('progress counts settled companies; doors 0 / null show as a dash', () => {
    expect(runProgress({ pending: 3, done: 5, cached: 1, error: 1 }, 0)).toEqual({ done: 7, total: 10 })
    expect(runProgress({}, 12)).toEqual({ done: 12, total: 12 })
    expect([doorsText(1200), doorsText(0), doorsText(null)]).toEqual(['1,200', '—', '—'])
  })

  it('request answers in plain words; only a 201 says it was requested', () => {
    expect(requestOutcome(201, { error: undefined }).tone).toBe('success')
    expect(requestOutcome(201, null).message).toMatch(/Nothing is spent until you do/)
    expect(requestOutcome(409, { error: 'duplicate' }).message).toMatch(/already waiting/)
    expect(requestOutcome(409, { error: 'nothing_to_check' }).message).toMatch(/already checked/)
    expect(requestOutcome(409, { error: 'job_processing: validation must be completed first' }).message).toMatch(/Validation must finish/)
    expect(requestOutcome(500, null).tone).toBe('error')
  })
})
