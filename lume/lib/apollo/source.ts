import 'server-only'
import { datasetItems, getRun } from '@/lib/adapters/apify'
import { createServiceClient } from '@/lib/supabase/service'
import type { ApolloSource } from '@/lib/apollo/records'

export class SourceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
  }
}

export const DATASET_ID_RE = /^[A-Za-z0-9]{8,40}$/
export const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Raw rows of an Apify dataset/run or a validation job (≤ 20 000). */
export async function loadSourceRows(source: ApolloSource, signal?: AbortSignal): Promise<{ rows: Record<string, unknown>[]; label: string }> {
  if (source.kind === 'job') {
    if (!JOB_ID_RE.test(source.id)) throw new SourceError(400, 'bad_job_id')
    const sb = createServiceClient()
    const rows: Record<string, unknown>[] = []
    for (let from = 0; from < 20_000; from += 1000) {
      const { data, error } = await sb.from('validation_rows').select('email,row_data').eq('job_id', source.id.toLowerCase()).order('row_index').range(from, from + 999)
      if (error) throw error
      for (const r of data ?? []) rows.push({ ...((r.row_data as Record<string, unknown>) ?? {}), ...(r.email ? { email: r.email } : {}) })
      if (!data || data.length < 1000) break
    }
    if (!rows.length) throw new SourceError(404, 'job_has_no_rows')
    return { rows, label: `validation job ${source.id.slice(0, 8)}` }
  }
  if (!DATASET_ID_RE.test(source.id)) throw new SourceError(400, `bad_${source.kind}_id`)
  let datasetId = source.id
  if (source.kind === 'run') {
    const run = await getRun(source.id, signal)
    if (!run.datasetId) throw new SourceError(409, 'run_has_no_dataset')
    datasetId = run.datasetId
  }
  const { items } = await datasetItems(datasetId, signal)
  if (!items.length) throw new SourceError(422, 'empty_dataset')
  return { rows: items, label: `Apify dataset ${datasetId}` }
}
