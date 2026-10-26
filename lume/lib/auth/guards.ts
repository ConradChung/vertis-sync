import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isOwner } from '@/lib/auth/isOwner'
import { secretMatches } from '@/lib/auth/secret'
import { internalBearerMatches } from '@/lib/auth/internalBearer'
import { hasBearerToken } from '@/lib/auth/bearer'
import { verifiedSessionUser, type SessionUser } from '@/lib/auth/session'

export { secretMatches }

type Pass<T> = { ok: true } & T
type Fail = { ok: false; response: NextResponse }

export type OwnerAuth =
  | Pass<{ via: 'session'; user: SessionUser }>
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
  // JWT verified locally against the signing keys: no Auth-server round trip.
  const user = await verifiedSessionUser(supabase.auth)

  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'unauthenticated' }, { status: 401 }) }
  }
  if (!isOwner(user.email, process.env.LUME_ALLOWED_EMAIL)) {
    return { ok: false, response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) }
  }
  return { ok: true, via: 'session', user }
}

/**
 * `requireOwner`, but only the owner's own cookie session passes: the
 * internal bearer (the agent's tool calls) is a 403 `session_required`. For
 * routes that record a human decision — deciding a pending action or a gate —
 * which the agent must never take on the owner's behalf (it files a
 * `decide_gate` pending action instead).
 */
export async function requireOwnerSession(req: Request): Promise<Pass<{ via: 'session'; user: SessionUser }> | Fail> {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth
  if (auth.via !== 'session') {
    return { ok: false, response: NextResponse.json({ error: 'session_required' }, { status: 403 }) }
  }
  return auth
}

/** Where a shared secret is presented: a header name, or `{ query }` for a URL parameter. */
export type SecretSource = string | { query: string }

/**
 * For shared-secret entrypoints (webhooks, DB hooks, cron, action execute).
 *
 * Compares the presented secret to the named env var in constant time.
 * 401 on any mismatch, including an unset env var. The secret comes from a
 * request header, or from a query parameter for callers that cannot set
 * headers (Instantly webhooks: `?secret=`):
 *
 *   const auth = requireSecret(req, 'x-lume-secret', 'LUME_ACTION_SECRET')
 *   const auth = requireSecret(req, { query: 'secret' }, 'INSTANTLY_WEBHOOK_SECRET')
 *   if (!auth.ok) return auth.response
 */
export function requireSecret(req: Request, source: SecretSource, envName: string): Pass<object> | Fail {
  const presented =
    typeof source === 'string' ? req.headers.get(source) : new URL(req.url).searchParams.get(source.query)
  const expected = process.env[envName]
  if (!secretMatches(presented, expected)) {
    return { ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }
  }
  return { ok: true }
}
