import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ requireOwner: vi.fn(), listAwaitingActions: vi.fn() }))
vi.mock('@/lib/auth/guards', () => ({ requireOwner: h.requireOwner }))
vi.mock('@/lib/approvals/store', () => ({ listAwaitingActions: h.listAwaitingActions, PENDING_LIMIT: 200 }))

import { NextResponse } from 'next/server'
import { GET } from '@/app/api/actions/pending/route'
import { DbError } from '@/lib/db/service'

const pass = { ok: true, via: 'session', user: {} }
const deny = { ok: false, response: NextResponse.json({ error: 'unauthenticated' }, { status: 401 }) }
const req = () => new Request('http://localhost/api/actions/pending')

const base = { risk: 'high', status: 'awaiting', claim_status: 'awaiting', requested_by: 'agent', agent_run_id: null, rule_id: null, telegram_message_id: null, decided_via: null, decided_at: null, executed_at: null, result: null, error: null, updated_at: '2026-11-23T10:00:00Z' }

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset()
  h.requireOwner.mockResolvedValue(pass)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET /api/actions/pending', () => {
  it('owner-gated', async () => {
    h.requireOwner.mockResolvedValue(deny)
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(h.listAwaitingActions).not.toHaveBeenCalled()
  })

  it('{ count, items } with caps and notify warnings, every kind', async () => {
    h.listAwaitingActions.mockResolvedValue({
      count: 2,
      rows: [
        { ...base, id: 'a2', kind: 'company_check', payload: { summary: 'Check 500', max_usd: 3.89, estimate_usd: 3.53 }, notify_status: 'skipped', notify_error: 'missing token', created_at: '2026-11-23T11:00:00Z' },
        { ...base, id: 'a1', kind: 'pause_campaign', payload: { summary: 'Pause Roofers' }, notify_status: null, created_at: '2026-11-23T10:00:00Z' },
      ],
    })
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.count).toBe(2)
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(['a2', 'a1'])
    expect(body.items[0]).toMatchObject({ kind: 'company_check', cap_usd: 3.89, estimate_usd: 3.53, notify_warning: 'Telegram not sent: missing token' })
    expect(body.items[1]).toMatchObject({ kind: 'pause_campaign', cap_usd: null, notify_warning: null })
  })

  it('zero pending: count 0', async () => {
    h.listAwaitingActions.mockResolvedValue({ count: 0, rows: [] })
    expect(await (await GET(req())).json()).toEqual({ count: 0, items: [] })
  })

  it('a database error is a generic 500', async () => {
    h.listAwaitingActions.mockRejectedValue(new DbError('listAwaitingActions', { message: 'relation x', code: '42P01', details: '', hint: '', name: 'PostgrestError' }))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'database' })
  })
})
