import { NextResponse } from 'next/server'
import { dbErrorResponse } from '@/lib/http/errors'
import { uuidParam } from '@/lib/http/json'
import { slackOwnerGuard } from '@/lib/slack/ownerRoute'
import { deleteBinding } from '@/lib/slack/store'

/** DELETE → unbind a channel (its past posts stay in Slack, never updated again). Owner's own session. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await slackOwnerGuard(req, false)
  if (denied) return denied
  const id = uuidParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'bad_id' }, { status: 400 })
  try {
    return NextResponse.json({ ok: true, deleted: await deleteBinding(id) })
  } catch (err) {
    return dbErrorResponse(err, 'api/slack/channels')
  }
}
