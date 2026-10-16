import { secretMatches } from '@/lib/auth/secret'
import { bearerToken } from '@/lib/auth/bearer'

/**
 * `Authorization: Bearer ${LUME_INTERNAL_SECRET}` lets the agent's tool
 * wrappers (server-to-server, no cookie session) call owner routes. Pure so
 * `requireOwner` stays thin. Constant-time via `secretMatches`; an unset
 * secret never matches.
 *
 * Node-only (secret.ts uses node:crypto). The Edge middleware uses
 * `bearerMatches` from `lib/auth/bearer.ts` (Web Crypto) instead; both parse
 * the header with the same `bearerToken`.
 */
export function internalBearerMatches(
  authorization: string | null | undefined,
  expected: string | null | undefined
): boolean {
  const presented = bearerToken(authorization)
  if (!presented || !expected) return false
  return secretMatches(presented, expected)
}
