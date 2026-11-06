import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ requireOwner: vi.fn(), listRecentJobs: vi.fn() }))
vi.mock('@/lib/auth/guards', () => ({ requireOwner: h.requireOwner }))
vi.mock('@/lib/db/service', () => ({ listRecentJobs: h.listRecentJobs, isDbError: () => false }))

import { GET } from '@/app/api/jobs/route'

const req = () => new Request('https://lume.test/api/jobs')

beforeEach(() => {
  vi.clearAllMocks()
  h.requireOwner.mockResolvedValue({ ok: true, via: 'session' })
})

describe('GET /api/jobs', () => {
  it('lists running jobs and those finished in the last 24 h', async () => {
    const jobs = [{ id: 'a', filename: 'x.csv', status: 'processing', total_rows: 5272, processed_rows: 153, enrich: true, created_at: 't', updated_at: 't', error_message: null }]
    h.listRecentJobs.mockResolvedValue(jobs)
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ jobs })
    const since = h.listRecentJobs.mock.calls[0][0] as Date
    expect(Math.abs(Date.now() - since.getTime() - 24 * 60 * 60 * 1000)).toBeLessThan(5_000)
  })
  it('is owner-only', async () => {
    h.requireOwner.mockResolvedValue({ ok: false, response: new Response('{}', { status: 401 }) })
    expect((await GET(req())).status).toBe(401)
    expect(h.listRecentJobs).not.toHaveBeenCalled()
  })
  it('a DB failure is a 5xx, not a crash', async () => {
    h.listRecentJobs.mockRejectedValue(new Error('db down'))
    expect((await GET(req())).status).toBeGreaterThanOrEqual(500)
  })
})
