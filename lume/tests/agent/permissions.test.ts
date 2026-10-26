import { describe, it, expect, vi } from 'vitest'
import { TOOL_TIERS, HIGH_RISK_KIND } from '@/lib/agent/permissions'
import { buildTools } from '@/lib/agent/tools'

describe('tool tiering', () => {
  it('every high-risk tool maps to a pending_actions kind', () => {
    for (const [name, tier] of Object.entries(TOOL_TIERS)) if (tier === 'high') expect(HIGH_RISK_KIND[name]).toBeTruthy()
  })
  it('high-risk tools never call a route; they create a pending action', async () => {
    const fetchSpy = vi.fn(); const createAction = vi.fn().mockResolvedValue({ id: 'a1' })
    const tools = buildTools({ fetch: fetchSpy, createAction, agentRunId: 'r1' })
    const send = tools.find(t => t.name === 'send_reply')!
    const out = await send.run({ campaign_id: 'c', reply_to_uuid: 'e', body: 'hi' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(createAction).toHaveBeenCalledWith('send_reply', expect.anything(), 'agent', expect.objectContaining({ agentRunId: 'r1' }))
    expect(out).toMatchObject({ status: 'awaiting_approval', action_id: 'a1' })
  })
  it('read tools call their route with the internal bearer', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('[]'))
    const tools = buildTools({ fetch: fetchSpy, createAction: vi.fn(), agentRunId: 'r1' })
    await tools.find(t => t.name === 'list_orders')!.run({})
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toMatch(/^Bearer /)
  })
})
