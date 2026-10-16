import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/guards'
import { ApifyError, datasetItems, isApifyConfigured, lastSucceededDatasetId } from '@/lib/adapters/apify'
import { parseJsonBody } from '@/lib/http/json'
import { MAX_CSV_BYTES, toCsv } from '@/lib/import/csv'
import { ingestBody, intakeErrorResponse } from '@/lib/import/errors'
import { createIngest } from '@/lib/import/ingest'

/**
 * Pull an Apify dataset into the approval gate: `{dataset_id}` or
 * `{actor_id}` (its last SUCCEEDED run's default dataset). Items (≤ 20 000)
 * become a CSV — nested values JSON-stringified — and go through
 * `createIngest`, i.e. the same Approve / Deny prompt a dropped file gets.
 */

export const maxDuration = 120
/** One deadline for both Apify GETs and the Storage upload, inside maxDuration. */
const DEADLINE_MS = 105_000

// Apify ids: dataset ids are 17 alphanumerics; actor ids are an id or
// `username~name` / `username/name`.
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:[~/][A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/

const Body = z
  .object({
    dataset_id: z.string().trim().regex(ID).optional(),
    actor_id: z.string().trim().regex(ACTOR).optional(),
  })
  .refine((b) => Boolean(b.dataset_id) !== Boolean(b.actor_id), { message: 'exactly one of dataset_id / actor_id' })

export async function POST(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response

  const body = await parseJsonBody(req, Body, 1024)
  if (!body.ok) return body.response
  if (!isApifyConfigured()) return NextResponse.json({ error: 'apify_not_configured' }, { status: 503 })

  const { dataset_id, actor_id } = body.data
  const deadline = AbortSignal.timeout(DEADLINE_MS)
  let datasetId: string
  let items: Record<string, unknown>[]
  let truncated: boolean
  let skipped: number
  try {
    datasetId = dataset_id ?? (await lastSucceededDatasetId(actor_id!, deadline))
    ;({ items, truncated, skipped } = await datasetItems(datasetId, deadline))
  } catch (err) {
    if (err instanceof ApifyError) {
      if (err.code === 'not_found' || err.code === 'no_succeeded_run') {
        return NextResponse.json({ error: err.code }, { status: 404 })
      }
      if (err.code === 'timeout') return NextResponse.json({ error: 'apify_timeout' }, { status: 504 })
      if (err.code === 'too_large') return NextResponse.json({ error: 'too_large' }, { status: 413 })
      if (err.code === 'not_configured') return NextResponse.json({ error: 'apify_not_configured' }, { status: 503 })
      console.error(`[api/import/apify] ${err.message}`)
      return NextResponse.json({ error: 'apify_error' }, { status: 502 })
    }
    throw err
  }

  if (items.length === 0) return NextResponse.json({ error: 'empty_dataset' }, { status: 422 })
  const bytes = new TextEncoder().encode(toCsv(items))
  if (bytes.byteLength > MAX_CSV_BYTES) return NextResponse.json({ error: 'too_large' }, { status: 413 })

  try {
    const result = await createIngest(bytes, `apify-${datasetId}.csv`, {
      source: 'apify',
      detail: actor_id ? `actor ${actor_id} → dataset ${datasetId}` : `dataset ${datasetId}`,
      signal: deadline,
    })
    return NextResponse.json({ ...ingestBody(result), dataset_id: datasetId, items: items.length, truncated, skipped })
  } catch (err) {
    if (deadline.aborted) {
      console.error('[api/import/apify] deadline passed during upload')
      return NextResponse.json({ error: 'apify_timeout' }, { status: 504 })
    }
    return intakeErrorResponse(err, 'api/import/apify')
  }
}
