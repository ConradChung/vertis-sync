import { NextResponse } from 'next/server'
import { requireSecret } from '@/lib/auth/guards'
import { mapInstantlyWebhook } from '@/lib/adapters/instantlyWebhook'
import { logEvent } from '@/lib/db/service'
import { dbErrorResponse } from '@/lib/http/errors'
import { readBodyCapped } from '@/lib/http/readBody'

/** Instantly bodies are a few KB; anything this big is not a webhook. */
export const MAX_BODY_BYTES = 128 * 1024

/**
 * Instantly webhook → `events`. Public to the middleware; authenticated here
 * by `?secret=` against `INSTANTLY_WEBHOOK_SECRET` (constant time). The
 * upsert on `webhook_id` ignores a replayed delivery, and the answer after
 * auth is always `200 {ok:true}` (duplicate or not) so Instantly stops
 * retrying. A database failure is a 500 so it does retry.
 */
export async function POST(req: Request) {
  const auth = requireSecret(req, { query: 'secret' }, 'INSTANTLY_WEBHOOK_SECRET')
  if (!auth.ok) return auth.response

  const read = await readBodyCapped(req, MAX_BODY_BYTES)
  if (!read.ok) return NextResponse.json({ error: 'payload_too_large' }, { status: 413 })
  let body: unknown
  try {
    body = JSON.parse(read.text)
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  try {
    const inserted = await logEvent(mapInstantlyWebhook(body as Record<string, unknown>))
    return NextResponse.json({ ok: true, duplicate: inserted === null })
  } catch (err) {
    return dbErrorResponse(err, 'api/webhooks/instantly')
  }
}
