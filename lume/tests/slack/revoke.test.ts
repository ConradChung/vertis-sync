import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memdb } from '../stubs/memdb'

// lib/slack/store.ts runs for real against an in-memory database.
const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import('../stubs/memdb').memdb> | null }))
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => db.current!.client }))
const api = vi.hoisted(() => ({ slackApi: vi.fn() }))
vi.mock('@/lib/slack/api', () => api)
const actions = vi.hoisted(() => ({ getAction: vi.fn(), claimClientDecision: vi.fn(), saveClientEdit: vi.fn() }))
vi.mock('@/lib/actions/store', () => actions)
vi.mock('@/lib/actions/create', () => ({ BLOCKING_REPLY_STATUSES: ['awaiting', 'approved', 'executing', 'executed'] }))
vi.mock('@/lib/actions/grant', () => ({ scheduleExecution: vi.fn() }))
vi.mock('@/lib/campaigns/service', () => ({ findAwaitingActionBy: vi.fn().mockResolvedValue(null) }))
const inbox = vi.hoisted(() => ({ getReply: vi.fn() }))
vi.mock('@/lib/inbox/store', () => inbox)
vi.mock('@/lib/inbox/replyModeStore', () => ({ getReplyMode: vi.fn().mockResolvedValue('client') }))
const ops = vi.hoisted(() => ({ listVerticals: vi.fn() }))
vi.mock('@/lib/operators/store', () => ops)
vi.mock('@/lib/slack/facts', () => ({ gatherFacts: vi.fn().mockResolvedValue({ name: 'Ada', title: null, company: 'Acme', website: null, phone: null, linkedin: null, location: null, reply: 'Yes', stage: null }) }))
vi.mock('@/lib/alerts', () => ({ alert: vi.fn(), alertLink: (p: string) => p, gateKey: (a: string, b: string) => `${a}:${b}` }))
vi.mock('@/lib/db/service', () => ({ logEvent: vi.fn(), DbError: class extends Error {} }))
vi.mock('@/lib/webhooks/deliver', () => ({ pushForItem: vi.fn() }))

import { listBindings, revokeInstall, saveInstall, upsertBinding } from '@/lib/slack/store'
import { postReplyToChannels } from '@/lib/slack/post'
import { clientButton } from '@/lib/slack/decide'

const CAMPAIGN = '11111111-2222-3333-4444-555555555555'
const VID = '0b4c1f2e-7d3a-4b9e-8f6a-2c1d3e4f5a6b'
const install = { team_id: 'T0AAA', team_name: 'Acme', bot_user_id: 'U0BOT', access_token: 'xoxb-1', scope: 'chat:write', installed_by: 'U0ADMIN' }
const ACTION = '0b4c1f2e-7d3a-4b9e-8f6a-2c1d3e4f5a60'

beforeEach(() => {
  vi.clearAllMocks()
  db.current = memdb({ lume_slack_installs: ['team_id'], lume_slack_channels: ['team_id', 'channel_id'], lume_slack_posts: ['reply_to_uuid', 'team_id', 'channel_id'] })
  vi.stubEnv('SLACK_CLIENT_ID', 'id')
  vi.stubEnv('SLACK_CLIENT_SECRET', 'secret')
  vi.stubEnv('SLACK_SIGNING_SECRET', 'sign')
  vi.stubEnv('LUME_SLACK_TOKEN_KEY', randomBytes(32).toString('base64'))
  ops.listVerticals.mockResolvedValue([{ id: VID, campaign_ids: [CAMPAIGN], archived_at: null }])
  inbox.getReply.mockImplementation(async (id: string) => ({ reply_to_uuid: id, campaign_id: CAMPAIGN, lead_email: 'ada@acme.com', lead_name: 'Ada', company: 'Acme', excerpt: 'Yes' }))
  api.slackApi.mockImplementation(async (method: string) => ({ ok: true, ts: method === 'chat.postMessage' ? `${Date.now()}.000${api.slackApi.mock.calls.length}` : undefined }))
  actions.getAction.mockResolvedValue({ id: ACTION, kind: 'send_reply', status: 'awaiting', created_at: '2026-10-29T00:00:00Z', payload: { reply_to_uuid: 'r-1', campaign_id: CAMPAIGN, body: 'hi' } })
})
afterEach(() => vi.unstubAllEnvs())

const bind = () => upsertBinding({ team_id: 'T0AAA', channel_id: 'C0AAA', channel_name: 'leads', vertical_id: VID, campaign_ids: [], visible_fields: ['name'], active: true })

describe('a revoked workspace stays revoked', () => {
  it('revoke pauses every binding of the workspace', async () => {
    await saveInstall(install)
    await bind()
    expect(await revokeInstall('T0AAA')).toBe(true)
    expect((await listBindings({ teamId: 'T0AAA' })).every((b) => !b.active)).toBe(true)
  })

  it('a reinstall onto an existing row pauses its bindings and says so', async () => {
    expect(await saveInstall(install)).toEqual({ reinstalled: false, paused: 0 })
    await bind()
    expect(await saveInstall(install)).toEqual({ reinstalled: true, paused: 1 })
    expect((await listBindings({ teamId: 'T0AAA' }))[0].active).toBe(false)
  })

  it('revoke → reinstall from an old link → a positive reply posts nothing and a client approve is refused', async () => {
    await saveInstall(install)
    await bind()
    expect(await postReplyToChannels('r-1')).toBe(1)
    const post = db.current!.table('lume_slack_posts')[0]
    db.current!.table('lume_slack_posts')[0].action_id = ACTION

    await revokeInstall('T0AAA')
    await saveInstall({ ...install, access_token: 'xoxb-2' })

    expect(await postReplyToChannels('r-2')).toBe(0)
    expect(await clientButton({ team: 'T0AAA', user: 'U0CLIENT', channel: 'C0AAA' }, post.ts as string, ACTION, 'approve')).toBe('refused')
    expect(actions.claimClientDecision).not.toHaveBeenCalled()
  })
})
