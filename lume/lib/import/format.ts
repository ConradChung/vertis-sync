import type { OrderKind, OrderRow } from '@/lib/db/types'

/** Display helpers for orders. Pure. */

const SOURCE_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  slack: 'Slack',
  lume: 'Lume',
  apollo_link: 'Apollo link',
  leadsfriday: 'Job scrape',
  csv: 'Dashboard CSV',
  apify: 'Dashboard Apify',
  hnwi: 'HNWI',
}

export function sourceLabel(source: string | null): string {
  if (!source) return '—'
  return SOURCE_LABEL[source] ?? source
}

export const KIND_LABEL: Record<OrderKind, string> = {
  ingest: 'CSV intake',
  apollo_order: 'Apollo order',
  job_batch: 'Job scrape batch',
  dashboard_job: 'Dashboard job',
}

export type StatusTone = 'wait' | 'run' | 'ok' | 'bad' | 'idle'

const WAIT = /^awaiting|^waiting/
const OK = new Set(['approved', 'ingested', 'delivered', 'completed', 'complete', 'done', 'written', 'ranked', 'pushed', 'merged'])
const BAD = new Set(['rejected', 'failed', 'error', 'cancelled', 'denied'])
const IDLE = new Set(['skipped', 'discarded'])

export function statusTone(status: string | null): StatusTone {
  if (!status) return 'idle'
  if (WAIT.test(status)) return 'wait'
  if (OK.has(status)) return 'ok'
  if (BAD.has(status)) return 'bad'
  if (IDLE.has(status)) return 'idle'
  return 'run'
}

export function statusLabel(status: string | null): string {
  return status ? status.replace(/_/g, ' ') : '—'
}

const fmt = new Intl.NumberFormat('en-US')

/**
 * `lume_orders.cost_usd` holds Leadsfriday credits for Apollo orders
 * (`credits_deducted`); nothing else has a cost yet.
 */
export function costLabel(o: Pick<OrderRow, 'kind' | 'cost_usd'>): string {
  if (o.cost_usd === null || o.cost_usd === undefined) return '—'
  return o.kind === 'apollo_order' ? `${fmt.format(Number(o.cost_usd))} cr` : `$${Number(o.cost_usd).toFixed(2)}`
}

export function ago(iso: string, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const h = Math.round(mins / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/** Apollo links are long; show the host + a short tail. */
export function summaryLabel(o: Pick<OrderRow, 'kind' | 'summary'>): string {
  const s = o.summary ?? '—'
  if (o.kind === 'apollo_order' && s.startsWith('https://app.apollo.io/')) return 'Apollo people search'
  return s
}
