import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  getSignalConfig: vi.fn(), saveSignalSlack: vi.fn(), listReadyCommenters: vi.fn(), saveDryRunCard: vi.fn(), claimPerson: vi.fn(),
  markPersonPosted: vi.fn(), releasePerson: vi.fn(), listReadyDigests: vi.fn(), getSignalPost: vi.fn(), listReadyReactors: vi.fn(),
  claimDigest: vi.fn(), markDigestPosted: vi.fn(), releaseDigest: vi.fn(), markReactors: vi.fn(), listPendingNotices: vi.fn(),
  claimNotice: vi.fn(), releaseNotice: vi.fn(),
}))
vi.mock('@/lib/signal/store', () => store)
const api = vi.hoisted(() => ({ slackApi: vi.fn(), listChannels: vi.fn() }))
vi.mock('@/lib/slack/api', () => api)
const slackStore = vi.hoisted(() => ({ getBotToken: vi.fn(), listInstalls: vi.fn() }))
vi.mock('@/lib/slack/store', () => slackStore)

import { parseSignalConfig } from '@/lib/signal/config'
import { runSignalAlerts } from '@/lib/signal/alerts'
import { person } from './fixtures'

const TEAM = 'T082MHH6U5P'
const post = { post_id: '7400', post_url: 'https://www.linkedin.com/feed/update/urn:li:activity:7400', posted_at: '2026-11-20T12:00:00Z', text_excerpt: 'Rent day', digest_status: 'ready' }
const live = (over: Record<string, unknown> = {}) => parseSignalConfig({ dry_run: false, slack: { team_id: null, channel_id: null, channel_name: 'sales' }, reactor_opening: null, ...over })
const posts = () => api.slackApi.mock.calls.filter((c) => c[0] === 'chat.postMessage')

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('SLACK_CLIENT_ID', 'id')
  vi.stubEnv('SLACK_CLIENT_SECRET', 'secret')
  vi.stubEnv('SLACK_SIGNING_SECRET', 'sign')
  vi.stubEnv('LUME_SLACK_TOKEN_KEY', randomBytes(32).toString('base64'))
  store.getSignalConfig.mockResolvedValue(parseSignalConfig({ dry_run: true }))
  store.listReadyCommenters.mockResolvedValue([person()])
  store.listReadyDigests.mockResolvedValue([])
  store.listPendingNotices.mockResolvedValue([])
  store.getSignalPost.mockResolvedValue(post)
  store.saveDryRunCard.mockResolvedValue(true)
  store.claimPerson.mockResolvedValue(true)
  store.claimDigest.mockResolvedValue(true)
  store.claimNotice.mockResolvedValue(true)
  store.markPersonPosted.mockResolvedValue(undefined)
  store.releasePerson.mockResolvedValue(undefined)
  store.markReactors.mockResolvedValue(undefined)
  store.markDigestPosted.mockResolvedValue(undefined)
  store.releaseDigest.mockResolvedValue(undefined)
  store.releaseNotice.mockResolvedValue(undefined)
  slackStore.listInstalls.mockResolvedValue([{ team_id: TEAM, revoked_at: null }])
  slackStore.getBotToken.mockResolvedValue({ token: 'xoxb-test', bot_user_id: 'U0BOT' })
  api.listChannels.mockResolvedValue([{ id: 'C0GENERAL', name: 'general', is_private: false, is_member: true }, { id: 'C0SALES', name: 'sales', is_private: false, is_member: true }])
  api.slackApi.mockResolvedValue({ ok: true, ts: '1700.0001' })
})
afterEach(() => vi.unstubAllEnvs())

describe('runSignalAlerts: dry run', () => {
  it('saves the card, makes no Slack call at all', async () => {
    const r = await runSignalAlerts()
    expect(r.commenters.dry_run).toBe(1)
    expect(store.saveDryRunCard).toHaveBeenCalledWith(42, expect.arrayContaining([expect.objectContaining({ type: 'header' })]))
    expect(store.claimPerson).not.toHaveBeenCalled()
    expect(api.slackApi).not.toHaveBeenCalled()
    expect(api.listChannels).not.toHaveBeenCalled()
    expect(slackStore.getBotToken).not.toHaveBeenCalled()
  })

  it('dry-runs digests and notices too, marking reactors dry_run', async () => {
    store.listReadyCommenters.mockResolvedValue([])
    store.listReadyDigests.mockResolvedValue([post])
    store.listReadyReactors.mockResolvedValue([person({ id: 7, kind: 'reactor' })])
    store.listPendingNotices.mockResolvedValue([{ key: 'warn80:x', text: 'cap at 80%' }])
    const r = await runSignalAlerts()
    expect(r.digests.dry_run).toBe(1)
    expect(r.notices.dry_run).toBe(1)
    expect(store.claimDigest).toHaveBeenCalledWith('7400', 'dry_run', expect.any(Array))
    expect(store.markReactors).toHaveBeenCalledWith([7], 'dry_run')
    expect(store.claimNotice).toHaveBeenCalledWith('warn80:x', 'dry_run')
    expect(api.slackApi).not.toHaveBeenCalled()
  })

  it('refuses a vendor row (no card saved) and reports it', async () => {
    store.listReadyCommenters.mockResolvedValue([person({ crawl_verdict: 'vendor' })])
    const r = await runSignalAlerts()
    expect(r.commenters.refused).toBe(1)
    expect(store.saveDryRunCard).not.toHaveBeenCalled()
  })
})

