import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'
import { isOwner } from '@/lib/auth/isOwner'
import { isPublicPath } from '@/lib/auth/publicPaths'
import { bearerMatches, hasBearerToken } from '@/lib/auth/bearer'
import { isOperatorRevoked, verifyOperatorCookieWeb } from '@/lib/operators/revocation'

const OPERATOR_COOKIE = 'lume_op'

/**
 * Single-user gate. `lib/auth/publicPaths.ts` is the single source of what
 * passes without a session; `config.matcher` below only trims framework
 * assets so the function never runs for them.
 *
 *  - public paths (login, forbidden, auth callback, magic-link, shared-secret
 *    API entrypoints, static files) pass through; the API ones verify their
 *    own `X-Lume-*` secret in the handler.
 *  - API routes: no session → 401 JSON, wrong account → 403 JSON.
 *  - pages: no session → redirect /login; wrong account → redirect /forbidden
 *    (a redirect, not a rewrite: Next drops a custom status on rewrites, so
 *    the URL changes and the 403 intent is carried by the page itself).
 *  - a Grok Bot whose operator key was revoked (valid `lume_op` cookie, row
 *    revoked or gone), or any `lume_op` cookie that is present but does not
 *    verify (forged, stale key derivation, malformed): signed out locally (Supabase signOut, local scope;
 *    every auth cookie and `lume_op` cleared) → /login, or 401 for the API.
 *    `/auth/*` is exempt so a re-issued key can sign in over a stale cookie.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isAuthPage = pathname === '/login' || pathname.startsWith('/auth/')
  const isApi = pathname.startsWith('/api/')

  // Shared-secret and static routes never need a session refresh.
  if (isPublicPath(pathname) && !isAuthPage) {
    return NextResponse.next({ request })
  }

  // Server-to-server callers (the agent's tool wrappers) authenticate with
  // `Authorization: Bearer ${LUME_INTERNAL_SECRET}`. Compared here in constant
  // time (Web Crypto; this is the Edge runtime): a valid bearer passes to the
  // handler, a present-but-wrong one is a 401 right here, and the route's
  // `requireOwner(req)` repeats the check as defence in depth. No bearer at
  // all falls through to the cookie session below.
  const authorization = request.headers.get('authorization')
  if (isApi && hasBearerToken(authorization)) {
    if (await bearerMatches(authorization, process.env.LUME_INTERNAL_SECRET)) {
      return NextResponse.next({ request })
    }
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { response, user, supabase } = await updateSession(request)
  const owner = isOwner(user?.email, process.env.LUME_ALLOWED_EMAIL)

  if (isAuthPage) {
    // Already signed in as the owner: skip the login form.
    if (pathname === '/login' && user && owner) {
      return redirectTo('/overview', request, response)
    }
    return response
  }

  if (!user) {
    return isApi ? jsonError('unauthenticated', 401, response) : redirectTo('/login', request, response)
  }

  if (!owner) {
    return isApi ? jsonError('forbidden', 403, response) : redirectTo('/forbidden', request, response)
  }

  if (await operatorCookieRejected(request)) {
    try {
      await supabase.auth.signOut({ scope: 'local' })
    } catch (err) {
      console.error('[middleware] operator signOut failed:', err instanceof Error ? err.message : err)
    }
    const out = isApi ? jsonError('operator_revoked', 401, response) : redirectTo('/login', request, response)
    return clearSession(request, out)
  }

  return response
}

/**
 * A `lume_op` cookie that must end the session: present but unverifiable
 * (forged, signed with an older key derivation, malformed — fail closed, no
 * DB lookup), or verified for an operator that is revoked or deleted. No
 * cookie (the owner) is never rejected; a failed revocation lookup fails open.
 */
async function operatorCookieRejected(request: NextRequest): Promise<boolean> {
  const value = request.cookies.get(OPERATOR_COOKIE)?.value
  if (!value) return false
  const id = await verifyOperatorCookieWeb(value, process.env.LUME_INTERNAL_SECRET)
  if (!id) return true
  return (await isOperatorRevoked(id)) === true
}

/** Sign out locally: expire `lume_op` and every Supabase auth-token cookie (chunks included). */
function clearSession(request: NextRequest, res: NextResponse) {
  res.cookies.set(OPERATOR_COOKIE, '', { maxAge: 0, path: '/' })
  for (const c of request.cookies.getAll()) {
    if (c.name.startsWith('sb-') && c.name.includes('auth-token')) res.cookies.set(c.name, '', { maxAge: 0, path: '/' })
  }
  return res
}

function redirectTo(pathname: string, request: NextRequest, from: NextResponse) {
  const url = request.nextUrl.clone()
  url.pathname = pathname
  url.search = ''
  const to = NextResponse.redirect(url)
  copyCookies(from, to)
  return to
}

function jsonError(error: string, status: 401 | 403, from: NextResponse) {
  const to = NextResponse.json({ error }, { status })
  copyCookies(from, to)
  return to
}

/** Keep any refreshed auth cookies when swapping the response object. */
function copyCookies(from: NextResponse, to: NextResponse) {
  for (const c of from.cookies.getAll()) to.cookies.set(c)
}

export const config = {
  // Framework assets only; every other exemption lives in lib/auth/publicPaths.ts.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
