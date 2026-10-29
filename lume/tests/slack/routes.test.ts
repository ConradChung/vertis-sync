import { createHmac, randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const jobs: (() => Promise<unknown>)[] = []
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: () => Promise<unknown>) => jobs.push(fn) }))
const decide = vi.hoisted(() => ({ clientButton: vi.fn(), clientOpenEdit: vi.fn(), clientSaveEdit: vi.fn() }))
vi.mock('@/lib/slack/decide', () => decide)
const mention = vi.hoisted(() => ({ answerMention: vi.fn() }))
vi.mock('@/lib/slack/mention', () => mention)
const store = vi.hoisted(() => ({ revokeInstall: vi.fn(), saveInstall: vi.fn() }))
vi.mock('@/lib/slack/store', () => store)
const api = vi.hoisted(() => ({ oauthAccess: vi.fn() }))
vi.mock('@/lib/slack/api', () => api)
const alerts = vi.hoisted(() => ({ alert: vi.fn(), alertLink: (p: string) => p }))
vi.mock('@/lib/alerts', () => alerts)

import { POST as events } from '@/app/api/slack/events/route'
import { POST as interactions } from '@/app/api/slack/interactions/route'
import { GET as install } from '@/app/api/slack/install/route'
import { GET as callback } from '@/app/api/slack/oauth/callback/route'
import { signInstallLink, signState } from '@/lib/slack/installLink'
import { parseEvent, parseInteraction } from '@/lib/slack/payloads'

const SECRET = 'sign-secret'
const KEY = randomBytes(32).toString('base64')
const UUID = '0b4c1f2e-7d3a-4b9e-8f6a-2c1d3e4f5a6b'

function signed(url: string, body: string, opts: { secret?: string; ts?: number; headers?: Record<string, string> } = {}) {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000)
  const sig = `v0=${createHmac('sha256', opts.secret ?? SECRET).update(`v0:${ts}:${body}`).digest('hex')}`
  return new Request(url, { method: 'POST', body, headers: { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig, ...(opts.headers ?? {}) } })
}
const form = (payload: unknown) => `payload=${encodeURIComponent(JSON.stringify(payload))}`
const button = (action_id: string, value = UUID) => ({
  type: 'block_actions', team: { id: 'T0AAA' }, user: { id: 'U0CLIENT' }, trigger_id: 'trig', container: { channel_id: 'C0AAA', message_ts: '1.2' },
  actions: [{ action_id, value }],
})
const runJobs = async () => {
  for (const j of jobs.splice(0)) await j()
}

beforeEach(() => {
  vi.resetAllMocks()
  jobs.length = 0
  vi.stubEnv('SLACK_CLIENT_ID', 'cid')
  vi.stubEnv('SLACK_CLIENT_SECRET', 'csecret')
  vi.stubEnv('SLACK_SIGNING_SECRET', SECRET)
  vi.stubEnv('LUME_SLACK_TOKEN_KEY', KEY)
  vi.stubEnv('LUME_URL', 'https://lume.example')
})
afterEach(() => vi.unstubAllEnvs())

describe('/api/slack/events', () => {
  it('answers url_verification with the challenge', async () => {
    const res = await events(signed('https://x/api/slack/events', JSON.stringify({ type: 'url_verification', challenge: 'abc' })))
    expect(await res.json()).toEqual({ challenge: 'abc' })
  })
  it('refuses a bad signature, a stale timestamp, and everything while not configured', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc' })
    expect((await events(signed('https://x/api/slack/events', body, { secret: 'wrong' }))).status).toBe(401)
    expect((await events(signed('https://x/api/slack/events', body, { ts: Math.floor(Date.now() / 1000) - 600 }))).status).toBe(401)
    vi.stubEnv('SLACK_SIGNING_SECRET', '')
    expect((await events(signed('https://x/api/slack/events', body))).status).toBe(503)
  })
  it('a mention is acknowledged at once and answered after the response', async () => {
    const body = JSON.stringify({ type: 'event_callback', team_id: 'T0AAA', event: { type: 'app_mention', channel: 'C0AAA', user: 'U0CLIENT', text: '<@U0BOT> hi', ts: '5.5' } })
    const res = await events(signed('https://x/api/slack/events', body))
    expect(res.status).toBe(200)
    expect(mention.answerMention).not.toHaveBeenCalled()
    await runJobs()
    expect(mention.answerMention).toHaveBeenCalledWith(expect.objectContaining({ team: 'T0AAA', channel: 'C0AAA', thread_ts: null }))
  })
  it('a Slack retry is dropped (never answered twice)', async () => {
    const body = JSON.stringify({ type: 'event_callback', team_id: 'T0AAA', event: { type: 'app_mention', channel: 'C0AAA', user: 'U0CLIENT', text: 'hi', ts: '5.5' } })
    await events(signed('https://x/api/slack/events', body, { headers: { 'x-slack-retry-num': '1' } }))
    expect(jobs).toHaveLength(0)
  })
  it('app_uninstalled revokes the workspace', async () => {
    store.revokeInstall.mockResolvedValue(true)
    await events(signed('https://x/api/slack/events', JSON.stringify({ type: 'event_callback', team_id: 'T0AAA', event: { type: 'app_uninstalled' } })))
    await runJobs()
    expect(store.revokeInstall).toHaveBeenCalledWith('T0AAA')
    expect(alerts.alert).toHaveBeenCalledWith(expect.objectContaining({ owner_only: true }))
  })
})

