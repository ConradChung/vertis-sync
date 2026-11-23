import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const guards = vi.hoisted(() => ({ requireOwner: vi.fn(), requireOwnerSession: vi.fn() }))
vi.mock('@/lib/auth/guards', () => guards)
const db = vi.hoisted(() => ({ value: null as unknown, upserts: [] as unknown[] }))
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: db.value == null ? null : { value: db.value }, error: null }) }) }),
      upsert: async (row: unknown) => {
        db.upserts.push(row)
        return { error: null }
      },
    }),
  }),
}))
const slack = vi.hoisted(() => ({ listInstalls: vi.fn(), getBotToken: vi.fn(), listChannels: vi.fn(), slackApi: vi.fn() }))
vi.mock('@/lib/slack/store', () => ({ listInstalls: slack.listInstalls, getBotToken: slack.getBotToken }))
vi.mock('@/lib/slack/api', () => ({ listChannels: slack.listChannels, slackApi: slack.slackApi }))
vi.mock('@/lib/slack/config', () => ({ isSlackConfigured: () => true }))

import { GET, POST } from '@/app/api/settings/health/route'

const SECRETS = {
  APIFY_API_TOKEN: 'apify_api_FAKE-0123456789',
  TELEGRAM_BOT_TOKEN: '555:FAKE-telegram-token',
  SUPABASE_SERVICE_ROLE_KEY: 'svc-FAKE-role-key-value',
  LUME_ACTION_SECRET: 'FAKE-action-secret-value',
}
const fetchMock = vi.fn()

beforeEach(() => {
  vi.resetAllMocks()
  db.value = { slack_test_channel: 'ops-test', keep: 1 }
  db.upserts = []
  for (const [k, v] of Object.entries(SECRETS)) vi.stubEnv(k, v)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example.co')
  vi.stubEnv('TELEGRAM_CHAT_ID', '42')
  vi.stubEnv('CRAWL_WORKER_URL', 'https://worker.example.com')
  vi.stubEnv('LUME_AGENT_MODEL', '')
  guards.requireOwner.mockResolvedValue({ ok: true })
  guards.requireOwnerSession.mockResolvedValue({ ok: true })
  slack.listInstalls.mockResolvedValue([{ team_id: 'T1', revoked_at: null }])
  slack.getBotToken.mockResolvedValue({ token: 'xoxb-FAKE' })
  slack.listChannels.mockResolvedValue([{ id: 'CSALES', name: 'sales', is_member: true }, { id: 'COPS', name: 'ops-test', is_member: true }])
  slack.slackApi.mockResolvedValue({ ok: true, ts: '1' })
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith('/functions/v1/config-health')) return new Response(JSON.stringify({ names: { TELEGRAM_BOT_TOKEN: true } }), { status: 200 })
    if (url.startsWith('https://api.apify.com/')) return new Response('{}', { status: 200 })
    if (url.startsWith('https://api.telegram.org/')) return new Response(JSON.stringify({ ok: true, result: { message_id: 3 } }), { status: 200 })
    if (url === 'https://worker.example.com/health') return new Response('{"ok":true}', { status: 200 })
    throw new Error(`unexpected ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const req = (method: string) => new Request('http://localhost/api/settings/health', { method })

describe('/api/settings/health', () => {
  it('GET: presence for Vercel + edge and the last run; booleans only, no value anywhere', async () => {
    const res = await GET(req('GET'))
    expect(res.status).toBe(200)
    const text = await res.text()
    const body = JSON.parse(text)
    expect(body.vercel.find((r: { name: string }) => r.name === 'APIFY_API_TOKEN')).toEqual({ name: 'APIFY_API_TOKEN', required: true, present: true })
    expect(body.vercel.find((r: { name: string }) => r.name === 'LUME_AGENT_MODEL').present).toBe(false)
    expect(body.edge.ok).toBe(true)
    expect(body.slack_test_channel).toBe('ops-test')
    for (const v of Object.values(SECRETS)) expect(text).not.toContain(v)
    // GET never runs a live check.
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(['https://db.example.co/functions/v1/config-health'])
    expect(slack.slackApi).not.toHaveBeenCalled()
  })

  it('POST: runs the four checks, posts to the configured test channel (never #sales), stores a merged value', async () => {
    const res = await POST(req('POST'))
    expect(res.status).toBe(200)
    const text = await res.text()
    const run = JSON.parse(text)
    expect(Object.values(run.results).every((r) => (r as { ok: boolean }).ok)).toBe(true)
    expect(slack.slackApi).toHaveBeenCalledTimes(1)
    expect(slack.slackApi.mock.calls[0][2]).toMatchObject({ channel: 'COPS' })
    expect(db.upserts).toHaveLength(1)
    expect(db.upserts[0]).toMatchObject({ key: 'config_health', value: { slack_test_channel: 'ops-test', keep: 1, last_checked_at: run.checked_at } })
    for (const v of Object.values(SECRETS)) {
      expect(text).not.toContain(v)
      expect(JSON.stringify(db.upserts)).not.toContain(v)
    }
  })

  it('POST with slack_test_channel = sales refuses and posts nothing', async () => {
    db.value = { slack_test_channel: '#sales' }
    const run = await (await POST(req('POST'))).json()
    expect(run.results.slack.ok).toBe(false)
    expect(run.results.slack.detail).toMatch(/refusing to post to #sales/)
    expect(slack.slackApi).not.toHaveBeenCalled()
  })

  it('POST needs the owner session; GET the owner', async () => {
    const denied = new Response('{}', { status: 401 })
    guards.requireOwnerSession.mockResolvedValue({ ok: false, response: denied })
    expect((await POST(req('POST'))).status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
    guards.requireOwner.mockResolvedValue({ ok: false, response: new Response('{}', { status: 403 }) })
    expect((await GET(req('GET'))).status).toBe(403)
  })
})
