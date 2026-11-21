import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let sessionEmail: string | null = 'frank@getzenport.com'
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getClaims: async () => ({ data: sessionEmail ? { claims: { sub: 'u1', email: sessionEmail } } : null }) },
  }),
}))

const portalUsers: Record<string, { email: string; client: string; campaign_ids: string[]; linkedin_set_ids: string[] }> = {
  'frank@getzenport.com': { email: 'frank@getzenport.com', client: 'Kaspen', campaign_ids: ['camp-k'], linkedin_set_ids: ['set-k'] },
}
vi.mock('@/lib/portal/access', async (orig) => ({
  ...(await orig<typeof import('@/lib/portal/access')>()),
  getPortalUser: vi.fn(async (e: string) => portalUsers[e?.trim().toLowerCase()] ?? null),
}))

const svc = vi.hoisted(() => ({
  createUser: vi.fn(),
  generateLink: vi.fn(),
  calls: [] as Array<{ table: string; ops: Array<[string, unknown[]]> }>,
}))
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    auth: { admin: { createUser: svc.createUser, generateLink: svc.generateLink } },
    from(table: string) {
      const rec = { table, ops: [] as Array<[string, unknown[]]> }
      svc.calls.push(rec)
      const b: Record<string, unknown> = {}
      for (const op of ['select', 'in', 'or', 'not', 'eq', 'order', 'range']) {
        b[op] = (...args: unknown[]) => {
          rec.ops.push([op, args])
          return b
        }
      }
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], count: 0, error: null })
      return b
    },
  }),
}))

const anthropicCreate = vi.hoisted(() => vi.fn())
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreate }
  },
}))

import { requirePortalUser } from '@/lib/auth/guards'
import { GET as meGET } from '@/app/api/portal/me/route'
import { GET as leadsGET } from '@/app/api/portal/leads/route'
import { POST as agentPOST } from '@/app/api/portal/agent/route'
import { POST as linkPOST } from '@/app/api/portal/sign-in-link/route'
import { clearPortalRegionCache } from '@/lib/portal/leads'

const get = (path: string) => new Request(`http://localhost${path}`)
const post = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  sessionEmail = 'frank@getzenport.com'
  process.env.LUME_ALLOWED_EMAIL = 'owner@example.com'
  delete process.env.LUME_URL
  svc.calls.length = 0
  svc.createUser.mockReset()
  svc.generateLink.mockReset()
  anthropicCreate.mockReset()
  clearPortalRegionCache()
})
afterEach(() => vi.restoreAllMocks())

describe('requirePortalUser', () => {
  it('portal user → own row; other account → 403; signed out → 401', async () => {
    const a = await requirePortalUser(get('/api/portal/me'))
    expect(a.ok && a.user.client).toBe('Kaspen')
    expect(a.ok && a.viewer).toBe('portal')
    sessionEmail = 'stranger@x.com'
    const b = await requirePortalUser(get('/api/portal/me'))
    expect(!b.ok && b.response.status).toBe(403)
    sessionEmail = null
    const c = await requirePortalUser(get('/api/portal/me'))
    expect(!c.ok && c.response.status).toBe(401)
  })

  it('a portal user cannot use ?as= to read someone else', async () => {
    const a = await requirePortalUser(get('/api/portal/me?as=other@client.com'))
    expect(a.ok && a.user.email).toBe('frank@getzenport.com')
  })

  it('owner previews with ?as=, 400 without, 404 for an unknown portal email', async () => {
    sessionEmail = 'owner@example.com'
    const a = await requirePortalUser(get('/api/portal/me?as=Frank@GetZenport.com'))
    expect(a.ok && a.viewer).toBe('owner')
    expect(a.ok && a.user.email).toBe('frank@getzenport.com')
    const b = await requirePortalUser(get('/api/portal/me'))
    expect(!b.ok && b.response.status).toBe(400)
    const c = await requirePortalUser(get('/api/portal/me?as=nobody@x.com'))
    expect(!c.ok && c.response.status).toBe(404)
  })
})

describe('GET /api/portal/me', () => {
  it('returns only email + client', async () => {
    expect(await (await meGET(get('/api/portal/me'))).json()).toEqual({ email: 'frank@getzenport.com', client: 'Kaspen' })
  })
})

