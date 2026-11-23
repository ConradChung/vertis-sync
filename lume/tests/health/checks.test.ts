import { describe, expect, it, vi } from 'vitest'
import { APIFY_ME_URL, checkApify, checkSlack, checkTelegram, checkWorker, runChecks, type SlackCheckDeps } from '@/lib/health/checks'
import { fetchEdgePresence } from '@/lib/health/edge'
import { mergeConfigHealth, parseConfigHealth, presence, scrubDetail, secretValues } from '@/lib/health/model'
import { EDGE_ENV_NAMES, LUME_ENV_NAMES } from '@/lib/health/names'

const FAKE = 'apify_api_FAKE-secret-value-0001'
const envOf = (o: Record<string, string>) => (k: string) => o[k]
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const AT = new Date('2026-11-23T18:00:00Z')

describe('presence', () => {
  it('booleans only, empty / whitespace = missing, never a value', () => {
    const env = envOf({ APIFY_API_TOKEN: FAKE, TELEGRAM_CHAT_ID: '  ', LUME_URL: 'https://lume.example.com' })
    const rows = presence(LUME_ENV_NAMES, env)
    expect(rows.find((r) => r.name === 'APIFY_API_TOKEN')).toEqual({ name: 'APIFY_API_TOKEN', required: true, present: true })
    expect(rows.find((r) => r.name === 'TELEGRAM_CHAT_ID')?.present).toBe(false)
    expect(rows.find((r) => r.name === 'LUME_AGENT_MODEL')).toEqual({ name: 'LUME_AGENT_MODEL', required: false, present: false })
    const out = JSON.stringify(rows)
    expect(out).not.toContain(FAKE)
    expect(out).not.toContain('lume.example.com')
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['name', 'present', 'required'])
  })
})

