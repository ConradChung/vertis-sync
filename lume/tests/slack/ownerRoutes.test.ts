import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const guards = vi.hoisted(() => ({ requireOwnerSession: vi.fn() }))
vi.mock('@/lib/auth/guards', () => guards)
const store = vi.hoisted(() => ({ getInstall: vi.fn(), upsertBinding: vi.fn(), listInstalls: vi.fn(), listBindings: vi.fn() }))
vi.mock('@/lib/slack/store', () => store)
const ops = vi.hoisted(() => ({ getVertical: vi.fn() }))
vi.mock('@/lib/operators/store', () => ops)
vi.mock('@/lib/alerts', () => ({ alert: vi.fn(), alertLink: (p: string) => p }))

import { POST as installLink } from '@/app/api/slack/install-link/route'
import { PUT as bind } from '@/app/api/slack/channels/route'
import { GET as installs } from '@/app/api/slack/installs/route'
import { verifyInstallLink } from '@/lib/slack/installLink'

const KEY = randomBytes(32).toString('base64')
const VID = '0b4c1f2e-7d3a-4b9e-8f6a-2c1d3e4f5a6b'
const req = (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } })

beforeEach(() => {
  vi.resetAllMocks()
  guards.requireOwnerSession.mockResolvedValue({ ok: true, via: 'session', user: { email: 'o@x.com' } })
  vi.stubEnv('SLACK_CLIENT_ID', 'cid')
  vi.stubEnv('SLACK_CLIENT_SECRET', 'cs')
  vi.stubEnv('SLACK_SIGNING_SECRET', 'ss')
  vi.stubEnv('LUME_SLACK_TOKEN_KEY', KEY)
  vi.stubEnv('LUME_URL', 'https://lume.example')
  store.getInstall.mockResolvedValue({ team_id: 'T0AAA', team_name: 'Acme', revoked_at: null })
  ops.getVertical.mockResolvedValue({ id: VID, name: 'Roofers', campaign_ids: ['c1', 'c2'], archived_at: null })
  store.upsertBinding.mockImplementation(async (b) => ({ id: 'b1', ...b }))
})
afterEach(() => vi.unstubAllEnvs())

describe('POST /api/slack/install-link', () => {
  it('gives the owner a signed, expiring link', async () => {
    const res = await installLink(req('https://lume.example/api/slack/install-link', 'POST', { days: 3 }))
    const { url, expires_at } = await res.json()
    const t = new URL(url).searchParams.get('t')
    expect(url.startsWith('https://lume.example/api/slack/install?t=')).toBe(true)
    expect(verifyInstallLink(t, KEY)).toMatchObject({ ok: true })
    expect(Date.parse(expires_at) - Date.now()).toBeGreaterThan(2.9 * 86_400_000)
  })
  it('refuses a Grok Bot cookie, the agent bearer, and a missing config', async () => {
    expect((await installLink(req('https://lume.example/api/slack/install-link', 'POST', {}, { cookie: 'lume_op=abc' }))).status).toBe(403)
    guards.requireOwnerSession.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'session_required' }, { status: 403 }) })
    expect((await installLink(req('https://lume.example/api/slack/install-link', 'POST', {}))).status).toBe(403)
    guards.requireOwnerSession.mockResolvedValue({ ok: true, via: 'session', user: {} })
    vi.stubEnv('LUME_SLACK_TOKEN_KEY', 'too-short')
    const res = await installLink(req('https://lume.example/api/slack/install-link', 'POST', {}))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'slack_not_configured', missing: ['LUME_SLACK_TOKEN_KEY'] })
  })
})

describe('GET /api/slack/installs', () => {
  it('reports not configured (with the missing names) but still lists', async () => {
    vi.stubEnv('SLACK_CLIENT_ID', '')
    store.listInstalls.mockResolvedValue([])
    store.listBindings.mockResolvedValue([])
    const res = await installs(req('https://lume.example/api/slack/installs', 'GET'))
    expect(await res.json()).toEqual({ configured: false, missing: ['SLACK_CLIENT_ID'], installs: [], bindings: [] })
  })
})

describe('PUT /api/slack/channels', () => {
  const body = { team_id: 'T0AAA', channel_id: 'C0AAA', channel_name: 'leads', vertical_id: VID, campaign_ids: ['c1'], visible_fields: ['name', 'reply'] }
  it('binds a channel to a vertical subset', async () => {
    const res = await bind(req('https://lume.example/api/slack/channels', 'PUT', body))
    expect(res.status).toBe(200)
    expect(store.upsertBinding).toHaveBeenCalledWith(expect.objectContaining({ team_id: 'T0AAA', channel_id: 'C0AAA', vertical_id: VID, campaign_ids: ['c1'], visible_fields: ['name', 'reply'], active: true }))
  })
  it("refuses a campaign outside the vertical, an unknown field, a revoked workspace", async () => {
    expect((await bind(req('https://lume.example/api/slack/channels', 'PUT', { ...body, campaign_ids: ['c9'] }))).status).toBe(400)
    expect((await bind(req('https://lume.example/api/slack/channels', 'PUT', { ...body, visible_fields: ['email'] }))).status).toBe(400)
    store.getInstall.mockResolvedValue({ team_id: 'T0AAA', revoked_at: '2026-10-29' })
    expect((await bind(req('https://lume.example/api/slack/channels', 'PUT', body))).status).toBe(404)
    expect(store.upsertBinding).not.toHaveBeenCalled()
  })
})