describe('/api/slack/interactions', () => {
  it('Approve and Skip run the client decision after the response', async () => {
    const res = await interactions(signed('https://x/api/slack/interactions', form(button('lume_approve'))))
    expect(res.status).toBe(200)
    await runJobs()
    expect(decide.clientButton).toHaveBeenCalledWith({ team: 'T0AAA', user: 'U0CLIENT', channel: 'C0AAA' }, '1.2', UUID, 'approve')
    await interactions(signed('https://x/api/slack/interactions', form(button('lume_skip'))))
    await runJobs()
    expect(decide.clientButton).toHaveBeenLastCalledWith(expect.anything(), '1.2', UUID, 'skip')
  })
  it('Edit opens the modal with the trigger id', async () => {
    await interactions(signed('https://x/api/slack/interactions', form(button('lume_edit'))))
    await runJobs()
    expect(decide.clientOpenEdit).toHaveBeenCalledWith(expect.anything(), '1.2', UUID, 'trig')
  })
  it('an unsigned click does nothing', async () => {
    const res = await interactions(signed('https://x/api/slack/interactions', form(button('lume_approve')), { secret: 'nope' }))
    expect(res.status).toBe(401)
    expect(jobs).toHaveLength(0)
  })
  it('an empty edit is answered with a field error; a real one is saved after the response', async () => {
    const view = (body: string) => ({ type: 'view_submission', team: { id: 'T0AAA' }, user: { id: 'U0CLIENT' }, view: { callback_id: 'lume_edit_submit', private_metadata: '7', state: { values: { lume_body: { body: { value: body } } } } } })
    const bad = await interactions(signed('https://x/api/slack/interactions', form(view('   '))))
    expect(await bad.json()).toMatchObject({ response_action: 'errors', errors: { lume_body: expect.any(String) } })
    expect(jobs).toHaveLength(0)
    await interactions(signed('https://x/api/slack/interactions', form(view('Tuesday at 10?'))))
    await runJobs()
    expect(decide.clientSaveEdit).toHaveBeenCalledWith({ team: 'T0AAA', user: 'U0CLIENT' }, 7, 'Tuesday at 10?')
  })
})

describe('payload parsing', () => {
  it('drops malformed ids, unknown actions and bot mentions', () => {
    expect(parseInteraction(form(button('lume_approve', 'not-a-uuid')))).toBeNull()
    expect(parseInteraction(form(button('other_action')))).toBeNull()
    expect(parseInteraction(form({ ...button('lume_approve'), team: { id: 'bad team' } }))).toBeNull()
    expect(parseEvent(JSON.stringify({ type: 'event_callback', team_id: 'T0AAA', event: { type: 'app_mention', bot_id: 'B1', channel: 'C0AAA', user: 'U0X', text: 'x', ts: '1.1' } }))).toBeNull()
    expect(parseEvent(JSON.stringify({ type: 'event_callback', team_id: 'T0AAA', event: { type: 'tokens_revoked', tokens: { oauth: ['U1'] } } }))).toBeNull()
    expect(parseEvent('not json')).toBeNull()
  })
})

