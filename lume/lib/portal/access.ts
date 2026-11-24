/**
 * Who may use the read-only client portal (/portal), and where they may go.
 *
 * Edge-safe: the middleware imports this file, so it uses `fetch` against
 * PostgREST only (no `node:*`, no `server-only`, no supabase-js), the same
 * pattern as `lib/operators/revocation.ts`. `lume_portal_users` is revoked
 * from anon/authenticated: only the service-role key can read it.
 */

export interface PortalUser {
  email: string
  client: string
  campaign_ids: string[]
  linkedin_set_ids: string[]
  /** Lead lists shared as call sheets (GTM-18: the Google Maps list first). */
  sheet_set_ids: string[]
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * The active portal user for `email` (compared lowercase), or null when there
 * is no row, the row is disabled, or the lookup fails (fail closed: a DB blip
 * leaves a client user with no access, never with more).
 */
export async function getPortalUser(email: string | null | undefined): Promise<PortalUser | null> {
  const e = email?.trim().toLowerCase()
  if (!e || e.length > 254 || !EMAIL_SHAPE.test(e)) return null
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('[portal/access] missing Supabase URL or service key')
    return null
  }
  try {
    const lookup = (select: string) =>
      fetch(`${url.replace(/\/+$/, '')}/rest/v1/lume_portal_users?${new URLSearchParams({ select, email: `eq.${e}`, limit: '1' })}`, {
        headers: { apikey: key, authorization: `Bearer ${key}`, accept: 'application/json' },
        cache: 'no-store',
      })
    let res = await lookup('email,client,campaign_ids,linkedin_set_ids,sheet_set_ids,disabled_at')
    // Before the GTM-18 migration adds sheet_set_ids, PostgREST answers 400 for the unknown column: read without it (no call sheets) rather than lock the client out.
    if (res.status === 400) res = await lookup('email,client,campaign_ids,linkedin_set_ids,disabled_at')
    if (!res.ok) {
      console.error('[portal/access] lookup failed:', res.status)
      return null
    }
    const rows = (await res.json()) as Array<{
      email: string
      client: string
      campaign_ids: string[] | null
      linkedin_set_ids: string[] | null
      sheet_set_ids?: string[] | null
      disabled_at: string | null
    }>
    const row = rows[0]
    if (!row || row.disabled_at || row.email !== e) return null
    return {
      email: row.email,
      client: row.client,
      campaign_ids: (row.campaign_ids ?? []).filter((x) => typeof x === 'string' && x.length > 0),
      linkedin_set_ids: (row.linkedin_set_ids ?? []).filter((x) => typeof x === 'string' && x.length > 0),
      sheet_set_ids: (row.sheet_set_ids ?? []).filter((x) => typeof x === 'string' && x.length > 0),
    }
  } catch (err) {
    console.error('[portal/access] lookup failed:', err instanceof Error ? err.message : err)
    return null
  }
}

export type PortalRouteDecision =
  | { action: 'allow' }
  | { action: 'redirect'; to: '/portal' | '/login' | '/forbidden' }
  | { action: 'error'; status: 401 | 403 }

/** The one portal route owners may use but portal users never may. */
export const PORTAL_OWNER_ONLY_API = '/api/portal/sign-in-link'

function normalise(pathname: string): string {
  const p = pathname.split('?')[0].replace(/\/+$/, '')
  return p === '' ? '/' : p
}

/** `/portal` or anything below it (not `/portalx`). */
export function isPortalPage(pathname: string): boolean {
  const p = normalise(pathname)
  return p === '/portal' || p.startsWith('/portal/')
}

/** `/api/portal/*`, excluding the owner-only sign-in-link route. */
export function isPortalApi(pathname: string): boolean {
  const p = normalise(pathname)
  if (!p.startsWith('/api/portal/')) return false
  return p !== PORTAL_OWNER_ONLY_API && !p.startsWith(`${PORTAL_OWNER_ONLY_API}/`)
}

/**
 * Pure routing rule for a request that already passed the public-path check
 * (public paths and `/login`, `/auth/*` are the caller's business):
 *
 *  - signed out: API 401, page → /login
 *  - owner: everything (incl. /portal for previews)
 *  - portal user: /portal/** and /api/portal/* (not sign-in-link) only;
 *    any other API 403, any other page → /portal
 *  - any other signed-in account: API 403, page → /forbidden (unchanged)
 */
export function portalRouteDecision(input: {
  pathname: string
  isOwner: boolean
  isPortal: boolean
  signedIn: boolean
}): PortalRouteDecision {
  const p = normalise(input.pathname)
  const api = p === '/api' || p.startsWith('/api/')
  if (!input.signedIn) return api ? { action: 'error', status: 401 } : { action: 'redirect', to: '/login' }
  if (input.isOwner) return { action: 'allow' }
  if (input.isPortal) {
    if (api) return isPortalApi(p) ? { action: 'allow' } : { action: 'error', status: 403 }
    return isPortalPage(p) ? { action: 'allow' } : { action: 'redirect', to: '/portal' }
  }
  return api ? { action: 'error', status: 403 } : { action: 'redirect', to: '/forbidden' }
}

/**
 * A post-sign-in `next` a portal user may be sent to: a relative path under
 * /portal, nothing that could leave the origin. Anything else → '/portal'.
 */
export function safePortalNext(next: string | null | undefined): string {
  if (!next || next.length > 512) return '/portal'
  if (!next.startsWith('/') || next.startsWith('//') || /[\\\s]/.test(next) || next.includes('..')) return '/portal'
  const path = next.split(/[?#]/)[0]
  return isPortalPage(path) && (path === '/portal' || path.startsWith('/portal/')) ? next : '/portal'
}
