import 'server-only'

/**
 * Apify REST, read-only: a dataset's items, or the default dataset of an
 * actor's last SUCCEEDED run. Token from `APIFY_API_TOKEN`, sent as a bearer
 * header (never in a URL that could reach a log).
 */

export const APIFY_MAX_ITEMS = 20_000
const BASE = 'https://api.apify.com/v2'

export class ApifyError extends Error {
  readonly status: number
  readonly code: 'not_configured' | 'not_found' | 'no_succeeded_run' | 'upstream'
  constructor(code: ApifyError['code'], status: number, message: string) {
    super(message)
    this.name = 'ApifyError'
    this.code = code
    this.status = status
  }
}

export function isApifyConfigured(): boolean {
  return Boolean(process.env.APIFY_API_TOKEN?.trim())
}

function token(): string {
  const t = process.env.APIFY_API_TOKEN?.trim()
  if (!t) throw new ApifyError('not_configured', 0, 'APIFY_API_TOKEN not set')
  return t
}

async function get(path: string): Promise<Response> {
  const t = token()
  try {
    return await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${t}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(50_000),
    })
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).split(t).join('<token>')
    throw new ApifyError('upstream', 0, msg)
  }
}

/** `user/name` and `user~name` are the same actor; the REST path wants `~`. */
export function actorPathId(actorId: string): string {
  return actorId.replace('/', '~')
}

/** Default dataset id of the actor's last succeeded run. */
export async function lastSucceededDatasetId(actorId: string): Promise<string> {
  const res = await get(`/acts/${encodeURIComponent(actorPathId(actorId))}/runs/last?status=SUCCEEDED`)
  if (res.status === 404) throw new ApifyError('no_succeeded_run', 404, `no succeeded run for ${actorId}`)
  if (!res.ok) throw new ApifyError('upstream', res.status, `runs/last HTTP ${res.status}`)
  const body = (await res.json().catch(() => null)) as { data?: { defaultDatasetId?: string } } | null
  const id = body?.data?.defaultDatasetId
  if (!id) throw new ApifyError('no_succeeded_run', 404, `last run of ${actorId} has no dataset`)
  return id
}

/**
 * Up to `APIFY_MAX_ITEMS` clean items. Asks for one extra so `truncated`
 * says whether the dataset held more than the cap.
 */
export async function datasetItems(datasetId: string): Promise<{ items: Record<string, unknown>[]; truncated: boolean }> {
  const res = await get(`/datasets/${encodeURIComponent(datasetId)}/items?format=json&clean=true&limit=${APIFY_MAX_ITEMS + 1}`)
  if (res.status === 404) throw new ApifyError('not_found', 404, `dataset ${datasetId} not found`)
  if (!res.ok) throw new ApifyError('upstream', res.status, `dataset items HTTP ${res.status}`)
  const body = (await res.json().catch(() => null)) as unknown
  if (!Array.isArray(body)) throw new ApifyError('upstream', 502, 'dataset items: not an array')
  const objects = body.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
  return { items: objects.slice(0, APIFY_MAX_ITEMS), truncated: objects.length > APIFY_MAX_ITEMS }
}
