import { after, NextResponse } from 'next/server'
import { EDIT_BLOCK_ID } from '@/lib/slack/card'
import { editBodyError, parseInteraction } from '@/lib/slack/payloads'
import { readSlackRequest } from '@/lib/slack/request'
import { signalEditErrors } from '@/lib/slack/signalCard'
import { signalCardOpts } from '@/lib/signal/config'

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

// 300: a #content-gen Redo writes a new draft (up to three Claude calls) in after().
export const maxDuration = 300

export async function POST(req: Request) {
  const r = await readSlackRequest(req)
  if (!r.ok) return r.response
  const it = parseInteraction(r.raw)
  if (!it) return new Response(null, { status: 200 })

  if (it.kind === 'edit_submit') {
    const err = editBodyError(it.body)
    if (err) return NextResponse.json({ response_action: 'errors', errors: { [EDIT_BLOCK_ID]: err } })
  }

  if (it.kind === 'signal_edit_submit') {
    const errors = signalEditErrors(it.drafts, signalCardOpts().noteLimit)
    if (errors) return NextResponse.json({ response_action: 'errors', errors })
  }

  after(async () => {
    try {
      // Reply desk (SendPilot channel): Sent / Redo / Booked / Not interested.
      if (it.kind === 'rdesk_button') {
        const [{ handleButton }, { liveDeps }] = await Promise.all([import('@/lib/replydesk/engine'), import('@/lib/replydesk/live')])
        await handleButton({ decision: it.decision, draft_id: it.draft_id, user: it.user, team: it.team, channel: it.channel, message_ts: it.message_ts }, liveDeps())
        return
      }
      // LinkedIn draft generator (#content-gen): Redo / Skip.
      if (it.kind === 'content_button') {
        const cd = await import('@/lib/content/decide')
        await cd.contentButton({ team: it.team, user: it.user, channel: it.channel }, it.message_ts, it.draft_id, it.decision)
        return
      }
      // GTM-15 Reddit mention cards (#sales).
      if (it.kind === 'reddit_button') {
        const rd = await import('@/lib/slack/redditDecide')
        await rd.redditButton({ team: it.team, user: it.user, channel: it.channel }, it.message_ts, it.mention_id, it.decision)
        return
      }
      // GTM-14 signal cards (#sales) go to their own handler; lead posts below are unchanged.
      if (it.kind === 'signal_button' || it.kind === 'signal_edit_submit') {
        const sd = await import('@/lib/slack/signalDecide')
        if (it.kind === 'signal_edit_submit') await sd.signalSaveEdit({ team: it.team, user: it.user }, it.person_id, it.drafts)
        else if (it.decision === 'edit') await sd.signalOpenEdit({ team: it.team, user: it.user, channel: it.channel }, it.message_ts, it.person_id, it.trigger_id)
        else await sd.signalButton({ team: it.team, user: it.user, channel: it.channel }, it.message_ts, it.person_id, it.decision)
        return
      }
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
