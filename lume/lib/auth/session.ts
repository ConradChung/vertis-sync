/**
 * The signed-in identity, verified from the session JWT.
 *
 * `auth.getClaims()` checks the access token's signature against the
 * project's published signing keys (ES256; the JWKS is cached per runtime
 * instance) and its expiry, so a request costs no Auth-server round trip —
 * unlike `getUser()`, which calls `/auth/v1/user` every time. An expired
 * token is refreshed first (via the session's refresh token), which is what
 * keeps the middleware's cookie refresh working. A legacy symmetric-key token
 * falls back to `getUser()` inside the SDK.
 */
export interface SessionUser {
  id: string
  email: string | undefined
}

interface ClaimsAuth {
  getClaims: () => Promise<{ data: { claims: Record<string, unknown> } | null; error?: unknown }>
}

export async function verifiedSessionUser(auth: ClaimsAuth): Promise<SessionUser | null> {
  try {
    const { data, error } = await auth.getClaims()
    const claims = data?.claims
    if (error || !claims || typeof claims.sub !== 'string' || !claims.sub) return null
    return { id: claims.sub, email: typeof claims.email === 'string' ? claims.email : undefined }
  } catch {
    return null
  }
}
