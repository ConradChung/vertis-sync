import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  requireOwnerSession: vi.fn(),
  currentOperator: vi.fn(),
  listAlerts: vi.fn(),
  ackAlerts: vi.fn(),
}))
vi.mock('@/lib/auth/guards', () => ({ requireOwner: h.requireOwner, requireOwnerSession: h.requireOwnerSession }))
vi.mock('@/lib/operators/session', () => ({ currentOperator: h.currentOperator }))
vi.mock('@/lib/alertsStore', () => ({ listAlerts: h.listAlerts, ackAlerts: h.ackAlerts, ALERTS_DEFAULT_LIMIT: 50 }))

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
