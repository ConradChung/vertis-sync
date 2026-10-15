/**
 * Public origin of the current request, honouring the proxy headers Vercel
 * sets (`x-forwarded-host` / `x-forwarded-proto`) and falling back to the
 * request URL for local dev. Used for redirect targets in auth flows.
 */
export function requestOrigin(request: Request): string {
  const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  if (host) {
    const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'https'
    return `${proto}://${host}`
  }
  return new URL(request.url).origin
}
