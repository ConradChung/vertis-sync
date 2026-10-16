import 'server-only'

/**
 * Apify REST, read-only: a dataset's items, or the default dataset of an
 * actor's last SUCCEEDED run. Token from `APIFY_API_TOKEN`, sent as a bearer
 * header (never in a URL that could reach a log).
 */

export const APIFY_MAX_ITEMS = 20_000
/** The items response is read into memory; refuse anything bigger. */
export const APIFY_MAX_BODY_BYTES = 40 * 1024 * 1024
const BASE = 'https://api.apify.com/v2'

export class ApifyError extends Error {
  readonly status: number
  readonly code: 'not_configured' | 'not_found' | 'no_succeeded_run' | 'upstream' | 'too_large' | 'timeout'
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

const isTimeout = (err: unknown, signal?: AbortSignal) =>
  signal?.aborted || (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))

async function get(path: string, signal?: AbortSignal): Promise<Response> {
  const t = token()
  const timeout = AbortSignal.timeout(50_000)
  try {
    return await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${t}`, Accept: 'application/json' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  } catch (err) {
    if (isTimeout(err, signal)) throw new ApifyError('timeout', 504, `GET ${path.split('?')[0]} timed out`)
    const msg = (err instanceof Error ? err.message : String(err)).split(t).join('<token>')
    throw new ApifyError('upstream', 0, msg)
  }
}

/** Body as text with a byte cap: Content-Length first, then counted while streaming. */
async function readCapped(res: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {})
    throw new ApifyError('too_large', 413, `dataset items: ${declared} bytes`)
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new ApifyError('too_large', 413, `dataset items: over ${maxBytes} bytes`)
      }
      chunks.push(value)
    }
  } catch (err) {
    if (err instanceof ApifyError) throw err
    if (isTimeout(err, signal)) throw new ApifyError('timeout', 504, 'dataset items: read timed out')
    throw new ApifyError('upstream', 0, 'dataset items: read failed')
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    buf.set(c, off)
    off += c.byteLength
  }
  return new TextDecoder().decode(buf)
}

/** `user/name` and `user~name` are the same actor; the REST path wants `~`. */
export function actorPathId(actorId: string): string {
  return actorId.replace('/', '~')
}

/** Default dataset id of the actor's last succeeded run. */
export async function lastSucceededDatasetId(actorId: string, signal?: AbortSignal): Promise<string> {
  const res = await get(`/acts/${encodeURIComponent(actorPathId(actorId))}/runs/last?status=SUCCEEDED`, signal)
  if (res.status === 404) throw new ApifyError('no_succeeded_run', 404, `no succeeded run for ${actorId}`)
  if (!res.ok) throw new ApifyError('upstream', res.status, `runs/last HTTP ${res.status}`)
  const body = (await res.json().catch(() => null)) as { data?: { defaultDatasetId?: string } } | null
  const id = body?.data?.defaultDatasetId
  if (!id) throw new ApifyError('no_succeeded_run', 404, `last run of ${actorId} has no dataset`)
  return id
}

export interface DatasetItems {
  items: Record<string, unknown>[]
  /** The dataset held more than `APIFY_MAX_ITEMS`. */
  truncated: boolean
  /** Items that were not plain objects (scalars, arrays, null) — left out of the CSV. */
  skipped: number
}

/**
 * Up to `APIFY_MAX_ITEMS` clean items. Asks for one extra so `truncated`
 * says whether the dataset held more than the cap. The body is read with a
 * 40 MB cap (`too_large`).
 */
export async function datasetItems(datasetId: string, signal?: AbortSignal): Promise<DatasetItems> {
  const res = await get(`/datasets/${encodeURIComponent(datasetId)}/items?format=json&clean=true&limit=${APIFY_MAX_ITEMS + 1}`, signal)
  if (res.status === 404) throw new ApifyError('not_found', 404, `dataset ${datasetId} not found`)
  if (!res.ok) throw new ApifyError('upstream', res.status, `dataset items HTTP ${res.status}`)
  const text = await readCapped(res, APIFY_MAX_BODY_BYTES, signal)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new ApifyError('upstream', 502, 'dataset items: invalid JSON')
  }
  if (!Array.isArray(body)) throw new ApifyError('upstream', 502, 'dataset items: not an array')
  const truncated = body.length > APIFY_MAX_ITEMS
  const capped = truncated ? body.slice(0, APIFY_MAX_ITEMS) : body
  const items = capped.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
  return { items, truncated, skipped: capped.length - items.length }
}
