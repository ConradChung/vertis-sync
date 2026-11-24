import { NextResponse } from 'next/server'
import { requireSecret } from '@/lib/auth/guards'
import { backfillExcerpts } from '@/lib/reddit/ingest'

/**
 * GTM-15: fill the comment excerpt + summary on mentions stored before the
 * HTML excerpt was parsed, from the kept F5Bot emails, and edit their #sales
 * cards in place. Same secret as the F5Bot webhook. Re-running is a no-op
 * once every row has its excerpt.
 */
export const maxDuration = 120

export async function POST(req: Request) {
  const auth = requireSecret(req, 'X-Lume-F5bot-Secret', 'LUME_F5BOT_SECRET')
  if (!auth.ok) return auth.response
  try {
    const result = await backfillExcerpts()
    return NextResponse.json(result, { status: result.ok ? 200 : 500 })
  } catch (err) {
    console.error('[api/webhooks/f5bot/backfill] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ ok: false, error: 'f5bot_backfill_failed' }, { status: 500 })
  }
}
