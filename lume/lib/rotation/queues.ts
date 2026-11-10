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

/**
 * Why queued leads aren't reaching Instantly, in plain words, for the agent and
 * the Rotate page. Rotation fills free slots oldest-queued-first whatever the
 * campaign's status, so a paused campaign ahead in line takes freed slots too.
 */
export function bankBlockers(tags: readonly TagQueues[], inInstantly: number | null, cap: number): string[] {
  const out: string[] = []
  const all = tags.flatMap((t) => t.campaigns)
  const queued = all.filter((c) => c.queued > 0).sort((a, b) => (a.place ?? 1e9) - (b.place ?? 1e9))
  if (!queued.length) return out
  if (inInstantly !== null && inInstantly >= cap) {
    out.push(`Instantly is full (${inInstantly.toLocaleString('en-US')}/${cap.toLocaleString('en-US')} contacts), so rotation can't move any queued leads until slots are freed (remove_leads frees them 5-10 minutes later).`)
  }
  for (const c of all) {
    if (c.active > 0 && c.status && c.status !== 'active') {
      out.push(`"${c.name}" is ${c.status} but holds ${c.active.toLocaleString('en-US')} slots in Instantly; those leads aren't being emailed.`)
    }
  }
  const ahead = queued.filter((c) => c.status === 'paused')
  for (const p of ahead) {
    const behind = queued.filter((c) => (c.place ?? 0) > (p.place ?? 0)).map((c) => `"${c.name}"`)
    if (behind.length) {
      out.push(`"${p.name}" is paused but is #${p.place} in line with ${p.queued.toLocaleString('en-US')} queued: freed slots go to it before ${behind.join(', ')}.`)
    }
  }
  for (const c of queued) {
    if (c.status === 'draft') out.push(`"${c.name}" is a draft: its leads can rotate in, but nothing sends until it is launched.`)
  }
  return out
}
