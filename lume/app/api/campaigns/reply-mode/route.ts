import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner, requireOwnerSession } from '@/lib/auth/guards'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { operatorCookieForbidden } from '@/lib/operators/guard'
import { listReplyModes, setReplyMode } from '@/lib/inbox/replyModeStore'
import { REPLY_MODES } from '@/lib/inbox/replyMode'
import { CampaignId } from '@/lib/inbox/schemas'
import { alert, alertLink } from '@/lib/alerts'

/**
 * Per-campaign reply approval mode (inbox manager 3e).
 *   GET → `{ modes: [{ campaign_id, mode, updated_at, updated_by }] }`; a
 *        campaign not listed is `owner`. Owner, bots and the agent may read.
 *   PUT `{ campaign_id, mode: 'owner' | 'client' | 'auto' }` →
 *        `{ campaign_id, mode, from }`. The owner's own session only, like
 *        minting a key: the agent bearer (403 session_required) and any
 *        `lume_op` cookie (403 operator_forbidden) are refused. Every change
 *        writes its `lume.reply_mode_changed` event in the same transaction
 *        (RPC lume_set_reply_mode), then an owner-only alert.
 * `client` is stored but behaves like `owner` until the Slack app (3g).
 */

const Body = z.strictObject({ campaign_id: CampaignId, mode: z.enum(REPLY_MODES) })

export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    return NextResponse.json({ modes: await listReplyModes() }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return dbErrorResponse(err, 'api/campaigns/reply-mode')
  }
}

export async function PUT(req: Request) {
  const auth = await requireOwnerSession(req)
  if (!auth.ok) return auth.response
  const bot = operatorCookieForbidden(req)
  if (bot) return bot
  const body = await parseJsonBody(req, Body, 2048)
  if (!body.ok) return body.response
  const { campaign_id, mode } = body.data
  let change
  try {
    change = await setReplyMode(campaign_id, mode, 'owner')
  } catch (err) {
    return dbErrorResponse(err, 'api/campaigns/reply-mode')
  }
  if (change.from !== change.to) {
    const title = `Reply mode for campaign ${campaign_id}: ${change.from} → ${change.to}`
    const body =
      change.to === 'auto'
        ? `${title}\nReplies with a verdict of GOOD on this campaign are now sent without an approval, after the live thread re-check. BAD, unsubscribe and hostile replies still wait for you.`
        : change.to === 'client'
          ? `${title}\nClient approval arrives with the Slack app; until then you approve, as in Owner mode.`
          : `${title}\nEvery reply on this campaign waits for an approval.`
    try {
      await alert({ source: 'lume.settings', severity: change.to === 'auto' ? 'warn' : 'info', title, body, link: alertLink('/settings'), campaign_id, scope: 'replies', owner_only: true })
    } catch (err) {
      console.error('[api/campaigns/reply-mode] alert failed:', err instanceof Error ? err.message : err)
    }
  }
  return NextResponse.json({ campaign_id, mode: change.to, from: change.from })
}
