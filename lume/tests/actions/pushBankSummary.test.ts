import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ getPushJob: vi.fn(), getPushPreview: vi.fn() }))
vi.mock('@/lib/db/service', async (importOriginal) => ({ ...(await importOriginal<object>()), getPushJob: h.getPushJob }))
vi.mock('@/lib/adapters/instantlyPush', () => ({ getPushPreview: h.getPushPreview }))

import { buildActionRequest } from '@/lib/actions/build'

const JOB = '3941b73f-c74e-4cc5-9766-f0140e6ad9c9'
const job = (extra: Record<string, unknown> = {}) => ({
  id: JOB, filename: 'big.csv', valid_count: 5000, instantly_status: 'reviewing_company',
  instantly_campaign_id: 'camp-1', instantly_campaign_name: 'Fall Mega',
  location_barrier: false, company_barrier: true, company_strict: false, instantly_pushed: 0, instantly_banked: 0, ...extra,
})
const preview = (extra: Record<string, unknown> = {}) => ({
  ok: true, preview: { ok: true, eligible: 4563, filtered: 37, junk: 0, missingFirstName: 0, blankLocation: 0, samples: [], strict: false, instantlyKeyPresent: true, ...extra },
})

beforeEach(() => { h.getPushJob.mockReset(); h.getPushPreview.mockReset() })

describe('buildActionRequest: push_to_instantly lead bank route', () => {
  it('route=bank: the summary says lead bank (rotates automatically)', async () => {
    h.getPushJob.mockResolvedValue(job())
    h.getPushPreview.mockResolvedValue(preview({ route: 'bank', banked_estimate: 4563, bank_threshold: 1000 }))
    const b = await buildActionRequest({ kind: 'push_to_instantly', payload: { job_id: JOB } })
    expect(b).toMatchObject({ ok: true, payload: { route: 'bank', eligible: 4563 } })
    const summary = (b as { payload: { summary: string } }).payload.summary
    expect(summary).toContain('Push 4,563 leads from big.csv → lead bank (rotates automatically into Fall Mega as slots free; over the 1,000 threshold)')
    expect(summary).toContain('37 filtered')
  })

  it('route=direct (or an older preview with no route): unchanged summary', async () => {
    for (const extra of [{ route: 'direct' }, {}]) {
      h.getPushJob.mockResolvedValue(job())
      h.getPushPreview.mockResolvedValue(preview({ eligible: 400, ...extra }))
      const b = await buildActionRequest({ kind: 'push_to_instantly', payload: { job_id: JOB } })
      expect(b).toMatchObject({ ok: true, payload: { route: 'direct' } })
      expect((b as { payload: { summary: string } }).payload.summary).toMatch(/^Push 400 leads from big\.csv → Fall Mega \(37 filtered/)
    }
  })

  it('launch_campaign is ready after a banked push (nothing pushed directly yet)', async () => {
    h.getPushJob.mockResolvedValue(job({ instantly_status: 'done', instantly_banked: 4500 }))
    const b = await buildActionRequest({ kind: 'launch_campaign', payload: { job_id: JOB } })
    expect(b).toMatchObject({ ok: true, payload: { summary: expect.stringContaining('4,500 leads from big.csv in the lead bank') } })
    h.getPushJob.mockResolvedValue(job({ instantly_status: 'done' }))
    expect(await buildActionRequest({ kind: 'launch_campaign', payload: { job_id: JOB } })).toMatchObject({ ok: false, status: 409 })
  })
})
