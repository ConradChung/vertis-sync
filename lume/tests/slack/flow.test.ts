import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  claimPost: vi.fn(), updatePost: vi.fn(), releasePost: vi.fn(), getBotToken: vi.fn(), getBinding: vi.fn(), getInstall: vi.fn(),
  listBindings: vi.fn(), listInstalls: vi.fn(), listPostsForReply: vi.fn(), getPost: vi.fn(), getPostByTs: vi.fn(),
}))
vi.mock('@/lib/slack/store', () => store)
const api = vi.hoisted(() => ({ slackApi: vi.fn() }))
vi.mock('@/lib/slack/api', () => api)
const actions = vi.hoisted(() => ({ getAction: vi.fn(), claimClientDecision: vi.fn(), saveClientEdit: vi.fn() }))
vi.mock('@/lib/actions/store', () => actions)
vi.mock('@/lib/actions/create', () => ({ BLOCKING_REPLY_STATUSES: ['awaiting', 'approved', 'executing', 'executed'] }))
const grant = vi.hoisted(() => ({ scheduleExecution: vi.fn() }))
vi.mock('@/lib/actions/grant', () => grant)
const campaigns = vi.hoisted(() => ({ findAwaitingActionBy: vi.fn() }))
vi.mock('@/lib/campaigns/service', () => campaigns)
const inbox = vi.hoisted(() => ({ getReply: vi.fn() }))
vi.mock('@/lib/inbox/store', () => inbox)
const modes = vi.hoisted(() => ({ getReplyMode: vi.fn() }))
vi.mock('@/lib/inbox/replyModeStore', () => modes)
const ops = vi.hoisted(() => ({ listVerticals: vi.fn() }))
vi.mock('@/lib/operators/store', () => ops)
const facts = vi.hoisted(() => ({ gatherFacts: vi.fn() }))
vi.mock('@/lib/slack/facts', () => facts)
const alerts = vi.hoisted(() => ({ alert: vi.fn(), alertLink: (p: string) => p, gateKey: (a: string, b: string) => `${a}:${b}` }))
vi.mock('@/lib/alerts', () => alerts)
vi.mock('@/lib/db/service', () => ({ logEvent: vi.fn(), DbError: class extends Error {} }))
const push = vi.hoisted(() => ({ pushForItem: vi.fn() }))
vi.mock('@/lib/webhooks/deliver', () => push)

import { postReplyToChannels, syncAction } from '@/lib/slack/post'
import { clientButton, clientOpenEdit, clientSaveEdit } from '@/lib/slack/decide'
import { clientApprovalBlocker } from '@/lib/slack/clientCheck'

const CAMPAIGN = '11111111-2222-3333-4444-555555555555'
const binding = { id: 'b1', team_id: 'T0AAA', channel_id: 'C0AAA', channel_name: 'leads', vertical_id: 'v1', campaign_ids: [], visible_fields: ['name', 'company', 'reply'], active: true }
const vertical = { id: 'v1', campaign_ids: [CAMPAIGN], archived_at: null }
const reply = { reply_to_uuid: 'r-1', campaign_id: CAMPAIGN, lead_email: 'ada@acme.com', lead_name: 'Ada', company: 'Acme', excerpt: 'Tuesday works' }
const leadFacts = { name: 'Ada', title: 'CTO', company: 'Acme', website: null, phone: null, linkedin: null, location: null, reply: 'Tuesday works', stage: 'Replied' }
const action = (over: Record<string, unknown> = {}) => ({
  id: 'a-1', kind: 'send_reply', status: 'awaiting', created_at: '2026-10-29T00:00:00Z', decided_via: null,
  payload: { reply_to_uuid: 'r-1', campaign_id: CAMPAIGN, body: 'Great, Tuesday?', eaccount: 'me@x.com', summary: 's', their_message: 'Tuesday works' },
  ...over,
})
const post = { id: 7, reply_to_uuid: 'r-1', team_id: 'T0AAA', channel_id: 'C0AAA', ts: '1.2', action_id: 'a-1', card: { ...leadFacts, opt_out: false, campaign_id: CAMPAIGN } }
const actor = { team: 'T0AAA', user: 'U0CLIENT', channel: 'C0AAA' }

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('SLACK_CLIENT_ID', 'id')
  vi.stubEnv('SLACK_CLIENT_SECRET', 'secret')
  vi.stubEnv('SLACK_SIGNING_SECRET', 'sign')
  vi.stubEnv('LUME_SLACK_TOKEN_KEY', randomBytes(32).toString('base64'))
  store.listBindings.mockResolvedValue([binding])
  store.listInstalls.mockResolvedValue([{ team_id: 'T0AAA', revoked_at: null }])
  store.getInstall.mockResolvedValue({ team_id: 'T0AAA', revoked_at: null })
  store.getBinding.mockResolvedValue(binding)
  store.getBotToken.mockResolvedValue({ token: 'xoxb-test', bot_user_id: 'U0BOT' })
  store.getPostByTs.mockResolvedValue(post)
  store.getPost.mockResolvedValue(post)
  ops.listVerticals.mockResolvedValue([vertical])
  inbox.getReply.mockResolvedValue(reply)
  facts.gatherFacts.mockResolvedValue(leadFacts)
  modes.getReplyMode.mockResolvedValue('client')
  campaigns.findAwaitingActionBy.mockResolvedValue(null)
  api.slackApi.mockResolvedValue({ ok: true, ts: '1.2' })
  actions.getAction.mockResolvedValue(action())
})
afterEach(() => vi.unstubAllEnvs())

