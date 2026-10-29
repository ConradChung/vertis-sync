import { describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ rpc }) }))

import { setReplyMode } from '@/lib/inbox/replyModeStore'

describe('setReplyMode', () => {
  it('goes through lume_set_reply_mode, so the mode and its audit event are one transaction', async () => {
    rpc.mockResolvedValue({ data: { from: 'owner', to: 'auto', event_id: 41 }, error: null })
    expect(await setReplyMode('c-1', 'auto', 'owner')).toEqual({ from: 'owner', to: 'auto', event_id: 41 })
    expect(rpc).toHaveBeenCalledWith('lume_set_reply_mode', { p_campaign_id: 'c-1', p_mode: 'auto', p_by: 'owner' })
  })

  it('an RPC error throws (nothing half-written)', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'lock timeout', code: '55P03' } })
    await expect(setReplyMode('c-1', 'auto', 'owner')).rejects.toThrow()
  })
})
