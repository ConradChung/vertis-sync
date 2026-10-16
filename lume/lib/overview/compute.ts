import type { CampaignHealth } from '@/lib/overview/types'

/**
 * Pure rules behind the Overview. No I/O; unit-tested.
 */

export const BOUNCE_RED_THRESHOLD = 5
export const REPLY_RATE_AMBER_BELOW = 1 // percent

const pct = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)}%`

/**
 * Health dot for one campaign: red when it has ≥ 5 `bounce` events in the
 * last 24 h, amber when its reply rate is under 1 %, otherwise green. With no
 * reply rate (nothing sent, or not an Instantly campaign) and few bounces it
 * is `idle`.
 */
export function campaignHealth({
  bounces24h,
  replyRate,
  idleReason = 'No sends yet',
}: {
  bounces24h: number
  replyRate: number | null
  idleReason?: string
}): CampaignHealth {
  if (bounces24h >= BOUNCE_RED_THRESHOLD) {
    return { level: 'red', reason: `${bounces24h} bounces in the last 24 h — check the sending inboxes` }
  }
  if (replyRate === null || !Number.isFinite(replyRate)) return { level: 'idle', reason: idleReason }
  if (replyRate < REPLY_RATE_AMBER_BELOW) {
    return { level: 'amber', reason: `Reply rate ${pct(replyRate)} is under ${REPLY_RATE_AMBER_BELOW}%` }
  }
  const b = bounces24h === 1 ? '1 bounce' : `${bounces24h} bounces`
  return { level: 'green', reason: `Reply rate ${pct(replyRate)} · ${b} in 24 h` }
}

const utcDate = (t: number) => new Date(t).toISOString().slice(0, 10)

/**
 * Count rows per calendar date over `dates` (YYYY-MM-DD, ascending). `dayOf`
 * picks the zone; the Overview passes `ownerDate` (America/Los_Angeles).
 */
export function countByDay(
  rows: { created_at: string }[],
  dates: string[],
  dayOf: (t: number) => string = utcDate
): number[] {
  const idx = new Map(dates.map((d, i) => [d, i]))
  const out = dates.map(() => 0)
  for (const r of rows) {
    // created_at can carry any offset; parse to an instant first.
    const t = Date.parse(r.created_at)
    if (!Number.isFinite(t)) continue
    const j = idx.get(dayOf(t))
    if (j !== undefined) out[j]++
  }
  return out
}

/** Count rows per campaign id (rows without one are ignored). */
export function countByCampaign(rows: { campaign_id: string | null }[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rows) if (r.campaign_id) m.set(r.campaign_id, (m.get(r.campaign_id) ?? 0) + 1)
  return m
}

/** "now", "42s ago", "5m ago", "3h ago", "2d ago". */
export function timeAgo(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 10) return 'now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** "in 8m 42s", "in 1h 18m", "in 2d 3h", "due". */
export function countdown(iso: string | null, now: number): string {
  if (!iso) return '—'
  const s = Math.floor((Date.parse(iso) - now) / 1000)
  if (s <= 0) return 'due'
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return `in ${d}d ${h}h`
  if (h > 0) return `in ${h}h ${m}m`
  if (m > 0) return `in ${m}m ${String(sec).padStart(2, '0')}s`
  return `in ${sec}s`
}

/**
 * Inbox health for one sending account: red when the account errors or
 * warmup is banned/suspended, amber when warmup is paused or the score is
 * under 80, green when active and warm.
 */
export function accountHealth(a: {
  status: string
  warmup_status: string
  warmup_score: number | null
}): CampaignHealth {
  const errored = ['connection_error', 'soft_bounce_error', 'sending_error'].includes(a.status)
  if (errored) return { level: 'red', reason: a.status.replace(/_/g, ' ') }
  if (['banned', 'permanent_suspension', 'spam_folder_unknown'].includes(a.warmup_status)) {
    return { level: 'red', reason: `warmup ${a.warmup_status.replace(/_/g, ' ')}` }
  }
  if (a.status === 'paused') return { level: 'amber', reason: 'account paused' }
  if (a.warmup_status !== 'active') return { level: 'amber', reason: `warmup ${a.warmup_status.replace(/_/g, ' ')}` }
  if (a.warmup_score !== null && a.warmup_score < 80) return { level: 'amber', reason: `warmup at ${a.warmup_score}%` }
  return { level: 'green', reason: a.warmup_score !== null ? `warm (${a.warmup_score}%)` : 'active' }
}
