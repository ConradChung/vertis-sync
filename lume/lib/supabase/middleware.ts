import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { verifiedSessionUser, type SessionUser } from '@/lib/auth/session'

/**
 * Refreshes the Supabase session cookies on every matched request and
 * returns the current user alongside the response that carries any rewritten
 * cookies. Mirrors the root app's `updateSession`; the routing decisions live
 * in `lume/middleware.ts` so they can be read in one place.
 */
export async function updateSession(
  request: NextRequest
): Promise<{ response: NextResponse; user: SessionUser | null }> {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
        },
      },
    }
  )

  // Do not put logic between createServerClient and getClaims(): it is what
  // triggers the refresh that keeps users from being randomly logged out.
  // getClaims verifies the JWT locally (signing keys), so this costs no
  // Auth-server round trip on every request the way getUser() did.
  const user = await verifiedSessionUser(supabase.auth)

  // No valid user but stale auth cookies: clear them so the next login is clean.
  // Skip `*-code-verifier`: it is set by signInWithOtp before the magic link
  // lands and must survive the signed-out /auth/callback hop that exchanges it.
  if (!user) {
    for (const c of request.cookies.getAll()) {
      if (c.name.startsWith('sb-') && c.name.includes('auth-token') && !c.name.includes('code-verifier')) {
        response.cookies.set(c.name, '', { maxAge: 0, path: '/' })
      }
    }
  }

  return { response, user }
}
