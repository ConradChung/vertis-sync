import 'server-only'
import { ApifyError } from '@/lib/adapters/apify'
import { loadActor } from '@/lib/apify/service'
import { buildActionRequest } from '@/lib/actions/build'
import { createAction } from '@/lib/actions/create'
import type { Json, PendingActionRow } from '@/lib/db/types'
import { MapsError } from '@/lib/maps/errors'
import { buildMapsScrapeRequest, fitToSchema, MAPS_ACTOR_ID, type MapsScrapeOptions, type MapsScrapeRequest } from '@/lib/maps/scrape'

export { MapsError }

/**
 * GTM-12 (Google Maps → LA County PM leads), the scrape request (the sheet
 * is lib/maps/sheet.ts):
 *
 *  planMapsScrape    the run_actor request for the chosen areas, fitted to the
 *                    actor's live input schema. Reads Apify; starts nothing.
 *  fileMapsScrape    files it as a run_actor pending action (Lume card +
 *                    Telegram prompt). The run starts only after the owner
 *                    confirms; Apify enforces the dollar cap.
 */

export interface MapsScrapePlanView {
  request: MapsScrapeRequest
  areas: { id: string; query: string; region: string }[]
  /** Optional fields the actor no longer defines, left out (the actor's default applies). */
  dropped_fields: string[]
}

export async function planMapsScrape(opts: MapsScrapeOptions): Promise<MapsScrapePlanView> {
  const plan = buildMapsScrapeRequest(opts)
  if (!plan.ok) throw new MapsError(400, plan.error)
  let fields: string[] = []
  try {
    const brief = await loadActor(MAPS_ACTOR_ID)
    fields = brief.schema ? Object.keys(brief.schema.properties) : []
  } catch (err) {
    if (err instanceof ApifyError && err.code === 'not_configured') throw new MapsError(503, 'apify_not_configured')
    throw err
  }
  // No schema to fit against: send as built and let run_actor's own check answer.
  const fitted = fields.length ? fitToSchema(plan.request.input, fields) : { input: plan.request.input, dropped: [] }
  return {
    request: { ...plan.request, input: fitted.input },
    areas: plan.areas.map((a) => ({ id: a.id, query: a.query, region: a.region })),
    dropped_fields: fitted.dropped,
  }
}

export type FiledScrape = { action: PendingActionRow; summary: string; plan: MapsScrapePlanView }

/** The scrape as a run_actor pending action. Refusals from the run_actor check come back as MapsError. */
export async function fileMapsScrape(opts: MapsScrapeOptions, requestedBy: PendingActionRow['requested_by']): Promise<FiledScrape> {
  const plan = await planMapsScrape(opts)
  const built = await buildActionRequest({ kind: 'run_actor', payload: plan.request })
  if (!built.ok) throw new MapsError(built.status, built.error)
  const payload = { ...built.payload, lane: 'gtm-12-google-maps', areas_count: plan.areas.length } as Record<string, Json> & { summary: string }
  const action = await createAction(built.kind, payload, requestedBy)
  return { action, summary: payload.summary, plan }
}
