import 'server-only'
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js'

let cached: SupabaseClient | undefined

/**
 * Service-role client. Server-only: the `server-only` import makes any
 * accidental client bundle import a build error.
 *
 * Bypasses RLS, so call it only after `requireOwner()` or `requireSecret()`
 * has passed. No session persistence or token refresh: it is a static key.
 */
export function createServiceClient(): SupabaseClient {
  if (cached) return cached
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  }
  cached = createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return cached
}
