// One switch for every outbound notification (Phase G4).
//
// alert() always writes the notification to the durable feed (lume_alerts),
// which Lume's /operator page shows to the Grok Bot. Telegram still sends
// only while ALERT_CHANNELS includes `telegram`: the caller passes its
// existing send, unchanged, as the `telegram` callback, and gets that
// callback's result back (callers that store a Telegram message_id for later
// edits keep working).
//
// ALERT_CHANNELS is a comma list of `telegram` and `feed`; missing or empty
// means `telegram,feed`. The feed is written regardless (it is the record the
// operator acks); `feed` is accepted so the cutover value reads naturally
// (ALERT_CHANNELS=feed turns Telegram off).
//
// The feed insert never blocks or breaks the caller: it starts before the
// Telegram send, is handed to EdgeRuntime.waitUntil when available (so the
// send and everything after it run on the old timing), is time-boxed, and
// any failure is logged and swallowed.

export type AlertChannel = 'telegram' | 'feed'
export type AlertSeverity = 'info' | 'warn' | 'urgent'
export type AlertScope = 'campaign' | 'orders' | 'replies' | 'validation'
/**
 * What a repeated dedupe_key does (lume_alert_upsert): `reopen` (default)
 * refreshes the row and makes it unacked again, so a gate that re-opens is
 * seen; `update` refreshes the content but keeps the ack (a re-post of a gate
 * that is no longer open); `touch` only un-acks (a thinner ping that must not
 * overwrite the pipeline's own prompt).
 */
export type AlertMode = 'reopen' | 'update' | 'touch'

export interface AlertInput<T> {
  source: string
  severity?: AlertSeverity
  title: string
  body?: string | null
  link?: string | null
  campaign_id?: string | null
  scope?: AlertScope | null
  dedupe_key?: string | null
  mode?: AlertMode
  telegram?: () => Promise<T>
}

export interface AlertDeps {
  env: (key: string) => string | undefined
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  log: (...args: unknown[]) => void
  waitUntil?: (p: Promise<unknown>) => void
}

const KNOWN: ReadonlySet<string> = new Set(['telegram', 'feed'])
const DEFAULT_CHANNELS: AlertChannel[] = ['telegram', 'feed']
const FEED_TIMEOUT_MS = 5000

export function parseChannels(raw: string | undefined | null, warn: (msg: string) => void = console.warn): Set<AlertChannel> {
  const tokens = (raw ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
  if (tokens.length === 0) return new Set(DEFAULT_CHANNELS)
  const out = new Set<AlertChannel>()
  for (const t of tokens) {
    if (KNOWN.has(t)) out.add(t as AlertChannel)
    else warn(`[alert] ALERT_CHANNELS: ignoring unknown channel "${t}"`)
  }
  // A value with no recognised channel is a typo, not an instruction to go
  // silent: keep Telegram on.
  if (out.size === 0) {
    warn('[alert] ALERT_CHANNELS has no known channel; using telegram,feed')
    return new Set(DEFAULT_CHANNELS)
  }
  return out
}

// First non-empty line of a message, with Markdown / HTML markup removed.
export function titleFrom(text: string): string {
  const line = (text ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  return line
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Paired markers only, so snake_case (push_to_instantly) survives.
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/(^|[^\p{L}\p{N}])_([^_]+)_(?=[^\p{L}\p{N}]|$)/gu, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

// A Lume page for the feed row: absolute when LUME_URL is set, else relative.
export function lumeLink(path: string, env: (key: string) => string | undefined = (k) => Deno.env.get(k)): string {
  const base = (env('LUME_URL') ?? '').trim().replace(/\/+$/, '')
  return base ? `${base}${path}` : path
}

function defaultDeps(): AlertDeps {
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime
  return {
    env: (k) => Deno.env.get(k),
    fetch: (input, init) => fetch(input, init),
    log: (...a) => console.error(...a),
    waitUntil: rt?.waitUntil ? (p) => rt.waitUntil!(p) : undefined,
  }
}

function insertFeed<T>(input: AlertInput<T>, deps: AlertDeps): Promise<void> {
  const url = deps.env('SUPABASE_URL')
  const key = deps.env('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) {
    deps.log('[alert] lume_alerts insert skipped: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set')
    return Promise.resolve()
  }
  // One write path for every alert: the lume_alert_upsert RPC (plain insert
  // without a dedupe_key; re-open / update / touch semantics with one).
  const args = {
    p_source: input.source,
    p_severity: input.severity ?? 'info',
    p_title: input.title || input.source,
    p_body: input.body ?? null,
    p_link: input.link ?? null,
    p_campaign_id: input.campaign_id ?? null,
    p_scope: input.scope ?? null,
    p_dedupe_key: input.dedupe_key ?? null,
    p_mode: input.mode ?? 'reopen',
  }
  let res: Promise<Response>
  try {
    res = deps.fetch(`${url}/rest/v1/rpc/lume_alert_upsert`, {
      method: 'POST',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    })
  } catch (e) {
    res = Promise.reject(e)
  }
  return res.then(async (r) => {
    if (!r.ok) deps.log(`[alert] lume_alerts insert failed (${r.status}) for ${input.source}: ${(await r.text().catch(() => '')).slice(0, 300)}`)
    else await r.body?.cancel()
  }).catch((e) => {
    deps.log(`[alert] lume_alerts insert failed for ${input.source}: ${e instanceof Error ? e.message : String(e)}`)
  })
}

export async function alert<T>(input: AlertInput<T>, deps: AlertDeps = defaultDeps()): Promise<T | undefined> {
  // Start the feed write first so it is attempted even if the send throws.
  const feed = insertFeed(input, deps)
  const handedOff = !!deps.waitUntil
  if (deps.waitUntil) deps.waitUntil(feed)
  try {
    const channels = parseChannels(deps.env('ALERT_CHANNELS'), (m) => deps.log(m))
    if (input.telegram && channels.has('telegram')) return await input.telegram()
    return undefined
  } finally {
    if (!handedOff) await feed
  }
}