describe('/api/slack/install and the OAuth callback', () => {
  it('a valid install link redirects to Slack with minimal scopes and sets the state cookie', async () => {
    const t = signInstallLink(KEY, { expiresAt: Date.now() + 60_000, nonce: 'n1' })
    const res = await install(new Request(`https://lume.example/api/slack/install?t=${encodeURIComponent(t)}`))
    expect(res.status).toBe(302)
    const to = new URL(res.headers.get('location')!)
    expect(to.origin + to.pathname).toBe('https://slack.com/oauth/v2/authorize')
    expect(to.searchParams.get('scope')).toBe('chat:write,app_mentions:read,channels:read,groups:read')
    expect(to.searchParams.get('redirect_uri')).toBe('https://lume.example/api/slack/oauth/callback')
    const cookie = res.headers.get('set-cookie')!
    expect(cookie).toContain(`lume_slack_state=${to.searchParams.get('state')}`)
    expect(cookie.toLowerCase()).toContain('httponly')
  })
  it('an expired or forged link is refused', async () => {
    const old = signInstallLink(KEY, { expiresAt: Date.now() - 1, nonce: 'n1' })
    expect((await install(new Request(`https://lume.example/api/slack/install?t=${encodeURIComponent(old)}`))).status).toBe(403)
    const forged = signInstallLink(randomBytes(32).toString('base64'), { expiresAt: Date.now() + 60_000, nonce: 'n1' })
    expect((await install(new Request(`https://lume.example/api/slack/install?t=${encodeURIComponent(forged)}`))).status).toBe(403)
  })
  it('reports "not configured" cleanly while env vars are missing', async () => {
    vi.stubEnv('SLACK_CLIENT_SECRET', '')
    const res = await install(new Request('https://lume.example/api/slack/install?t=x'))
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('not set up yet')
  })
  it('the callback needs the same state as the cookie; then stores the install and tells the owner', async () => {
    const state = signState(KEY, { expiresAt: Date.now() + 60_000, nonce: 's1', link: 'n1' })
    const noCookie = await callback(new Request(`https://lume.example/api/slack/oauth/callback?code=c&state=${encodeURIComponent(state)}`))
    expect(noCookie.status).toBe(400)
    expect(api.oauthAccess).not.toHaveBeenCalled()

    api.oauthAccess.mockResolvedValue({ team_id: 'T0AAA', team_name: 'Acme', bot_user_id: 'U0BOT', access_token: 'xoxb-1', scope: 'chat:write', installed_by: 'U0ADMIN' })
    store.saveInstall.mockResolvedValue({ reinstalled: false, paused: 0 })
    const ok = await callback(new Request(`https://lume.example/api/slack/oauth/callback?code=c&state=${encodeURIComponent(state)}`, { headers: { cookie: `lume_slack_state=${state}` } }))
    expect(ok.status).toBe(200)
    expect(api.oauthAccess).toHaveBeenCalledWith('c', 'https://lume.example/api/slack/oauth/callback', 'cid', 'csecret')
    expect(store.saveInstall).toHaveBeenCalledWith(expect.objectContaining({ team_id: 'T0AAA', access_token: 'xoxb-1' }))
    expect(alerts.alert).toHaveBeenCalledWith(expect.objectContaining({ owner_only: true }))
    expect(await ok.text()).not.toContain('xoxb')
  })
  it('a reinstall tells the owner the bindings were paused and need re-enabling', async () => {
    const state = signState(KEY, { expiresAt: Date.now() + 60_000, nonce: 's2', link: 'n1' })
    api.oauthAccess.mockResolvedValue({ team_id: 'T0AAA', team_name: 'Acme', bot_user_id: 'U0BOT', access_token: 'xoxb-2', scope: 'chat:write', installed_by: 'U0ADMIN' })
    store.saveInstall.mockResolvedValue({ reinstalled: true, paused: 2 })
    await callback(new Request(`https://lume.example/api/slack/oauth/callback?code=c&state=${encodeURIComponent(state)}`, { headers: { cookie: `lume_slack_state=${state}` } }))
    const a = alerts.alert.mock.calls[0][0]
    expect(a.title).toContain('reinstalled')
    expect(a.body).toMatch(/bindings were paused \(2\).*re-enable them in Settings → Slack/)
  })
  it('a Slack "access_denied" is a cancelled page, nothing stored', async () => {
    const res = await callback(new Request('https://lume.example/api/slack/oauth/callback?error=access_denied'))
    expect(await res.text()).toContain('Install cancelled')
    expect(store.saveInstall).not.toHaveBeenCalled()
  })
})
