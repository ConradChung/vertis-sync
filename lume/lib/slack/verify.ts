import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Slack request signing (https://api.slack.com/authentication/verifying-requests-from-slack):
 * `v0=` + hex HMAC-SHA256 of `v0:<X-Slack-Request-Timestamp>:<raw body>` with
 * the app's signing secret. Over the RAW body (never a re-serialised one),
 * compared in constant time, with a 5-minute window either way against
 * replays. A missing secret fails closed. Pure.
 */

export const SLACK_MAX_SKEW_S = 300

export type SlackVerify = { ok: true } | { ok: false; reason: 'not_configured' | 'missing_headers' | 'stale' | 'bad_signature' }

export function verifySlackSignature(
  rawBody: string,
  headers: { timestamp: string | null; signature: string | null },
  secret: string | null | undefined,
  nowS: number = Math.floor(Date.now() / 1000)
): SlackVerify {
  if (!secret) return { ok: false, reason: 'not_configured' }
  const { timestamp, signature } = headers
  if (!timestamp || !signature) return { ok: false, reason: 'missing_headers' }
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(nowS - Number(timestamp)) > SLACK_MAX_SKEW_S) return { ok: false, reason: 'stale' }
  if (!/^v0=[0-9a-f]{64}$/.test(signature)) return { ok: false, reason: 'bad_signature' }
  const expected = createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest()
  const presented = Buffer.from(signature.slice(3), 'hex')
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return { ok: false, reason: 'bad_signature' }
  return { ok: true }
}

/** The two signing headers of a request. */
export function slackHeaders(req: Request): { timestamp: string | null; signature: string | null } {
  return { timestamp: req.headers.get('x-slack-request-timestamp'), signature: req.headers.get('x-slack-signature') }
}
