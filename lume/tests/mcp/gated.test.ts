/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// No live writes and no Instantly calls: every collaborator is stubbed.
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => { throw new Error('no db in tests') } }))
const m = vi.hoisted(() => ({
  build: vi.fn(),
  create: vi.fn(),
  getAction: vi.fn(),
  claim: vi.fn(),
  dispatch: vi.fn(),
  fresh: vi.fn(),
  edit: vi.fn(),
  suggest: vi.fn(),
}))
vi.mock('@/lib/actions/build', () => ({ buildActionRequest: m.build }))
vi.mock('@/lib/actions/create', () => {
  class DuplicateActionError extends Error { constructor(readonly existingId: string) { super('dup') } }
  class InvalidActionPayloadError extends Error {}
  return { createAction: m.create, DuplicateActionError, InvalidActionPayloadError }
})
vi.mock('@/lib/actions/store', () => ({ getAction: m.getAction, claimDecision: m.claim }))
vi.mock('@/lib/actions/execute', () => ({ dispatchExecuteNow: m.dispatch }))
vi.mock('@/lib/adapters/instantlySequences', () => ({ getSequenceFresh: m.fresh }))
vi.mock('@/lib/adapters/telegram', () => ({ editMessage: m.edit }))
vi.mock('@/lib/campaigns/suggestData', () => ({ getCampaignSuggestion: m.suggest }))

import { DuplicateActionError } from '@/lib/actions/create'
import { mcpContext } from '@/lib/mcp/context'
import { McpUserError } from '@/lib/mcp/sanitize'
import { confirmableKinds, gatedTools, previewHash } from '@/lib/mcp/tools/gated'

const tool = (n: string) => gatedTools.find((t) => t.name === n)!
const run = (n: string, args: Record<string, unknown>) => tool(n).run(tool(n).input.parse(args) as never) as Promise<any>
const ID = '44444444-4444-4444-8444-444444444444'
const JOB = '55555555-5555-4555-8555-555555555555'
const NOW = new Date('2026-11-21T12:00:00Z')

const filedRow = (over: Record<string, unknown> = {}) => ({
  id: ID, kind: 'pause_campaign', status: 'awaiting', claim_status: 'awaiting', requested_by: 'mcp',
  payload: { campaign_id: 'camp-1', summary: 'Pause Kaspen TX' }, created_at: NOW.toISOString(), telegram_message_id: 9, ...over,
})

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.unstubAllEnvs()
  m.build.mockImplementation(async (req: any) => ({ ok: true, kind: req.kind, payload: { ...req.payload, summary: `do ${req.kind}` } }))
  m.create.mockImplementation(async (kind: string, payload: any, by: string) => filedRow({ kind, payload, requested_by: by }))
})
afterEach(() => vi.useRealTimers())

describe('gated tool list', () => {
  it('campaign setup comes first, confirm/cancel last', () => {
    expect(gatedTools.map((t) => t.name)).toEqual([
      'lume_suggest_campaign_setup', 'lume_get_campaign_sequence', 'lume_create_campaign', 'lume_duplicate_campaign', 'lume_update_sequence',
      'lume_push_to_instantly', 'lume_run_validation', 'lume_pause_campaign', 'lume_resume_campaign', 'lume_assign_leads',
      'lume_run_influencer_scrape', 'lume_run_influencer_reactions', 'lume_run_influencer_lookup', 'lume_confirm_action', 'lume_cancel_action',
    ])
  })
  it('request tools are never destructive; only confirm is', () => {
    for (const t of gatedTools) {
      expect(t.annotations.destructiveHint).toBe(t.name === 'lume_confirm_action')
    }
    expect(tool('lume_confirm_action').cls).toBe('confirm')
  })
})