const lastCall = (method: string) => api.slackApi.mock.calls.filter((c) => c[0] === method).at(-1)

describe('postReplyToChannels', () => {
  it('posts once to a bound channel, claiming the dedupe row first, with the stored facts', async () => {
    store.claimPost.mockResolvedValue({ ...post, ts: null })
    expect(await postReplyToChannels('r-1')).toBe(1)
    expect(store.claimPost).toHaveBeenCalledWith(expect.objectContaining({ reply_to_uuid: 'r-1', team_id: 'T0AAA', channel_id: 'C0AAA', card: expect.objectContaining({ name: 'Ada', opt_out: false }) }))
    const [, token, body] = lastCall('chat.postMessage')!
    expect(token).toBe('xoxb-test')
    expect(body.channel).toBe('C0AAA')
    expect(JSON.stringify(body.blocks)).not.toContain('CTO') // title hidden for this channel
    expect(store.updatePost).toHaveBeenCalledWith(7, { ts: '1.2' })
  })
  it('a second sighting (claim lost) posts nothing', async () => {
    store.claimPost.mockResolvedValue(null)
    expect(await postReplyToChannels('r-1')).toBe(0)
    expect(api.slackApi).not.toHaveBeenCalled()
  })
  it('no channel covers the campaign, or the install is revoked: nothing', async () => {
    ops.listVerticals.mockResolvedValue([{ ...vertical, campaign_ids: ['other'] }])
    expect(await postReplyToChannels('r-1')).toBe(0)
    ops.listVerticals.mockResolvedValue([vertical])
    store.listInstalls.mockResolvedValue([{ team_id: 'T0AAA', revoked_at: '2026-10-29' }])
    expect(await postReplyToChannels('r-1')).toBe(0)
    expect(store.claimPost).not.toHaveBeenCalled()
  })
  it('a failed chat.postMessage releases the claim so a later sighting can post', async () => {
    store.claimPost.mockResolvedValue({ ...post, ts: null })
    api.slackApi.mockRejectedValue(new Error('channel_not_found'))
    expect(await postReplyToChannels('r-1')).toBe(0)
    expect(store.releasePost).toHaveBeenCalledWith(7)
  })
  it('does nothing while Slack is not configured', async () => {
    vi.stubEnv('SLACK_SIGNING_SECRET', '')
    expect(await postReplyToChannels('r-1')).toBe(0)
    expect(inbox.getReply).not.toHaveBeenCalled()
  })
})

