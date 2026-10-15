/**
 * Shape check only, for the Edge middleware (no `node:crypto` there, so this
 * file must stay free of `secret.ts`): does this request carry a bearer token
 * at all? When it does on an `/api/*` path, the middleware steps aside and the
 * handler's `requireOwner(req)` makes the real constant-time decision — so a
 * wrong token still ends in a 401, just from the route instead of the
 * middleware. Browsers never send this header.
 */
export function hasBearerToken(authorization: string | null | undefined): boolean {
  return !!authorization && /^Bearer\s+\S+/i.test(authorization.trim())
}
