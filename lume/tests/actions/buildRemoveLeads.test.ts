import { beforeEach, describe, expect, it, vi } from 'vitest'

const rl = vi.hoisted(() => ({ buildRemoveLeads: vi.fn() }))
vi.mock('@/lib/actions/removeLeads', async (orig) => ({ ...(await orig<typeof import('@/lib/actions/removeLeads')>()), ...rl }))

import { buildActionRequest } from '@/lib/actions/build'

const CID = '869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d'
beforeEach(() => rl.buildRemoveLeads.mockReset())

describe('buildActionRequest: remove_leads', () => {
  it('validates the request and hands it to the remove_leads builder', async () => {
    rl.buildRemoveLeads.mockResolvedValue({ ok: true, payload: { campaign_id: CID, lead_ids: ['a'], count: 1, summary: 'Remove 1 lead' } })
    const b = await buildActionRequest({ kind: 'remove_leads', payload: { campaign_id: CID, lead_ids: ['a'], reason: 'cap' } })
    expect(b).toEqual({ ok: true, kind: 'remove_leads', payload: { campaign_id: CID, lead_ids: ['a'], count: 1, summary: 'Remove 1 lead' } })
    expect(rl.buildRemoveLeads.mock.calls[0][0]).toEqual({ campaign_id: CID, lead_ids: ['a'], reason: 'cap' })
  })
  it('400 for both / neither selector, a protected state, or no reason', async () => {
    for (const payload of [
      { campaign_id: CID, reason: 'x' },
      { campaign_id: CID, reason: 'x', lead_ids: ['a'], filter: { state: 'bounced' } },
      { campaign_id: CID, reason: 'x', filter: { state: 'replied' } },
      { campaign_id: CID, reason: 'x', filter: { state: 'no_reply_after_days' } },
      { campaign_id: CID, lead_ids: ['a'] },
    ]) {
      expect(await buildActionRequest({ kind: 'remove_leads', payload })).toMatchObject({ ok: false, status: 400 })
    }
    expect(rl.buildRemoveLeads).not.toHaveBeenCalled()
  })
})
