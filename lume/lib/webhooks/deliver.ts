import 'server-only'
import { randomUUID } from 'node:crypto'
import { after } from 'next/server'
import { alert, alertLink } from '@/lib/alerts'
import { hasLiveMaster, verticalFor, type RouteItem } from '@/lib/operators/route'
import { listOperators, listVerticals } from '@/lib/operators/store'
import { getWebhook, recordDelivery } from '@/lib/webhooks/store'
import { buildPush, signatureHeaders, type PushPayload } from '@/lib/webhooks/push'

/**
 * Webhook push delivery (inbox manager 3f). Lume POSTs a small signed JSON
 * doorbell to the vertical's Grok routine when a positive reply, a new
 * Needs-confirmation item or a draft awaiting approval routes to it.
 *
 *  - `pushForItem` never blocks the caller: it schedules the work with
 *    `after()` (outside a request scope it starts unawaited) and swallows
 *    every error.
 *  - Each attempt has a 5 s timeout; one retry on a timeout, a network error,
 *    a 429 or a 5xx; never on another 4xx. Redirects are not followed.
 *  - A failed delivery is a warn in the feed (owner only) and is recorded on
 *    the webhook row for Settings. The secret is never logged.
 *  - An item no vertical owns (owner / master only) is not pushed; the
 *    /operator poll stays the backstop for everything.
 */

export const PUSH_TIMEOUT_MS = 5_000

export interface DeliverOptions {
  fetch?: typeof fetch
  timeoutMs?: number
  retryDelayMs?: number
}

export interface DeliverResult {
  ok: boolean
  status?: number
  error?: string
  attempts: number
}

export async function deliver(hook: { url: string; secret: string }, payload: PushPayload, opts: DeliverOptions = {}): Promise<DeliverResult> {
  const doFetch = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? PUSH_TIMEOUT_MS
  const body = JSON.stringify(buildPush(payload))
  const deliveryId = randomUUID()
  let last: DeliverResult = { ok: false, attempts: 0, error: 'not sent' }
  for (let attempt = 1; attempt <= 2; attempt++) {
    const headers = signatureHeaders(hook.secret, body, payload.type, Math.floor(Date.now() / 1000), deliveryId)
    try {
      const res = await doFetch(hook.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual', cache: 'no-store' })
      if (res.ok) return { ok: true, status: res.status, attempts: attempt }
      last = { ok: false, status: res.status, error: `HTTP ${res.status}`, attempts: attempt }
      if (res.status < 500 && res.status !== 429) return last
    } catch (err) {
      const name = err instanceof Error ? err.name : ''
      last = { ok: false, attempts: attempt, error: name === 'TimeoutError' || name === 'AbortError' ? `timed out after ${timeoutMs} ms` : 'network error' }
    }
    if (attempt === 1 && (opts.retryDelayMs ?? 500) > 0) await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 500))
  }
  return last
}

export type SendPushResult = DeliverResult | { ok: false; skipped: 'no_webhook' }

/** Deliver to one vertical's webhook now (the Settings "Send test" awaits this). */
export async function sendPush(verticalId: string, payload: PushPayload, opts: DeliverOptions = {}): Promise<SendPushResult> {
  const hook = await getWebhook(verticalId)
  if (!hook) return { ok: false, skipped: 'no_webhook' }
  const out = await deliver(hook, payload, opts)
  await recordDelivery(verticalId, out.ok, out.ok ? null : (out.error ?? 'failed'))
  if (!out.ok) {
    const host = (() => {
      try {
        return new URL(hook.url).host
      } catch {
        return 'the webhook'
      }
    })()
    const title = `Webhook push to ${payload.vertical} failed (${out.error ?? 'failed'})`
    try {
      await alert({
        source: 'lume.webhooks',
        severity: 'warn',
        title,
        body: `${title}\nEvent ${payload.type} for item ${payload.item_id} could not be delivered to ${host} after ${out.attempts} attempt${out.attempts === 1 ? '' : 's'}. The bot will still see it on its /operator poll.`,
        link: alertLink('/settings/verticals'),
        owner_only: true,
      })
    } catch (err) {
      console.error('[webhooks] failure alert failed:', err instanceof Error ? err.message : err)
    }
  }
  return out
}

/** Push to the vertical this item routes to, after the response. Never throws, never blocks. */
export function pushForItem(item: RouteItem, payload: Omit<PushPayload, 'vertical'>, opts: DeliverOptions = {}): void {
  if (item.owner_only) return
  const job = async () => {
    try {
      const [verticals, operators] = await Promise.all([listVerticals(), listOperators({ includeRevoked: false })])
      const v = verticalFor(item, verticals, { masterLive: hasLiveMaster(operators) })
      if (!v) return
      await sendPush(v.id, { ...payload, vertical: v.name }, opts)
    } catch (err) {
      console.error('[webhooks] push failed:', err instanceof Error ? err.message : err)
    }
  }
  try {
    after(job)
  } catch {
    void job()
  }
}
