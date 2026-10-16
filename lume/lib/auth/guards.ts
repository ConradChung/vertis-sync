import { NextResponse } from 'next/server'
import type { User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { isOwner } from '@/lib/auth/isOwner'
import { secretMatches } from '@/lib/auth/secret'
import { internalBearerMatches } from '@/lib/auth/internalBearer'
import { hasBearerToken } from '@/lib/auth/bearer'

export { secretMatches }

type Pass<T> = { ok: true } & T
type Fail = { ok: false; response: NextResponse }

export type OwnerAuth =
  | Pass<{ via: 'session'; user: User }>
  | Pass<{ via: 'internal'; user: null }>

/**
 * For route handlers behind the owner.
 *
 * Two ways in:
 *  1. `Authorization: Bearer ${LUME_INTERNAL_SECRET}` (constant-time) — the
 *     agent's tool wrappers calling routes server-to-server. The middleware
 *     already compared it; this repeats the check as defence in depth. A
 *     bearer that is present but wrong is a 401 here too — it never falls
 *     through to the cookie session. Only checked when the request is passed
 *     in; browsers never send this header.
 *  2. The owner's cookie session, read through the server client and checked
 *     against `LUME_ALLOWED_EMAIL`.
 *
 * 401 when neither is present, 403 when the session belongs to someone else.
 * Call before touching the service role:
 *
 *   const auth = await requireOwner(req)
 *   if (!auth.ok) return auth.response
 */
export async function requireOwner(req?: Request): Promise<OwnerAuth | Fail> {
  const authorization = req?.headers.get('authorization')
  if (req && hasBearerToken(authorization)) {
    if (internalBearerMatches(authorization, process.env.LUME_INTERNAL_SECRET)) {
      return { ok: true, via: 'internal', user: null }
    }
    return { ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }
  }

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
  return { ok: true, via: 'session', user }
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
