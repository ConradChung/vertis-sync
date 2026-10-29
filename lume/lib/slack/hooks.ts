import { after } from 'next/server'
import { isSlackConfigured } from '@/lib/slack/config'

/**
 * The client Slack app's hooks into the inbox plumbing (3g). Cheap to import
 * (env check only; the work is a dynamic import), never throw, never block
 * the caller: the work runs after the response (`after()`), or unawaited
 * outside a request scope. While the Slack env vars are missing they do
 * nothing at all.
 *
 *  - slackOnPositiveReply: lib/inbox/replies.ts, a positive reply's first sighting.
 *  - slackOnAction: a send_reply was created, edited, decided or executed.
 */

function schedule(label: string, job: () => Promise<unknown>): void {
  const run = async () => {
    try {
      await job()
    } catch (err) {
      console.error(`[slack] ${label} failed:`, err instanceof Error ? err.message : err)
    }
  }
  try {
    after(run)
  } catch {
    void run()
  }
}

export function slackOnPositiveReply(replyToUuid: string): void {
  if (!isSlackConfigured()) return
  schedule('posting a positive reply', async () => (await import('@/lib/slack/post')).postReplyToChannels(replyToUuid))
}

export function slackOnAction(action: { id: string; kind: string }): void {
  if (action.kind !== 'send_reply' || !isSlackConfigured()) return
  schedule('updating a reply post', async () => (await import('@/lib/slack/post')).syncAction(action.id))
}
