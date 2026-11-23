import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({ getMention: vi.fn(), decideMention: vi.fn() }))
vi.mock('@/lib/reddit/store', () => store)
const signalStore = vi.hoisted(() => ({ getSignalConfig: vi.fn() }))
vi.mock('@/lib/signal/store', () => signalStore)
const api = vi.hoisted(() => ({ slackApi: vi.fn() }))
vi.mock('@/lib/slack/api', () => api)
const slackStore = vi.hoisted(() => ({ getBotToken: vi.fn() }))
vi.mock('@/lib/slack/store', () => slackStore)

import { parseSignalConfig } from '@/lib/signal/config'
import { redditButton } from '@/lib/slack/redditDecide'

const TEAM = 'T082MHH6U5P'
const actor = { team: TEAM, user: 'U0SALES', channel: 'C0SALES' }
const mention = (over = {}) => ({
  id: 7, url: 'https://www.reddit.com/r/Landlord/comments/1gx3def/x/', kind: 'post', subreddit: 'Landlord', author: 'rental_rita', title: 't', snippet: 's',
  keyword: 'buildium', hot: false, reddit_created_at: null, alert_status: 'posted', decided_by: null, slack_team_id: TEAM, slack_channel_id: 'C0SALES', slack_ts: '1700.0001', ...over,
})
const calls = (m: string) => api.slackApi.mock.calls.filter((c) => c[0] === m)

beforeEach(() => {
  vi.resetAllMocks()
  signalStore.getSignalConfig.mockResolvedValue(parseSignalConfig({ slack: { team_id: TEAM, channel_id: 'C0SALES', channel_name: 'sales' } }))
  store.getMention.mockResolvedValue(mention())
  slackStore.getBotToken.mockResolvedValue({ token: 'xoxb-test', bot_user_id: 'U0BOT' })
  api.slackApi.mockResolvedValue({ ok: true })
})

describe('redditButton', () => {
  it('Mark contacted records it and re-renders the card', async () => {
    store.decideMention.mockResolvedValue(mention({ alert_status: 'contacted', decided_by: 'U0SALES' }))
    expect(await redditButton(actor, '1700.0001', 7, 'contacted')).toBe('done')
    expect(store.decideMention).toHaveBeenCalledWith(7, 'contacted', 'U0SALES')
    expect(calls('chat.update')[0][2]).toMatchObject({ channel: 'C0SALES', ts: '1700.0001' })
    expect(JSON.stringify(calls('chat.update')[0][2].blocks)).toContain('Contacted')
  })

  it('Skip maps to skipped', async () => {
    store.decideMention.mockResolvedValue(mention({ alert_status: 'skipped', decided_by: 'U0SALES' }))
    expect(await redditButton(actor, '1700.0001', 7, 'skip')).toBe('done')
    expect(store.decideMention).toHaveBeenCalledWith(7, 'skipped', 'U0SALES')
  })

  it('a double click just re-renders', async () => {
    store.decideMention.mockResolvedValue(null)
    expect(await redditButton(actor, '1700.0001', 7, 'contacted')).toBe('already')
    expect(calls('chat.update')).toHaveLength(1)
  })

  it('refuses another channel without touching the row', async () => {
    expect(await redditButton({ ...actor, channel: 'C0OTHER' }, '1700.0001', 7, 'contacted')).toBe('refused')
    expect(store.decideMention).not.toHaveBeenCalled()
  })

  it('refuses a stale card (different message ts) and says so', async () => {
    expect(await redditButton(actor, '1700.9999', 7, 'contacted')).toBe('refused')
    expect(store.decideMention).not.toHaveBeenCalled()
    expect(calls('chat.postEphemeral')).toHaveLength(1)
  })
})
