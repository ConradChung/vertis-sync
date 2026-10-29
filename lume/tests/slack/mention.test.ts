import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({ getBotToken: vi.fn(), getBinding: vi.fn(), getInstall: vi.fn(), getPostByTs: vi.fn() }))
vi.mock('@/lib/slack/store', () => store)
const api = vi.hoisted(() => ({ slackApi: vi.fn() }))
vi.mock('@/lib/slack/api', () => api)
const actions = vi.hoisted(() => ({ getAction: vi.fn() }))
vi.mock('@/lib/actions/store', () => actions)
vi.mock('@/lib/actions/create', () => ({ BLOCKING_REPLY_STATUSES: [] }))
vi.mock('@/lib/actions/grant', () => ({}))
vi.mock('@/lib/campaigns/service', () => ({}))
vi.mock('@/lib/inbox/store', () => ({}))
vi.mock('@/lib/inbox/replyModeStore', () => ({}))
vi.mock('@/lib/slack/facts', () => ({}))
const ops = vi.hoisted(() => ({ listVerticals: vi.fn() }))
vi.mock('@/lib/operators/store', () => ops)
const alerts = vi.hoisted(() => ({ alert: vi.fn(), alertLink: (p: string) => p, gateKey: (a: string, b: string) => `${a}:${b}` }))
vi.mock('@/lib/alerts', () => alerts)
vi.mock('@/lib/db/service', () => ({ DbError: class extends Error {} }))

// A tiny lume_replies query recorder.
const queries: { filters: [string, string, unknown][] }[] = []
let rows: Record<string, unknown>[] = []
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: () => {
      const q = { filters: [] as [string, string, unknown][] }
      queries.push(q)
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'order', 'limit']) b[m] = () => b
      for (const m of ['in', 'eq', 'ilike']) b[m] = (c: string, v: unknown) => (q.filters.push([m, c, v]), b)
      b.maybeSingle = () => Promise.resolve({ data: { handled_how: null }, error: null })
      b.then = (r: (v: unknown) => unknown) => r({ data: rows, error: null })
      return b
    },
  }),
}))

import { answerMention, cleanQuestion, ENRICH_INTENT, ENRICH_REPLY, searchTerm } from '@/lib/slack/mention'

const CAMPAIGN = 'c-1'
const binding = { id: 'b1', team_id: 'T0AAA', channel_id: 'C0AAA', vertical_id: 'v1', campaign_ids: [], visible_fields: ['name', 'company', 'stage'], active: true }
const ev = { team: 'T0AAA', channel: 'C0AAA', user: 'U0CLIENT', text: '<@U0BOT> status?', ts: '5.5', thread_ts: null as string | null }
const post = { id: 7, reply_to_uuid: 'r-1', team_id: 'T0AAA', channel_id: 'C0AAA', ts: '1.2', action_id: 'a-1', card: { name: 'Ada', title: 'CTO', company: 'Acme', stage: 'Replied', campaign_id: CAMPAIGN, opt_out: false } }

beforeEach(() => {
  vi.resetAllMocks()
  queries.length = 0
  rows = []
  store.getBotToken.mockResolvedValue({ token: 'xoxb', bot_user_id: 'U0BOT' })
  store.getBinding.mockResolvedValue(binding)
  store.getInstall.mockResolvedValue({ team_id: 'T0AAA', revoked_at: null })
  store.getPostByTs.mockResolvedValue(null)
  ops.listVerticals.mockResolvedValue([{ id: 'v1', campaign_ids: [CAMPAIGN], archived_at: null }])
  actions.getAction.mockResolvedValue({ id: 'a-1', kind: 'send_reply', status: 'awaiting', payload: { body: 'x' } })
  api.slackApi.mockResolvedValue({ ok: true })
})

describe('question parsing', () => {
  it('strips the mention and keeps only safe search words', () => {
    expect(cleanQuestion('<@U0BOT>  what about   Acme?')).toBe('what about Acme?')
    expect(searchTerm("what's the status of Acme, Inc.?")).toBe('Acme Inc.')
    expect(searchTerm('status?')).toBeNull()
    expect(searchTerm('x%_,()*')).toBeNull()
  })
  it('recognises enrichment asks', () => {
    for (const q of ['can you enrich this lead', 'find their email', 'what is her phone number', 'run it through Apollo']) expect(ENRICH_INTENT.test(q)).toBe(true)
    for (const q of ['what is the status', 'did they reply']) expect(ENRICH_INTENT.test(q)).toBe(false)
  })
})

describe('answerMention', () => {
  it('in a lead thread: that lead (visible fields only) and its status, in the thread', async () => {
    store.getPostByTs.mockResolvedValue(post)
    const text = await answerMention({ ...ev, thread_ts: '1.2' })
    expect(text).toContain('Ada')
    expect(text).toContain('Replied')
    expect(text).toContain('awaits approval')
    expect(text).not.toContain('CTO')
    expect(api.slackApi).toHaveBeenCalledWith('chat.postMessage', 'xoxb', expect.objectContaining({ channel: 'C0AAA', thread_ts: '1.2' }))
  })
  it('a thread whose lead is outside the channel campaigns is not answered from it', async () => {
    store.getPostByTs.mockResolvedValue({ ...post, card: { ...post.card, campaign_id: 'not-mine' } })
    const text = await answerMention({ ...ev, thread_ts: '1.2' })
    expect(text).not.toContain('Ada')
  })
  it('a search is scoped to the bound campaigns', async () => {
    rows = [{ reply_to_uuid: 'r-1', lead_name: 'Ada', company: 'Acme', received_at: '2026-10-28T10:00:00Z', handled_how: null }]
    const text = await answerMention({ ...ev, text: '<@U0BOT> what about Acme' })
    expect(text).toContain('Ada (Acme)')
    for (const q of queries.filter((q) => q.filters.some(([m]) => m === 'ilike'))) expect(q.filters).toContainEqual(['in', 'campaign_id', [CAMPAIGN]])
  })
  it('enrichment is never run: the client is told, the owner gets an owner-only feed item', async () => {
    const text = await answerMention({ ...ev, text: '<@U0BOT> can you find their phone number?' })
    expect(text).toBe(ENRICH_REPLY)
    expect(alerts.alert).toHaveBeenCalledWith(expect.objectContaining({ owner_only: true, source: 'lume.slack' }))
    expect(alerts.alert.mock.calls[0][0]).not.toHaveProperty('telegram')
  })
  it('an unbound channel gets a polite refusal and no data', async () => {
    store.getBinding.mockResolvedValue(null)
    const text = await answerMention(ev)
    expect(text).toContain("isn't connected")
    expect(queries).toHaveLength(0)
  })
  it('a revoked workspace gets nothing at all', async () => {
    store.getBotToken.mockResolvedValue(null)
    expect(await answerMention(ev)).toBeNull()
    expect(api.slackApi).not.toHaveBeenCalled()
  })
})
