// Slot allocation for instantly-rotate. Pure, so it is tested without loading index.ts.
//
// The Instantly workspace cap (ROTATE_CAP) counts every contact stored in the workspace, whatever the
// campaign, so every banked campaign shares it. Free slots go to the oldest queued lead_bank rows first
// (bigserial id = insertion order), across campaigns, each lead into its own campaign_id.

export interface QueuedRef {
  id: number
  campaign_id: string
}

export interface Allocation<T extends QueuedRef> {
  /** Slots this run may fill: min(maxPush, cap - inWorkspace), never below 0. */
  free: number
  /** The queued rows to push, oldest first. */
  picked: T[]
  /** How many of `picked` go to each campaign. */
  perCampaign: Record<string, number>
}

/** Free slots under the shared cap, bounded by the per-run maximum. */
export function freeSlots(cap: number, inWorkspace: number, maxPush: number): number {
  return Math.max(0, Math.min(maxPush, cap - inWorkspace))
}

/**
 * Pick the queued rows to push this run. `queued` may come from any number of campaigns, in any order;
 * rows of campaigns in `exclude` (tripped this run) are skipped.
 */
export function allocate<T extends QueuedRef>(
  opts: { cap: number; inWorkspace: number; maxPush: number; queued: T[]; exclude?: ReadonlySet<string> },
): Allocation<T> {
  const free = freeSlots(opts.cap, opts.inWorkspace, opts.maxPush)
  const picked = opts.queued
    .filter((q) => !opts.exclude?.has(q.campaign_id))
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id))
    .slice(0, free)
  const perCampaign: Record<string, number> = {}
  for (const q of picked) perCampaign[q.campaign_id] = (perCampaign[q.campaign_id] ?? 0) + 1
  return { free, picked, perCampaign }
}

/** The campaigns a run serves: ROTATE_CAMPAIGN_ID first (always), then every other banked campaign once. */
export function rotationCampaigns(primary: string, banked: readonly string[]): string[] {
  const out = [primary]
  for (const c of banked) if (c && !out.includes(c)) out.push(c)
  return out
}
