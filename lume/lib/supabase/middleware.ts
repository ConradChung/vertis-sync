import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import type { User } from '@supabase/supabase-js'

/**
 * Refreshes the Supabase session cookies on every matched request and
 * returns the current user alongside the response that carries any rewritten
 * cookies. Mirrors the root app's `updateSession`; the routing decisions live
 * in `lume/middleware.ts` so they can be read in one place.
 */
export async function updateSession(
  request: NextRequest
): Promise<{ response: NextResponse; user: User | null }> {
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

  // Do not put logic between createServerClient and getUser(): it is what
  // triggers the refresh that keeps users from being randomly logged out.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // No valid user but stale auth cookies: clear them so the next login is clean.
  if (!user) {
    for (const c of request.cookies.getAll()) {
      if (c.name.startsWith('sb-') && c.name.includes('auth-token')) {
        response.cookies.set(c.name, '', { maxAge: 0, path: '/' })
      }
    }
  }

  return { response, user }
}
