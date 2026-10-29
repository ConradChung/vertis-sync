import 'server-only'
import { NextResponse } from 'next/server'
import { InstantlyError } from '@/lib/adapters/instantly'
import { RateLimitedError } from '@/lib/adapters/instantlyEmails'
import { dbErrorResponse } from '@/lib/http/errors'
import { isFormPost, readJsonOrForm, type BodyRead } from '@/lib/http/form'
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

interface Schema<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false }
}

/**
 * A JSON body for an inbox write. Same rules as every cookie-authenticated
 * Lume POST (lib/http/form.ts readJsonOrForm): a browser caller must be
 * same-origin (Origin, else Sec-Fetch-Site), so a Grok Bot's `fetch()` from
 * its signed-in Lume tab passes and a cross-site page does not; the agent's
 * bearer calls skip the check. Forms are not accepted here (415).
 */
export async function readInboxJson<T>(req: Request, schema: Schema<T>, maxBytes = 32 * 1024): Promise<BodyRead<T>> {
  if (isFormPost(req)) return { ok: false, response: NextResponse.json({ error: 'json_only' }, { status: 415 }) }
  return readJsonOrForm(req, schema, maxBytes, () => null)
}
