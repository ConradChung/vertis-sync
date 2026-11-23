import { NextResponse } from 'next/server'
import { requireSecret } from '@/lib/auth/guards'
import { ingestF5bot } from '@/lib/reddit/ingest'

/**
 * GTM-15: one F5Bot alert email, POSTed by the Apps Script in the inbox that
 * receives them, with `X-Lume-F5bot-Secret` (= LUME_F5BOT_SECRET, its own
 * secret so the script never holds the cron hook secret).
 *
 * Body: { message_id?, subject?, body (plain text), html? }, at most 512 KB.
 * 200 with a summary (also when the email had no Reddit links); 500 when a
 * Slack send failed (the row stays unalerted and the next email retries it),
 * so the script leaves the email unlabelled and sends it again.
 */
export const maxDuration = 60
const MAX_BYTES = 512 * 1024

const str = (v: unknown) => (typeof v === 'string' ? v : null)

export async function POST(req: Request) {
  const auth = requireSecret(req, 'X-Lume-F5bot-Secret', 'LUME_F5BOT_SECRET')
  if (!auth.ok) return auth.response
  const raw = await req.text()
  if (raw.length > MAX_BYTES) return NextResponse.json({ ok: false, error: 'too_large' }, { status: 413 })
  let p: Record<string, unknown>
  try {
    const j = JSON.parse(raw)
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not an object')
    p = j
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 })
  }
  const body = str(p.body)
  const html = str(p.html)
  if (!body && !html) return NextResponse.json({ ok: false, error: 'missing_body' }, { status: 400 })
  try {
    const result = await ingestF5bot({ message_id: str(p.message_id)?.slice(0, 200), subject: str(p.subject)?.slice(0, 500), body, html })
    return NextResponse.json(result, { status: result.ok ? 200 : 500 })
  } catch (err) {
    console.error('[api/webhooks/f5bot] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: 'f5bot_ingest_failed' }, { status: 500 })
  }
}
