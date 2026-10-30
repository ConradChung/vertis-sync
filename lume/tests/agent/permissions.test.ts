import { describe, it, expect, vi } from 'vitest'
import { TOOL_TIERS, HIGH_RISK_KIND, ALWAYS_ASK_KINDS, SKIPPABLE_KINDS, skippable } from '@/lib/agent/permissions'
import type { PendingActionKind } from '@/lib/db/types'
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
  it('every high-risk kind is in exactly one of the two sets', () => {
    for (const kind of Object.values(HIGH_RISK_KIND)) {
      expect(Number(SKIPPABLE_KINDS.has(kind)) + Number(ALWAYS_ASK_KINDS.has(kind)), kind).toBe(1)
    }
  })
  it('kinds no agent tool files are in neither set, so they ask (allowlist fails closed)', () => {
    // Keyed by the union, so a new kind fails tsc here until it is classified.
    const ALL: Record<PendingActionKind, true> = {
      push_to_instantly: true, launch_campaign: true, assign_leads: true, activate_rule: true, send_reply: true,
      pause_campaign: true, resume_campaign: true, create_campaign: true, decide_gate: true, delete_rule: true,
      crm_close_deal: true, run_actor: true, update_sequence: true, issue_operator_key: true, remove_leads: true, label_reply: true,
      influencer_run: true, influencer_reactions: true,
    }
    const agentKinds = new Set(Object.values(HIGH_RISK_KIND))
    const others = (Object.keys(ALL) as PendingActionKind[]).filter((k) => !agentKinds.has(k))
    expect(others).toEqual(expect.arrayContaining(['push_to_instantly', 'crm_close_deal']))
    for (const k of others) {
      expect(SKIPPABLE_KINDS.has(k) || ALWAYS_ASK_KINDS.has(k), k).toBe(false)
      expect(skippable(k)).toBe(false)
    }
  })
})