describe('syncAction', () => {
  it('updates every post of the reply with the draft and the buttons (Client mode)', async () => {
    store.listPostsForReply.mockResolvedValue([{ ...post }])
    await syncAction('a-1')
    const [, , body] = lastCall('chat.update')!
    expect(body).toMatchObject({ channel: 'C0AAA', ts: '1.2' })
    const s = JSON.stringify(body.blocks)
    expect(s).toContain('Great, Tuesday?')
    expect(s).toContain('lume_approve')
  })
  it('Owner mode: the draft, no buttons', async () => {
    modes.getReplyMode.mockResolvedValue('owner')
    store.listPostsForReply.mockResolvedValue([{ ...post }])
    await syncAction('a-1')
    const s = JSON.stringify(lastCall('chat.update')![2].blocks)
    expect(s).not.toContain('lume_approve')
    expect(s).toContain('Awaiting Conrad')
  })
  it('an older draft never takes a post over from a newer one', async () => {
    store.listPostsForReply.mockResolvedValue([{ ...post, action_id: 'a-new' }])
    actions.getAction.mockImplementation(async (id: string) => (id === 'a-new' ? action({ id: 'a-new', created_at: '2026-10-30T00:00:00Z' }) : action()))
    await syncAction('a-1')
    expect(store.updatePost).not.toHaveBeenCalled()
    expect(lastCall('chat.update')).toBeUndefined()
  })
  it('a paused channel is not re-rendered', async () => {
    store.getBinding.mockResolvedValue({ ...binding, active: false })
    store.listPostsForReply.mockResolvedValue([{ ...post }])
    await syncAction('a-1')
    expect(lastCall('chat.update')).toBeUndefined()
  })
})

describe('clientButton', () => {
  it('Approve in Client mode claims as the client and schedules the executor', async () => {
    actions.claimClientDecision.mockResolvedValue(action({ status: 'approved', decided_via: 'client' }))
    expect(await clientButton(actor, '1.2', 'a-1', 'approve')).toBe('approved')
    expect(actions.claimClientDecision).toHaveBeenCalledWith('a-1', true, { team: 'T0AAA', user: 'U0CLIENT' })
    expect(grant.scheduleExecution).toHaveBeenCalledWith('a-1')
    expect(alerts.alert).toHaveBeenCalledWith(expect.not.objectContaining({ telegram: expect.anything() }))
  })
  it('Skip claims a rejection and never executes', async () => {
    actions.claimClientDecision.mockResolvedValue(action({ status: 'rejected', decided_via: 'client' }))
    expect(await clientButton(actor, '1.2', 'a-1', 'skip')).toBe('skipped')
    expect(actions.claimClientDecision).toHaveBeenCalledWith('a-1', false, expect.anything())
    expect(grant.scheduleExecution).not.toHaveBeenCalled()
  })
  it('Owner mode: refused (ephemeral), nothing claimed', async () => {
    modes.getReplyMode.mockResolvedValue('owner')
    expect(await clientButton(actor, '1.2', 'a-1', 'approve')).toBe('refused')
    expect(actions.claimClientDecision).not.toHaveBeenCalled()
    expect(lastCall('chat.postEphemeral')![2]).toMatchObject({ channel: 'C0AAA', user: 'U0CLIENT' })
  })
  it('a channel that does not cover the campaign is refused', async () => {
    store.getBinding.mockResolvedValue({ ...binding, campaign_ids: ['someone-else'] })
    expect(await clientButton(actor, '1.2', 'a-1', 'approve')).toBe('refused')
    expect(actions.claimClientDecision).not.toHaveBeenCalled()
  })
  it('a button on a post that points at another action is stale', async () => {
    expect(await clientButton(actor, '1.2', 'a-OTHER', 'approve')).toBe('refused')
    expect(actions.claimClientDecision).not.toHaveBeenCalled()
  })
  it('a post from another workspace is never decided', async () => {
    expect(await clientButton({ ...actor, team: 'T0EVIL' }, '1.2', 'a-1', 'approve')).toBe('refused')
    expect(actions.claimClientDecision).not.toHaveBeenCalled()
  })
  it('a possible opt-out cannot be approved', async () => {
    actions.getAction.mockResolvedValue(action({ payload: { ...action().payload, their_message: 'please unsubscribe me' } }))
    expect(await clientButton(actor, '1.2', 'a-1', 'approve')).toBe('refused')
    expect(actions.claimClientDecision).not.toHaveBeenCalled()
  })
  it('the editor cannot approve their own edit', async () => {
    actions.getAction.mockResolvedValue(action({ edited_by_slack_user: 'U0CLIENT' }))
    expect(await clientButton(actor, '1.2', 'a-1', 'approve')).toBe('refused')
    expect(actions.claimClientDecision).not.toHaveBeenCalled()
  })
  it('losing the race (someone decided first) is refused, no execution', async () => {
    actions.claimClientDecision.mockResolvedValue(null)
    expect(await clientButton(actor, '1.2', 'a-1', 'approve')).toBe('refused')
    expect(grant.scheduleExecution).not.toHaveBeenCalled()
  })
})

