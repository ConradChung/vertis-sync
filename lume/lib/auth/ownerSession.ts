import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Sign the owner in on this response's cookies without an email round-trip:
 * mint a one-time magic-link token server-side (no email is sent), then
 * redeem it into the normal Supabase cookie session for `email`. Shared by
 * `/auth/key` (the owner's bookmark) and `/auth/operator` (a Grok Bot's
 * operator key, which carries full owner rights by the owner's decision).
 * False on any failure; `tag` prefixes the log line.
 */
export async function mintOwnerSession(email: string, tag: string): Promise<boolean> {
  const { data, error } = await createServiceClient().auth.admin.generateLink({ type: 'magiclink', email })
  const tokenHash = data?.properties?.hashed_token
  if (error || !tokenHash) {
    console.error(`[${tag}] generateLink failed:`, error?.message)
    return false
  }
  const supabase = await createClient()
  const { error: verifyError } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' })
  if (verifyError) {
    console.error(`[${tag}] verify failed:`, verifyError.message)
    return false
  }
  return true
}
