/**
 * Campaign by name for a validation job at `awaiting_campaign`: Lume's twin of
 * telegram-inbox's `handleCampaignNameReply`. Instantly's `?search=` there is
 * a case-insensitive "name contains"; here the same match runs over the
 * (cached) campaign list. Same resolution rules:
 *  - no match → none;
 *  - exactly one exact (case-insensitive, trimmed) name match wins outright,
 *    even when it shares a prefix with others ("Scaleport - R3" next to
 *    "Scaleport - Managers");
 *  - else exactly one match resolves;
 *  - else several: the first 8, for the owner (or bot) to pick one.
 * Pure.
 */

export interface CampaignLite {
  id: string
  name: string
  status: number
}

export type CampaignQueryResult =
  | { kind: 'empty' }
  | { kind: 'none' }
  | { kind: 'resolved'; campaign: CampaignLite }
  | { kind: 'several'; matches: CampaignLite[] }

export const MAX_CAMPAIGN_CHOICES = 8

export function resolveCampaignQuery(query: string, campaigns: readonly CampaignLite[]): CampaignQueryResult {
  const q = query.trim().toLowerCase()
  if (!q) return { kind: 'empty' }
  const matches = campaigns.filter((c) => c.status >= 0 && c.name.toLowerCase().includes(q))
  if (matches.length === 0) return { kind: 'none' }
  const exact = matches.filter((c) => c.name.trim().toLowerCase() === q)
  if (exact.length === 1) return { kind: 'resolved', campaign: exact[0] }
  if (matches.length === 1) return { kind: 'resolved', campaign: matches[0] }
  return { kind: 'several', matches: matches.slice(0, MAX_CAMPAIGN_CHOICES) }
}
