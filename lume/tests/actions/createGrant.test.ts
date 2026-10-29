import { beforeEach, describe, expect, it, vi } from 'vitest'

const svc = vi.hoisted(() => ({
  findAwaitingAction: vi.fn(),
  findAwaitingRuleAction: vi.fn(),
  insertPendingAction: vi.fn(),
  setActionMessageId: vi.fn(),
}))
vi.mock('@/lib/db/service', () => ({ ...svc, isDbError: () => false }))
vi.mock('@/lib/campaigns/service', () => ({ findAwaitingActionBy: vi.fn().mockResolvedValue(null) }))
const tg = vi.hoisted(() => ({ sendActionPrompt: vi.fn(), sendMessage: vi.fn() }))
vi.mock('@/lib/adapters/telegram', () => tg)
const grant = vi.hoisted(() => ({ tryGrantSend: vi.fn() }))
vi.mock('@/lib/actions/grant', () => grant)
vi.mock('@/lib/supabase/service', async () => (await import('../stubs/feed')).serviceModule)
import { feed } from '../stubs/feed'

import { createAction } from '@/lib/actions/create'

const payload = { eaccount: 'me@x.com', reply_to_uuid: 'u-1', body: 'hi', campaign_id: 'c-1', lead_email: 'ada@acme.com', verdict: 'GOOD', summary: 'Send reply to ada@acme.com' }

beforeEach(() => {
  vi.resetAllMocks()
  feed.rows.length = 0
  svc.insertPendingAction.mockImplementation(async (r: Record<string, unknown>) => ({ id: 'a-1', status: 'awaiting', telegram_message_id: null, ...r }))
  tg.sendActionPrompt.mockResolvedValue({ ok: true, messageId: 7 })
  tg.sendMessage.mockResolvedValue({ ok: true, messageId: 8 })
  vi.unstubAllEnvs()
})

describe('createAction: send_reply and the Auto-mode grant', () => {
  it('a granted reply is returned approved, with an info notice instead of the approval prompt', async () => {
    grant.tryGrantSend.mockResolvedValue({ granted: true, row: { id: 'a-1', kind: 'send_reply', status: 'approved', decided_via: 'grant', payload } })
    const row = await createAction('send_reply', payload, 'user')
    expect(row).toMatchObject({ status: 'approved', decided_via: 'grant' })
    expect(tg.sendActionPrompt).not.toHaveBeenCalled()
    expect(tg.sendMessage).toHaveBeenCalledTimes(1)
    expect(feed.rows).toHaveLength(1)
    expect(feed.rows[0]).toMatchObject({ severity: 'info', scope: 'replies', campaign_id: 'c-1', dedupe_key: 'a-1:lume_action' })
    expect(feed.rows[0].title).toMatch(/Auto-approved/)
  })

  it('a held reply gets the usual urgent prompt (Telegram unchanged)', async () => {
    grant.tryGrantSend.mockResolvedValue({ granted: false, reason: 'mode_owner' })
    const row = await createAction('send_reply', payload, 'user')
    expect(row.status).toBe('awaiting')
    expect(tg.sendActionPrompt).toHaveBeenCalledTimes(1)
    expect(feed.rows[0]).toMatchObject({ severity: 'urgent' })
  })

  it('other kinds never consult the grant', async () => {
    await createAction('pause_campaign', { campaign_id: 'c-1', summary: 'Pause' }, 'user')
    expect(grant.tryGrantSend).not.toHaveBeenCalled()
  })

  it('with ALERT_CHANNELS=feed nothing goes to Telegram for a grant', async () => {
    vi.stubEnv('ALERT_CHANNELS', 'feed')
    grant.tryGrantSend.mockResolvedValue({ granted: true, row: { id: 'a-1', kind: 'send_reply', status: 'approved', payload } })
    await createAction('send_reply', payload, 'user')
    expect(tg.sendMessage).not.toHaveBeenCalled()
    expect(feed.rows).toHaveLength(1)
  })
})
