import 'server-only'

/**
 * Apify REST. Reads: a dataset's items, the default dataset of an actor's
 * last SUCCEEDED run, Store search, actor details + pricing, the default
 * build's input schema, a run's status. One write: `startRun`, called only by
 * the `run_actor` pending action's executor (lib/actions/execute.ts) with
 * limits from lib/apify/pricing.ts. Token from `APIFY_API_TOKEN`, sent as a
 * bearer header (never in a URL that could reach a log).
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

async function request(method: 'GET' | 'POST', path: string, signal?: AbortSignal, body?: unknown): Promise<Response> {
  const t = token()
  const timeout = AbortSignal.timeout(50_000)
  try {
    return await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${t}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  } catch (err) {
    if (isTimeout(err, signal)) throw new ApifyError('timeout', 504, `${method} ${path.split('?')[0]} timed out`)
    const msg = (err instanceof Error ? err.message : String(err)).split(t).join('<token>')
    throw new ApifyError('upstream', 0, msg)
  }
}

const get = (path: string, signal?: AbortSignal) => request('GET', path, signal)

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

// ---------------------------------------------------------------------------
// Store, actors, runs

type Raw = Record<string, unknown>
const obj = (v: unknown): Raw | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null)
const strOr = (v: unknown, d: string | null = null) => (typeof v === 'string' ? v : d)
const numOr = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** `{ data }` of a JSON response; 404 → `not_found`, other non-2xx → `upstream`. */
async function dataOf(res: Response, what: string): Promise<Raw> {
  if (res.status === 404) throw new ApifyError('not_found', 404, `${what} not found`)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { type?: string; message?: string } } | null
    const detail = body?.error?.message ? `: ${body.error.message.slice(0, 200)}` : ''
    throw new ApifyError('upstream', res.status, `${what} HTTP ${res.status}${detail}`)
  }
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null
  const data = obj(body?.data)
  if (!data) throw new ApifyError('upstream', 502, `${what}: unexpected response`)
  return data
}

export interface StoreActor {
  id: string
  title: string
  description: string
  rating: number | null
  reviews: number | null
  users: number | null
  users30d: number | null
  successRate30d: number | null
  categories: string[]
  pricingInfo: unknown
  url: string
}

export async function searchStore(query: string, limit = 10, signal?: AbortSignal): Promise<{ total: number; items: StoreActor[] }> {
  const q = new URLSearchParams({ search: query, limit: String(Math.min(Math.max(limit, 1), 50)) })
  const data = await dataOf(await get(`/store?${q}`, signal), 'store search')
  const items = (Array.isArray(data.items) ? data.items : []).flatMap((raw): StoreActor[] => {
    const i = obj(raw)
    const username = strOr(i?.username)
    const name = strOr(i?.name)
    if (!i || !username || !name) return []
    const stats = obj(i.stats) ?? {}
    const runs = obj(stats.publicActorRunStats30Days)
    const total = numOr(runs?.TOTAL)
    const ok = numOr(runs?.SUCCEEDED)
    return [
      {
        id: `${username}/${name}`,
        title: strOr(i.title, name)!,
        description: strOr(i.description, '')!.slice(0, 400),
        rating: numOr(i.actorReviewRating ?? stats.actorReviewRating),
        reviews: numOr(i.actorReviewCount ?? stats.actorReviewCount),
        users: numOr(stats.totalUsers),
        users30d: numOr(stats.totalUsers30Days),
        successRate30d: total && ok !== null ? Math.round((ok / total) * 1000) / 10 : null,
        categories: Array.isArray(i.categories) ? i.categories.filter((c): c is string => typeof c === 'string') : [],
        pricingInfo: i.currentPricingInfo ?? null,
        url: `https://apify.com/${username}/${name}`,
      },
    ]
  })
  return { total: numOr(data.total) ?? items.length, items }
}

export interface ActorDetails {
  id: string
  /** `username/name` */
  name: string
  title: string
  description: string
  pricingInfos: unknown[]
  defaultMemoryMb: number | null
  isDeprecated: boolean
}