describe('request tools file a pending action and only that', () => {
  it.each([
    ['lume_create_campaign', { name: 'Kaspen · TX', template_id: JOB.toUpperCase(), email_list: ['a@x.com'], daily_limit: 50 }, 'new_campaign'],
    ['lume_duplicate_campaign', { source_campaign_id: 'camp-1', name: 'Copy' }, 'create_campaign'],
    ['lume_update_sequence', { campaign_id: 'camp-1', base_hash: 'a'.repeat(32), steps: [{ delay: 0, delay_unit: 'days', variants: [{ subject: 'Hi', body: 'Hello' }] }] }, 'update_sequence'],
    ['lume_push_to_instantly', { job_id: JOB }, 'push_to_instantly'],
    ['lume_run_validation', { list_id: JOB }, 'send_lead_list'],
    ['lume_assign_leads', { campaign_id: 'camp-1', filter: { states: ['TX'] }, limit: 100 }, 'assign_leads'],
    ['lume_run_influencer_scrape', { slugs: ['jane'] }, 'influencer_run'],
    ['lume_run_influencer_reactions', { run_id: JOB }, 'influencer_reactions'],
    ['lume_run_influencer_lookup', { batch_id: JOB }, 'influencer_lookup'],
  ])('%s → builds %s like the dashboard, files it as requested_by mcp, returns the preview', async (name, args, kind) => {
    const out = await run(name as string, args as Record<string, unknown>)
    expect(m.build.mock.calls[0][0].kind).toBe(kind)
    expect(m.build.mock.calls[0][0].payload).not.toHaveProperty('idempotency_key')
    expect(m.create).toHaveBeenCalledWith(kind, expect.objectContaining({ summary: `do ${kind}` }), 'mcp', { ruleId: null })
    expect(out.data).toMatchObject({ action_id: ID, kind, status: 'awaiting', summary: `do ${kind}` })
    expect(out.data.approve_in).toMatch(/dashboard|Telegram/)
    expect(m.claim).not.toHaveBeenCalled()
    expect(m.dispatch).not.toHaveBeenCalled()
  })

  it('a refused build files nothing and says why', async () => {
    m.build.mockResolvedValue({ ok: false, status: 409, error: 'nothing_to_push' })
    await expect(run('lume_push_to_instantly', { job_id: JOB })).rejects.toThrow(/nothing_to_push.*Nothing was filed/)
    expect(m.create).not.toHaveBeenCalled()
  })

  it('a duplicate names the action already awaiting', async () => {
    m.create.mockRejectedValue(new (DuplicateActionError as any)('existing-1'))
    await expect(run('lume_duplicate_campaign', { source_campaign_id: 'camp-1', name: 'Copy' })).rejects.toThrow(/existing-1/)
  })

  it('update_sequence requires base_hash', () => {
    expect(() => tool('lume_update_sequence').input.parse({ campaign_id: 'c', steps: [{ delay: 0, delay_unit: 'days', variants: [{ subject: 's', body: 'b' }] }] })).toThrow()
  })
})

describe('pause / resume read the live status first', () => {
  it('pause of an active campaign files and returns a preview hash bound to that status', async () => {
    m.fresh.mockResolvedValue({ status: 1, hash: 'h', steps: [], name: 'X' })
    const out = await run('lume_pause_campaign', { campaign_id: 'camp-1' })
    expect(m.create).toHaveBeenCalledWith('pause_campaign', expect.anything(), 'mcp', { ruleId: null })
    expect(out.data.mcp_can_confirm).toBe(true)
    expect(out.data.preview_hash).toBe(previewHash(filedRow() as any, 1))
    expect(out.data.confirm_by).toBe('2026-11-21T13:00:00.000Z')
  })
  it.each([[2, 'pause'], [0, 'pause'], [1, 'resume'], [0, 'resume'], [3, 'resume']])('status %s: %s is refused before anything is filed', async (status, op) => {
    m.fresh.mockResolvedValue({ status, hash: 'h', steps: [], name: 'X' })
    await expect(run(`lume_${op}_campaign`, { campaign_id: 'camp-1' })).rejects.toBeInstanceOf(McpUserError)
    expect(m.create).not.toHaveBeenCalled()
  })
})

