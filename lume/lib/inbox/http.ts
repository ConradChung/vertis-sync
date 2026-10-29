import 'server-only'
import { NextResponse } from 'next/server'
import { InstantlyError } from '@/lib/adapters/instantly'
import { RateLimitedError } from '@/lib/adapters/instantlyEmails'
import { dbErrorResponse } from '@/lib/http/errors'
import { instantlyErrorResponse } from '@/lib/http/instantly'
import { InboxError, inboxErrorResponse } from '@/lib/inbox/scope'

/**
 * One failure mapping for every /api/inbox route:
 *  - Instantly's 20/min `/emails` budget → 429 `{ error: 'rate_limited',
 *    retry_after_s }` with `Retry-After` (callers wait that long);
 *  - a scope refusal or bad input → its own status and code;
 *  - other Instantly failures → 502 (lib/http/instantly.ts);
 *  - anything else → the usual DB 500.
 */
export function inboxFailure(err: unknown, where: string): NextResponse {
  if (err instanceof RateLimitedError) {
    const secs = Math.max(1, Math.ceil(err.retryAfterMs / 1000))
    return NextResponse.json({ error: 'rate_limited', retry_after_s: secs }, { status: 429, headers: { 'Retry-After': String(secs) } })
  }
  if (err instanceof InboxError) return inboxErrorResponse(err)
  if (err instanceof InstantlyError) return instantlyErrorResponse(err, where)
  return dbErrorResponse(err, where)
}

/** JSON answers from the inbox routes are per-caller and short-lived. */
export const NO_STORE = { 'Cache-Control': 'private, no-store' } as const
