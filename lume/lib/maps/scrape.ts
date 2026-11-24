import { ACTOR_RUN_CAP_USD } from '@/lib/apify/pricing'
import { pickAreas, type MapsArea } from '@/lib/maps/areas'

/**
 * GTM-12, step 1: the Google Maps scrape as an ordinary `run_actor` request
 * (lib/apify/service.ts). Nothing here starts a run: the request is filed as
 * a pending action, checked against the actor's live input schema and pricing,
 * capped by Apify at `max_charge_usd`, and starts only after the owner
 * confirms it in Lume or Telegram.
 *
 * Input: one search string per area ("property management in Pasadena, CA"),
 * no paid add-ons (contacts, reviews, images, detail pages stay off), closed
 * places skipped. Places without a website are still returned (the actor's
 * own default) and dropped when the sheet is built, so the count of dropped
 * rows stays visible.
 */

export const MAPS_ACTOR_ID = 'compass/crawler-google-places'
export const MAPS_DEFAULT_QUERY = 'property management'
export const MAPS_DEFAULT_PER_SEARCH = 80
export const MAPS_MAX_PER_SEARCH = 120

export interface MapsScrapeOptions {
  /** Area ids from LA_COUNTY_AREAS; default all of LA County. */
  areas?: readonly string[]
  /** Regions (la-city, westside, …); combined with `areas`. */
  regions?: readonly string[]
  /** Places per search string (1–120, default 80). */
  per_search?: number
  /** Search phrase before "in <area>" (default "property management"). */
  query?: string
  /** Hard cap for the run in USD (default and max: Lume's run cap). */
  max_charge_usd?: number
}

export interface MapsScrapeRequest {
  actor_id: string
  input: Record<string, unknown>
  max_charge_usd: number
  expected_items: number
}

export type MapsScrapePlan =
  | { ok: true; request: MapsScrapeRequest; areas: MapsArea[] }
  | { ok: false; error: string }

export const searchString = (query: string, area: MapsArea) => `${query} in ${area.query}`

const cleanQuery = (q: string | undefined) => (q ?? MAPS_DEFAULT_QUERY).replace(/\s+/g, ' ').trim()

/** The `run_actor` request for a Maps scrape, or why it can't be built. Pure. */
export function buildMapsScrapeRequest(opts: MapsScrapeOptions = {}): MapsScrapePlan {
  const { areas, unknown } = pickAreas({ ids: opts.areas, regions: opts.regions })
  if (unknown.length) return { ok: false, error: `unknown_area: ${unknown.slice(0, 10).join(', ')}` }
  if (!areas.length) return { ok: false, error: 'no_areas' }
  const query = cleanQuery(opts.query)
  if (query.length < 3 || query.length > 80) return { ok: false, error: 'query must be 3–80 characters' }
  const perSearch = opts.per_search ?? MAPS_DEFAULT_PER_SEARCH
  if (!Number.isInteger(perSearch) || perSearch < 1 || perSearch > MAPS_MAX_PER_SEARCH) {
    return { ok: false, error: `per_search must be a whole number from 1 to ${MAPS_MAX_PER_SEARCH}` }
  }
  const cap = opts.max_charge_usd ?? ACTOR_RUN_CAP_USD
  if (!(cap > 0) || cap > ACTOR_RUN_CAP_USD) return { ok: false, error: `max_charge_usd must be above 0 and at most ${ACTOR_RUN_CAP_USD}` }
  return {
    ok: true,
    areas,
    request: {
      actor_id: MAPS_ACTOR_ID,
      input: {
        searchStringsArray: areas.map((area) => searchString(query, area)),
        maxCrawledPlacesPerSearch: perSearch,
        language: 'en',
        skipClosedPlaces: true,
        scrapePlaceDetailPage: false,
        scrapeContacts: false,
        maxReviews: 0,
        maxImages: 0,
        maxQuestions: 0,
      },
      max_charge_usd: cap,
      // Worst case: every search fills up. Real runs return fewer (overlap, small areas).
      expected_items: areas.length * perSearch,
    },
  }
}

/**
 * Optional fields (paid add-ons kept off, closed places skipped, language):
 * when the actor's live schema no longer has one, it is dropped instead of
 * having the whole request refused, and the drop is shown with the request.
 * The search strings and the per-search limit always stay: run_actor refuses
 * a request without them.
 */
export const MAPS_OPTIONAL_OFF_FIELDS = ['scrapePlaceDetailPage', 'scrapeContacts', 'maxReviews', 'maxImages', 'maxQuestions', 'skipClosedPlaces', 'language'] as const

export function fitToSchema(input: Record<string, unknown>, schemaFields: Iterable<string>): { input: Record<string, unknown>; dropped: string[] } {
  const known = new Set(schemaFields)
  const optional = new Set<string>(MAPS_OPTIONAL_OFF_FIELDS)
  const out: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const [k, v] of Object.entries(input)) {
    if (!known.has(k) && optional.has(k)) dropped.push(k)
    else out[k] = v
  }
  return { input: out, dropped }
}