describe('lume_confirm_action', () => {
  const hash = () => previewHash(filedRow() as any, 1)
  const confirm = (over: Record<string, unknown> = {}) => run('lume_confirm_action', { action_id: ID, preview_hash: hash(), confirm: true, ...over })
  beforeEach(() => {
    m.getAction.mockResolvedValue(filedRow())
    m.fresh.mockResolvedValue({ status: 1, hash: 'h', steps: [], name: 'X' })
    m.claim.mockResolvedValue(filedRow({ status: 'approved', claim_status: 'claimed' }))
    m.dispatch.mockResolvedValue('dispatched')
  })

  it('approves via mcp and hands off to /api/actions/<id>/execute on this deployment', async () => {
    const out = await mcpContext.run({ origin: 'https://lume.internal' }, () => confirm())
    expect(m.claim).toHaveBeenCalledWith(ID, true, 'mcp')
    expect(m.dispatch).toHaveBeenCalledWith(ID, 'https://lume.internal')
    expect(m.edit).toHaveBeenCalledWith(9, expect.stringContaining('Approved'))
    expect(out.data).toMatchObject({ status: 'approved', started: true })
  })

  it('confirm must be literally true', () => {
    expect(() => tool('lume_confirm_action').input.parse({ action_id: ID, preview_hash: hash(), confirm: false })).toThrow()
  })

  const refused = async (re: RegExp) => {
    await expect(confirm()).rejects.toThrow(re)
    expect(m.claim).not.toHaveBeenCalled()
    expect(m.dispatch).not.toHaveBeenCalled()
  }
  it('refuses rows not requested via MCP', async () => {
    m.getAction.mockResolvedValue(filedRow({ requested_by: 'user' }))
    await refused(/requested through MCP/)
  })
  it('refuses kinds outside the allowlist (new_campaign, push, …)', async () => {
    m.getAction.mockResolvedValue(filedRow({ kind: 'push_to_instantly' }))
    await refused(/not confirmable/)
  })
  it('refuses after the 1 hour window (still approvable in Lume/Telegram)', async () => {
    m.getAction.mockResolvedValue(filedRow({ created_at: new Date(NOW.getTime() - 61 * 60_000).toISOString() }))
    await refused(/older than 1 hour/)
  })
  it('refuses a row that is no longer awaiting', async () => {
    m.getAction.mockResolvedValue(filedRow({ status: 'rejected', claim_status: 'claimed' }))
    await refused(/already rejected/)
  })
  it('refuses when the live status changed since the preview (hash mismatch)', async () => {
    m.fresh.mockResolvedValue({ status: 2, hash: 'h', steps: [], name: 'X' })
    await refused(/changed since the preview/)
  })
  it('a lost claim (decided in Telegram first) does nothing', async () => {
    m.claim.mockResolvedValue(null)
    await expect(confirm()).rejects.toThrow(/decided this action first/)
    expect(m.dispatch).not.toHaveBeenCalled()
  })
  it('a failed hand-off leaves it approved for the capped sweeper', async () => {
    m.dispatch.mockResolvedValue({ error: 'execute returned 500' })
    const out = await mcpContext.run({ origin: 'https://lume.internal' }, () => confirm())
    expect(out.data).toMatchObject({ status: 'approved', started: false })
    expect(out.data.note).toMatch(/sweeper/)
  })
})

describe('confirm allowlist is config, capped by code', () => {
  it('defaults to pause and resume', () => {
    expect([...confirmableKinds({})].sort()).toEqual(['pause_campaign', 'resume_campaign'])
  })
  it('config can narrow it', () => {
    expect([...confirmableKinds({ LUME_MCP_CONFIRM_KINDS: 'pause_campaign' })]).toEqual(['pause_campaign'])
    expect([...confirmableKinds({ LUME_MCP_CONFIRM_KINDS: '' })]).toEqual([])
  })
  it('config can never widen it past pause/resume', () => {
    expect([...confirmableKinds({ LUME_MCP_CONFIRM_KINDS: 'push_to_instantly,new_campaign,send_reply,pause_campaign' })]).toEqual(['pause_campaign'])
  })
  it('a narrowed allowlist is enforced at confirm', async () => {
    vi.stubEnv('LUME_MCP_CONFIRM_KINDS', 'pause_campaign')
    m.getAction.mockResolvedValue(filedRow({ kind: 'resume_campaign' }))
    await expect(run('lume_confirm_action', { action_id: ID, preview_hash: 'f'.repeat(64), confirm: true })).rejects.toThrow(/not confirmable/)
    expect(m.claim).not.toHaveBeenCalled()
  })
})

describe('lume_cancel_action', () => {
  it('rejects an awaiting MCP row via mcp', async () => {
    m.getAction.mockResolvedValue(filedRow())
    m.claim.mockResolvedValue(filedRow({ status: 'rejected' }))
    const out = await run('lume_cancel_action', { action_id: ID })
    expect(m.claim).toHaveBeenCalledWith(ID, false, 'mcp')
    expect(out.data).toEqual({ action_id: ID, cancelled: true, status: 'rejected' })
  })
  it('never touches rows from the dashboard, Telegram, rules or the agent', async () => {
    m.getAction.mockResolvedValue(filedRow({ requested_by: 'agent' }))
    await expect(run('lume_cancel_action', { action_id: ID })).rejects.toThrow(/requested through MCP/)
    expect(m.claim).not.toHaveBeenCalled()
  })
})
