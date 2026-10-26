import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { getRun, isApifyConfigured } from '@/lib/adapters/apify'
import { apifyErrorResponse } from '@/lib/apify/http'

const RUN_ID = /^[A-Za-z0-9]{8,40}$/

/** `GET /api/apify/runs/<runId>` — status, item count and cost so far of one actor run. Read-only. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  if (!isApifyConfigured()) return NextResponse.json({ error: 'apify_not_configured' }, { status: 503 })
  const { id } = await params
  if (!RUN_ID.test(id)) return NextResponse.json({ error: 'bad run id' }, { status: 400 })
  try {
    const r = await getRun(id)
    return NextResponse.json({
      run_id: r.id,
      status: r.status,
      status_message: r.statusMessage,
      started_at: r.startedAt,
      finished_at: r.finishedAt,
      dataset_id: r.datasetId,
      item_count: r.itemCount,
      cost_usd: r.usageTotalUsd,
      limits: r.options,
      charged_events: r.chargedEventCounts,
      console_url: r.consoleUrl,
    })
  } catch (err) {
    return apifyErrorResponse(err, 'api/apify/runs')
  }
}
