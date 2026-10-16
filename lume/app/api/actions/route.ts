import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { createAction, DuplicateActionError, InvalidActionPayloadError } from '@/lib/actions/create'
import { getPushJob, PUSH_REVIEW_STATUSES } from '@/lib/db/service'
import { dbErrorResponse } from '@/lib/http/errors'
import { UUID_RE } from '@/lib/http/json'

/**
 * Request a high-risk action (a `pending_actions` row + Telegram prompt).
 * Only `push_to_instantly` and `launch_campaign` for now. The summary the
 * owner approves is built here from the job row, never taken from the
 * client, so the Telegram prompt says what will actually run.
 */

const Body = z.object({
  kind: z.enum(['push_to_instantly', 'launch_campaign']),
  payload: z.looseObject({ job_id: z.string().regex(UUID_RE) }),
})

const onOff = (v: boolean | null, dflt: boolean) => ((v ?? dflt) ? 'on' : 'off')

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const parsed = Body.safeParse(raw)
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  const { kind } = parsed.data
  const jobId = parsed.data.payload.job_id.toLowerCase()

  try {
    const job = await getPushJob(jobId)
    if (!job) return NextResponse.json({ error: 'job_not_found' }, { status: 404 })
    if (!job.instantly_campaign_id) return NextResponse.json({ error: 'no_campaign' }, { status: 409 })

    let summary: string
    if (kind === 'push_to_instantly') {
      if (!(PUSH_REVIEW_STATUSES as readonly string[]).includes(job.instantly_status ?? '')) {
        return NextResponse.json({ error: 'job_not_ready' }, { status: 409 })
      }
      summary =
        `Push ${job.valid_count ?? '?'} valid leads from ${job.filename ?? jobId} → ${job.instantly_campaign_name ?? job.instantly_campaign_id}` +
        ` (location ${onOff(job.location_barrier, false)}, company ${onOff(job.company_barrier, true)}, ` +
        `${job.company_strict ? 'stricter' : 'standard'} names)`
    } else {
      summary = `Launch ${job.instantly_campaign_name ?? job.instantly_campaign_id} (from ${job.filename ?? jobId})`
    }

    const action = await createAction(
      kind,
      { job_id: jobId, summary, campaign_id: job.instantly_campaign_id },
      auth.via === 'internal' ? 'agent' : 'user'
    )
    return NextResponse.json({ ok: true, action: { id: action.id, kind: action.kind, summary } }, { status: 201 })
  } catch (err) {
    if (err instanceof DuplicateActionError) {
      return NextResponse.json({ error: 'duplicate', existing_id: err.existingId }, { status: 409 })
    }
    if (err instanceof InvalidActionPayloadError) {
      return NextResponse.json({ error: 'invalid_payload' }, { status: 400 })
    }
    return dbErrorResponse(err, 'api/actions')
  }
}
