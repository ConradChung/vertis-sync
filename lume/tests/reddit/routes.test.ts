import { createHmac, randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const jobs: (() => Promise<unknown>)[] = []
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: () => Promise<unknown>) => jobs.push(fn) }))
const rd = vi.hoisted(() => ({ redditButton: vi.fn() }))
vi.mock('@/lib/slack/redditDecide', () => rd)
const sd = vi.hoisted(() => ({ signalButton: vi.fn(), signalOpenEdit: vi.fn(), signalSaveEdit: vi.fn() }))
vi.mock('@/lib/slack/signalDecide', () => sd)
const ingest = vi.hoisted(() => ({ ingestF5bot: vi.fn() }))
vi.mock('@/lib/reddit/ingest', () => ingest)

import { POST as interactions } from '@/app/api/slack/interactions/route'
import { POST as f5bot } from '@/app/api/webhooks/f5bot/route'
import { parseInteraction } from '@/lib/slack/payloads'

const SECRET = 'sign-secret'
function signed(body: string) {
  const ts = Math.floor(Date.now() / 1000)
  const sig = `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')}`
  return new Request('https://x/api/slack/interactions', { method: 'POST', body, headers: { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig } })
}
const form = (payload: unknown) => `payload=${encodeURIComponent(JSON.stringify(payload))}`
const button = (action_id: string, value?: string) => ({
  type: 'block_actions', team: { id: 'T0AAA' }, user: { id: 'U0USER' }, trigger_id: 'trig', container: { channel_id: 'C0AAA', message_ts: '1.2' },
  actions: [{ action_id, ...(value ? { value } : {}) }],
})
const hook = (body: unknown, secret: string | null = 'f5-secret') =>
  new Request('https://x/api/webhooks/f5bot', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: secret ? { 'X-Lume-F5bot-Secret': secret } : {} })

beforeEach(() => {
  vi.resetAllMocks()
  jobs.length = 0
  vi.stubEnv('SLACK_CLIENT_ID', 'cid')
  vi.stubEnv('SLACK_CLIENT_SECRET', 'csecret')
  vi.stubEnv('SLACK_SIGNING_SECRET', SECRET)
  vi.stubEnv('LUME_SLACK_TOKEN_KEY', randomBytes(32).toString('base64'))
  vi.stubEnv('LUME_F5BOT_SECRET', 'f5-secret')
})
afterEach(() => vi.unstubAllEnvs())

describe('reddit buttons', () => {
  it('parse Mark contacted / Skip; ignore the URL buttons', () => {
    expect(parseInteraction(form(button('reddit_contacted', '7')))).toEqual({ kind: 'reddit_button', decision: 'contacted', team: 'T0AAA', user: 'U0USER', channel: 'C0AAA', message_ts: '1.2', mention_id: 7 })
    expect(parseInteraction(form(button('reddit_skip', '7')))).toMatchObject({ kind: 'reddit_button', decision: 'skip' })
    expect(parseInteraction(form(button('reddit_skip', 'abc')))).toBeNull()
    expect(parseInteraction(form(button('reddit_open')))).toBeNull()
    expect(parseInteraction(form(button('reddit_dm')))).toBeNull()
  })

  it('the interactions route sends them to redditDecide', async () => {
    const res = await interactions(signed(form(button('reddit_contacted', '7'))))
    expect(res.status).toBe(200)
    for (const j of jobs.splice(0)) await j()
    expect(rd.redditButton).toHaveBeenCalledWith({ team: 'T0AAA', user: 'U0USER', channel: 'C0AAA' }, '1.2', 7, 'contacted')
    expect(sd.signalButton).not.toHaveBeenCalled()
  })
})

describe('POST /api/webhooks/f5bot', () => {
  it('401 without or with a wrong secret, before reading anything', async () => {
    expect((await f5bot(hook({ body: 'x' }, null))).status).toBe(401)
    expect((await f5bot(hook({ body: 'x' }, 'nope'))).status).toBe(401)
    vi.stubEnv('LUME_F5BOT_SECRET', '')
    expect((await f5bot(hook({ body: 'x' }, ''))).status).toBe(401)
    expect(ingest.ingestF5bot).not.toHaveBeenCalled()
  })

  it('400 on bad JSON or no body', async () => {
    expect((await f5bot(hook('{nope'))).status).toBe(400)
    expect((await f5bot(hook({ subject: 'x' }))).status).toBe(400)
  })

  it('413 on an oversized email', async () => {
    expect((await f5bot(hook({ body: 'a'.repeat(600 * 1024) }))).status).toBe(413)
  })

  it('passes the email through and mirrors ok in the status', async () => {
    ingest.ingestF5bot.mockResolvedValue({ ok: true, posted: 1 })
    const res = await f5bot(hook({ message_id: 'm1', subject: 'F5Bot found something!', body: 'b', html: '<p>h</p>' }))
    expect(res.status).toBe(200)
    expect(ingest.ingestF5bot).toHaveBeenCalledWith({ message_id: 'm1', subject: 'F5Bot found something!', body: 'b', html: '<p>h</p>' })
    ingest.ingestF5bot.mockResolvedValue({ ok: false, failed: 1 })
    expect((await f5bot(hook({ body: 'b' }))).status).toBe(500)
  })
})
