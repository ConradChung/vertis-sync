import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import { maskSecret } from '@/lib/webhooks/push'

/**
 * `lume_vertical_webhooks` (migration lume_reply_modes_webhooks): one
 * optional outbound webhook per vertical. The secret is read only here, for
 * signing; every API answer uses `WebhookView` (masked).
 */

export interface WebhookRow {
  vertical_id: string
  url: string
  secret: string
  updated_at: string
  last_delivery_at: string | null
  last_delivery_ok: boolean | null
  last_error: string | null
}

export type WebhookView = Omit<WebhookRow, 'secret'> & { secret_masked: string }

const COLS = 'vertical_id, url, secret, updated_at, last_delivery_at, last_delivery_ok, last_error'

export const toView = ({ secret, ...rest }: WebhookRow): WebhookView => ({ ...rest, secret_masked: maskSecret(secret) })

export async function getWebhook(verticalId: string): Promise<WebhookRow | null> {
  const res = await createServiceClient().from('lume_vertical_webhooks').select(COLS).eq('vertical_id', verticalId).maybeSingle()
  if (res.error) throw new DbError('getWebhook', res.error)
  return (res.data as WebhookRow | null) ?? null
}

export async function setWebhook(verticalId: string, url: string, secret: string): Promise<WebhookRow> {
  const res = await createServiceClient()
    .from('lume_vertical_webhooks')
    .upsert({ vertical_id: verticalId, url, secret, updated_at: new Date().toISOString(), last_delivery_at: null, last_delivery_ok: null, last_error: null }, { onConflict: 'vertical_id' })
    .select(COLS)
    .single()
  if (res.error || !res.data) throw new DbError('setWebhook', res.error ?? new Error('no data'))
  return res.data as WebhookRow
}

export async function deleteWebhook(verticalId: string): Promise<boolean> {
  const res = await createServiceClient().from('lume_vertical_webhooks').delete().eq('vertical_id', verticalId).select('vertical_id')
  if (res.error) throw new DbError('deleteWebhook', res.error)
  return (res.data ?? []).length > 0
}

/** Best effort: the delivery outcome for Settings. Never throws. */
export async function recordDelivery(verticalId: string, ok: boolean, error: string | null): Promise<void> {
  try {
    const res = await createServiceClient()
      .from('lume_vertical_webhooks')
      .update({ last_delivery_at: new Date().toISOString(), last_delivery_ok: ok, last_error: error ? error.slice(0, 300) : null })
      .eq('vertical_id', verticalId)
    if (res.error) console.error('[webhooks] recordDelivery failed:', res.error.message)
  } catch (err) {
    console.error('[webhooks] recordDelivery failed:', err instanceof Error ? err.message : err)
  }
}
