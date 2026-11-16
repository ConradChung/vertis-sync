import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { createServiceClient } from '@/lib/supabase/service'
import { requestOrigin } from '@/lib/http/origin'
import { getPortalUser } from '@/lib/portal/access'
import type { PortalSignInLinkResponse } from '@/lib/portal/types'

export const dynamic = 'force-dynamic'

const Body = z.object({ email: z.string().trim().toLowerCase().max(254) })

/** Supabase's default email OTP lifetime (Auth → Email → OTP expiry, 3600 s). */
const LINK_TTL_MINUTES = 60

/**
 * POST /api/portal/sign-in-link { email } → PortalSignInLinkResponse.
 * OWNER ONLY (the middleware also 403s portal users here).
 *
 * Mints a one-time sign-in link for an active portal user so the owner can
 * hand it over directly. Creates the auth user first if it does not exist.
 * The link points at our own `/auth/callback?token_hash=…&type=magiclink&next=/portal`
 * (not Supabase's `action_link`): an admin-generated link has no PKCE
 * verifier, so `action_link` would land with tokens in the URL fragment,
 * which the server-side callback cannot read. The token is never logged.
 */
export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response

  let email: string
  try {
    email = Body.parse(await req.json()).email
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  const portalUser = await getPortalUser(email)
  if (!portalUser) return NextResponse.json({ error: 'not_a_portal_user' }, { status: 404 })

  const admin = createServiceClient().auth.admin
  const created = await admin.createUser({ email: portalUser.email, email_confirm: true })
  if (created.error && created.error.code !== 'email_exists' && created.error.status !== 422) {
    console.error('[portal/sign-in-link] createUser failed:', created.error.code ?? created.error.status)
    return NextResponse.json({ error: 'create_user_failed' }, { status: 502 })
  }

  const { data, error } = await admin.generateLink({ type: 'magiclink', email: portalUser.email })
  const tokenHash = data?.properties?.hashed_token
  if (error || !tokenHash) {
    console.error('[portal/sign-in-link] generateLink failed:', error?.code ?? error?.status)
    return NextResponse.json({ error: 'generate_link_failed' }, { status: 502 })
  }

  const qs = new URLSearchParams({ token_hash: tokenHash, type: 'magiclink', next: '/portal' })
  const body: PortalSignInLinkResponse = {
    url: `${requestOrigin(req)}/auth/callback?${qs}`,
    expires_in_minutes: LINK_TTL_MINUTES,
  }
  return NextResponse.json(body, { headers: { 'cache-control': 'no-store' } })
}
