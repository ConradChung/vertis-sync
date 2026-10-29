import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InboxEmail } from '@/lib/inbox/model'

const h = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  currentOperator: vi.fn(),
  getVertical: vi.fn(),
  listEmails: vi.fn(),
  getEmail: vi.fn(),
  getThreadEmails: vi.fn(),
  recordReply: vi.fn(),
  markReplyHandled: vi.fn(),
  findDeal: vi.fn(),
  findLeadByEmail: vi.fn(),
  ackAlertsByDedupeKey: vi.fn(),
}))
vi.mock('@/lib/auth/guards', async (orig) => ({ ...(await orig<typeof import('@/lib/auth/guards')>()), requireOwner: h.requireOwner }))
vi.mock('@/lib/operators/session', () => ({ currentOperator: h.currentOperator }))
vi.mock('@/lib/operators/store', () => ({ getVertical: h.getVertical }))
vi.mock('@/lib/adapters/instantlyEmails', async () => {
  const { InstantlyError } = await import('@/lib/adapters/instantly')
  class RateLimitedError extends InstantlyError {
    constructor(readonly retryAfterMs: number) {
      super(429, 'rate limited')
    }
  }
  return { RateLimitedError, listEmails: h.listEmails, getEmail: h.getEmail, getThreadEmails: h.getThreadEmails }
})
vi.mock('@/lib/inbox/store', () => ({ recordReply: h.recordReply, markReplyHandled: h.markReplyHandled }))
vi.mock('@/lib/crm/service', () => ({ findDeal: h.findDeal, findLeadByEmail: h.findLeadByEmail }))
vi.mock('@/lib/alertsStore', () => ({ ackAlertsByDedupeKey: h.ackAlertsByDedupeKey }))
vi.mock('@/lib/supabase/service', async () => (await import('../stubs/feed')).serviceModule)
import { feed } from '../stubs/feed'

import { GET as repliesGET } from '@/app/api/inbox/replies/route'
import { GET as threadGET } from '@/app/api/inbox/thread/route'
import { RateLimitedError } from '@/lib/adapters/instantlyEmails'

const C1 = '869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d'
const C2 = '11111111-2222-4333-8444-555555555555'
const V = '0a4c1e2f-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
const BOT = { id: 'op-1', vertical_id: V, is_master: false, label: 'Scaleport inbox', revoked_at: null }

const email = (o: Partial<InboxEmail> = {}): InboxEmail => ({
  id: 'e1', thread_id: 't1', direction: 'in', eaccount: 'frank@ours.com', from: 'ada@acme.com', to: ['frank@ours.com'], cc: [],
  lead: 'ada@acme.com', subject: 'Re: hi', text: 'Yes please.\n\nOn Mon Frank wrote:\n> hi', at: '2026-10-28T10:00:00.000Z',
  campaign_id: C1, interest: null, unread: true, auto_reply: false, created_at: null, ...o,
})

