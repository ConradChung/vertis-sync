import { NextResponse } from 'next/server'
import type { User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { isOwner } from '@/lib/auth/isOwner'
import { secretMatches } from '@/lib/auth/secret'

export { secretMatches }

type Pass<T> = { ok: true } & T
type Fail = { ok: false; response: NextResponse }

/**
 * For route handlers behind the owner's session.
 *
 * Reads the session through the cookie-backed server client and checks the
 * email against `LUME_ALLOWED_EMAIL`. 401 when there is no session, 403 when
 * the session belongs to someone else. Call before touching the service role:
 *
 *   const auth = await requireOwner()
 *   if (!auth.ok) return auth.response
 */
export async function requireOwner(): Promise<Pass<{ user: User }> | Fail> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'unauthenticated' }, { status: 401 }) }
  }
  if (!isOwner(user.email, process.env.LUME_ALLOWED_EMAIL)) {
    return { ok: false, response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) }
  }
  return { ok: true, user }
}

/**
 * For shared-secret entrypoints (webhooks, DB hooks, cron, action execute).
 *
 * Compares the named request header to the named env var in constant time.
 * 401 on any mismatch, including an unset env var.
 *
 *   const auth = requireSecret(req, 'x-lume-secret', 'LUME_ACTION_SECRET')
 *   if (!auth.ok) return auth.response
 */
export function requireSecret(req: Request, headerName: string, envName: string): Pass<object> | Fail {
  const presented = req.headers.get(headerName)
  const expected = process.env[envName]
  if (!secretMatches(presented, expected)) {
    return { ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }
  }
  return { ok: true }
}
