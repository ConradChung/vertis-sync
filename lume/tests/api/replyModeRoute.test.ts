import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getClaims: async () => ({ data: { claims: { sub: 'owner-id', email: 'owner@example.com' } } }) } }),
}))
const modes = vi.hoisted(() => ({ listReplyModes: vi.fn(), setReplyMode: vi.fn() }))
vi.mock('@/lib/inbox/replyModeStore', () => modes)
const svc = vi.hoisted(() => ({ logEvent: vi.fn() }))
vi.mock('@/lib/db/service', () => svc)
vi.mock('@/lib/supabase/service', async () => (await import('../stubs/feed')).serviceModule)
import { feed } from '../stubs/feed'

import { GET, PUT } from '@/app/api/campaigns/reply-mode/route'

const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/campaigns/reply-mode', { method, ...(body ? { body: JSON.stringify(body) } : {}), headers: { 'content-type': 'application/json', ...headers } })

beforeEach(() => {
  vi.resetAllMocks()
  feed.rows.length = 0
  process.env.LUME_ALLOWED_EMAIL = 'owner@example.com'
  vi.stubEnv('LUME_INTERNAL_SECRET', 'internal-secret')
})

describe('/api/campaigns/reply-mode', () => {
  it('GET lists the stored modes (the agent bearer may read)', async () => {
    modes.listReplyModes.mockResolvedValue([{ campaign_id: 'c-1', mode: 'auto' }])
    const res = await GET(req('GET', undefined, { authorization: 'Bearer internal-secret' }))
    expect(await res.json()).toEqual({ modes: [{ campaign_id: 'c-1', mode: 'auto' }] })
  })

  it('PUT by the owner changes the mode, logs an event and an owner-only alert', async () => {
    modes.setReplyMode.mockResolvedValue({ from: 'owner', to: 'auto' })
    const res = await PUT(req('PUT', { campaign_id: '869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d', mode: 'auto' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ campaign_id: '869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d', mode: 'auto', from: 'owner' })
    expect(modes.setReplyMode).toHaveBeenCalledWith('869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d', 'auto', 'owner')
    expect(svc.logEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'lume.reply_mode_changed', payload: expect.objectContaining({ from: 'owner', to: 'auto' }) }))
    expect(feed.rows).toHaveLength(1)
    expect(feed.rows[0]).toMatchObject({ owner_only: true, severity: 'warn', scope: 'replies' })
  })

  it('an unchanged mode logs nothing', async () => {
    modes.setReplyMode.mockResolvedValue({ from: 'owner', to: 'owner' })
    await PUT(req('PUT', { campaign_id: 'c-1', mode: 'owner' }))
    expect(svc.logEvent).not.toHaveBeenCalled()
    expect(feed.rows).toHaveLength(0)
  })

  it('owner-only: the agent bearer and any Grok Bot cookie are refused, like minting a key', async () => {
    expect((await PUT(req('PUT', { campaign_id: 'c-1', mode: 'auto' }, { authorization: 'Bearer internal-secret' }))).status).toBe(403)
    const bot = await PUT(req('PUT', { campaign_id: 'c-1', mode: 'auto' }, { cookie: 'lume_op=anything' }))
    expect(bot.status).toBe(403)
    expect(await bot.json()).toEqual({ error: 'operator_forbidden' })
    expect(modes.setReplyMode).not.toHaveBeenCalled()
  })

  it('400 for an unknown mode or a bad campaign id', async () => {
    expect((await PUT(req('PUT', { campaign_id: 'c-1', mode: 'everyone' }))).status).toBe(400)
    expect((await PUT(req('PUT', { campaign_id: 'bad id!', mode: 'auto' }))).status).toBe(400)
  })
})
