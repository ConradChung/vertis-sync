import { z } from 'zod'
import type { Json } from '@/lib/db/types'

/**
 * Cycle-out rules (`rotation_rules.kind = 'cycle_out'`): on their cron, ask to
 * remove the campaign's leads whose sequence finished at least `after_days`
 * ago with no reply (never replied, interested or bounced ones), then, with
 * `refill_to`, ask to top the campaign back up to that many leads from the
 * lead bank (the rotation's own assign_leads mechanism). Pure.
 */

export const DEFAULT_AFTER_DAYS = 14
export const DEFAULT_CYCLE_CRON = '0 7 * * *'
/** A cycle_out rule's daily_cap: the most leads removed per run. */
export const DEFAULT_CYCLE_MAX = 1000

export const cycleParamsSchema = z.strictObject({
  after_days: z.number().int().min(1).max(365).default(DEFAULT_AFTER_DAYS),
  refill_to: z.number().int().min(1).max(100_000).optional(),
})

export type CycleParams = z.infer<typeof cycleParamsSchema>

/** Stored params → clean params, or null when they no longer parse. */
export function parseCycleParams(raw: unknown): CycleParams | null {
  const r = cycleParamsSchema.safeParse(raw ?? {})
  return r.success ? r.data : null
}

export function cycleParamsJson(p: CycleParams): Record<string, Json> {
  return { after_days: p.after_days, ...(p.refill_to ? { refill_to: p.refill_to } : {}) }
}

/**
 * How many lead-bank leads to assign so the campaign is back at `refillTo`:
 * leads still in Instantly after the removal plus those already queued for it
 * count toward the target; never more than are available.
 */
export function refillCount(input: { refillTo: number; inCampaign: number; queued: number; available: number }): number {
  const gap = input.refillTo - Math.max(0, input.inCampaign) - Math.max(0, input.queued)
  return Math.max(0, Math.min(gap, input.available))
}

export function describeCycle(p: CycleParams): string {
  return (
    `remove leads whose sequence finished ${p.after_days}+ days ago with no reply` +
    (p.refill_to ? `, then refill to ${new Intl.NumberFormat('en-US').format(p.refill_to)} leads from the lead bank` : '')
  )
}