const get = (path: string) => new Request(`http://localhost${path}`)

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset()
  feed.rows = []
  process.env.INSTANTLY_API_KEY = 'k'
  h.requireOwner.mockResolvedValue({ ok: true, via: 'session', user: { id: 'u', email: 'o@x' } })
  h.currentOperator.mockResolvedValue(null)
  h.getVertical.mockResolvedValue({ id: V, name: 'Scaleport', campaign_ids: [C1, 'gmail:recruiter'], scopes: ['replies'], is_default: false, archived_at: null })
  h.listEmails.mockResolvedValue({ emails: [email()], next: null, stale: false })
  h.recordReply.mockResolvedValue(true)
  h.findDeal.mockResolvedValue({ name: 'Ada Lovelace', company: 'Acme' })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET /api/inbox/replies', () => {
  it('owner: every campaign, received only, mapped with a trimmed excerpt', async () => {
    const res = await repliesGET(get('/api/inbox/replies?unread=true&interest=interested&limit=10'))
    expect(res.status).toBe(200)
    expect(h.listEmails).toHaveBeenCalledWith({ campaign_id: undefined, email_type: 'received', is_unread: true, i_status: 1, limit: 10, starting_after: undefined })
    const body = await res.json()
    expect(body.replies[0]).toMatchObject({ reply_to_uuid: 'e1', eaccount: 'frank@ours.com', lead_email: 'ada@acme.com', excerpt: 'Yes please.' })
    expect(res.headers.get('cache-control')).toContain('no-store')
  })

  it('a vertical bot defaults to its one Instantly campaign', async () => {
    h.currentOperator.mockResolvedValue(BOT)
    await repliesGET(get('/api/inbox/replies'))
    expect(h.listEmails).toHaveBeenCalledWith(expect.objectContaining({ campaign_id: C1 }))
  })

  it('a vertical bot asking for another campaign: 403, no Instantly call', async () => {
    h.currentOperator.mockResolvedValue(BOT)
    const res = await repliesGET(get(`/api/inbox/replies?campaign_id=${C2}`))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'campaign_out_of_scope' })
    expect(h.listEmails).not.toHaveBeenCalled()
  })

  it('a vertical bot never sees another campaign even if Instantly returned one', async () => {
    h.currentOperator.mockResolvedValue(BOT)
    h.listEmails.mockResolvedValue({ emails: [email(), email({ id: 'e2', campaign_id: C2 })], next: null, stale: false })
    const body = await (await repliesGET(get('/api/inbox/replies'))).json()
    expect(body.replies.map((r: { reply_to_uuid: string }) => r.reply_to_uuid)).toEqual(['e1'])
  })

  it('the master bot sees everything', async () => {
    h.currentOperator.mockResolvedValue({ ...BOT, is_master: true, vertical_id: null })
    await repliesGET(get(`/api/inbox/replies?campaign_id=${C2}`))
    expect(h.listEmails).toHaveBeenCalledWith(expect.objectContaining({ campaign_id: C2 }))
  })

  it('rate limited: 429 with Retry-After', async () => {
    h.listEmails.mockRejectedValue(new RateLimitedError(12_300))
    const res = await repliesGET(get('/api/inbox/replies'))
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('13')
    expect(await res.json()).toEqual({ error: 'rate_limited', retry_after_s: 13 })
  })

  it('bad query: 400; Instantly unset: configured false', async () => {
    expect((await repliesGET(get('/api/inbox/replies?limit=500'))).status).toBe(400)
    expect((await repliesGET(get('/api/inbox/replies?interest=maybe'))).status).toBe(400)
    delete process.env.INSTANTLY_API_KEY
    expect(await (await repliesGET(get('/api/inbox/replies'))).json()).toEqual({ configured: false })
  })

  it('an interested reply is recorded and alerted once (feed only, urgent, replies scope, deduped)', async () => {
    h.listEmails.mockResolvedValue({ emails: [email({ interest: 1 })], next: null, stale: false })
    await repliesGET(get('/api/inbox/replies'))
    expect(h.recordReply).toHaveBeenCalledWith(expect.objectContaining({ reply_to_uuid: 'e1', source: 'poll', lead_name: 'Ada Lovelace', company: 'Acme', campaign_id: C1 }))
    expect(feed.rows).toEqual([
      expect.objectContaining({
        source: 'lume.replies', severity: 'urgent', scope: 'replies', campaign_id: C1, dedupe_key: 'e1:reply',
        title: 'Positive reply: Ada Lovelace <ada@acme.com> (Acme)', link: '/operator#new-replies',
      }),
    ])
    h.recordReply.mockResolvedValue(false)
    await repliesGET(get('/api/inbox/replies'))
    expect(feed.rows).toHaveLength(1)
  })

  it('non-interested and auto replies are not recorded', async () => {
    h.listEmails.mockResolvedValue({ emails: [email({ interest: -1 }), email({ id: 'e3', interest: 1, auto_reply: true })], next: null, stale: false })
    await repliesGET(get('/api/inbox/replies'))
    expect(h.recordReply).not.toHaveBeenCalled()
  })

  it('a recording failure never fails the read', async () => {
    h.listEmails.mockResolvedValue({ emails: [email({ interest: 1 })], next: null, stale: false })
    h.recordReply.mockRejectedValue(new Error('db'))
    expect((await repliesGET(get('/api/inbox/replies'))).status).toBe(200)
  })
})

describe('GET /api/inbox/thread', () => {
  const out = email({ id: 'o1', direction: 'out', from: 'frank@ours.com', text: 'Hi Ada', at: '2026-10-27T09:00:00.000Z' })

  it('by reply_to_uuid: oldest → newest, trimmed, with latest_inbound', async () => {
    h.getEmail.mockResolvedValue(email())
    h.getThreadEmails.mockResolvedValue([email(), out])
    const res = await threadGET(get('/api/inbox/thread?reply_to_uuid=e1'))
    expect(h.getThreadEmails).toHaveBeenCalledWith('t1')
    const { thread } = await res.json()
    expect(thread.messages.map((m: { id: string }) => m.id)).toEqual(['o1', 'e1'])
    expect(thread.messages[1].text).toBe('Yes please.')
    expect(thread.latest_inbound).toMatchObject({ reply_to_uuid: 'e1', eaccount: 'frank@ours.com' })
  })

  it('by thread_id', async () => {
    h.getThreadEmails.mockResolvedValue([out])
    expect((await threadGET(get('/api/inbox/thread?thread_id=t1'))).status).toBe(200)
    expect(h.getEmail).not.toHaveBeenCalled()
  })

  it('needs exactly one of the two ids', async () => {
    expect((await threadGET(get('/api/inbox/thread'))).status).toBe(400)
    expect((await threadGET(get('/api/inbox/thread?thread_id=t1&reply_to_uuid=e1'))).status).toBe(400)
  })

  it('unknown email: 404; out-of-scope email: 403 before the thread read', async () => {
    h.getEmail.mockResolvedValue(null)
    expect((await threadGET(get('/api/inbox/thread?reply_to_uuid=nope'))).status).toBe(404)
    h.currentOperator.mockResolvedValue(BOT)
    h.getEmail.mockResolvedValue(email({ campaign_id: C2 }))
    expect((await threadGET(get('/api/inbox/thread?reply_to_uuid=e1'))).status).toBe(403)
    expect(h.getThreadEmails).not.toHaveBeenCalled()
  })

  it('a vertical bot: a thread_id whose emails sit in another campaign is 403', async () => {
    h.currentOperator.mockResolvedValue(BOT)
    h.getThreadEmails.mockResolvedValue([email({ campaign_id: C2 })])
    expect((await threadGET(get('/api/inbox/thread?thread_id=t1'))).status).toBe(403)
  })
})
