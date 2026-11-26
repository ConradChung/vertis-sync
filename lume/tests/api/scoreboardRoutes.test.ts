import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => ({ email: 'owner@example.com' as string | null }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getClaims: async () => ({ data: session.email ? { claims: { sub: 'u', email: session.email } } : null }) } }),
}))
const store = vi.hoisted(() => ({ getScoreboard: vi.fn(), setTopObjection: vi.fn() }))
vi.mock('@/lib/scoreboard/store', () => store)
const replies = vi.hoisted(() => ({ loadReplies: vi.fn() }))
vi.mock('@/lib/replies/store', () => replies)
const today = vi.hoisted(() => ({ loadToday: vi.fn() }))
vi.mock('@/lib/today/store', () => today)

import { GET as scoreGET, PUT as scorePUT } from '@/app/api/scoreboard/route'
import { GET as repliesGET } from '@/app/api/replies/route'
import { GET as todayGET } from '@/app/api/today/route'
import { weekOf } from '@/lib/scoreboard/week'

const put = (body: unknown) => new Request('http://localhost/api/scoreboard', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  vi.clearAllMocks()
  session.email = 'owner@example.com'
  process.env.LUME_ALLOWED_EMAIL = 'owner@example.com'
  store.getScoreboard.mockResolvedValue({ week: { start: '2026-11-23', end: '2026-11-30', label: 'x' }, counts: { conversations: 1, pilots_started: 0, pilots_paid: 0 }, top_objection: null })
  store.setTopObjection.mockImplementation(async (_w: string, t: string | null) => t)
  replies.loadReplies.mockResolvedValue({ items: [], approvals: 0, replies: 0 })
  today.loadToday.mockResolvedValue({ today: '2026-11-26', scoreboard: null, queue: { signals: { items: [], total: 0 }, replies: { items: [], open: 0 }, checkins: [], tasks: [] }, errors: [] })
})

describe('/api/scoreboard, /api/replies, /api/today', () => {
  it('are owner-only', async () => {
    session.email = 'someone@else.com'
    for (const res of [await scoreGET(new Request('http://localhost/api/scoreboard')), await scorePUT(put({ top_objection: 'x' })), await repliesGET(new Request('http://localhost/api/replies')), await todayGET(new Request('http://localhost/api/today'))]) {
      expect([401, 403]).toContain(res.status)
    }
    expect(store.setTopObjection).not.toHaveBeenCalled()
    expect(replies.loadReplies).not.toHaveBeenCalled()
    expect(today.loadToday).not.toHaveBeenCalled()
  })

  it('GET returns the counts; the reads answer the owner', async () => {
    const res = await scoreGET(new Request('http://localhost/api/scoreboard'))
    expect(res.status).toBe(200)
    expect((await res.json()).counts).toEqual({ conversations: 1, pilots_started: 0, pilots_paid: 0 })
    expect((await repliesGET(new Request('http://localhost/api/replies'))).status).toBe(200)
    expect((await todayGET(new Request('http://localhost/api/today'))).status).toBe(200)
  })

  it("PUT saves this week's top objection (and null clears it)", async () => {
    const res = await scorePUT(put({ top_objection: 'We already have a VA for that' }))
    expect(res.status).toBe(200)
    expect(store.setTopObjection).toHaveBeenCalledWith(weekOf().start, 'We already have a VA for that')
    await scorePUT(put({ top_objection: null }))
    expect(store.setTopObjection).toHaveBeenLastCalledWith(weekOf().start, null)
  })

  it('PUT refuses a long line, a missing field and anything extra', async () => {
    for (const bad of [{ top_objection: 'x'.repeat(301) }, {}, { top_objection: 'ok', counts: { pilots_paid: 9 } }, { top_objection: 5 }]) {
      expect((await scorePUT(put(bad))).status).toBe(400)
    }
    expect(store.setTopObjection).not.toHaveBeenCalled()
  })
})
