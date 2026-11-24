import 'server-only'
import { ApifyError, datasetItems, getRun } from '@/lib/adapters/apify'
import { DATASET_ID_RE } from '@/lib/apollo/source'
import { appendItems, createList, deleteList, type AppendResult } from '@/lib/leads/lists/store'
import type { ItemSource } from '@/lib/leads/lists/model'
import { MapsError } from '@/lib/maps/errors'
import { cleanPlaces, cleanSummary, isPmCategory, sheetRow, type CleanResult } from '@/lib/maps/places'

/**
 * GTM-12, the Maps sheet: a finished Google Maps run (or its dataset) → the
 * cleaned sheet (lib/maps/places.ts) as a new lead list. Reading a dataset is
 * free; nothing is sent, nothing goes to Frank's portal, no paid step runs.
 */

/** A dataset of Maps places has place ids / categories / Maps ratings; anything else is the wrong source. */
export function looksLikeMapsDataset(items: readonly Record<string, unknown>[]): boolean {
  const sample = items.slice(0, 50)
  const hits = sample.filter((x) => typeof x.placeId === 'string' || typeof x.categoryName === 'string' || typeof x.totalScore === 'number').length
  return sample.length > 0 && hits * 2 >= sample.length
}

const FINISHED = new Set(['SUCCEEDED', 'TIMED-OUT', 'ABORTED'])

export interface MapsSheetSource {
  run_id?: string
  dataset_id?: string
}

export interface MapsSheetResult {
  list_id: string
  list_name: string
  run_status: string | null
  /** The dataset had more items than Lume reads in one go (20 000); only the first were used. */
  truncated: boolean
  clean: Omit<CleanResult, 'kept'> & { kept: number; pm_category: number; with_phone: number }
  append: AppendResult
  summary: string
}

/** Load the dataset behind a finished Maps run. */
async function loadMapsItems(src: MapsSheetSource): Promise<{ items: Record<string, unknown>[]; truncated: boolean; runStatus: string | null; datasetId: string }> {
  if (!!src.run_id === !!src.dataset_id) throw new MapsError(400, 'pass run_id or dataset_id')
  const id = (src.run_id ?? src.dataset_id)!
  if (!DATASET_ID_RE.test(id)) throw new MapsError(400, src.run_id ? 'bad_run_id' : 'bad_dataset_id')
  try {
    let datasetId = id
    let runStatus: string | null = null
    if (src.run_id) {
      const run = await getRun(id)
      runStatus = run.status
      if (!FINISHED.has(run.status)) throw new MapsError(409, `run_not_finished: ${run.status}`)
      if (!run.datasetId) throw new MapsError(409, 'run_has_no_dataset')
      datasetId = run.datasetId
    }
    const { items, truncated } = await datasetItems(datasetId)
    if (!items.length) throw new MapsError(422, 'empty_dataset')
    return { items, truncated, runStatus, datasetId }
  } catch (err) {
    if (err instanceof ApifyError) {
      if (err.code === 'not_configured') throw new MapsError(503, 'apify_not_configured')
      if (err.code === 'not_found') throw new MapsError(404, 'not_found')
      if (err.code === 'too_large') throw new MapsError(422, 'dataset_too_large')
      if (err.code === 'upstream' || err.code === 'timeout') throw new MapsError(502, 'apify_unavailable')
    }
    throw err
  }
}

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })

/**
 * The Maps sheet: a finished run's places, cleaned (lib/maps/places.ts), as a
 * new lead list. `by` marks who built it (lists and rows say so). Refuses a
 * dataset that is not Maps places, or one where nothing survives cleaning.
 */
export async function buildMapsSheet(
  src: MapsSheetSource,
  opts: { name?: string; notes?: string | null; by: 'owner' | 'agent' | 'mcp' },
): Promise<MapsSheetResult> {
  const { items, truncated, runStatus, datasetId } = await loadMapsItems(src)
  if (!looksLikeMapsDataset(items)) throw new MapsError(422, 'not_a_maps_dataset')
  const clean = cleanPlaces(items)
  if (!clean.kept.length) throw new MapsError(422, `nothing_kept: ${cleanSummary(clean)}`)
  const summary = cleanSummary(clean)
  const name = opts.name?.trim() || `LA PM · Google Maps · ${today()}`
  const source: ItemSource = opts.by === 'mcp' ? 'mcp' : 'actor_run'
  const notes = [
    opts.notes?.trim(),
    `GTM-12 Maps sheet from Apify ${src.run_id ? `run ${src.run_id}` : `dataset ${datasetId}`}${runStatus && runStatus !== 'SUCCEEDED' ? ` (run ${runStatus.toLowerCase()}, partial)` : ''}.`,
    summary,
    'LinkedIn and the PM-vs-vendor verdict come from the crawl worker (a separate, approved step).',
  ]
    .filter(Boolean)
    .join('\n')
  const list = await createList({ name, notes, created_by: opts.by })
  let append: AppendResult
  try {
    append = await appendItems(list.id, clean.kept.map((p) => sheetRow(p, source)))
  } catch (err) {
    // The list was created by this call: take it back so a retry starts clean.
    await deleteList(list.id).catch(() => undefined)
    throw err
  }
  return {
    list_id: list.id,
    list_name: list.name,
    run_status: runStatus,
    truncated,
    clean: { dropped: clean.dropped, total: clean.total, kept: clean.kept.length, pm_category: clean.kept.filter(isPmCategory).length, with_phone: clean.kept.filter((p) => !!p.phone).length },
    append,
    summary,
  }
}
