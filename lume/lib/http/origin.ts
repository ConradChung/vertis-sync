/**
 * Public base URL of this deployment, without a trailing slash, from
 * `LUME_URL`. Empty string when unset so callers can fall back to a request
 * origin. Pure: used by deep links (Telegram) and redirect targets alike.
 */
export function configuredBaseUrl(): string {
  const raw = process.env.LUME_URL?.trim()
  if (!raw) return ''
  return raw.replace(/\/+$/, '')
}

/**
 * Public origin of the current request. Prefers the configured `LUME_URL`
 * (the one origin Supabase Auth allowlists and Telegram deep links use), then
 * the proxy headers Vercel sets (`x-forwarded-host` / `x-forwarded-proto`),
 * then the request URL for local dev. Used for redirect targets in auth flows.
 */
export function requestOrigin(request: Request): string {
  const configured = configuredBaseUrl()
  if (configured) return configured
  const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  if (host) {
    const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'https'
    return `${proto}://${host}`
  }
  return new URL(request.url).origin
}

/**
 * Where this deployment calls itself server-to-server (agent tool fetches, the
 * sweeper's execute dispatch): `LUME_INTERNAL_URL` when set, else the origin
 * of the request being handled. Never `LUME_URL`: that is the public deep-link
 * host, and a local or preview run must not call production.
 */
export function internalOrigin(request: Request): string {
  const raw = process.env.LUME_INTERNAL_URL?.trim()
  if (raw) return raw.replace(/\/+$/, '')
  return new URL(request.url).origin
}
