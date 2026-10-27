import { NextResponse } from 'next/server'
import { secretMatches } from '@/lib/auth/secret'
import { mintOwnerSession } from '@/lib/auth/ownerSession'
import { requestOrigin } from '@/lib/http/origin'
import { OPERATOR_COOKIE } from '@/lib/operators/cookie'

/**
 * Owner key sign-in: `/auth/key?k=<LUME_OWNER_KEY>` signs the owner in without
 * an email round-trip (a bookmarkable link for testing). The key is compared
 * in constant time; an unset key disables the route (404). The session is the
 * normal Supabase one for `LUME_ALLOWED_EMAIL`, so the owner check and every
 * approval gate still apply. Rotate by changing LUME_OWNER_KEY.
 *
 * Clears any `lume_op` cookie: the owner signing in on a browser a Grok Bot
 * used is the owner, not that bot.
 */
export async function GET(request: Request) {
  const expected = process.env.LUME_OWNER_KEY?.trim()
  const email = process.env.LUME_ALLOWED_EMAIL?.trim()
  if (!expected || !email) return new NextResponse('Not found', { status: 404 })

  const origin = requestOrigin(request)
  const presented = new URL(request.url).searchParams.get('k')
  if (!secretMatches(presented, expected)) return NextResponse.redirect(`${origin}/login?error=exchange_failed`)

  if (!(await mintOwnerSession(email, 'auth/key'))) return NextResponse.redirect(`${origin}/login?error=exchange_failed`)
  const res = NextResponse.redirect(`${origin}/overview`)
  res.cookies.delete(OPERATOR_COOKIE)
  res.headers.set('Referrer-Policy', 'no-referrer')
  return res
}
