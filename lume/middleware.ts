import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'
import { isOwner } from '@/lib/auth/isOwner'
import { isPublicPath } from '@/lib/auth/publicPaths'

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
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isAuthPage = pathname === '/login' || pathname.startsWith('/auth/')
  const isApi = pathname.startsWith('/api/')

  // Shared-secret and static routes never need a session refresh.
  if (isPublicPath(pathname) && !isAuthPage) {
    return NextResponse.next({ request })
  }

  const { response, user } = await updateSession(request)
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

  return response
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