describe('GET /api/portal/leads', () => {
  it('scopes by the portal user campaign ids, never the request', async () => {
    const res = await leadsGET(get('/api/portal/leads?tab=email&campaign_id=camp-evil&campaign_ids=camp-evil'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ rows: [], total: 0, page: 1, pageSize: 50, regions: [] })
    expect(svc.calls.length).toBeGreaterThan(0)
    for (const c of svc.calls) {
      expect(c.ops).toContainEqual(['in', ['campaign_id', ['camp-k']]])
      expect(JSON.stringify(c.ops)).not.toContain('camp-evil')
    }
  })
  it('linkedin tab scopes by set ids', async () => {
    await leadsGET(get('/api/portal/leads?tab=linkedin'))
    expect(svc.calls[0].table).toBe('lume_portal_linkedin_leads')
    expect(svc.calls[0].ops).toContainEqual(['in', ['set_id', ['set-k']]])
  })
  it('400 on bad params; 403 for non-portal accounts (no DB)', async () => {
    expect((await leadsGET(get('/api/portal/leads?tab=sms'))).status).toBe(400)
    sessionEmail = 'stranger@x.com'
    expect((await leadsGET(get('/api/portal/leads'))).status).toBe(403)
    expect(svc.calls).toHaveLength(0)
  })
})

describe('POST /api/portal/agent', () => {
  it('rejects bodies over 20KB and bad shapes before calling the model', async () => {
    expect((await agentPOST(post('/api/portal/agent', { messages: [{ role: 'user', content: 'x'.repeat(21_000) }] }))).status).toBe(413)
    expect((await agentPOST(post('/api/portal/agent', 'not json'))).status).toBe(400)
    expect((await agentPOST(post('/api/portal/agent', { messages: [{ role: 'system', content: 'x' }] }))).status).toBe(400)
    expect((await agentPOST(post('/api/portal/agent', { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }))).status).toBe(400)
    expect(anthropicCreate).not.toHaveBeenCalled()
  })
  it('runs the scoped search for the portal user', async () => {
    anthropicCreate
      .mockResolvedValueOnce({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'search_leads', input: { q: 'acme' } }] })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'No matches.' }] })
    const res = await agentPOST(post('/api/portal/agent', { messages: [{ role: 'user', content: 'acme?' }] }))
    expect(await res.json()).toEqual({ reply: 'No matches.', leads: [] })
    expect(svc.calls[0].ops).toContainEqual(['in', ['campaign_id', ['camp-k']]])
  })
})

describe('POST /api/portal/sign-in-link', () => {
  it('is owner only', async () => {
    expect((await linkPOST(post('/api/portal/sign-in-link', { email: 'frank@getzenport.com' }))).status).toBe(403)
    sessionEmail = null
    expect((await linkPOST(post('/api/portal/sign-in-link', { email: 'frank@getzenport.com' }))).status).toBe(401)
    expect(svc.generateLink).not.toHaveBeenCalled()
  })
  it('404 for a non-portal email', async () => {
    sessionEmail = 'owner@example.com'
    expect((await linkPOST(post('/api/portal/sign-in-link', { email: 'x@y.co' }))).status).toBe(404)
  })
  it('creates the auth user if missing and returns a callback link with the token hash', async () => {
    sessionEmail = 'owner@example.com'
    svc.createUser.mockResolvedValue({ data: null, error: { code: 'email_exists', status: 422 } })
    svc.generateLink.mockResolvedValue({ data: { properties: { hashed_token: 'hash123', action_link: 'https://supabase/verify' } }, error: null })
    const res = await linkPOST(post('/api/portal/sign-in-link', { email: 'Frank@GetZenport.com' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.expires_in_minutes).toBe(60)
    const url = new URL(body.url)
    expect(url.origin + url.pathname).toBe('http://localhost/auth/callback')
    expect(Object.fromEntries(url.searchParams)).toEqual({ token_hash: 'hash123', type: 'magiclink', next: '/portal' })
    expect(svc.createUser).toHaveBeenCalledWith({ email: 'frank@getzenport.com', email_confirm: true })
    expect(svc.generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: 'frank@getzenport.com' })
  })
  it('502 when createUser fails for another reason', async () => {
    sessionEmail = 'owner@example.com'
    vi.spyOn(console, 'error').mockImplementation(() => {})
    svc.createUser.mockResolvedValue({ data: null, error: { code: 'unexpected_failure', status: 500 } })
    expect((await linkPOST(post('/api/portal/sign-in-link', { email: 'frank@getzenport.com' }))).status).toBe(502)
    expect(svc.generateLink).not.toHaveBeenCalled()
  })
})
