import { describe, expect, it } from 'vitest'
import { BankQueueBody, bankQueuePayloadError, groupPushes, NO_SOURCE_NAME, pushKey, StopBody, type PushRow } from '@/lib/rotation/pushes'

const JOB = '16f26ffc-f8e5-47a5-9e1b-7532f61dad75'
const KASPEN = 'bcf7a6d2-1302-47fc-ae77-9d2a760c91c1'
const NOLOC = 'eed7dbe2-61b6-4e3a-a0ac-135280b2a041'
const row = (p: Partial<PushRow>): PushRow => ({
  source_job_id: JOB, job_name: 'leadsfriday-4445.csv', filename: 'leadsfriday-4445.csv', campaign_id: KASPEN,
  queued: 0, stopped: 0, active: 0, finished: 0, first_banked_at: '2026-11-09T21:58:18Z', last_pushed_at: null, ...p,
})

describe('groupPushes', () => {
  it('groups by source list with totals, names campaigns, and puts the no-source group last', () => {
    const names = new Map([[KASPEN, { name: 'Kaspen', status: 'Active' }], [NOLOC, { name: 'Kaspen (no location)', status: 'Active' }]])
    const g = groupPushes(
      [
        row({ source_job_id: null, job_name: null, filename: null, active: 992, first_banked_at: '2026-10-08T00:00:00Z' }),
        row({ campaign_id: NOLOC, queued: 142, stopped: 671 }),
        row({ queued: 2991, stopped: 753, active: 3 }),
      ],
      names
    )
    expect(g.map((x) => x.name)).toEqual(['leadsfriday-4445.csv', NO_SOURCE_NAME])
    expect(g[0]).toMatchObject({ queued: 3133, stopped: 1424, active: 3 })
    expect(g[0].campaigns.map((c) => c.campaign_name)).toEqual(['Kaspen', 'Kaspen (no location)'])
    expect(g[1].key).toBe('none')
  })

  it('carries why leads were stopped, dropping malformed entries', () => {
    const reasons = [
      { reason: 'Not a property manager (company research)', count: '671', at: '2026-11-12T04:34:51Z' },
      { reason: 'Wrong region', count: 2, at: null },
      { count: 9 },
    ] as unknown as PushRow['stop_reasons']
    const c = groupPushes([row({ campaign_id: NOLOC, stopped: 673, stop_reasons: reasons })], new Map())[0].campaigns[0]
    expect(c.stop_reasons).toEqual([
      { reason: 'Not a property manager (company research)', count: 671, at: '2026-11-12T04:34:51Z' },
      { reason: 'Wrong region', count: 2, at: null },
    ])
    expect(groupPushes([row({ stopped: 0 })], new Map())[0].campaigns[0].stop_reasons).toEqual([])
  })

  it('falls back to the campaign id when Instantly names are unavailable', () => {
    expect(groupPushes([row({ queued: '5' as unknown as number })], new Map())[0].campaigns[0]).toMatchObject({ campaign_name: KASPEN, queued: 5 })
  })
})

describe('bank_queue payloads', () => {
  it('move needs another campaign; stop takes a job (or null) and a campaign', () => {
    expect(BankQueueBody.safeParse({ op: 'move', source_job_id: JOB, campaign_id: KASPEN }).success).toBe(false)
    expect(BankQueueBody.safeParse({ op: 'move', source_job_id: JOB, campaign_id: KASPEN, to_campaign_id: KASPEN }).success).toBe(false)
    expect(BankQueueBody.safeParse({ op: 'move', source_job_id: JOB, campaign_id: KASPEN, to_campaign_id: NOLOC }).success).toBe(true)
    expect(BankQueueBody.safeParse({ op: 'stop', source_job_id: JOB, campaign_id: KASPEN }).success).toBe(false)
    expect(StopBody.safeParse({ source_job_id: null, campaign_id: KASPEN }).success).toBe(true)
    expect(StopBody.safeParse({ source_job_id: 'nope', campaign_id: KASPEN }).success).toBe(false)
    expect(StopBody.safeParse({ source_job_id: JOB, campaign_id: KASPEN, reason: 'Not a property manager' }).data?.reason).toBe('Not a property manager')
    expect(StopBody.safeParse({ source_job_id: JOB, campaign_id: KASPEN, reason: 'x'.repeat(201) }).success).toBe(false)
  })

  it('createAction refuses a payload whose push_key or count does not match', () => {
    const ok = { op: 'restart', source_job_id: JOB, campaign_id: KASPEN, count: 753, push_key: pushKey(JOB, KASPEN), summary: 's' }
    expect(bankQueuePayloadError(ok)).toBeNull()
    expect(bankQueuePayloadError({ ...ok, push_key: pushKey(null, KASPEN) })).toMatch(/push_key/)
    expect(bankQueuePayloadError({ ...ok, count: 0 })).toMatch(/count/)
    expect(bankQueuePayloadError({ ...ok, op: 'move', to_campaign_id: KASPEN })).toMatch(/another campaign/)
    expect(bankQueuePayloadError({ ...ok, source_job_id: null, push_key: 'none:' + KASPEN })).toBeNull()
  })
})
