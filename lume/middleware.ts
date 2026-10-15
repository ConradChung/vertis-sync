import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'
import { isOwner } from '@/lib/auth/isOwner'
import { isPublicPath } from '@/lib/auth/publicPaths'

/**
 * Single-user gate.
 *
 *  - public paths (login, auth callback, shared-secret API entrypoints, static
 *    assets) pass through; the API ones verify their own `X-Lume-*` secret.
 *  - no session on anything else → redirect to /login
 *  - a session whose email is not LUME_ALLOWED_EMAIL → 403, rewritten to
 *    /forbidden so the URL stays put and nothing about the app leaks.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isAuthPage = pathname === '/login' || pathname.startsWith('/auth/')

  // Shared-secret and static routes never need a session refresh.
  if (isPublicPath(pathname) && !isAuthPage) {
    return NextResponse.next({ request })
  }

  const { response, user } = await updateSession(request)
  const owner = isOwner(user?.email, process.env.LUME_ALLOWED_EMAIL)

  if (isAuthPage) {
    // Already signed in as the owner: skip the login form.
    if (pathname === '/login' && user && owner) {
      const url = request.nextUrl.clone()
      url.pathname = '/overview'
      url.search = ''
      return redirectWithCookies(url, response)
    }
    return response
  }

  if (!user) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''
    return redirectWithCookies(url, response)
  }

  if (!owner) {
    const url = request.nextUrl.clone()
    url.pathname = '/forbidden'
    url.search = ''
    const forbidden = NextResponse.rewrite(url, { request, status: 403 })
    copyCookies(response, forbidden)
    return forbidden
  }

  return response
}

function redirectWithCookies(url: URL, from: NextResponse) {
  const to = NextResponse.redirect(url)
  copyCookies(from, to)
  return to
}

/** Keep any refreshed auth cookies when swapping the response object. */
function copyCookies(from: NextResponse, to: NextResponse) {
  for (const c of from.cookies.getAll()) to.cookies.set(c)
}

export const config = {
  matcher: [
    /*
     * Everything except:
     * - _next/static, _next/image (framework assets)
     * - favicon.ico and image files
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
