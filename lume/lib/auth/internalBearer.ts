import { secretMatches } from '@/lib/auth/secret'

/**
 * `Authorization: Bearer ${LUME_INTERNAL_SECRET}` lets the agent's tool
 * wrappers (server-to-server, no cookie session) call owner routes. Pure so
 * `requireOwner` stays thin. Constant-time via `secretMatches`; an unset
 * secret never matches.
 *
 * Node-only (secret.ts uses node:crypto). The Edge middleware uses the
 * shape-only `hasBearerToken` from `lib/auth/bearer.ts` instead.
 */
export function internalBearerMatches(
  authorization: string | null | undefined,
  expected: string | null | undefined
): boolean {
  if (!authorization || !expected) return false
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  if (!m) return false
  return secretMatches(m[1], expected)
}
