/**
 * Paths the middleware lets through without a session.
 *
 * Everything else requires the owner's session. Shared-secret routes
 * (webhooks, hooks, cron, action execute) authenticate themselves with
 * `requireSecret` in their handlers; they are public only to the middleware.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

const PUBLIC_PATTERNS: RegExp[] = [
  /^\/login$/,
  /^\/forbidden$/, // the 403 page must render for a signed-out visitor too
  /^\/auth\/[^/]+$/, // /auth/callback, /auth/confirm
  /^\/api\/webhooks\/.+$/, // Instantly webhooks
  /^\/api\/hooks\/.+$/, // DB triggers / pg_net hooks
  /^\/api\/cron\/.+$/, // Vercel cron / pg_cron ticks
  new RegExp(`^/api/actions/${UUID}/execute$`, 'i'), // telegram-inbox lume_ok
  /^\/_next\//, // framework assets
  /^\/favicon\.ico$/,
  /^\/[^?]*\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf|css|js|map|txt|xml|json|webmanifest)$/i,
]

export function isPublicPath(pathname: string): boolean {
  // Strip a query string if a caller passes a full path+search.
  const path = pathname.split('?')[0]
  if (path.includes('/../') || path.endsWith('/..')) return false
  return PUBLIC_PATTERNS.some((re) => re.test(path))
}
