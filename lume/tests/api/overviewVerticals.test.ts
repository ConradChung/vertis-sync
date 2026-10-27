import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  listVerticals: vi.fn(),
  listOperators: vi.fn(),
  getGates: vi.fn(),
  listAlerts: vi.fn(),
  listDecidedSince: vi.fn(),
}))
vi.mock('@/lib/auth/guards', () => ({ requireOwner: h.requireOwner }))
vi.mock('@/lib/operators/store', () => ({ listVerticals: h.listVerticals, listOperators: h.listOperators }))
vi.mock('@/lib/db/service', () => ({ getGates: h.getGates }))
vi.mock('@/lib/alertsStore', () => ({ listAlerts: h.listAlerts, ALERTS_MAX_LIMIT: 200 }))
vi.mock('@/lib/actions/store', () => ({ listDecidedSince: h.listDecidedSince }))

import { GET } from '@/app/api/overview/verticals/route'

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset()
  h.requireOwner.mockResolvedValue({ ok: true, via: 'session', user: {} })
  for (const f of [h.listVerticals, h.listOperators, h.getGates, h.listAlerts, h.listDecidedSince]) f.mockResolvedValue([])
})

describe('GET /api/overview/verticals', () => {
  it('reads only the bots’ decisions for the last week (decided_via = operator, filtered in the query)', async () => {
    const res = await GET(new Request('http://localhost/api/overview/verticals'))
    expect(res.status).toBe(200)
    const [since, limit, opts] = h.listDecidedSince.mock.calls[0]
    expect(since).toBeInstanceOf(Date)
    expect(limit).toBe(200)
    expect(opts).toEqual({ via: 'operator' })
  })
})
