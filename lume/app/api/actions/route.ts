import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { createAction, DuplicateActionError, InvalidActionPayloadError } from '@/lib/actions/create'
import { getPushPreview } from '@/lib/adapters/instantlyPush'
import { getPushJob, PUSH_REVIEW_STATUSES } from '@/lib/db/service'
import type { Json } from '@/lib/db/types'
import { dbErrorResponse } from '@/lib/http/errors'
import { parseJsonBody, UUID_RE } from '@/lib/http/json'

/**
 * Request a high-risk action (a `pending_actions` row + Telegram prompt).
 * Only `push_to_instantly` and `launch_campaign` for now.
 *
 * The payload is a snapshot of what the owner confirms, built here from the
 * job row and the instantly-push preview (never from the client):
 * push_to_instantly = { job_id, campaign_id, location_barrier,
 * company_barrier, company_strict, eligible, summary }. Task 12's executor
 * compares the job's current columns to it before sending push_go.
 */

const Body = z.object({
  kind: z.enum(['push_to_instantly', 'launch_campaign']),
  payload: z.looseObject({ job_id: z.string().regex(UUID_RE) }),
})

const onOff = (v: boolean) => (v ? 'on' : 'off')
const fmt = new Intl.NumberFormat('en-US')

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response

  const body = await parseJsonBody(req, Body, 4096)
  if (!body.ok) return body.response
  const { kind } = body.data
  const jobId = body.data.payload.job_id.toLowerCase()

  try {
    const job = await getPushJob(jobId)
    if (!job) return NextResponse.json({ error: 'job_not_found' }, { status: 404 })
    if (!job.instantly_campaign_id) return NextResponse.json({ error: 'no_campaign' }, { status: 409 })
    const campaign = job.instantly_campaign_name ?? job.instantly_campaign_id

    let payload: Record<string, Json>
    if (kind === 'push_to_instantly') {
      if (!(PUSH_REVIEW_STATUSES as readonly string[]).includes(job.instantly_status ?? '')) {
        return NextResponse.json({ error: 'job_not_ready' }, { status: 409 })
      }
      const pv = await getPushPreview(jobId)
      if (!pv.ok) return NextResponse.json({ error: 'preview_failed' }, { status: 502 })
      const { eligible, filtered } = pv.preview
      if (!eligible) return NextResponse.json({ error: 'nothing_to_push' }, { status: 409 })
      // DB defaults: location off, company on, standard names.
      const location = job.location_barrier ?? false
      const company = job.company_barrier ?? true
      const strict = job.company_strict ?? false
      payload = {
        job_id: jobId,
        campaign_id: job.instantly_campaign_id,
        location_barrier: location,
        company_barrier: company,
        company_strict: strict,
        eligible,
        summary:
          `Push ${fmt.format(eligible)} leads from ${job.filename ?? jobId} → ${campaign}` +
          ` (${fmt.format(filtered)} filtered; location ${onOff(location)}, company ${onOff(company)}, ` +
          `${strict ? 'stricter' : 'standard'} names)`,
      }
    } else {
      if (job.instantly_status !== 'done' || !(job.instantly_pushed && job.instantly_pushed > 0)) {
        return NextResponse.json({ error: 'job_not_ready' }, { status: 409 })
      }
      payload = {
        job_id: jobId,
        campaign_id: job.instantly_campaign_id,
        summary: `Launch ${campaign} (${fmt.format(job.instantly_pushed)} leads pushed from ${job.filename ?? jobId})`,
      }
    }

    const action = await createAction(kind, payload, auth.via === 'internal' ? 'agent' : 'user')
    return NextResponse.json({ ok: true, action: { id: action.id, kind: action.kind, summary: payload.summary } }, { status: 201 })
  } catch (err) {
    if (err instanceof DuplicateActionError) {
      return NextResponse.json({ error: 'duplicate', existing_id: err.existingId || null }, { status: 409 })
    }
    if (err instanceof InvalidActionPayloadError) {
      return NextResponse.json({ error: 'invalid_payload' }, { status: 400 })
    }
    return dbErrorResponse(err, 'api/actions')
  }
}
