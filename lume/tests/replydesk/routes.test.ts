import { createHmac, randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOT, CHANNEL, extraction, memDeps, TEAM } from './memory'

// Sample events posted at the real Slack routes (signature checked), with the
// engine's ports in memory. No real SendPilot message has been seen yet: the
// sample is a plausible bot post with an attachment.
const jobs: (() => Promise<unknown>)[] = []
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: () => Promise<unknown>) => jobs.push(fn) }))
const live = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/lib/replydesk/live', () => ({ liveDeps: () => live.current }))
vi.mock('@/lib/slack/mention', () => ({ answerMention: vi.fn() }))
vi.mock('@/lib/alerts', () => ({ alert: vi.fn(), alertLink: (p: string) => p }))

import { POST as events } from '@/app/api/slack/events/route'
import { POST as interactions } from '@/app/api/slack/interactions/route'
import { POST as cron } from '@/app/api/cron/reply-desk/route'
import { parseEvent } from '@/lib/slack/payloads'

const SECRET = 'sign-secret'
function signed(url: string, body: string) {
  const ts = Math.floor(Date.now() / 1000)
  const sig = `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')}`
  return new Request(url, { method: 'POST', body, headers: { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig } })
}
const run = async () => {
  for (const j of jobs.splice(0)) await j()
}

const URL_ = 'https://www.linkedin.com/in/dana-whitfield-12ab'
function messageBody(o: { channel?: string; app_id?: string; user?: string; subtype?: string; text?: string } = {}) {
  return JSON.stringify({
    type: 'event_callback',
    team_id: TEAM,
    api_app_id: 'A0LUME',
    event: {
      type: 'message',
      subtype: o.subtype ?? 'bot_message',
      channel: o.channel ?? CHANNEL,
      ts: '1764093600.000100',
      text: o.text ?? 'New reply from Dana Whitfield',
      bot_id: 'B0SENDPLT',
      app_id: o.app_id ?? 'A0SENDPLT',
      ...(o.user ? { user: o.user } : {}),
      attachments: [{ title: 'Dana Whitfield replied', title_link: URL_, text: 'Interesting. What does it cost?', fields: [{ title: 'Campaign', value: 'Owner-operators 500+ Q4' }] }],
    },
  })
}

beforeEach(() => {
  jobs.length = 0
  vi.stubEnv('SLACK_CLIENT_ID', 'cid')
  vi.stubEnv('SLACK_CLIENT_SECRET', 'csecret')
  vi.stubEnv('SLACK_SIGNING_SECRET', SECRET)
  vi.stubEnv('LUME_SLACK_TOKEN_KEY', randomBytes(32).toString('base64'))
  vi.stubEnv('LUME_HOOK_SECRET', 'hook-secret')
})
afterEach(() => vi.unstubAllEnvs())

describe('/api/slack/events → reply desk', () => {
  it('a SendPilot notification in the channel: acked at once, then saved, extracted, a deal, and a thread draft', async () => {
    const m = memDeps()
    live.current = m.deps
    m.ai.extract = [extraction()]
    const res = await events(signed('https://x/api/slack/events', messageBody()))
    expect(res.status).toBe(200)
    expect(m.store.inbound).toHaveLength(0) // nothing before the response
    await run()
    expect(m.store.log.slice(0, 2)).toEqual(['saveInbound', 'claude:extract'])
    expect(m.store.deals[0]).toMatchObject({ stage: 'Conversation', linkedin_url: URL_ })
    expect(m.slack.posts[0]).toMatchObject({ channel: CHANNEL, thread_ts: '1764093600.000100' })
  })

  it('another channel is ignored (no row, no Claude call)', async () => {
    const m = memDeps()
    live.current = m.deps
    await events(signed('https://x/api/slack/events', messageBody({ channel: 'C0GENERAL' })))
    await run()
    expect(m.store.inbound).toHaveLength(0)
    expect(m.ai.calls).toHaveLength(0)
  })

  it("Lume's own posts are dropped (same app id, or the bot's user id), and edits/deletes are not messages", async () => {
    expect(parseEvent(messageBody({ app_id: 'A0LUME' }))).toBeNull()
    expect(parseEvent(messageBody({ subtype: 'message_changed' }))).toBeNull()
    expect(parseEvent(messageBody({ subtype: 'message_deleted' }))).toBeNull()
    const m = memDeps()
    live.current = m.deps
    await events(signed('https://x/api/slack/events', messageBody({ user: BOT, app_id: 'A0OTHERINSTALL' })))
    await run()
    expect(m.store.inbound).toHaveLength(0)
  })
})

describe('/api/slack/interactions → reply desk buttons', () => {
  it('Sent from Slack records the send and starts the schedule', async () => {
    const m = memDeps('2026-11-25T18:00:00.000Z')
    live.current = m.deps
    m.ai.extract = [extraction()]
    await events(signed('https://x/api/slack/events', messageBody()))
    await run()
    const payload = { type: 'block_actions', team: { id: TEAM }, user: { id: 'U0FRANK' }, container: { channel_id: CHANNEL, message_ts: '1764100000.001' }, actions: [{ action_id: 'rdesk_sent', value: '1' }] }
    const res = await interactions(signed('https://x/api/slack/interactions', `payload=${encodeURIComponent(JSON.stringify(payload))}`))
    expect(res.status).toBe(200)
    await run()
    expect(m.store.drafts[0]).toMatchObject({ status: 'sent', decided_by: 'U0FRANK' })
    expect(m.store.threads.get('deal-1')).toMatchObject({ schedule: 'followup', next_due_at: '2026-11-27T18:00:00.000Z' })
    expect(m.slack.updates[0].msg.blocks.some((b) => (b as { type: string }).type === 'actions')).toBe(false)
  })
})

describe('/api/cron/reply-desk', () => {
  it('needs the hook secret', async () => {
    const m = memDeps()
    live.current = m.deps
    expect((await cron(new Request('https://x/api/cron/reply-desk', { method: 'POST' }))).status).toBe(401)
    const ok = await cron(new Request('https://x/api/cron/reply-desk', { method: 'POST', headers: { 'X-Lume-Hook-Secret': 'hook-secret' } }))
    expect(ok.status).toBe(200)
  })
})
