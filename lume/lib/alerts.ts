import 'server-only'
import { maskKeyText } from '@/lib/operators/mask'
import { createServiceClient } from '@/lib/supabase/service'
import { configuredBaseUrl } from '@/lib/http/origin'
import type { TelegramResult } from '@/lib/adapters/telegram'

/**
 * One switch for Lume's own notifications (Phase G4), the twin of the edge
 * helper `supabase/functions/_shared/alert.ts`.
 *
 * `alert()` always writes the notification to the durable feed
 * (`lume_alerts`, through the `lume_alert_upsert` RPC), which the Grok Bot reads on /operator. The caller's
 * existing Telegram send runs, unchanged, as the `telegram` callback only
 * while `ALERT_CHANNELS` includes `telegram`; its result is returned so
 * callers that store a Telegram message id keep working.
 *
 * `ALERT_CHANNELS`: a comma list of `telegram` and `feed`. Missing or empty
 * means `telegram,feed`; unknown tokens are ignored with a warning; a value
 * with no known channel falls back to the default rather than going silent.
 * The feed is written regardless.
 *
 * The feed insert starts before the send and is awaited after it, so the send
 * goes out on its old timing; it is capped at 5 s, and a feed failure or
 * timeout is logged, never thrown.
 */

export type AlertChannel = 'telegram' | 'feed'
export type AlertSeverity = 'info' | 'warn' | 'urgent'
export type AlertScope = 'campaign' | 'orders' | 'replies' | 'validation'
/**
 * A repeated dedupe_key (lume_alert_upsert): `reopen` (default) refreshes the
 * row and un-acks it; `update` refreshes the content and keeps the ack;
 * `touch` only un-acks (a thinner ping must not overwrite the pipeline's prompt).
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

const KNOWN: ReadonlySet<string> = new Set(['telegram', 'feed'])
const DEFAULT_CHANNELS: AlertChannel[] = ['telegram', 'feed']

export function parseChannels(raw: string | undefined | null, warn: (msg: string) => void = console.warn): Set<AlertChannel> {
  const tokens = (raw ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
  if (tokens.length === 0) return new Set(DEFAULT_CHANNELS)
  const out = new Set<AlertChannel>()
  for (const t of tokens) {
    if (KNOWN.has(t)) out.add(t as AlertChannel)
    else warn(`[alerts] ALERT_CHANNELS: ignoring unknown channel "${t}"`)
  }
  if (out.size === 0) {
    warn('[alerts] ALERT_CHANNELS has no known channel; using telegram,feed')
    return new Set(DEFAULT_CHANNELS)
  }
  return out
}

/** First non-empty line of a message with Markdown / HTML markup removed. */
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

/**
 * The feed's dedupe_key for a gate prompt: `<target id>:<gate kind>`, the same
 * format the edge functions' _shared/alert.ts uses, so one gate is one row. No per-instance
 * suffix: a gate that re-opens is un-acked by lume_alert_upsert (mode reopen).
 */
export function gateKey(targetId: string, kind: string): string {
  return `${targetId}:${kind}`
}

/** A Lume page for the feed row: absolute when `LUME_URL` is set, else relative. */
export function alertLink(path: string): string {
  const base = configuredBaseUrl()
  return base ? `${base}${path}` : path
}

/** What callers treat as the Telegram result when Telegram is switched off. */
export const telegramSkipped: TelegramResult = { ok: false, skipped: true }

/** Same cap as the edge helper: a hung feed write never holds the caller longer. */
export const FEED_TIMEOUT_MS = 5_000

async function insertFeed<T>(input: AlertInput<T>): Promise<void> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // An operator sign-in link is never stored in plaintext (lib/operators/mask.ts).
    const args = {
      p_source: input.source,
      p_severity: input.severity ?? 'info',
      p_title: maskKeyText(input.title || input.source),
      p_body: input.body == null ? null : maskKeyText(input.body),
      p_link: input.link == null ? null : maskKeyText(input.link),
      p_campaign_id: input.campaign_id ?? null,
      p_scope: input.scope ?? null,
      p_dedupe_key: input.dedupe_key ?? null,
      p_mode: input.mode ?? 'reopen',
    }
    const call = createServiceClient().rpc('lume_alert_upsert', args).abortSignal(controller.signal)
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve('timeout')
      }, FEED_TIMEOUT_MS)
    })
    const res = await Promise.race([call, timeout])
    if (res === 'timeout') {
      console.error(`[alerts] lume_alerts insert failed for ${input.source}:`, `timed out after ${FEED_TIMEOUT_MS} ms`)
    } else if (res.error) {
      console.error(`[alerts] lume_alerts insert failed for ${input.source}:`, res.error.message)
    }
  } catch (err) {
    console.error(`[alerts] lume_alerts insert failed for ${input.source}:`, err instanceof Error ? err.message : err)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function alert<T>(input: AlertInput<T>): Promise<T | undefined> {
  const feed = insertFeed(input)
  try {
    const channels = parseChannels(process.env.ALERT_CHANNELS)
    if (input.telegram && channels.has('telegram')) return await input.telegram()
    return undefined
  } finally {
    await feed
  }
}
