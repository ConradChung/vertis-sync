import { describe, it, expect, vi } from 'vitest'
import { TOOL_TIERS, HIGH_RISK_KIND, ALWAYS_ASK_KINDS, skippable } from '@/lib/agent/permissions'
import { buildTools } from '@/lib/agent/tools'

const prepare = vi.fn(async (r: { kind: string; payload: Record<string, unknown> }) => ({ ok: true as const, kind: r.kind, payload: { ...r.payload, summary: 's' } }))

describe('tool tiering', () => {
  it('every high-risk tool maps to a pending_actions kind', () => {
    for (const [name, tier] of Object.entries(TOOL_TIERS)) if (tier === 'high') expect(HIGH_RISK_KIND[name]).toBeTruthy()
  })
  it('high-risk tools never call a route; they create a pending action', async () => {
    const fetchSpy = vi.fn(); const createAction = vi.fn().mockResolvedValue({ id: 'a1' })
    const tools = buildTools({ fetch: fetchSpy, createAction, prepare: prepare as never, agentRunId: 'r1' })
    const send = tools.find(t => t.name === 'send_reply')!
    const out = await send.run({ eaccount: 'me@send.com', campaign_id: 'c', reply_to_uuid: 'e', body: 'hi' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(createAction).toHaveBeenCalledWith('send_reply', expect.anything(), 'agent', expect.objectContaining({ agentRunId: 'r1' }))
    expect(out).toMatchObject({ status: 'awaiting_approval', action_id: 'a1' })
  })
  it('read tools call their route with the internal bearer', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('[]'))
    const tools = buildTools({ fetch: fetchSpy, createAction: vi.fn(), prepare: prepare as never, agentRunId: 'r1' })
    await tools.find(t => t.name === 'list_orders')!.run({})
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toMatch(/^Bearer /)
  })
})

describe('skip-permissions mode', () => {
  it('money and lead-email kinds always ask', () => {
    for (const k of ['run_actor', 'send_reply', 'decide_gate', 'launch_campaign', 'resume_campaign'] as const) {
      expect(ALWAYS_ASK_KINDS.has(k)).toBe(true)
      expect(skippable(k)).toBe(false)
    }
  })
  it('the rest are skippable', () => {
    for (const k of ['assign_leads', 'activate_rule', 'pause_campaign', 'create_campaign', 'delete_rule', 'update_sequence'] as const)
      expect(skippable(k)).toBe(true)
  })
  it('every high-risk kind has an answer', () => {
    for (const kind of Object.values(HIGH_RISK_KIND)) expect(typeof skippable(kind)).toBe('boolean')
  })
})
