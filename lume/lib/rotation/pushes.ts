import { z } from 'zod'
import type { Json } from '@/lib/db/types'
import { CAMPAIGN_ID_RE } from '@/lib/rules/schema'

/**
 * Rotate → Pushes (pure, client-safe): each push's lead bank queue, per
 * source list and campaign. Stop is direct (it can only stop sending);
 * restart and move are a `bank_queue` pending action that waits for a tap.
 * Only leads never pushed to Instantly change.
 */

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** `lume_lead_bank_pushes()` row. */
export interface PushRow {
  source_job_id: string | null
  job_name: string | null
  filename: string | null
  campaign_id: string
  queued: number
  stopped: number
  active: number
  finished: number
  first_banked_at: string | null
  last_pushed_at: string | null
  /** Why the stopped leads were stopped, biggest first (`lead_bank.stop_reason`). */
  stop_reasons?: StopReason[] | null
}

/** One stop reason on a push x campaign: how many leads, and when they were last stopped for it. */
export interface StopReason {
  reason: string
  count: number
  at: string | null
}

export interface PushCampaign extends PushRow {
  stop_reasons: StopReason[]
  campaign_name: string
  campaign_status: string | null
}

export interface PushGroup {
  /** `source_job_id`, or 'none' for leads banked before pushes were tracked. */
  key: string
  source_job_id: string | null
  name: string
  first_banked_at: string | null
  queued: number
  stopped: number
  active: number
  finished: number
  campaigns: PushCampaign[]
}

export const NO_SOURCE_NAME = 'Earlier leads (no source list)'

/** One awaiting restart / move per push and campaign (pending_actions_one_awaiting_bank_queue_idx). */
export const BANK_QUEUE_KEY = 'push_key'
export const pushKey = (jobId: string | null, campaignId: string) => `${jobId ?? 'none'}:${campaignId}`

const n = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0)

/** Rows → one group per source list, newest first; the no-source group last; campaigns by queued desc. */
export function groupPushes(rows: readonly PushRow[], names: ReadonlyMap<string, { name: string; status: string | null }>): PushGroup[] {
  const groups = new Map<string, PushGroup>()
  for (const r of rows) {
    const key = r.source_job_id ?? 'none'
    const g =
      groups.get(key) ??
      ({ key, source_job_id: r.source_job_id, name: r.source_job_id ? (r.job_name ?? r.filename ?? r.source_job_id) : NO_SOURCE_NAME, first_banked_at: null, queued: 0, stopped: 0, active: 0, finished: 0, campaigns: [] } as PushGroup)
    const c: PushCampaign = {
      ...r,
      queued: n(r.queued),
      stopped: n(r.stopped),
      active: n(r.active),
      finished: n(r.finished),
      stop_reasons: (Array.isArray(r.stop_reasons) ? r.stop_reasons : [])
        .filter((x) => x && typeof x.reason === 'string')
        .map((x) => ({ reason: x.reason, count: n(x.count), at: typeof x.at === 'string' ? x.at : null })),
      campaign_name: names.get(r.campaign_id)?.name ?? r.campaign_id,
      campaign_status: names.get(r.campaign_id)?.status ?? null,
    }
    g.campaigns.push(c)
    g.queued += c.queued
    g.stopped += c.stopped
    g.active += c.active
    g.finished += c.finished
    if (r.first_banked_at && (!g.first_banked_at || r.first_banked_at < g.first_banked_at)) g.first_banked_at = r.first_banked_at
    groups.set(key, g)
  }
  for (const g of groups.values()) g.campaigns.sort((a, b) => b.queued - a.queued || b.stopped - a.stopped || a.campaign_name.localeCompare(b.campaign_name))
  return [...groups.values()].sort((a, b) => {
    if (!a.source_job_id !== !b.source_job_id) return a.source_job_id ? -1 : 1
    return (b.first_banked_at ?? '').localeCompare(a.first_banked_at ?? '')
  })
}

const JobId = z.string().regex(LOWER_UUID).nullable()
const CampaignId = z.string().regex(CAMPAIGN_ID_RE)

/** Quick picks for why a queue is stopped (the owner can also type their own). */
export const STOP_REASONS = ['Not a property manager', 'Wrong region', 'Bad or old data', 'Pausing for now'] as const
export const STOP_REASON_MAX = 200

/** `POST /api/rotation/pushes`: stop one push's queue for one campaign (direct), with a short reason. */
export const StopBody = z.strictObject({ source_job_id: JobId, campaign_id: CampaignId, reason: z.string().trim().max(STOP_REASON_MAX).optional() })

/** `bank_queue` request: restart the stopped leads, or move the queued ones to another campaign. */
export const BankQueueBody = z
  .strictObject({ op: z.enum(['restart', 'move']), source_job_id: JobId, campaign_id: CampaignId, to_campaign_id: CampaignId.optional() })
  .refine((b) => b.op !== 'move' || (!!b.to_campaign_id && b.to_campaign_id !== b.campaign_id), 'move needs a different to_campaign_id')

/** What createAction checks on every bank_queue row. */
export function bankQueuePayloadError(p: Record<string, Json>): string | null {
  if (p.op !== 'restart' && p.op !== 'move') return 'payload.op must be restart or move'
  if (p.source_job_id !== null && (typeof p.source_job_id !== 'string' || !LOWER_UUID.test(p.source_job_id))) return 'payload.source_job_id must be a lowercase uuid or null'
  if (typeof p.campaign_id !== 'string' || !CAMPAIGN_ID_RE.test(p.campaign_id)) return 'payload.campaign_id is required'
  if (p.op === 'move' && (typeof p.to_campaign_id !== 'string' || !CAMPAIGN_ID_RE.test(p.to_campaign_id) || p.to_campaign_id === p.campaign_id)) return 'payload.to_campaign_id must be another campaign'
  if (p[BANK_QUEUE_KEY] !== pushKey(p.source_job_id as string | null, p.campaign_id)) return 'payload.push_key does not match'
  if (typeof p.count !== 'number' || p.count < 1) return 'payload.count must be at least 1'
  return null
}
