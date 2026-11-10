import { beforeEach, describe, expect, it, vi } from 'vitest'

let usageFails = false
vi.mock('@/lib/auth/guards', () => ({ requireOwner: vi.fn(async () => ({ ok: true, via: 'internal', user: null })) }))
vi.mock('@/lib/adapters/instantly', () => ({
  isInstantlyConfigured: () => true,
  listCampaigns: vi.fn(async () => [{ id: 'kaspen', name: 'Kaspen', statusLabel: 'draft' }]),
}))
vi.mock('@/lib/adapters/instantlyLeads', () => ({
  getContactUsage: async () => {
    if (usageFails) throw new Error('down')
    return { current: 5, limit: 1000 }
  },
}))
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    rpc: async () => ({ data: [{ campaign_id: 'kaspen', queued: 4739, active: 0, finished: 0, oldest_queued_at: '2026-10-08T00:00:00Z', last_pushed_at: null }], error: null }),
    from: (t: string) => {
      const q = {
        select: () => q, is: () => q, order: () => q, limit: () => q,
        maybeSingle: async () => ({ data: { ran_at: '2026-11-10T01:00:00Z', in_instantly_after: 1000 }, error: null }),
        then: (r: (v: unknown) => unknown) => r({ data: t === 'lume_verticals' ? [{ id: 'v', name: 'Kaspen', campaign_ids: ['kaspen'] }] : [], error: null }),
      }
      return q
    },
  }),
}))

const { GET } = await import('@/app/api/rotation/queues/route')

describe('GET /api/rotation/queues', () => {
  beforeEach(() => { usageFails = false })
  it('uses the live Instantly count, not the last rotation run (stale after a manual campaign delete)', async () => {
    const body = await (await GET(new Request('https://x/api/rotation/queues'))).json()
    expect([body.in_instantly, body.in_instantly_source]).toEqual([5, 'live'])
    expect(body.blockers.join('\n')).not.toMatch(/Instantly is full/)
  })
  it('falls back to the last run when Instantly usage cannot be read', async () => {
    usageFails = true
    const body = await (await GET(new Request('https://x/api/rotation/queues'))).json()
    expect([body.in_instantly, body.in_instantly_source]).toEqual([1000, 'last_run'])
    expect(body.blockers[0]).toMatch(/Instantly is full/)
  })
})