describe('clientOpenEdit', () => {
  it('reads the post, the token and the action in parallel, then opens the modal', async () => {
    let release!: (v: unknown) => void
    store.getPostByTs.mockReturnValue(new Promise((r) => (release = r)))
    const opened = clientOpenEdit(actor, '1.2', 'a-1', 'trig')
    await Promise.resolve()
    expect(store.getBotToken).toHaveBeenCalled()
    expect(actions.getAction).toHaveBeenCalledWith('a-1')
    release(post)
    expect(await opened).toBe(true)
    expect(lastCall('views.open')![2]).toMatchObject({ trigger_id: 'trig', view: { callback_id: 'lume_edit_submit', private_metadata: '7' } })
  })
  it('an expired trigger tells the user to try again', async () => {
    api.slackApi.mockImplementation(async (method: string) => {
      if (method === 'views.open') throw Object.assign(new Error('slack views.open: expired_trigger_id'), { code: 'expired_trigger_id' })
      return { ok: true }
    })
    expect(await clientOpenEdit(actor, '1.2', 'a-1', 'trig')).toBe(false)
    expect(lastCall('chat.postEphemeral')![2]).toMatchObject({ user: 'U0CLIENT', text: expect.stringMatching(/try again/i) })
  })
})

describe('clientSaveEdit', () => {
  it('saves the body as the client\'s draft; it stays awaiting and is not executed', async () => {
    actions.saveClientEdit.mockResolvedValue(action({ edited_by_slack_user: 'U0CLIENT', payload: { ...action().payload, body: 'Tuesday 10am works' } }))
    expect(await clientSaveEdit({ team: 'T0AAA', user: 'U0CLIENT' }, 7, 'Tuesday 10am works')).toBe('saved')
    const [id, payload, user] = actions.saveClientEdit.mock.calls[0]
    expect(id).toBe('a-1')
    expect(user).toBe('U0CLIENT')
    expect(payload).toMatchObject({ body: 'Tuesday 10am works', original_body: 'Great, Tuesday?', edited_by: 'slack:T0AAA:U0CLIENT' })
    expect(actions.claimClientDecision).not.toHaveBeenCalled()
    expect(grant.scheduleExecution).not.toHaveBeenCalled()
  })
  it('an unchanged body is not an edit', async () => {
    expect(await clientSaveEdit({ team: 'T0AAA', user: 'U0CLIENT' }, 7, 'Great, Tuesday?')).toBe('unchanged')
    expect(actions.saveClientEdit).not.toHaveBeenCalled()
  })
  it('a modal from another workspace is refused', async () => {
    expect(await clientSaveEdit({ team: 'T0EVIL', user: 'U0CLIENT' }, 7, 'x')).toBe('refused')
    expect(actions.saveClientEdit).not.toHaveBeenCalled()
  })
})

describe('clientApprovalBlocker (executor re-check)', () => {
  const approved = { payload: action().payload, decided_by_slack_team: 'T0AAA', decided_by_slack_user: 'U0CLIENT', edited_by_slack_user: null }
  const answered = { campaign_id: CAMPAIGN, text: 'Tuesday works' }
  it('holds while everything still holds', async () => expect(await clientApprovalBlocker(approved, answered)).toBeNull())
  it('the owner switched the campaign out of Client mode', async () => {
    modes.getReplyMode.mockResolvedValue('owner')
    expect(await clientApprovalBlocker(approved, answered)).toBe('client_mode_revoked')
  })
  it('the workspace was uninstalled or unbound', async () => {
    store.getInstall.mockResolvedValue({ team_id: 'T0AAA', revoked_at: '2026-10-29' })
    expect(await clientApprovalBlocker(approved, answered)).toBe('client_unbound')
    store.getInstall.mockResolvedValue({ team_id: 'T0AAA', revoked_at: null })
    store.listBindings.mockResolvedValue([])
    expect(await clientApprovalBlocker(approved, answered)).toBe('client_unbound')
  })
  it('a fresh opt-out in the email, another campaign, or a self-edit', async () => {
    expect(await clientApprovalBlocker(approved, { ...answered, text: 'Actually, stop emailing me' })).toBe('opt_out_or_hostile')
    expect(await clientApprovalBlocker(approved, { ...answered, campaign_id: 'other' })).toBe('campaign_mismatch')
    expect(await clientApprovalBlocker({ ...approved, edited_by_slack_user: 'U0CLIENT' }, answered)).toBe('client_self_edit')
  })
})
