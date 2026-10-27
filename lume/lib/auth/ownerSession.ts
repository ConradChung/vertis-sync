import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

/** A session `mintOwnerSession` redeemed; `sessionId` is its JWT `session_id` claim (auth.sessions.id), when present. */
export interface MintedSession {
  sessionId: string | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The `session_id` claim of a Supabase access token, or null. Decoded, not
 * verified: the token was just issued to us by Supabase's own verifyOtp, and
 * the value only says which auth.sessions row to delete on revocation.
 */
export function sessionIdFromAccessToken(token: string | null | undefined): string | null {
  const payload = token?.split('.')[1]
  if (!payload) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    const id = claims.session_id
    return typeof id === 'string' && UUID_RE.test(id) ? id : null
  } catch {
    return null
  }
}

/**
 * Sign the owner in on this response's cookies without an email round-trip:
 * mint a one-time magic-link token server-side (no email is sent), then
 * redeem it into the normal Supabase cookie session for `email`. Shared by
 * `/auth/key` (the owner's bookmark) and `/auth/operator` (a Grok Bot's
 * operator key, which carries full owner rights by the owner's decision).
 * Null on any failure; `tag` prefixes the log line.
 */
export async function mintOwnerSession(email: string, tag: string): Promise<MintedSession | null> {
  const { data, error } = await createServiceClient().auth.admin.generateLink({ type: 'magiclink', email })
  const tokenHash = data?.properties?.hashed_token
  if (error || !tokenHash) {
    console.error(`[${tag}] generateLink failed:`, error?.message)
    return null
  }
  const supabase = await createClient()
  const { data: verified, error: verifyError } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' })
  if (verifyError) {
    console.error(`[${tag}] verify failed:`, verifyError.message)
    return null
  }
  return { sessionId: sessionIdFromAccessToken(verified?.session?.access_token) }
}

/** Best-effort local sign-out of this request's session (server-side revoke + cookie clear). */
export async function signOutLocal(tag: string): Promise<void> {
  try {
    const supabase = await createClient()
    const { error } = await supabase.auth.signOut({ scope: 'local' })
    if (error) console.error(`[${tag}] signOut failed:`, error.message)
  } catch (err) {
    console.error(`[${tag}] signOut failed:`, err instanceof Error ? err.message : err)
  }
}
