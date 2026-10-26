import { NextResponse } from 'next/server'
import { requireSecret } from '@/lib/auth/guards'
import { mapInstantlyWebhook, WEBHOOK_MAX_BODY_BYTES } from '@/lib/adapters/instantlyWebhook'
import { logEvent } from '@/lib/db/service'
import { ingestInstantlyEvent } from '@/lib/crm/ingest'
import { dbErrorResponse } from '@/lib/http/errors'
import { readBodyCapped } from '@/lib/http/readBody'

/**
 * Instantly webhook → `events`. Public to the middleware; authenticated here
 * by `?secret=` against `INSTANTLY_WEBHOOK_SECRET` (constant time). The
 * upsert on `webhook_id` ignores a replayed delivery, and the answer after
 * auth is always `200 {ok:true}` (duplicate or not) so Instantly stops
 * retrying. A database failure is a 500 so it does retry.
 *
 * CRM: reply / interested / bounce / sent (and opens) also land on the lead's
 * deal (`lib/crm/ingest.ts`: activity deduped on webhook_id, forward-only
 * auto-advance logged as `lume.crm_stage_auto`). That runs for duplicates too
 * (idempotent) and never changes the answer: a CRM failure is logged, the
 * event is already stored.
 */
export async function POST(req: Request) {
  const auth = requireSecret(req, { query: 'secret' }, 'INSTANTLY_WEBHOOK_SECRET')
  if (!auth.ok) return auth.response

  const read = await readBodyCapped(req, WEBHOOK_MAX_BODY_BYTES)
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
    const ev = mapInstantlyWebhook(body as Record<string, unknown>)
    const inserted = await logEvent(ev)
    try {
      await ingestInstantlyEvent(ev)
    } catch (err) {
      console.error('[api/webhooks/instantly] crm ingest failed:', err instanceof Error ? err.message : err)
    }
    return NextResponse.json({ ok: true, duplicate: inserted === null })
  } catch (err) {
    return dbErrorResponse(err, 'api/webhooks/instantly')
  }
}
