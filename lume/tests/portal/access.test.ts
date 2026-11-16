import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPortalUser, isPortalApi, portalRouteDecision, safePortalNext } from '@/lib/portal/access'
import { magicLinkAudience } from '@/lib/auth/magicLink'
import { isPublicPath } from '@/lib/auth/publicPaths'

type Who = 'owner' | 'portal' | 'other' | 'signedOut'
const who = (w: Who) => ({ isOwner: w === 'owner', isPortal: w === 'portal', signedIn: w !== 'signedOut' })
const decide = (pathname: string, w: Who) => portalRouteDecision({ pathname, ...who(w) })

const allow = { action: 'allow' }
const toPortal = { action: 'redirect', to: '/portal' }
const toLogin = { action: 'redirect', to: '/login' }
const toForbidden = { action: 'redirect', to: '/forbidden' }
const e401 = { action: 'error', status: 401 }
const e403 = { action: 'error', status: 403 }

describe('portalRouteDecision', () => {
  const table: Array<[string, Record<Who, object>]> = [
    ['/portal', { owner: allow, portal: allow, other: toForbidden, signedOut: toLogin }],
    ['/portal/', { owner: allow, portal: allow, other: toForbidden, signedOut: toLogin }],
    ['/portal/leads', { owner: allow, portal: allow, other: toForbidden, signedOut: toLogin }],
    ['/portalx', { owner: allow, portal: toPortal, other: toForbidden, signedOut: toLogin }],
    ['/overview', { owner: allow, portal: toPortal, other: toForbidden, signedOut: toLogin }],
    ['/', { owner: allow, portal: toPortal, other: toForbidden, signedOut: toLogin }],
    ['/settings', { owner: allow, portal: toPortal, other: toForbidden, signedOut: toLogin }],
    ['/api/portal/me', { owner: allow, portal: allow, other: e403, signedOut: e401 }],
    ['/api/portal/leads', { owner: allow, portal: allow, other: e403, signedOut: e401 }],
    ['/api/portal/agent', { owner: allow, portal: allow, other: e403, signedOut: e401 }],
    ['/api/portal/sign-in-link', { owner: allow, portal: e403, other: e403, signedOut: e401 }],
    ['/api/portal/sign-in-link/', { owner: allow, portal: e403, other: e403, signedOut: e401 }],
    ['/api/portal', { owner: allow, portal: e403, other: e403, signedOut: e401 }],
    ['/api/portalx/me', { owner: allow, portal: e403, other: e403, signedOut: e401 }],
    ['/api/leads', { owner: allow, portal: e403, other: e403, signedOut: e401 }],
    ['/api/agent/run', { owner: allow, portal: e403, other: e403, signedOut: e401 }],
    ['/api/gates/decide', { owner: allow, portal: e403, other: e403, signedOut: e401 }],
  ]
  for (const [path, expected] of table) {
    for (const w of Object.keys(expected) as Who[]) {
      it(`${w} ${path}`, () => expect(decide(path, w)).toEqual(expected[w]))
    }
  }

  it('public and auth paths stay public (the middleware lets them through before this rule)', () => {
    for (const p of ['/login', '/forbidden', '/auth/callback', '/api/auth/magic-link']) expect(isPublicPath(p)).toBe(true)
    for (const p of ['/portal', '/api/portal/me', '/api/portal/sign-in-link']) expect(isPublicPath(p)).toBe(false)
  })

  it('isPortalApi excludes the owner-only route', () => {
    expect(isPortalApi('/api/portal/leads?tab=email')).toBe(true)
    expect(isPortalApi('/api/portal/sign-in-link')).toBe(false)
    expect(isPortalApi('/api/portal/sign-in-link/x')).toBe(false)
  })
})

describe('safePortalNext', () => {
  it('keeps relative paths under /portal only', () => {
    expect(safePortalNext('/portal')).toBe('/portal')
    expect(safePortalNext('/portal/leads?tab=linkedin')).toBe('/portal/leads?tab=linkedin')
    for (const bad of [null, '', '/overview', '//evil.com/portal', 'https://evil.com/portal', '/portalx', '/portal/../overview', '/\\evil.com', '/portal\\x', 'portal']) {
      expect(safePortalNext(bad)).toBe('/portal')
    }
  })
})

describe('getPortalUser', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://db.example.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc'
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const row = { email: 'frank@getzenport.com', client: 'Kaspen', campaign_ids: ['c1'], linkedin_set_ids: ['s1'], disabled_at: null }
  const ok = (rows: unknown) => new Response(JSON.stringify(rows), { status: 200 })

  it('looks the email up lowercase with the service key and returns the scope', async () => {
    fetchMock.mockResolvedValueOnce(ok([row]))
    expect(await getPortalUser('  Frank@GetZenport.com ')).toEqual({ email: row.email, client: 'Kaspen', campaign_ids: ['c1'], linkedin_set_ids: ['s1'] })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/rest/v1/lume_portal_users?')
    expect(new URL(String(url)).searchParams.get('email')).toBe('eq.frank@getzenport.com')
    expect(init.headers.authorization).toBe('Bearer svc')
  })

  it('null when missing, disabled, failing, or not an email', async () => {
    fetchMock.mockResolvedValueOnce(ok([]))
    expect(await getPortalUser('a@b.co')).toBeNull()
    fetchMock.mockResolvedValueOnce(ok([{ ...row, disabled_at: '2026-11-01T00:00:00Z' }]))
    expect(await getPortalUser(row.email)).toBeNull()
    fetchMock.mockResolvedValueOnce(new Response('x', { status: 500 }))
    expect(await getPortalUser(row.email)).toBeNull()
    fetchMock.mockRejectedValueOnce(new Error('down'))
    expect(await getPortalUser(row.email)).toBeNull()
    expect(await getPortalUser('nope')).toBeNull()
    expect(await getPortalUser(undefined)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})

describe('magicLinkAudience', () => {
  const lookup = vi.fn(async (e: string) => e === 'frank@getzenport.com')
  it('owner first, then active portal users, else nobody', async () => {
    expect(await magicLinkAudience('Owner@x.com', 'owner@x.com', lookup)).toBe('owner')
    expect(lookup).not.toHaveBeenCalled()
    expect(await magicLinkAudience('Frank@GetZenport.com', 'owner@x.com', lookup)).toBe('portal')
    expect(lookup).toHaveBeenLastCalledWith('frank@getzenport.com')
    expect(await magicLinkAudience('else@x.com', 'owner@x.com', lookup)).toBeNull()
    expect(await magicLinkAudience('junk', 'owner@x.com', lookup)).toBeNull()
    expect(await magicLinkAudience(undefined, 'owner@x.com', lookup)).toBeNull()
  })
})
