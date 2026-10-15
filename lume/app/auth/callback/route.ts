import { NextResponse } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { requestOrigin } from '@/lib/http/origin'

/** Fixed error codes; the login page maps them to copy. Never leak messages into the URL. */
export type CallbackError = 'missing_code' | 'exchange_failed' | 'expired'

/**
 * Magic-link landing. Supabase redirects here with either a PKCE `code`
 * (default template) or a `token_hash` + `type` pair (templates using
 * {{ .TokenHash }}). Either way: establish the cookie session, then send the
 * user to /overview. The middleware applies the owner check from there.
 *
 * Supabase Auth → URL Configuration must allowlist this URL for both
 * http://localhost:3000 and the Vercel deployment.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const origin = requestOrigin(request)
  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null

  const fail = (reason: CallbackError) => NextResponse.redirect(`${origin}/login?error=${reason}`)

  if (!code && !(tokenHash && type)) return fail('missing_code')

  const supabase = await createClient()
  const { error } = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : await supabase.auth.verifyOtp({ token_hash: tokenHash!, type: type! })

  if (!error) return NextResponse.redirect(`${origin}/overview`)

  console.warn('[auth/callback] failed:', error.code ?? error.status, error.message)
  const expired =
    error.code === 'otp_expired' || /expired|invalid/i.test(error.message)
  return fail(expired ? 'expired' : 'exchange_failed')
}
