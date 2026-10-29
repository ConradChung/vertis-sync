import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Webhook push to a vertical's Grok routine (inbox manager 3f). Pure: the
 * payload, its summary, the HMAC-SHA256 signature and the URL check.
 *
 * The payload is a doorbell, not data: `{ type, vertical, item_id, summary,
 * link }`. The summary holds a lead's name and company at most (never an
 * address, a message or a secret). A routine treats a push as "go check
 * /operator" and reads everything from Lume itself.
 *
 * Signature: `X-Lume-Signature: sha256=<hex HMAC-SHA256(secret,
 * "<X-Lume-Timestamp>.<raw body>")>`, with `X-Lume-Timestamp` in unix
 * seconds. docs/lume/INBOX-MANAGER-SETUP.md shows how to verify it.
 */

export const PUSH_TYPES = ['positive_reply', 'needs_confirmation', 'draft_awaiting', 'test'] as const
export type PushType = (typeof PUSH_TYPES)[number]

export interface PushPayload {
  type: PushType
  vertical: string
  item_id: string
  summary: string
  link: string
}

export function buildPush(p: PushPayload): PushPayload {
  return { type: p.type, vertical: p.vertical, item_id: p.item_id, summary: p.summary, link: p.link }
}

const SUMMARY_MAX = 300
const FIELD_MAX = 80

/** A name / company with anything address-like removed. */
function clean(v: string | null | undefined): string | null {
  if (!v) return null
  const s = v
    .replace(/<[^>]*>/g, ' ')
    .replace(/\S*@\S*/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return s ? s.slice(0, FIELD_MAX) : null
}

export function pushSummary(type: PushType, f: { name?: string | null; company?: string | null; kind?: string | null }): string {
  const name = clean(f.name)
  const company = clean(f.company)
  const who = name ? `${name}${company ? ` (${company})` : ''}` : company ? `a lead at ${company}` : 'a lead'
  let text: string
  if (type === 'positive_reply') text = `New positive reply from ${who}. Check /operator.`
  else if (type === 'draft_awaiting') text = `A reply draft awaits approval for ${who}. Check /operator.`
  else if (type === 'needs_confirmation') text = `New item needs confirmation: ${(clean(f.kind) ?? 'an item').replace(/_/g, ' ')}. Check /operator.`
  else text = 'Test push from Lume. Nothing to do; a real push means: check /operator.'
  return text.slice(0, SUMMARY_MAX)
}

export function signBody(secret: string, body: string, timestamp: number): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

export function signatureHeaders(secret: string, body: string, type: PushType, timestamp: number, deliveryId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'User-Agent': 'Lume-Webhook/1',
    'X-Lume-Event': type,
    'X-Lume-Delivery': deliveryId,
    'X-Lume-Timestamp': String(timestamp),
    'X-Lume-Signature': `sha256=${signBody(secret, body, timestamp)}`,
  }
}

/** Receiver side (documented; used by tests): a valid signature within `toleranceS` of now. */
export function verifySignature(secret: string, body: string, timestamp: string, signature: string, nowS = Math.floor(Date.now() / 1000), toleranceS = 300): boolean {
  const ts = Number(timestamp)
  if (!Number.isInteger(ts) || Math.abs(nowS - ts) > toleranceS) return false
  const m = /^sha256=([0-9a-f]{64})$/.exec(signature)
  if (!m) return false
  const a = Buffer.from(m[1], 'hex')
  const b = Buffer.from(signBody(secret, body, ts), 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

export type WebhookUrlError = 'invalid_url' | 'https_only' | 'no_credentials' | 'private_host'

/** Public https only: no credentials, no localhost / private / link-local / IP-literal hosts. */
export function checkWebhookUrl(raw: string): WebhookUrlError | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'invalid_url'
  }
  if (u.protocol !== 'https:') return 'https_only'
  if (u.username || u.password) return 'no_credentials'
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || /\.(localhost|local|internal|lan|home|corp)$/.test(host)) return 'private_host'
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return 'private_host'
  return null
}

export function maskSecret(secret: string): string {
  return `••••${secret.slice(-4)}`
}
