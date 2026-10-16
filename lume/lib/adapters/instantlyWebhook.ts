import { createHash } from 'node:crypto'
import type { EventInsert, Json } from '@/lib/db/types'

/**
 * Pure mapping of an Instantly webhook body onto an `events` insert.
 *
 * `event_type` reply_received | lead_interested | email_bounced | email_sent
 * → `reply | interested | bounce | sent`; anything else is kept as
 * `instantly.<event_type>`. `webhook_id` is `<event_type>:<event id>[:<timestamp>]`
 * when the payload carries an id, else a SHA-256 of the canonical body, so a retried delivery
 * of the same body dedupes on the unique `events_webhook_id_idx`.
 */

export const MAX_STRING = 2048

/**
 * Instantly bodies are a few KB; anything this big is not a webhook. Lives
 * here, not in the route: a route module may only export handlers and
 * route-segment config (`next build` rejects any other export).
 */
export const WEBHOOK_MAX_BODY_BYTES = 128 * 1024

const TYPE_MAP: Record<string, string> = {
  reply_received: 'reply',
  lead_interested: 'interested',
  email_bounced: 'bounce',
  email_sent: 'sent',
}

const ID_KEYS = ['event_id', 'webhook_event_id', 'id', 'email_id', 'message_id'] as const

type Body = Record<string, unknown>

const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' ? String(v) : null)

export function eventTypeFor(eventType: string | null): string {
  if (!eventType) return 'instantly.unknown'
  return TYPE_MAP[eventType] ?? `instantly.${eventType}`
}

/** Stable JSON (sorted keys) so the same body always hashes the same. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

export function webhookIdFor(body: Body): string {
  // The event type is part of the key: `email_id` can be shared by the
  // `email_sent` and a later `email_bounced` for the same message.
  // `timestamp`, when present, separates two genuine deliveries that share
  // an id (e.g. a second reply in the same thread reusing a message id).
  const type = s(body.event_type) ?? 'unknown'
  const ts = s(body.timestamp)
  for (const k of ID_KEYS) {
    const v = s(body[k])
    if (v) return `instantly:${type}:${v}${ts ? `:${ts}` : ''}`
  }
  return `instantly:sha256:${createHash('sha256').update(canonical(body)).digest('hex')}`
}

/** Strings over 2 KB are cut (with an ellipsis); nesting is bounded. */
export function truncatePayload(v: unknown, depth = 0): Json {
  if (typeof v === 'string') return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean' || v === null) return v
  if (depth >= 4) return null
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => truncatePayload(x, depth + 1))
  if (typeof v === 'object') {
    const out: Record<string, Json> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === undefined) continue
      out[k] = truncatePayload(x, depth + 1)
    }
    return out
  }
  return null
}

function titleFor(type: string, email: string | null, eventType: string | null): string {
  const who = email ?? 'unknown lead'
  switch (type) {
    case 'reply':
      return `Reply from ${who}`
    case 'interested':
      return `Interested: ${who}`
    case 'bounce':
      return `Bounce: ${who}`
    case 'sent':
      return `Sent to ${who}`
    default:
      return `Instantly ${eventType ?? 'event'}${email ? `: ${email}` : ''}`
  }
}

export function mapInstantlyWebhook(body: Body): EventInsert {
  const eventType = s(body.event_type)
  const type = eventTypeFor(eventType)
  const leadEmail = s(body.lead_email) ?? s(body.email) ?? s((body.lead as Body | undefined)?.email)
  const payload = truncatePayload(body) as Record<string, Json>
  return {
    type,
    source: 'instantly',
    source_id: s(body.email_id) ?? s(body.message_id),
    campaign_id: s(body.campaign_id) ?? s(body.campaign),
    lead_email: leadEmail ? leadEmail.toLowerCase() : null,
    title: titleFor(type, leadEmail ? leadEmail.toLowerCase() : null, eventType),
    payload,
    webhook_id: webhookIdFor(body),
  }
}
