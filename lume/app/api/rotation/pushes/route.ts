import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { isInstantlyConfigured, listCampaigns } from '@/lib/adapters/instantly'
import { logEvent } from '@/lib/db/service'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody } from '@/lib/http/json'
import { groupPushes, StopBody } from '@/lib/rotation/pushes'
import { listPushRows, stopPush } from '@/lib/rotation/pushesStore'

/**
 * GET → { pushes: PushGroup[], campaigns: { id, name }[] }: the lead bank per
 * source list and campaign (queued / stopped / in Instantly / finished), and
 * the campaigns a queue can move to. Names from Instantly, best effort.
 *
 * POST { source_job_id, campaign_id, reason? } → { stopped }: stop that queue now. It
 * can only stop sending, so it is direct; restart and move are a bank_queue
 * action (POST /api/actions) that waits for a tap.
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    const rows = await listPushRows()
    const names = new Map<string, { name: string; status: string | null }>()
    if (isInstantlyConfigured()) {
      try {
        for (const c of await listCampaigns()) names.set(c.id, { name: c.name, status: c.statusLabel ?? null })
      } catch (err) {
        console.error('[api/rotation/pushes] campaign names failed:', err instanceof Error ? err.message : err)
      }
    }
    return NextResponse.json({ pushes: groupPushes(rows, names), campaigns: [...names].map(([id, c]) => ({ id, name: c.name })) })
  } catch (err) {
    return dbErrorResponse(err, 'api/rotation/pushes')
  }
}

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const body = await parseJsonBody(req, StopBody, 1024)
  if (!body.ok) return body.response
  const { source_job_id, campaign_id } = body.data
  const reason = body.data.reason || null
  try {
    const out = await stopPush(source_job_id, campaign_id, reason)
    await logEvent({
      type: 'lume.bank_queue_stopped',
      source: 'lume',
      source_id: source_job_id ?? campaign_id,
      campaign_id,
      title: `Rotation stopped for ${out.stopped.toLocaleString('en-US')} queued leads${reason ? `: ${reason}` : ''}`,
      payload: { source_job_id, by: auth.via === 'internal' ? 'agent' : 'user', stopped: out.stopped, reason },
    }).catch(() => null)
    return NextResponse.json(out)
  } catch (err) {
    return dbErrorResponse(err, 'api/rotation/pushes')
  }
}
