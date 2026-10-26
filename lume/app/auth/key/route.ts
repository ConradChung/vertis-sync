import { NextResponse } from 'next/server'
import { secretMatches } from '@/lib/auth/secret'
import { requestOrigin } from '@/lib/http/origin'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Owner key sign-in: `/auth/key?k=<LUME_OWNER_KEY>` signs the owner in without
 * an email round-trip (a bookmarkable link for testing). The key is compared
 * in constant time; an unset key disables the route (404). The session is the
 * normal Supabase one for `LUME_ALLOWED_EMAIL`, so the owner check and every
 * approval gate still apply. Rotate by changing LUME_OWNER_KEY.
 */
export async function GET(request: Request) {
  const expected = process.env.LUME_OWNER_KEY?.trim()
  const email = process.env.LUME_ALLOWED_EMAIL?.trim()
  if (!expected || !email) return new NextResponse('Not found', { status: 404 })

  const origin = requestOrigin(request)
  const presented = new URL(request.url).searchParams.get('k')
  if (!secretMatches(presented, expected)) return NextResponse.redirect(`${origin}/login?error=exchange_failed`)

  // Mint a one-time magic-link token server-side (no email is sent), then redeem it into the cookie session.
  const { data, error } = await createServiceClient().auth.admin.generateLink({ type: 'magiclink', email })
  const tokenHash = data?.properties?.hashed_token
  if (error || !tokenHash) {
    console.error('[auth/key] generateLink failed:', error?.message)
    return NextResponse.redirect(`${origin}/login?error=exchange_failed`)
  }
  const supabase = await createClient()
  const { error: verifyError } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' })
  if (verifyError) {
    console.error('[auth/key] verify failed:', verifyError.message)
    return NextResponse.redirect(`${origin}/login?error=exchange_failed`)
  }
  const res = NextResponse.redirect(`${origin}/overview`)
  res.headers.set('Referrer-Policy', 'no-referrer')
  return res
}
