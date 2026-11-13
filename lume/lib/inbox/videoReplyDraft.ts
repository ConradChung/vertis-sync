import 'server-only'
import { buildActionRequest } from '@/lib/actions/build'
import { createAction, DuplicateActionError } from '@/lib/actions/create'
import { getEmail, getThreadEmails } from '@/lib/adapters/instantlyEmails'
import { trimQuotes } from '@/lib/inbox/model'
import { askedVideo, isPlainYes, VIDEO_REPLY_CAMPAIGNS, VIDEO_REPLY_DRAFTED_BY, videoReplyBody } from '@/lib/inbox/videoReply'

/**
 * A new positive reply on a live Kaspen campaign that is a plain yes to the
 * video question gets the video-link reply filed as a send_reply. The video
 * grant (lib/actions/grant.ts) then approves it and the executor sends it
 * after every live re-check; if any check fails it simply waits in Slack /
 * Lume for a person like any draft. Cheap pre-checks here so other replies
 * cost nothing. Never throws.
 */
export async function draftVideoReply(input: { reply_to_uuid: string; campaign_id?: string | null }): Promise<'filed' | 'skipped'> {
  try {
    if (!input.campaign_id || !VIDEO_REPLY_CAMPAIGNS.has(input.campaign_id)) return 'skipped'
    const email = await getEmail(input.reply_to_uuid)
    if (!email || email.direction !== 'in' || !isPlainYes(trimQuotes(email.text ?? ''))) return 'skipped'
    const thread = await getThreadEmails(email.thread_id)
    if (thread.truncated || !askedVideo(thread.emails, email.id)) return 'skipped'

    const built = await buildActionRequest({
      kind: 'send_reply',
      payload: { reply_to_uuid: input.reply_to_uuid, body: videoReplyBody(null, null), verdict: 'GOOD', drafted_by: VIDEO_REPLY_DRAFTED_BY },
    })
    if (!built.ok) {
      console.error('[inbox/video] could not build the reply:', built.error)
      return 'skipped'
    }
    // Name and company are the server's own lookup (build.ts), the same ones the grant re-derives the body from.
    const p = built.payload
    p.body = videoReplyBody(typeof p.lead_name === 'string' ? p.lead_name : null, typeof p.company === 'string' ? p.company : null)
    p.summary = `Video link to ${typeof p.lead_name === 'string' ? p.lead_name : String(p.lead_email ?? 'lead')} (plain yes)`
    await createAction(built.kind, p, 'agent')
    return 'filed'
  } catch (err) {
    if (err instanceof DuplicateActionError) return 'skipped'
    console.error('[inbox/video] video reply failed; the reply waits for a person:', err instanceof Error ? err.message : err)
    return 'skipped'
  }
}
