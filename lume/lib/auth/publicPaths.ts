/**
 * Paths the middleware lets through without a session. Single source of
 * truth: `middleware.ts`'s matcher only trims framework assets.
 *
 * Everything else requires the owner's session. Shared-secret routes
 * (webhooks, hooks, cron, action execute) authenticate themselves with
 * `requireSecret` in their handlers, and `/api/auth/*` is its own gate; they
 * are public only to the middleware.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

const PUBLIC_PATTERNS: RegExp[] = [
  /^\/login$/,
  /^\/forbidden$/, // the 403 page must render for a signed-out visitor too
  /^\/auth\/[^/]+$/, // /auth/callback, /auth/confirm
  /^\/api\/auth\/.+$/, // owner-gated magic-link request
  /^\/api\/webhooks\/.+$/, // Instantly webhooks
  /^\/api\/hooks\/.+$/, // DB triggers / pg_net hooks
  /^\/api\/cron\/.+$/, // Vercel cron / pg_cron ticks
  new RegExp(`^/api/actions/${UUID}/execute$`, 'i'), // telegram-inbox lume_ok
  /^\/_next\//, // framework assets
  /^\/favicon\.ico$/,
  // Static files from /public. Never under /api/, and never scripts/styles/
  // data, so `/api/gates.json` or `/overview.js` cannot slip past the session.
  /^\/(?!api\/)[^?]*\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf|txt|xml|webmanifest)$/i,
]

export function isPublicPath(pathname: string): boolean {
  // Strip a query string if a caller passes a full path+search.
  const path = pathname.split('?')[0]
  if (path.includes('/../') || path.endsWith('/..')) return false
  return PUBLIC_PATTERNS.some((re) => re.test(path))
}
