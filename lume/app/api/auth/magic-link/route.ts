import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { shouldSendMagicLink } from '@/lib/auth/magicLink'
import { requestOrigin } from '@/lib/http/origin'

const Body = z.object({ email: z.string().trim().max(254) })

/**
 * Owner-gated magic link.
 *
 * Only the allowed email ever reaches Supabase; anyone else gets the same
 * `{ ok: true }` so the endpoint cannot be used to discover the owner's
 * address. `shouldCreateUser: false` means the owner's auth user must already
 * exist (see README). Public to the middleware; this is its own gate.
 */
export async function POST(request: Request) {
  let email: string | undefined
  try {
    email = Body.parse(await request.json()).email
  } catch {
    // Malformed body: still no oracle. Same shape, same status.
  }

  if (!shouldSendMagicLink(email, process.env.LUME_ALLOWED_EMAIL)) {
    console.info('[magic-link] skipped: not the owner')
    return NextResponse.json({ ok: true })
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithOtp({
    email: email!,
    options: {
      shouldCreateUser: false,
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
