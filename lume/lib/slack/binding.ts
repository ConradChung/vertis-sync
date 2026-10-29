import type { Json } from '@/lib/db/types'
import type { LeadFacts } from '@/lib/slack/card'

/**
 * Channel bindings and lead facts (3g). Pure.
 *
 * A channel sees a campaign only when ALL hold: the channel is active, its
 * workspace's install is not revoked, its vertical is live and owns the
 * campaign (lume_verticals.campaign_ids), and the channel's own campaign list
 * is empty (= all of the vertical's) or names it. Taking a campaign off the
 * vertical therefore stops the channel seeing it, whatever the binding says.
 */

export interface ChannelBinding {
  id: string
  team_id: string
  channel_id: string
  channel_name: string | null
  vertical_id: string
  campaign_ids: string[]
  visible_fields: string[]
  active: boolean
}

export interface BindingVertical {
  id: string
  campaign_ids: string[]
  archived_at: string | null
}

export function channelCoversCampaign(
  ch: Pick<ChannelBinding, 'active' | 'vertical_id' | 'campaign_ids'>,
  verticals: readonly BindingVertical[],
  campaignId: string | null | undefined,
  installLive = true
): boolean {
  if (!campaignId || !ch.active || !installLive) return false
  const v = verticals.find((x) => x.id === ch.vertical_id)
  if (!v || v.archived_at || !v.campaign_ids.includes(campaignId)) return false
  return ch.campaign_ids.length === 0 || ch.campaign_ids.includes(campaignId)
}

/** The campaigns a channel may see (for the @Lume lookup scope). */
export function channelCampaigns(ch: Pick<ChannelBinding, 'active' | 'vertical_id' | 'campaign_ids'>, verticals: readonly BindingVertical[]): string[] {
  if (!ch.active) return []
  const v = verticals.find((x) => x.id === ch.vertical_id)
  if (!v || v.archived_at) return []
  return ch.campaign_ids.length ? ch.campaign_ids.filter((c) => v.campaign_ids.includes(c)) : [...v.campaign_ids]
}

const s = (v: unknown): string | null => {
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

/** First non-empty value among keys, matched case- and separator-insensitively. */
export function pickKey(row: Record<string, Json> | null | undefined, keys: readonly string[]): string | null {
  if (!row || typeof row !== 'object') return null
  const index = new Map<string, unknown>()
  for (const [k, v] of Object.entries(row)) index.set(k.toLowerCase().replace(/[\s_.#-]/g, ''), v)
  for (const k of keys) {
    const v = s(index.get(k))
    if (v) return v
  }
  return null
}

export interface FactSources {
  reply: { lead_name: string | null; company: string | null; excerpt: string | null } | null
  deal: { name: string | null; company: string | null; city: string | null; stage: string | null } | null
  lead: { first_name: string | null; last_name: string | null; company_name: string | null; website: string | null; location: string | null } | null
  /** The original order's CSV row (validation_rows.row_data), if found. */
  order: Record<string, Json> | null
}

const linkedinOnly = (v: string | null) => (v && /linkedin\.com\//i.test(v) ? v : null)

/**
 * The lead card's facts, from what Lume holds: the recorded reply, the CRM
 * deal, the lead bank and the original order row. Never invented: a field
 * nobody holds stays null and is shown as missing. The order row's title is
 * read from person-title columns only (a Google Maps "title" is a place name).
 */
export function mergeFacts(src: FactSources): LeadFacts {
  const o = src.order
  const orderName = [pickKey(o, ['firstname']), pickKey(o, ['lastname'])].filter(Boolean).join(' ') || pickKey(o, ['fullname', 'personname', 'contactname'])
  const leadName = [src.lead?.first_name, src.lead?.last_name].filter((x) => x && x.trim()).join(' ') || null
  const city = pickKey(o, ['city'])
  const region = pickKey(o, ['state', 'region'])
  const country = pickKey(o, ['country'])
  const orderLocation = [city, region, country].filter(Boolean).join(', ') || null
  const hasPersonCompany = !!pickKey(o, ['companyname', 'company', 'organizationname'])
  return {
    name: src.deal?.name ?? src.reply?.lead_name ?? leadName ?? orderName ?? null,
    title: pickKey(o, ['jobtitle', 'persontitle', 'position', ...(hasPersonCompany ? ['title'] : [])]),
    company: src.deal?.company ?? src.reply?.company ?? src.lead?.company_name ?? pickKey(o, ['companyname', 'company', 'organizationname']),
    website: src.lead?.website ?? pickKey(o, ['website', 'websiteurl', 'companywebsite']),
    phone: pickKey(o, ['mobilephone', 'directphone', 'phone', 'phonenumber', 'workdirectphone', 'corporatephone', 'companyphone']),
    linkedin: linkedinOnly(pickKey(o, ['personlinkedinurl', 'linkedinurl', 'linkedin', 'linkedinprofile'])),
    location: src.deal?.city ?? src.lead?.location ?? orderLocation,
    reply: src.reply?.excerpt ?? null,
    stage: src.deal?.stage ?? null,
  }
}
