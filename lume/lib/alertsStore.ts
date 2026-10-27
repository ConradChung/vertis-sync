import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import type { AlertScope, AlertSeverity } from '@/lib/alerts'

/**
 * Reads and acks for the durable alert feed (`lume_alerts`, Phase G4). Service
 * role: call only after the route's owner guard. Writes come from
 * `lib/alerts.ts` and the edge helper.
 */

export interface AlertRow {
  id: string
  source: string
  severity: AlertSeverity
  title: string
  body: string | null
  link: string | null
  campaign_id: string | null
  scope: AlertScope | null
  created_at: string
  acked_at: string | null
  acked_by_operator: string | null
  dedupe_key: string | null
}

export const ALERTS_DEFAULT_LIMIT = 50
export const ALERTS_MAX_LIMIT = 200

const COLS = 'id, source, severity, title, body, link, campaign_id, scope, created_at, acked_at, acked_by_operator, dedupe_key'

export async function listAlerts({ unackedOnly, limit }: { unackedOnly: boolean; limit: number }): Promise<AlertRow[]> {
  const n = Math.min(Math.max(Math.floor(limit) || ALERTS_DEFAULT_LIMIT, 1), ALERTS_MAX_LIMIT)
  let q = createServiceClient().from('lume_alerts').select(COLS)
  if (unackedOnly) q = q.is('acked_at', null)
  const res = await q.order('created_at', { ascending: false }).limit(n)
  if (res.error) throw new DbError('listAlerts', res.error)
  return (res.data ?? []) as AlertRow[]
}

export type AckTarget = { ids: string[]; all?: undefined } | { all: true; ids?: undefined }

/**
 * Acknowledge unacked alerts: the given ids, or every unacked one. Already
 * acked rows are left as they were (first ack wins). `operatorId` records the
 * Grok Bot that acked; null for the owner. Returns the ids acked by this call.
 */
export async function ackAlerts(target: AckTarget, operatorId: string | null): Promise<string[]> {
  if (!target.all && target.ids.length === 0) return []
  let q = createServiceClient()
    .from('lume_alerts')
    .update({ acked_at: new Date().toISOString(), acked_by_operator: operatorId })
    .is('acked_at', null)
  if (!target.all) q = q.in('id', target.ids)
  const res = await q.select('id')
  if (res.error) throw new DbError('ackAlerts', res.error)
  return ((res.data ?? []) as { id: string }[]).map((r) => r.id)
}
