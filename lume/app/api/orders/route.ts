import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import {
  getApolloOrder,
  getGatesForTargets,
  getIngest,
  getJobBatch,
  getJobSample,
  getOrders,
} from '@/lib/db/service'
import type { OrderKind } from '@/lib/db/types'
import { dbErrorResponse } from '@/lib/http/errors'
import { uuidParam } from '@/lib/http/json'
import { sampleCsv, type CsvSample } from '@/lib/import/csv'
import {
  apolloOrderDetail,
  dashboardJobDetail,
  ingestDetail,
  jobBatchDetail,
  ORDER_KINDS,
  type OrderDetail,
} from '@/lib/import/orderDetail'
import { readObjectHead } from '@/lib/import/storage'

/**
 * Orders table (`lume_orders`), newest first. With `?id=&kind=`, one order's
 * read-only detail:
 *  - ingest: header + 5 rows from its CSV in Storage (or, once approved, the
 *    job's first 5 `validation_rows.row_data` and its enrichment config);
 *  - dashboard_job: the same job sample + config;
 *  - apollo_order: status, contact count, credits, Leadsfriday ids;
 *  - job_batch: counts.
 * Each carries the order's open gate (if any) for "Open in Validate".
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const params = new URL(req.url).searchParams

  if (params.has('id') || params.has('kind')) {
    const id = uuidParam(params.get('id') ?? undefined)
    const kind = params.get('kind') as OrderKind | null
    if (!id || !kind || !ORDER_KINDS.includes(kind)) {
      return NextResponse.json({ error: 'invalid_query' }, { status: 400 })
    }
    try {
      const detail = await orderDetail(kind, id)
      return detail ? NextResponse.json(detail) : NextResponse.json({ error: 'not_found' }, { status: 404 })
    } catch (err) {
      return dbErrorResponse(err, 'api/orders detail')
    }
  }

  const raw = params.get('limit')
  const limit = raw && /^\d+$/.test(raw) ? Number(raw) : 100
  try {
    return NextResponse.json(await getOrders({ limit }))
  } catch (err) {
    return dbErrorResponse(err, 'api/orders')
  }
}

async function fileSample(storagePath: string): Promise<CsvSample | null> {
  try {
    const head = await readObjectHead(storagePath)
    return head ? sampleCsv(head.text, 5, head.truncated) : null
  } catch (err) {
    // A missing preview never fails the detail.
    console.error('[api/orders] sample read failed:', err instanceof Error ? err.message : err)
    return null
  }
}

async function orderDetail(kind: OrderKind, id: string): Promise<OrderDetail | null> {
  switch (kind) {
    case 'ingest': {
      const ingest = await getIngest(id)
      if (!ingest) return null
      const jobId = ingest.validation_job_id
      const [job, sample, gates] = await Promise.all([
        jobId ? getJobSample(jobId) : Promise.resolve(null),
        jobId ? Promise.resolve(null) : fileSample(ingest.storage_path),
        getGatesForTargets(jobId ? [id, jobId] : [id]),
      ])
      // The job may be gone (or rows not yet written): fall back to the file.
      const fallback = job && job.rows.length ? null : jobId ? await fileSample(ingest.storage_path) : sample
      return ingestDetail(ingest, { fileSample: fallback, job, gates })
    }
    case 'dashboard_job': {
      const [job, gates] = await Promise.all([getJobSample(id), getGatesForTargets([id])])
      return job ? dashboardJobDetail(job, gates) : null
    }
    case 'apollo_order': {
      const order = await getApolloOrder(id)
      if (!order) return null
      // Once Leadsfriday delivers, the order's next gate is its ingest's approval.
      const gates = await getGatesForTargets(order.ingest_id ? [id, order.ingest_id] : [id])
      return apolloOrderDetail(order, gates)
    }
    case 'job_batch': {
      const [batch, gates] = await Promise.all([getJobBatch(id), getGatesForTargets([id])])
      return batch ? jobBatchDetail(batch, gates) : null
    }
  }
}
