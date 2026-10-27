import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  requireOwnerSession: vi.fn(),
  currentOperator: vi.fn(),
  listAlerts: vi.fn(),
  ackAlerts: vi.fn(),
  listVerticals: vi.fn(),
}))
vi.mock('@/lib/auth/guards', () => ({ requireOwner: h.requireOwner, requireOwnerSession: h.requireOwnerSession }))
vi.mock('@/lib/operators/session', () => ({ currentOperator: h.currentOperator }))
vi.mock('@/lib/alertsStore', () => ({ listAlerts: h.listAlerts, ackAlerts: h.ackAlerts, ALERTS_DEFAULT_LIMIT: 50, ALERTS_MAX_LIMIT: 200 }))
vi.mock('@/lib/operators/store', () => ({ listVerticals: h.listVerticals }))

import { NextResponse } from 'next/server'
import { GET } from '@/app/api/alerts/route'
import { POST } from '@/app/api/alerts/ack/route'
import { DbError } from '@/lib/db/service'

const A = '11111111-1111-4111-8111-111111111111'
const OP = '9b2f4c1e-0d3a-4e5b-8c7d-6e5f4a3b2c1d'
const pass = { ok: true, via: 'session', user: {} }
const deny = { ok: false, response: NextResponse.json({ error: 'unauthenticated' }, { status: 401 }) }

const ack = (body: unknown) =>
  POST(new Request('http://localhost/api/alerts/ack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset()
  h.requireOwner.mockResolvedValue(pass)
  h.requireOwnerSession.mockResolvedValue(pass)
  h.currentOperator.mockResolvedValue(null)
  h.listAlerts.mockResolvedValue([{ id: A }])
  h.ackAlerts.mockResolvedValue([A])
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET /api/alerts', () => {
  it('owner-gated', async () => {
    h.requireOwner.mockResolvedValue(deny)
    const res = await GET(new Request('http://localhost/api/alerts'))
    expect(res.status).toBe(401)
    expect(h.listAlerts).not.toHaveBeenCalled()
  })

  it('?unacked=1&limit=20 → unacked only, that limit', async () => {
    const res = await GET(new Request('http://localhost/api/alerts?unacked=1&limit=20'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ alerts: [{ id: A }] })
    expect(h.listAlerts).toHaveBeenCalledWith({ unackedOnly: true, limit: 20 })
  })

  it('defaults: everything, default limit; a junk limit falls back to the default', async () => {
    await GET(new Request('http://localhost/api/alerts'))
    expect(h.listAlerts).toHaveBeenLastCalledWith({ unackedOnly: false, limit: 50 })
    await GET(new Request('http://localhost/api/alerts?unacked=0&limit=abc'))
    expect(h.listAlerts).toHaveBeenLastCalledWith({ unackedOnly: false, limit: 50 })
  })

  it('limit=0 is passed through as 0 (the store clamps it to 1), not swapped for the default', async () => {
    await GET(new Request('http://localhost/api/alerts?limit=0'))
    expect(h.listAlerts).toHaveBeenLastCalledWith({ unackedOnly: false, limit: 0 })
  })

  it('a DB error is a 500 without detail', async () => {
    h.listAlerts.mockRejectedValue(new DbError('listAlerts', new Error('secret detail')))
    const res = await GET(new Request('http://localhost/api/alerts'))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})

describe('POST /api/alerts/ack', () => {
  it('owner session only (the agent bearer gets the session guard response)', async () => {
    h.requireOwnerSession.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'session_required' }, { status: 403 }) })
    const res = await ack({ all: true })
    expect(res.status).toBe(403)
    expect(h.ackAlerts).not.toHaveBeenCalled()
  })

  it('ids from the owner: acked_by_operator null', async () => {
    const res = await ack({ ids: [A.toUpperCase()] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, acked: [A] })
    expect(h.ackAlerts).toHaveBeenCalledWith({ ids: [A] }, null)
  })

  it('all from a Grok Bot operator session: records the operator', async () => {
    h.currentOperator.mockResolvedValue({ id: OP, label: 'Roofers bot' })
    await ack({ all: true })
    expect(h.ackAlerts).toHaveBeenCalledWith({ all: true }, OP)
  })

  it.each([
    [{}],
    [{ ids: [] }],
    [{ ids: ['not-a-uuid'] }],
    [{ all: false }],
    [{ ids: [A], all: true }],
    [{ ids: Array.from({ length: 501 }, () => A) }],
  ])('400 for %j', async (body) => {
    const res = await ack(body)
    expect(res.status).toBe(400)
    expect(h.ackAlerts).not.toHaveBeenCalled()
  })
})

describe('GET /api/alerts?vertical=', () => {
  const V1 = '5b54bc53-ac4a-49a3-b13a-a299b2d6b38f'
  const V2 = '466d9a53-6450-49df-a063-8e66437efa8b'
  const verticals = [
    { id: V1, name: 'Job search', campaign_ids: ['camp-js'], scopes: ['orders'], is_default: false, archived_at: null },
    { id: V2, name: 'Kaspen', campaign_ids: ['camp-k'], scopes: ['campaign'], is_default: true, archived_at: null },
  ]
  beforeEach(() => {
    h.listVerticals.mockResolvedValue(verticals)
    h.listAlerts.mockResolvedValue([
      { id: '1', campaign_id: 'camp-js', scope: null },
      { id: '2', campaign_id: 'camp-k', scope: null },
      { id: '3', campaign_id: null, scope: 'orders' },
      { id: '4', campaign_id: null, scope: null },
    ])
  })

  it('keeps only the alerts that route to that vertical (campaign, then sole scope, else default)', async () => {
    const js = await (await GET(new Request(`http://localhost/api/alerts?unacked=1&vertical=${V1}`))).json()
    expect(js.alerts.map((a: { id: string }) => a.id)).toEqual(['1', '3'])
    expect(h.listAlerts).toHaveBeenLastCalledWith({ unackedOnly: true, limit: 200 })
    const k = await (await GET(new Request(`http://localhost/api/alerts?vertical=${V2}&limit=1`))).json()
    expect(k.alerts.map((a: { id: string }) => a.id)).toEqual(['2'])
  })

  it('400 on a junk vertical id', async () => {
    expect((await GET(new Request('http://localhost/api/alerts?vertical=nope'))).status).toBe(400)
  })
})

describe('POST /api/alerts/ack as a plain form (/operator)', () => {
  const form = (body: string) =>
    POST(
      new Request('http://localhost/api/alerts/ack', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost' },
        body,
      })
    )
  it('several ids fields → those ids; 303 back with a count', async () => {
    h.ackAlerts.mockResolvedValue([A, A])
    const res = await form(`ids=${A}&ids=${A}&return_to=%2Foperator`)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('http://localhost/operator?flash=Acknowledged+2+alerts')
    expect(h.ackAlerts).toHaveBeenCalledWith({ ids: [A, A] }, null)
  })
  it('a junk id → flash_error, nothing acked', async () => {
    const res = await form('ids=nope')
    expect(res.headers.get('location')).toContain('flash_error=invalid_body')
    expect(h.ackAlerts).not.toHaveBeenCalled()
  })
})
