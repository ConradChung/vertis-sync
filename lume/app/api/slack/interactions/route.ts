import { after, NextResponse } from 'next/server'
import { EDIT_BLOCK_ID } from '@/lib/slack/card'
import { editBodyError, parseInteraction } from '@/lib/slack/payloads'
import { readSlackRequest } from '@/lib/slack/request'

/**
 * Slack interactivity (3g): the Approve / Edit / Skip buttons on a lead post
 * and the Edit modal's submit. Verified first (v0 signature, raw body),
 * answered within Slack's 3 s, the work in `after()` (lib/slack/decide.ts),
 * which re-reads everything and decides nothing on Slack's word alone: the
 * post must belong to this workspace and channel and point at the clicked
 * action, the channel must still be bound to the campaign, and the campaign
 * must be in Client mode. The modal's empty / too-long body is answered
 * synchronously so Slack shows it under the field.
 */

export const maxDuration = 60

export async function POST(req: Request) {
  const r = await readSlackRequest(req)
  if (!r.ok) return r.response
  const it = parseInteraction(r.raw)
  if (!it) return new Response(null, { status: 200 })

  if (it.kind === 'edit_submit') {
    const err = editBodyError(it.body)
    if (err) return NextResponse.json({ response_action: 'errors', errors: { [EDIT_BLOCK_ID]: err } })
  }

  after(async () => {
    try {
      const decide = await import('@/lib/slack/decide')
      if (it.kind === 'edit_submit') {
        await decide.clientSaveEdit({ team: it.team, user: it.user }, it.post_id, it.body)
      } else if (it.decision === 'edit') {
        await decide.clientOpenEdit({ team: it.team, user: it.user, channel: it.channel }, it.message_ts, it.action_id, it.trigger_id)
      } else {
        await decide.clientButton({ team: it.team, user: it.user, channel: it.channel }, it.message_ts, it.action_id, it.decision)
      }
    } catch (err) {
      console.error('[api/slack/interactions] handling failed:', err instanceof Error ? err.message : err)
    }
  })
  return new Response(null, { status: 200 })
}
