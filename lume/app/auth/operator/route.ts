import { NextResponse } from 'next/server'
import { mintOwnerSession, signOutLocal } from '@/lib/auth/ownerSession'
import { requestOrigin } from '@/lib/http/origin'
import { OPERATOR_COOKIE, OPERATOR_COOKIE_MAX_AGE, OPERATOR_COOKIE_OPTIONS, signOperatorCookie } from '@/lib/operators/cookie'
import { findOperatorByKey, recordOperatorSession, touchOperator } from '@/lib/operators/store'

/**
 * Grok Bot sign-in: `/auth/operator?k=<operator key>`. A live (unrevoked) key
 * gets the same Supabase owner session as `/auth/key` — full owner rights, the
 * owner's decision — plus an httpOnly `lume_op=<operator id>.<hmac>` cookie so
 * decisions and agent chats are attributed to that bot. Lands on `/operator`.
 * Any bad, revoked or unknown key (or a missing secret / owner email) →
 * `/login?error=exchange_failed`, before any token is minted.
 *
 * The minted session's id (JWT `session_id`) is recorded in
 * `lume_operator_sessions` so revoking the key deletes it. If it cannot be
 * recorded the sign-in fails closed: the fresh session is signed out again,
 * because a session revocation cannot reach would outlive the key.
 */
export async function GET(request: Request) {
  const origin = requestOrigin(request)
  const fail = () => {
    const res = NextResponse.redirect(`${origin}/login?error=exchange_failed`)
    res.headers.set('Referrer-Policy', 'no-referrer')
    return res
  }
  const email = process.env.LUME_ALLOWED_EMAIL?.trim()
  const secret = process.env.LUME_INTERNAL_SECRET
  if (!email || !secret) return fail()

  const key = new URL(request.url).searchParams.get('k')?.trim()
  let operator
  try {
    operator = await findOperatorByKey(key)
  } catch (err) {
    console.error('[auth/operator] key lookup failed:', err instanceof Error ? err.message : err)
    return fail()
  }
  if (!operator) return fail()

  const minted = await mintOwnerSession(email, 'auth/operator')
  if (!minted) return fail()
  try {
    if (!minted.sessionId) throw new Error('minted session has no session_id claim')
    await recordOperatorSession(operator.id, minted.sessionId)
  } catch (err) {
    console.error('[auth/operator] session record failed:', err instanceof Error ? err.message : err)
    await signOutLocal('auth/operator')
    return fail()
  }

  try {
    await touchOperator(operator.id)
  } catch (err) {
    console.error('[auth/operator] touch failed:', err instanceof Error ? err.message : err)
  }
  const res = NextResponse.redirect(`${origin}/operator`)
  res.cookies.set(OPERATOR_COOKIE, signOperatorCookie(operator.id, secret), { ...OPERATOR_COOKIE_OPTIONS, maxAge: OPERATOR_COOKIE_MAX_AGE })
  res.headers.set('Referrer-Policy', 'no-referrer')
  return res
}
