/**
 * Bearer-token helpers that run on the Edge runtime (the middleware). This
 * file must stay free of `node:crypto`; it uses Web Crypto only.
 *
 * `Authorization: Bearer ${LUME_INTERNAL_SECRET}` lets the agent's tool
 * wrappers (server-to-server, no cookie session) call owner routes. Browsers
 * never send this header.
 */

const BEARER_RE = /^Bearer\s+(\S+)\s*$/i

/** Does this header carry a bearer token at all (shape only, no comparison)? */
export function hasBearerToken(authorization: string | null | undefined): boolean {
  return !!authorization && BEARER_RE.test(authorization.trim())
}

/** The token part of `Bearer <token>`, or `null` when the header is not that shape. */
export function bearerToken(authorization: string | null | undefined): string | null {
  if (!authorization) return null
  const m = BEARER_RE.exec(authorization.trim())
  return m ? m[1] : null
}

/**
 * Constant-time compare of a presented bearer against the expected secret.
 * Same pattern as `supabase/functions/_shared/lume/action.ts` `secretsMatch`:
 * both sides are SHA-256 hashed so the loop runs over equal-length buffers
 * whatever the caller sent, then every byte is touched. Missing or empty
 * values never match, so an unset secret fails closed.
 */
export async function bearerMatches(
  authorization: string | null | undefined,
  expected: string | null | undefined
): Promise<boolean> {
  const presented = bearerToken(authorization)
  if (!presented || !expected) return false
  const enc = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(presented)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ])
  const x = new Uint8Array(a)
  const y = new Uint8Array(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}
