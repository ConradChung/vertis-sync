import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/adapters/instantlyEmails', () => ({ getEmail: vi.fn(), getThreadEmails: vi.fn(), listEmails: vi.fn() }))
vi.mock('@/lib/alertsStore', () => ({ ackAlertsByDedupeKey: vi.fn() }))
const crm = vi.hoisted(() => ({ findDeal: vi.fn(), findLeadByEmail: vi.fn() }))
vi.mock('@/lib/crm/service', () => crm)
const store = vi.hoisted(() => ({ recordReply: vi.fn(), markReplyHandled: vi.fn() }))
vi.mock('@/lib/inbox/store', () => store)
const push = vi.hoisted(() => ({ pushForItem: vi.fn() }))
vi.mock('@/lib/webhooks/deliver', () => push)
vi.mock('@/lib/supabase/service', async () => (await import('../stubs/feed')).serviceModule)

import { notePositiveReply } from '@/lib/inbox/replies'

beforeEach(() => {
  vi.resetAllMocks()
  crm.findDeal.mockResolvedValue({ name: 'Ada Lovelace', company: 'Acme' })
})

describe('notePositiveReply: webhook push (3f)', () => {
  it('the first sighting pushes positive_reply with name and company only', async () => {
    store.recordReply.mockResolvedValue(true)
    await notePositiveReply({ reply_to_uuid: 'u-1', campaign_id: 'c-1', lead_email: 'ada@acme.com', source: 'webhook', excerpt: 'Tuesday works' })
    expect(push.pushForItem).toHaveBeenCalledWith(
      { campaign_id: 'c-1', scope: 'replies' },
      { type: 'positive_reply', item_id: 'u-1', summary: 'New positive reply from Ada Lovelace (Acme). Check /operator.', link: '/operator#new-replies' }
    )
    const sent = JSON.stringify(push.pushForItem.mock.calls)
    expect(sent).not.toContain('ada@acme.com')
    expect(sent).not.toContain('Tuesday works')
  })

  it('a repeat sighting pushes nothing', async () => {
    store.recordReply.mockResolvedValue(false)
    await notePositiveReply({ reply_to_uuid: 'u-1', campaign_id: 'c-1', lead_email: 'ada@acme.com', source: 'poll' })
    expect(push.pushForItem).not.toHaveBeenCalled()
  })
})