export async function getActor(actorId: string, signal?: AbortSignal): Promise<ActorDetails> {
  const d = await dataOf(await get(`/acts/${encodeURIComponent(actorPathId(actorId))}`, signal), `actor ${actorId}`)
  const opts = obj(d.defaultRunOptions)
  return {
    id: strOr(d.id, actorId)!,
    name: `${strOr(d.username, '')}/${strOr(d.name, '')}`,
    title: strOr(d.title, strOr(d.name, actorId))!,
    description: strOr(d.description, '')!.slice(0, 600),
    pricingInfos: Array.isArray(d.pricingInfos) ? d.pricingInfos : [],
    defaultMemoryMb: numOr(opts?.memoryMbytes),
    isDeprecated: d.isDeprecated === true,
  }
}

export interface ActorBuildInput {
  /** `actorDefinition.input`, else the build's `inputSchema` string; null when the actor has none. */
  schema: unknown
  minMemoryMb: number | null
  maxMemoryMb: number | null
}

/** The input schema of the actor's default build. */
export async function getActorInputSchema(actorId: string, signal?: AbortSignal): Promise<ActorBuildInput> {
  const d = await dataOf(
    await get(`/acts/${encodeURIComponent(actorPathId(actorId))}/builds/default`, signal),
    `default build of ${actorId}`
  )
  const def = obj(d.actorDefinition)
  return {
    schema: def?.input ?? d.inputSchema ?? null,
    minMemoryMb: numOr(def?.minMemoryMbytes),
    maxMemoryMb: numOr(def?.maxMemoryMbytes),
  }
}

export interface RunInfo {
  id: string
  actorId: string | null
  status: string
  statusMessage: string | null
  startedAt: string | null
  finishedAt: string | null
  datasetId: string | null
  usageTotalUsd: number | null
  options: Raw | null
  chargedEventCounts: Raw | null
  consoleUrl: string
}

function runInfo(d: Raw): RunInfo {
  const id = strOr(d.id, '')!
  const actId = strOr(d.actId)
  return {
    id,
    actorId: actId,
    status: strOr(d.status, 'UNKNOWN')!,
    statusMessage: strOr(d.statusMessage),
    startedAt: strOr(d.startedAt),
    finishedAt: strOr(d.finishedAt),
    datasetId: strOr(d.defaultDatasetId),
    usageTotalUsd: numOr(d.usageTotalUsd),
    options: obj(d.options),
    chargedEventCounts: obj(d.chargedEventCounts),
    consoleUrl: actId ? `https://console.apify.com/actors/${actId}/runs/${id}` : `https://console.apify.com/actors/runs/${id}`,
  }
}

export interface StartRunOptions {
  timeout: number
  memory?: number
  maxItems?: number
  maxTotalChargeUsd: number
}

/**
 * Start a run with Apify-enforced limits. Callers: the `run_actor` executor
 * only. The limits are query parameters Apify applies to the run itself.
 */
export async function startRun(
  actorId: string,
  input: Record<string, unknown>,
  o: StartRunOptions,
  signal?: AbortSignal
): Promise<RunInfo> {
  const q = new URLSearchParams({ timeout: String(o.timeout), maxTotalChargeUsd: String(o.maxTotalChargeUsd) })
  if (o.memory) q.set('memory', String(o.memory))
  if (o.maxItems) q.set('maxItems', String(o.maxItems))
  const res = await request('POST', `/acts/${encodeURIComponent(actorPathId(actorId))}/runs?${q}`, signal, input)
  return runInfo(await dataOf(res, `start ${actorId}`))
}

export async function getRun(runId: string, signal?: AbortSignal): Promise<RunInfo & { itemCount: number | null }> {
  const run = runInfo(await dataOf(await get(`/actor-runs/${encodeURIComponent(runId)}`, signal), `run ${runId}`))
  let itemCount: number | null = null
  if (run.datasetId) {
    try {
      const ds = await dataOf(await get(`/datasets/${encodeURIComponent(run.datasetId)}`, signal), 'dataset')
      itemCount = numOr(ds.itemCount)
    } catch {
      // the count is a nicety; the status is what matters
    }
  }
  return { ...run, itemCount }
}

/** The account's plan tier (FREE, BRONZE, …) for tiered event prices; null when unknown. */
export async function planTier(signal?: AbortSignal): Promise<string | null> {
  try {
    const d = await dataOf(await get('/users/me', signal), 'user')
    return strOr(obj(d.plan)?.tier)
  } catch {
    return null
  }
}
