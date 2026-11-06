import { describe, expect, it, vi } from 'vitest'
import { ALWAYS_ASK_KINDS, HIGH_RISK_KIND, SKIPPABLE_KINDS, TOOL_TIERS } from '@/lib/agent/permissions'
import { buildTools } from '@/lib/agent/tools'

const BATCH = '0F3C2B1A-9D8E-4F7A-8B6C-5D4E3F2A1B0C'
const FILE = '1F3C2B1A-9D8E-4F7A-8B6C-5D4E3F2A1B0C'
const CONV = '1a2b3c4d-1111-4222-8333-444455556666'

function setup(skip = false) {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
  const createAction = vi.fn().mockResolvedValue({ id: 'a1' })
  const prepare = vi.fn(async ({ kind, payload }: { kind: string; payload: Record<string, unknown> }) => ({ ok: true as const, kind, payload: { ...payload, summary: 's' } }))
  const autoApprove = vi.fn()
  const tools = buildTools({ fetch: fetch as never, createAction, prepare: prepare as never, agentRunId: 'r', baseUrl: 'https://lume.test', secret: 's', conversationId: CONV, skipPermissions: skip, autoApprove })
  const tool = (n: string) => tools.find((t) => t.name === n)!
  const run = (n: string, input: unknown) => tool(n).run(tool(n).inputSchema.parse(input))
  const sent = (i = 0) => {
    const [url, init] = fetch.mock.calls[i] as unknown as [string, { method?: string; body?: string }]
    return { url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined }
  }
  return { fetch, prepare, createAction, autoApprove, tool, run, sent }
}

describe('influencer candidate tools', () => {
  it('tiers: import low, list read; the lookup and the approval of candidates always ask (sheet / web text reaches the agent)', () => {
    expect([TOOL_TIERS.import_influencer_candidates, TOOL_TIERS.list_influencer_candidates]).toEqual(['low', 'read'])
    expect([TOOL_TIERS.lookup_influencer_candidates, TOOL_TIERS.approve_influencer_candidates]).toEqual(['high', 'high'])
    expect(HIGH_RISK_KIND.lookup_influencer_candidates).toBe('influencer_lookup')
    expect(HIGH_RISK_KIND.approve_influencer_candidates).toBe('influencer_approve')
    for (const k of ['influencer_lookup', 'influencer_approve'] as const) {
      expect(ALWAYS_ASK_KINDS.has(k)).toBe(true)
      expect(SKIPPABLE_KINDS.has(k)).toBe(false)
    }
  })
  it('import stages the attachment for this chat with the column overrides', async () => {
    const { run, sent } = setup()
    await run('import_influencer_candidates', { file_id: FILE, sheet: 'People', columns: { name: 'Full Name' } })
    expect(sent()).toEqual({ url: 'https://lume.test/api/influencers/candidates', method: 'POST', body: { file_id: FILE.toLowerCase(), sheet: 'People', columns: { name: 'Full Name' }, conversation_id: CONV } })
  })
  it('list reads the batches, or one batch filtered by status', async () => {
    const { run, sent } = setup()
    await run('list_influencer_candidates', {})
    await run('list_influencer_candidates', { batch_id: BATCH, status: 'found' })
    expect(sent(0).url).toBe('https://lume.test/api/influencers/candidates')
    expect(sent(1).url).toBe(`https://lume.test/api/influencers/candidates/${BATCH.toLowerCase()}?status=found`)
  })
  it('approve only files an approval (never creates influencers itself), even with skip permissions on', async () => {
    const { run, prepare, createAction, autoApprove, fetch } = setup(true)
    const r = await run('approve_influencer_candidates', { ids: [BATCH] })
    expect(prepare).toHaveBeenCalledWith({ kind: 'influencer_approve', payload: { candidate_ids: [BATCH.toLowerCase()] } })
    expect(createAction.mock.calls[0][0]).toBe('influencer_approve')
    expect(r).toMatchObject({ status: 'awaiting_approval' })
    expect(autoApprove).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
  it('the lookup only files an approval, even with skip permissions on', async () => {
    const { run, prepare, createAction, autoApprove, fetch } = setup(true)
    const r = await run('lookup_influencer_candidates', { batch_id: BATCH, max_usd: 2 })
    expect(prepare).toHaveBeenCalledWith({ kind: 'influencer_lookup', payload: { batch_id: BATCH.toLowerCase(), max_usd: 2 } })
    expect(createAction.mock.calls[0][0]).toBe('influencer_lookup')
    expect(r).toMatchObject({ status: 'awaiting_approval' })
    expect(autoApprove).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('import and list carry the sheet so the chat shows Open in Leads', async () => {
    const SHEET = '5a2b3c4d-1111-4222-8333-444455556666'
    const fetch = vi.fn(async () => new Response(JSON.stringify({ batch: { id: BATCH, name: 'PM' }, list_id: SHEET }), { status: 200 }))
    const tools = buildTools({ fetch: fetch as never, createAction: vi.fn(), prepare: vi.fn() as never, agentRunId: 'r', baseUrl: 'https://lume.test', secret: 's', conversationId: CONV })
    const t = (n: string) => tools.find((x) => x.name === n)!
    const imp = (await t('import_influencer_candidates').run(t('import_influencer_candidates').inputSchema.parse({ file_id: FILE }))) as Record<string, unknown>
    expect(imp.lead_list).toEqual({ list_id: SHEET, name: 'PM' })
    const one = (await t('list_influencer_candidates').run(t('list_influencer_candidates').inputSchema.parse({ batch_id: BATCH }))) as Record<string, unknown>
    expect(one.lead_list).toEqual({ list_id: SHEET, name: 'PM' })
  })
})
