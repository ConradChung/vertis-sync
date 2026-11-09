/**
 * The lead bank grouped tag → campaign (owner, 2026-11-09), so it's clear which
 * leads rotate into which campaign. Rotation fills free Instantly slots
 * oldest-queued-first across every campaign, so each queue's place in line is
 * the order of its oldest queued lead.
 */

export interface QueueRow {
  campaign_id: string
  queued: number
  active: number
  finished: number
  oldest_queued_at: string | null
  last_pushed_at: string | null
}

export interface CampaignQueue extends QueueRow {
  name: string
  /** Instantly status label (active / paused / draft …), null when unknown. */
  status: string | null
  /** 1 = next to get free slots; null when nothing is queued. */
  place: number | null
}

export interface TagQueues {
  tag_id: string | null
  tag: string
  queued: number
  active: number
  campaigns: CampaignQueue[]
}

const n = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0)

export function groupQueues(
  rows: readonly QueueRow[],
  campaigns: ReadonlyMap<string, { name: string; status: string | null }>,
  verticals: readonly { id: string; name: string; campaign_ids: readonly string[] | null }[]
): TagQueues[] {
  const line = rows
    .filter((r) => n(r.queued) > 0 && r.oldest_queued_at)
    .sort((a, b) => Date.parse(a.oldest_queued_at!) - Date.parse(b.oldest_queued_at!))
    .map((r) => r.campaign_id)
  const tagOf = (id: string) => verticals.find((v) => (v.campaign_ids ?? []).includes(id)) ?? null
  const groups = new Map<string, TagQueues>()
  for (const r of rows) {
    const v = tagOf(r.campaign_id)
    const key = v?.id ?? 'untagged'
    const g = groups.get(key) ?? { tag_id: v?.id ?? null, tag: v?.name ?? 'Untagged', queued: 0, active: 0, campaigns: [] }
    const c = campaigns.get(r.campaign_id)
    const place = line.indexOf(r.campaign_id)
    g.campaigns.push({
      campaign_id: r.campaign_id,
      queued: n(r.queued),
      active: n(r.active),
      finished: n(r.finished),
      oldest_queued_at: r.oldest_queued_at,
      last_pushed_at: r.last_pushed_at,
      name: c?.name ?? `Campaign ${r.campaign_id.slice(0, 8)}`,
      status: c?.status ?? null,
      place: place < 0 ? null : place + 1,
    })
    g.queued += n(r.queued)
    g.active += n(r.active)
    groups.set(key, g)
  }
  const out = [...groups.values()]
  for (const g of out) g.campaigns.sort((a, b) => (a.place ?? 1e9) - (b.place ?? 1e9) || b.active - a.active || a.name.localeCompare(b.name))
  // Tags with something queued first (by their first place in line), untagged last.
  const first = (g: TagQueues) => Math.min(...g.campaigns.map((c) => c.place ?? 1e9))
  return out.sort((a, b) => (a.tag_id === null ? 1 : 0) - (b.tag_id === null ? 1 : 0) || first(a) - first(b) || a.tag.localeCompare(b.tag))
}