describe('runSignalAlerts: live', () => {
  beforeEach(() => store.getSignalConfig.mockResolvedValue(live()))

  it('finds #sales on the single install, saves it back, claims BEFORE posting, then saves ts and alerted', async () => {
    const order: string[] = []
    store.claimPerson.mockImplementation(async () => (order.push('claim'), true))
    api.slackApi.mockImplementation(async () => (order.push('post'), { ok: true, ts: '1700.0001' }))
    const r = await runSignalAlerts()
    expect(order).toEqual(['claim', 'post'])
    expect(r.commenters.posted).toBe(1)
    expect(r.channel).toEqual({ team_id: TEAM, channel_id: 'C0SALES' })
    expect(store.saveSignalSlack).toHaveBeenCalledWith(expect.anything(), TEAM, 'C0SALES')
    expect(posts()[0][2]).toMatchObject({ channel: 'C0SALES', unfurl_links: false })
    expect(store.markPersonPosted).toHaveBeenCalledWith(42, { team: TEAM, channel: 'C0SALES', ts: '1700.0001' })
  })

  it('uses the saved channel without listing channels', async () => {
    store.getSignalConfig.mockResolvedValue(live({ slack: { team_id: TEAM, channel_id: 'C0SALES', channel_name: 'sales' } }))
    await runSignalAlerts()
    expect(api.listChannels).not.toHaveBeenCalled()
    expect(store.saveSignalSlack).not.toHaveBeenCalled()
    expect(posts()).toHaveLength(1)
  })

  it('a retry / concurrent tick that loses the claim does not post', async () => {
    store.claimPerson.mockResolvedValue(false)
    const r = await runSignalAlerts()
    expect(r.commenters.skipped).toBe(1)
    expect(posts()).toHaveLength(0)
  })

  it('two ticks racing on one row post once', async () => {
    let claimed = false
    store.claimPerson.mockImplementation(async () => (claimed ? false : ((claimed = true), true)))
    await Promise.all([runSignalAlerts(), runSignalAlerts()])
    expect(posts()).toHaveLength(1)
  })

  it('a failed send releases the claim and reports the failure', async () => {
    api.slackApi.mockRejectedValue(new Error('slack chat.postMessage: channel_not_found'))
    const r = await runSignalAlerts()
    expect(r.ok).toBe(false)
    expect(r.commenters.failed).toBe(1)
    expect(store.releasePerson).toHaveBeenCalledWith(42)
    expect(store.markPersonPosted).not.toHaveBeenCalled()
  })

  it('posts nothing when #sales cannot be found', async () => {
    api.listChannels.mockResolvedValue([])
    const r = await runSignalAlerts()
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toMatch(/channel_not_found/)
    expect(store.claimPerson).not.toHaveBeenCalled()
  })

  it('digest: claim, post, ts saved, reactors alerted with the ts; failure releases', async () => {
    store.listReadyCommenters.mockResolvedValue([])
    store.listReadyDigests.mockResolvedValue([post])
    store.listReadyReactors.mockResolvedValue([person({ id: 7, kind: 'reactor' }), person({ id: 8, kind: 'reactor' })])
    const r = await runSignalAlerts()
    expect(r.digests.posted).toBe(1)
    expect(store.claimDigest).toHaveBeenCalledWith('7400', 'posted', expect.any(Array))
    expect(store.markDigestPosted).toHaveBeenCalledWith('7400', '1700.0001')
    expect(store.markReactors).toHaveBeenCalledWith([7, 8], 'posted', { team: TEAM, channel: 'C0SALES', ts: '1700.0001' })

    vi.mocked(store.markReactors).mockClear()
    api.slackApi.mockRejectedValue(new Error('boom'))
    const r2 = await runSignalAlerts()
    expect(r2.digests.failed).toBe(1)
    expect(store.releaseDigest).toHaveBeenCalledWith('7400')
    expect(store.markReactors).not.toHaveBeenCalled()
  })

  it('a digest with no PM reactors is marked empty, not posted', async () => {
    store.listReadyCommenters.mockResolvedValue([])
    store.listReadyDigests.mockResolvedValue([post])
    store.listReadyReactors.mockResolvedValue([])
    const r = await runSignalAlerts()
    expect(r.digests.empty).toBe(1)
    expect(store.claimDigest).toHaveBeenCalledWith('7400', 'empty', null)
    expect(posts()).toHaveLength(0)
  })

  it('notices post as escaped text once; a lost claim posts nothing', async () => {
    store.listReadyCommenters.mockResolvedValue([])
    store.listPendingNotices.mockResolvedValue([{ key: 'stop:daily', text: 'Lane stopped <!channel>' }])
    await runSignalAlerts()
    expect(posts()[0][2]).toMatchObject({ channel: 'C0SALES', text: 'Lane stopped &lt;!channel&gt;' })
    api.slackApi.mockClear()
    store.claimNotice.mockResolvedValue(false)
    await runSignalAlerts()
    expect(posts()).toHaveLength(0)
  })
})
