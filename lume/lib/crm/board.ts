import 'server-only'
import { isInstantlyConfigured, listCampaigns } from '@/lib/adapters/instantly'
import { getCampaigns } from '@/lib/db/service'
import { countByDay } from '@/lib/overview/compute'
import { lastNOwnerDates, ownerDate, ownerDayStart } from '@/lib/time/owner'
import {
  getAwaitingCloses,
  getDeals,
  getFollowupIds,
  getReplySnippets,
  getReplyStamps,
  getStages,
  withSnippets,
} from '@/lib/crm/service'
import type { CrmBoardResponse, CrmCampaignRef } from '@/lib/crm/types'

const DAYS = 14

/**
 * Campaign id → name: `lume_campaigns` (external_id), then Instantly's
 * (cached) list when configured, else the id. Never throws for Instantly.
 */
export async function campaignNames(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  try {
    for (const c of await getCampaigns()) if (c.external_id) out.set(c.external_id, c.name)
  } catch (err) {
    console.error('[crm] lume_campaigns read failed:', err instanceof Error ? err.message : err)
  }
  if (isInstantlyConfigured() && ids.some((id) => !out.has(id))) {
    try {
      for (const c of await listCampaigns()) if (!out.has(c.id)) out.set(c.id, c.name)
    } catch (err) {
      console.error('[crm] Instantly campaign list failed:', err instanceof Error ? err.message : err)
    }
  }
  return out
}

export async function buildBoard(campaign: string | 'all', now: Date = new Date()): Promise<CrmBoardResponse> {
  const days = lastNOwnerDates(now, DAYS)
  const since = ownerDayStart(days[0]).toISOString()

  const [stages, deals, followupIds, awaiting] = await Promise.all([
    getStages(campaign === 'all' ? null : campaign),
    getDeals(campaign),
    getFollowupIds(campaign),
    getAwaitingCloses(),
  ])
  const ids = deals.map((d) => d.id)
  const [snippets, stamps] = await Promise.all([
    getReplySnippets(ids),
    getReplyStamps(campaign === 'all' ? 'all' : ids, since),
  ])
  const cards = withSnippets(deals, snippets)
  const byId = new Map(cards.map((d) => [d.id, d]))
  const followups = followupIds.map((id) => byId.get(id)).filter((d): d is NonNullable<typeof d> => !!d)
  const today = ownerDate(now)
  const dueToday = cards.filter(
    (d) => d.next_action_at && Date.parse(d.next_action_at) > now.getTime() && ownerDate(d.next_action_at) === today
  ).length

  const campaignIds = [...new Set([...deals.map((d) => d.campaign_id), ...(campaign === 'all' ? [] : [campaign])])]
  const names = await campaignNames(campaignIds)
  // The switcher lists every campaign that has deals, plus every known Instantly campaign.
  const known = new Set(campaignIds)
  for (const id of names.keys()) known.add(id)
  const campaigns: CrmCampaignRef[] = [...known]
    .map((id) => ({ id, name: names.get(id) ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const awaitingHere: Record<string, string> = {}
  for (const id of ids) if (awaiting[id]) awaitingHere[id] = awaiting[id]

  return {
    campaign,
    stages,
    deals: cards,
    followups,
    due_today: dueToday,
    days,
    replies_14d: countByDay(stamps.map((s) => ({ created_at: s })), days, (t) => ownerDate(t)),
    awaiting_close: awaitingHere,
    campaigns,
    owners: [...new Set(deals.map((d) => d.owner).filter((o): o is string => !!o))].sort(),
  }
}
