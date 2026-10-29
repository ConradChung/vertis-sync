import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import type { Json } from '@/lib/db/types'
import { findDeal } from '@/lib/crm/service'
import { getReply, type ReplyRow } from '@/lib/inbox/store'
import { mergeFacts } from '@/lib/slack/binding'
import type { LeadFacts } from '@/lib/slack/card'

/**
 * The lead card's facts for one recorded reply (3g), read from Lume's own
 * tables only: lume_replies, the CRM deal, the lead bank row and the original
 * order's CSV row (validation_rows of the job pushed to that campaign). No
 * Instantly read, no enrichment, nothing paid. Read failures leave fields
 * missing rather than failing the post.
 */

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

async function leadBankRow(campaignId: string, email: string) {
  const res = await createServiceClient()
    .from('lead_bank')
    .select('first_name, last_name, company_name, website, location')
    .eq('campaign_id', campaignId)
    .eq('email', email)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (res.error) throw new DbError('slack.leadBankRow', res.error)
  return (res.data as { first_name: string | null; last_name: string | null; company_name: string | null; website: string | null; location: string | null } | null) ?? null
}

/** The order row this lead came from: a job pushed to this campaign, matching email (case-insensitive). */
async function orderRow(campaignId: string, email: string): Promise<Record<string, Json> | null> {
  const sb = createServiceClient()
  const jobs = await sb
    .from('validation_jobs')
    .select('id')
    .or(`instantly_campaign_id.eq.${campaignId},instantly_campaign_id_nolocation.eq.${campaignId}`)
    .order('created_at', { ascending: false })
    .limit(50)
  if (jobs.error) throw new DbError('slack.orderJobs', jobs.error)
  const ids = ((jobs.data ?? []) as { id: string }[]).map((j) => j.id)
  if (!ids.length) return null
  const rows = await sb.from('validation_rows').select('row_data').in('job_id', ids).ilike('email', likeEscape(email)).order('created_at', { ascending: false }).limit(1)
  if (rows.error) throw new DbError('slack.orderRow', rows.error)
  const data = ((rows.data ?? []) as { row_data: Json }[])[0]?.row_data
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, Json>) : null
}

const safe = async <T>(label: string, p: () => Promise<T>): Promise<T | null> => {
  try {
    return await p()
  } catch (err) {
    console.error(`[slack/facts] ${label} failed:`, err instanceof Error ? err.message : err)
    return null
  }
}

/** Campaign ids are Instantly uuids; anything else is not looked up in the order tables. */
const CAMPAIGN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function gatherFacts(reply: Pick<ReplyRow, 'campaign_id' | 'lead_email' | 'lead_name' | 'company' | 'excerpt'>): Promise<LeadFacts> {
  const email = reply.lead_email.toLowerCase()
  const campaign = reply.campaign_id
  const [deal, lead, order] = await Promise.all([
    campaign ? safe('deal', () => findDeal(campaign, email)) : null,
    campaign ? safe('lead_bank', () => leadBankRow(campaign, email)) : null,
    campaign && CAMPAIGN_UUID.test(campaign) ? safe('order', () => orderRow(campaign, email)) : null,
  ])
  return mergeFacts({
    reply: { lead_name: reply.lead_name, company: reply.company, excerpt: reply.excerpt },
    deal: deal ? { name: deal.name, company: deal.company, city: deal.city, stage: deal.stage } : null,
    lead,
    order,
  })
}

export async function factsForReply(replyToUuid: string): Promise<{ reply: ReplyRow; facts: LeadFacts } | null> {
  const reply = await getReply(replyToUuid)
  if (!reply) return null
  return { reply, facts: await gatherFacts(reply) }
}
