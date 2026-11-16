import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { magicLinkAudience } from '@/lib/auth/magicLink'
import { getPortalUser } from '@/lib/portal/access'
import { requestOrigin } from '@/lib/http/origin'

const Body = z.object({ email: z.string().trim().max(254) })

/**
 * Owner- and portal-gated magic link.
 *
 * Only the allowed email or an active client-portal user
 * (`lume_portal_users`) ever reaches Supabase; anyone else gets the same
 * `{ ok: true }` so the endpoint cannot be used to discover who has access.
 * The owner's auth user must already exist (`shouldCreateUser: false`, see
 * README); a portal user's is created on first request, since the portal
 * allowlist already vouches for the address. The callback sends portal users
 * to /portal. Public to the middleware; this is its own gate.
 */
export async function POST(request: Request) {
  let email: string | undefined
  try {
    email = Body.parse(await request.json()).email
  } catch {
    // Malformed body: still no oracle. Same shape, same status.
  }

  const audience = await magicLinkAudience(email, process.env.LUME_ALLOWED_EMAIL, async (e) => !!(await getPortalUser(e)))
  if (!audience) {
    console.info('[magic-link] skipped: not allowed')
    return NextResponse.json({ ok: true })
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithOtp({
    email: audience === 'portal' ? email!.trim().toLowerCase() : email!,
    options: {
      shouldCreateUser: audience === 'portal',
      emailRedirectTo: `${requestOrigin(request)}/auth/callback`,
    },
  })
  if (error) {
    // Logged server-side; the browser still sees the generic success copy.
    console.error('[magic-link] supabase error:', error.message)
  } else {
    console.info('[magic-link] sent')
  }
  return NextResponse.json({ ok: true })
}