describe('checkApify', () => {
  it('200 → token valid; sends the token as a Bearer header, not in the URL', async () => {
    const f = vi.fn().mockResolvedValue(json({ data: { username: 'x' } }))
    expect(await checkApify(f, envOf({ APIFY_API_TOKEN: FAKE }))).toEqual({ ok: true, detail: 'token valid' })
    expect(f.mock.calls[0][0]).toBe(APIFY_ME_URL)
    expect(f.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${FAKE}`)
  })
  it('401 → token rejected; other status → Apify <status>; unset → missing (no call)', async () => {
    expect(await checkApify(vi.fn().mockResolvedValue(json({}, 401)), envOf({ APIFY_API_TOKEN: FAKE }))).toEqual({ ok: false, detail: 'Apify 401: token rejected' })
    expect(await checkApify(vi.fn().mockResolvedValue(json({}, 503)), envOf({ APIFY_API_TOKEN: FAKE }))).toEqual({ ok: false, detail: 'Apify 503' })
    const f = vi.fn()
    expect(await checkApify(f, envOf({}))).toEqual({ ok: false, detail: 'APIFY_API_TOKEN missing' })
    expect(f).not.toHaveBeenCalled()
  })
})

describe('checkTelegram', () => {
  it('sent → ok; the text is "Lume config check ✓ <time>"', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, messageId: 1 })
    expect(await checkTelegram(send, AT)).toEqual({ ok: true, detail: 'sent to TELEGRAM_CHAT_ID' })
    expect(send.mock.calls[0][0]).toMatch(/^Lume config check ✓ Nov 23, 2026/)
  })
  it('skipped / failed carry the adapter reason', async () => {
    expect(await checkTelegram(vi.fn().mockResolvedValue({ ok: false, skipped: true, reason: 'missing chat id' }), AT)).toEqual({ ok: false, detail: 'skipped: missing chat id' })
    expect(await checkTelegram(vi.fn().mockResolvedValue({ ok: false, error: 'Telegram 401: Unauthorized' }), AT)).toEqual({ ok: false, detail: 'failed: Telegram 401: Unauthorized' })
  })
})

describe('checkWorker', () => {
  it('GETs <CRAWL_WORKER_URL>/health; 200 → reachable', async () => {
    const f = vi.fn().mockResolvedValue(json({ ok: true }))
    expect(await checkWorker(f, envOf({ CRAWL_WORKER_URL: 'https://worker.example.com/' }))).toEqual({ ok: true, detail: 'reachable (HTTP 200)' })
    expect(f.mock.calls[0][0]).toBe('https://worker.example.com/health')
    expect(f.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })
  it('non-2xx → not ok; unset → missing (no call)', async () => {
    expect(await checkWorker(vi.fn().mockResolvedValue(json({}, 502)), envOf({ CRAWL_WORKER_URL: 'https://w.example.com' }))).toEqual({ ok: false, detail: 'worker answered HTTP 502' })
    const f = vi.fn()
    expect(await checkWorker(f, envOf({}))).toEqual({ ok: false, detail: 'CRAWL_WORKER_URL missing' })
    expect(f).not.toHaveBeenCalled()
  })
})

const slackDeps = (o: Partial<SlackCheckDeps> = {}): SlackCheckDeps => ({
  configured: true,
  channelName: null,
  teamId: null,
  listInstalls: vi.fn().mockResolvedValue([{ team_id: 'T1', revoked_at: null }]),
  getBotToken: vi.fn().mockResolvedValue({ token: 'xoxb-fake-bot-token' }),
  listChannels: vi.fn().mockResolvedValue([
    { id: 'CSALES', name: 'sales', is_member: true },
    { id: 'CHEALTH', name: 'lume-health', is_member: true },
  ]),
  post: vi.fn().mockResolvedValue(undefined),
  ...o,
})

describe('checkSlack', () => {
  it('posts to #lume-health by default', async () => {
    const d = slackDeps()
    expect(await checkSlack(d, AT)).toEqual({ ok: true, detail: 'posted to #lume-health' })
    expect(d.post).toHaveBeenCalledWith('xoxb-fake-bot-token', 'CHEALTH', expect.stringMatching(/^Lume config check ✓/))
  })

  it('uses config_health.slack_test_channel when set', async () => {
    const d = slackDeps({ channelName: '#ops-test', listChannels: vi.fn().mockResolvedValue([{ id: 'COPS', name: 'ops-test', is_member: true }]) })
    expect(await checkSlack(d, AT)).toEqual({ ok: true, detail: 'posted to #ops-test' })
    expect(d.post).toHaveBeenCalledWith('xoxb-fake-bot-token', 'COPS', expect.any(String))
  })

  it.each(['sales', '#sales', ' #Sales '])('refuses %j before any Slack call', async (name) => {
    const d = slackDeps({ channelName: name })
    const r = await checkSlack(d, AT)
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/refusing to post to #sales/)
    expect(d.listInstalls).not.toHaveBeenCalled()
    expect(d.listChannels).not.toHaveBeenCalled()
    expect(d.post).not.toHaveBeenCalled()
  })

  it('channel missing or bot not a member → the create-and-invite hint, posts nowhere', async () => {
    const missing = slackDeps({ listChannels: vi.fn().mockResolvedValue([{ id: 'CSALES', name: 'sales', is_member: true }]) })
    expect(await checkSlack(missing, AT)).toEqual({ ok: false, detail: 'test channel not found (create #lume-health and invite the bot)' })
    expect(missing.post).not.toHaveBeenCalled()
    const notMember = slackDeps({ listChannels: vi.fn().mockResolvedValue([{ id: 'CH', name: 'lume-health', is_member: false }]) })
    expect((await checkSlack(notMember, AT)).detail).toBe('test channel not found (create #lume-health and invite the bot)')
    expect(notMember.post).not.toHaveBeenCalled()
  })

  it('not configured / several installs / Slack error codes', async () => {
    expect(await checkSlack(slackDeps({ configured: false }), AT)).toEqual({ ok: false, detail: 'Slack app not configured' })
    const two = slackDeps({ listInstalls: vi.fn().mockResolvedValue([{ team_id: 'T1', revoked_at: null }, { team_id: 'T2', revoked_at: null }]) })
    expect((await checkSlack(two, AT)).detail).toMatch(/several Slack installs/)
    const err = Object.assign(new Error('slack chat.postMessage: not_in_channel'), { code: 'not_in_channel' })
    expect(await checkSlack(slackDeps({ post: vi.fn().mockRejectedValue(err) }), AT)).toEqual({ ok: false, detail: 'Slack error: not_in_channel' })
  })
})

describe('runChecks', () => {
  it('returns {ok, detail, ms} per check and never a secret value in the JSON', async () => {
    let t = 1000
    const env = envOf({ APIFY_API_TOKEN: FAKE, CRAWL_WORKER_URL: 'https://worker.example.com', TELEGRAM_BOT_TOKEN: '1:tg-FAKE-token-xyz' })
    // Every fake echoes secrets back, as a hostile / chatty upstream might.
    const fetch = vi.fn(async (url: string) => {
      t += 5
      if (url.includes('apify')) return json({ error: `bad ${FAKE}` }, 500)
      throw new Error(`connect ECONNREFUSED ${FAKE}`)
    })
    const run = await runChecks({
      fetch,
      env,
      now: () => t,
      sendTelegram: vi.fn().mockResolvedValue({ ok: false, error: 'Telegram 400: chat 1:tg-FAKE-token-xyz not found' }),
      slack: slackDeps({ post: vi.fn().mockRejectedValue(new Error(`boom ${FAKE}`)) }),
      secrets: secretValues(LUME_ENV_NAMES, env),
    })
    expect(Object.keys(run.results).sort()).toEqual(['apify', 'slack', 'telegram', 'worker'])
    for (const r of Object.values(run.results)) {
      expect(typeof r.ok).toBe('boolean')
      expect(typeof r.detail).toBe('string')
      expect(r.ms).toBeGreaterThanOrEqual(0)
    }
    expect(run.results.worker).toMatchObject({ ok: false, detail: 'error: connect ECONNREFUSED <redacted>' })
    const out = JSON.stringify(run)
    expect(out).not.toContain(FAKE)
    expect(out).not.toContain('tg-FAKE-token-xyz')
  })

  it('a timeout reads "timed out after 10 s"', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    const run = await runChecks({
      fetch: vi.fn().mockRejectedValue(timeout),
      env: envOf({ CRAWL_WORKER_URL: 'https://w.example.com', APIFY_API_TOKEN: FAKE }),
      now: () => 0,
      sendTelegram: vi.fn().mockResolvedValue({ ok: true, messageId: 1 }),
      slack: slackDeps(),
      secrets: [],
    })
    expect(run.results.worker).toEqual({ ok: false, detail: 'timed out after 10 s', ms: 0 })
    expect(run.results.telegram.ok).toBe(true)
    expect(run.results.slack.ok).toBe(true)
  })
})

describe('scrubDetail', () => {
  it('redacts every value, any Telegram API URL, and clips to 300', () => {
    expect(scrubDetail(`x ${FAKE} y https://api.telegram.org/bot123:abc/sendMessage`, [FAKE])).toBe('x <redacted> y <telegram api>')
    expect(scrubDetail('z'.repeat(500), []).length).toBe(300)
  })
})

describe('config_health setting', () => {
  it('merge keeps slack_test_channel and other keys; parse round-trips', () => {
    const run = { checked_at: AT.toISOString(), results: { apify: { ok: true, detail: 'token valid', ms: 3 }, telegram: { ok: false, detail: 'skipped: missing token', ms: 1 }, slack: { ok: true, detail: 'posted', ms: 9 }, worker: { ok: true, detail: 'reachable (HTTP 200)', ms: 40 } } }
    const merged = mergeConfigHealth({ slack_test_channel: 'ops-test', slack_team_id: 'T1', note: 'keep' }, run)
    expect(merged).toMatchObject({ slack_test_channel: 'ops-test', slack_team_id: 'T1', note: 'keep', last_checked_at: run.checked_at })
    expect(parseConfigHealth(merged)).toEqual({ slack_test_channel: 'ops-test', slack_team_id: 'T1', last: run })
    expect(parseConfigHealth(null)).toEqual({ slack_test_channel: null, slack_team_id: null, last: null })
  })
})

describe('fetchEdgePresence', () => {
  const env = envOf({ NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.co/', SUPABASE_SERVICE_ROLE_KEY: 'svc-FAKE-key' })

  it('calls config-health with the service key; keeps listed names, booleans only', async () => {
    const f = vi.fn().mockResolvedValue(json({ names: { TELEGRAM_BOT_TOKEN: true, TELEGRAM_CHAT_ID: 'yes', EXTRA: true } }))
    const r = await fetchEdgePresence(f, env)
    expect(f.mock.calls[0][0]).toBe('https://db.example.co/functions/v1/config-health')
    expect(f.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer svc-FAKE-key', apikey: 'svc-FAKE-key' })
    expect(r.ok).toBe(true)
    expect(r.names.map((n) => n.name)).toEqual(EDGE_ENV_NAMES.map((n) => n.name))
    expect(r.names.find((n) => n.name === 'TELEGRAM_BOT_TOKEN')?.present).toBe(true)
    expect(r.names.find((n) => n.name === 'TELEGRAM_CHAT_ID')?.present).toBe(false)
    expect(JSON.stringify(r)).not.toContain('svc-FAKE-key')
    expect(JSON.stringify(r)).not.toContain('EXTRA')
  })

  it('404 / 401 / unreachable / unconfigured → ok false with a reason', async () => {
    expect(await fetchEdgePresence(vi.fn().mockResolvedValue(json({}, 404)), env)).toMatchObject({ ok: false, error: 'config-health is not deployed (404)' })
    expect(await fetchEdgePresence(vi.fn().mockResolvedValue(json({ error: 'unauthorized' }, 401)), env)).toMatchObject({ ok: false, error: 'config-health refused the service key (401)' })
    expect(await fetchEdgePresence(vi.fn().mockRejectedValue(new Error('x')), env)).toMatchObject({ ok: false, error: 'config-health unreachable' })
    expect(await fetchEdgePresence(vi.fn(), envOf({}))).toMatchObject({ ok: false, error: expect.stringMatching(/missing/) })
  })
})
