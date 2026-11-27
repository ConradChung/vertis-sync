import 'server-only'
import { addActivity, setStage } from '@/lib/crm/service'
import type { Json } from '@/lib/db/types'
import { DbError } from '@/lib/db/service'
import { parseReplyDeskConfig, REPLY_DESK_CONFIG_KEY, round4, type ReplyDeskConfig } from '@/lib/replydesk/config'
import { LINKEDIN_CAMPAIGN_ID, type DealRef, type DraftRow, type InboundRow, type PersonMatch, type Store, type ThreadRow } from '@/lib/replydesk/engine'
import { DRAFT_FACT_KINDS, FALLBACK_FACTS, type Fact } from '@/lib/replydesk/macros'
import { domainOf } from '@/lib/signals/merge'
import type { LinkedinWaiting } from '@/lib/replies/queue'
import { createServiceClient } from '@/lib/supabase/service'

/** Supabase adapter for the reply desk (service role; every table is service-only). */

const sb = () => createServiceClient()
const nowIso = () => new Date().toISOString()
function check<T>(op: string, res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new DbError(`replydesk.${op}`, res.error as never)
  return res.data
}

export async function getReplyDeskConfig(): Promise<ReplyDeskConfig> {
  const res = await sb().from('lume_settings').select('value').eq('key', REPLY_DESK_CONFIG_KEY).maybeSingle()
  return parseReplyDeskConfig((check('getConfig', res) as { value?: unknown } | null)?.value)
}

/** Save the listened-to channel (keeps every other key). */
export async function saveReplyDeskSlack(cfg: ReplyDeskConfig, slack: { team_id: string; channel_id: string; channel_name: string }): Promise<void> {
  const value = { ...cfg.raw, slack }
  check('saveSlack', await sb().from('lume_settings').upsert({ key: REPLY_DESK_CONFIG_KEY, value, updated_at: nowIso() }))
}

const INBOUND_COLS = 'id, team_id, channel_id, ts, received_at, label, person_name, company, linkedin_url, message, check_back_on, deal_id'
const DRAFT_COLS = 'id, deal_id, inbound_id, kind, step, macro, body, status, team_id, channel_id, thread_ts, slack_ts, created_at'
const THREAD_COLS = 'deal_id, team_id, channel_id, thread_ts, inbound_id, last_label, schedule, anchor_at, next_step, next_due_at, stopped_reason, last_sent_at'
const DEAL_COLS = 'id, stage, name, company'

export const liveStore: Store = {
  getConfig: getReplyDeskConfig,

  async monthSpend(fromIso) {
    const rows = check('monthSpend', await sb().from('reply_desk_spend').select('usd').gte('created_at', fromIso).limit(10_000)) as { usd: number | string }[] | null
    return round4((rows ?? []).reduce((s, r) => s + Number(r.usd || 0), 0))
  },

  async addSpend(row) {
    check('addSpend', await sb().from('reply_desk_spend').insert({ ...row, usd: round4(row.usd) }))
  },

  async saveInbound(row) {
    const res = await sb()
      .from('reply_desk_inbound')
      .upsert({ ...row, raw: row.raw as unknown as Json }, { onConflict: 'channel_id,ts', ignoreDuplicates: true })
      .select('id')
      .maybeSingle()
    const data = check('saveInbound', res) as { id: number } | null
    return data?.id ?? null
  },

  async updateInbound(id, patch) {
    check('updateInbound', await sb().from('reply_desk_inbound').update({ ...patch, updated_at: nowIso() } as never).eq('id', id))
  },

  async getInbound(id) {
    return (check('getInbound', await sb().from('reply_desk_inbound').select(INBOUND_COLS).eq('id', id).maybeSingle()) as InboundRow | null) ?? null
  },

  async matchPerson(url): Promise<PersonMatch> {
    if (!url) return { deal: null, signal: null }
    // 1. A deal that already carries this profile.
    const byUrl = check('match.deal', await sb().from('crm_deals').select(DEAL_COLS).ilike('linkedin_url', url).order('updated_at', { ascending: false }).limit(1)) as DealRef[] | null
    // 2. A LinkedIn signal person with this profile: their work email (Blitz) and their account's deal.
    const ppl = check('match.signal', await sb().from('signal_people').select('name, company_name, company_website, contacts').ilike('linkedin_url', url).limit(1)) as
      | { name: string | null; company_name: string | null; company_website: string | null; contacts: { email?: string | null }[] | null }[]
      | null
    const p = ppl?.[0]
    const email = p?.contacts?.find((c) => typeof c?.email === 'string' && c.email.includes('@'))?.email?.toLowerCase() ?? null
    const signal = p ? { name: p.name, company: p.company_name, email } : null
    if (byUrl?.[0]) return { deal: byUrl[0], signal }
    if (email) {
      const byEmail = check('match.email', await sb().from('crm_deals').select(DEAL_COLS).eq('email', email).order('updated_at', { ascending: false }).limit(1)) as DealRef[] | null
      if (byEmail?.[0]) return { deal: byEmail[0], signal }
    }
    const domain = domainOf(p?.company_website)
    if (domain) {
      const acct = check('match.account', await sb().from('signal_accounts').select('deal_id').eq('account_key', `d:${domain}`).maybeSingle()) as { deal_id: string | null } | null
      if (acct?.deal_id) {
        const d = check('match.accountDeal', await sb().from('crm_deals').select(DEAL_COLS).eq('id', acct.deal_id).maybeSingle()) as DealRef | null
        if (d) return { deal: d, signal }
      }
    }
    return { deal: null, signal }
  },

  async createDeal(row) {
    // No placeholder address: a LinkedIn deal carries its profile URL, and an email only when one is known.
    const res = await sb()
      .from('crm_deals')
      .insert({ campaign_id: LINKEDIN_CAMPAIGN_ID, email: row.email, linkedin_url: row.linkedin_url, name: row.name, company: row.company, source: 'user', stage: 'Contacted' } as never)
      .select(DEAL_COLS)
      .single()
    return check('createDeal', res) as DealRef
  },

  async updateDeal(id, patch) {
    check('updateDeal', await sb().from('crm_deals').update({ ...patch, updated_at: nowIso() } as never).eq('id', id))
  },

  async setStage(dealId, stage, source, reason, payload) {
    return setStage(dealId, stage, source, reason ?? null, (payload ?? {}) as Record<string, Json>)
  },

  async addActivity(dealId, kind, payload, source, dedupeKey) {
    await addActivity({ deal_id: dealId, kind, source, payload: payload as Record<string, Json>, dedupe_key: dedupeKey })
  },

  async getThread(dealId) {
    return (check('getThread', await sb().from('reply_desk_threads').select(THREAD_COLS).eq('deal_id', dealId).maybeSingle()) as ThreadRow | null) ?? null
  },

  async upsertThread(row) {
    check('upsertThread', await sb().from('reply_desk_threads').upsert({ ...row, updated_at: nowIso() }, { onConflict: 'deal_id' }))
  },

  async patchThread(dealId, patch, ifDueAt) {
    let q = sb().from('reply_desk_threads').update({ ...patch, updated_at: nowIso() }).eq('deal_id', dealId)
    if (ifDueAt !== undefined) q = q.eq('next_due_at', ifDueAt)
    const rows = check('patchThread', await q.select('deal_id')) as unknown[] | null
    return !!rows?.length
  },

  async dueThreads(now, limit) {
    const res = await sb().from('reply_desk_threads').select(THREAD_COLS).not('schedule', 'is', null).lte('next_due_at', now).order('next_due_at', { ascending: true }).limit(limit)
    return (check('dueThreads', res) as ThreadRow[] | null) ?? []
  },

  async insertDraft(row) {
    return check('insertDraft', await sb().from('reply_desk_drafts').insert(row).select(DRAFT_COLS).single()) as DraftRow
  },

  async patchDraft(id, patch, from) {
    let q = sb().from('reply_desk_drafts').update(patch).eq('id', id)
    if (from) q = q.eq('status', from)
    const rows = check('patchDraft', await q.select('id')) as unknown[] | null
    return !!rows?.length
  },

  async getDraft(id) {
    return (check('getDraft', await sb().from('reply_desk_drafts').select(DRAFT_COLS).eq('id', id).maybeSingle()) as DraftRow | null) ?? null
  },

  async dealDrafts(dealId) {
    return (check('dealDrafts', await sb().from('reply_desk_drafts').select(DRAFT_COLS).eq('deal_id', dealId).order('id', { ascending: true }).limit(200)) as DraftRow[] | null) ?? []
  },

  async facts(): Promise<Fact[]> {
    // The content generator's facts bank (owner-maintained); the hard-coded allowed facts only if it cannot be read.
    const res = await sb().from('content_facts').select('kind, text').eq('active', true).in('kind', [...DRAFT_FACT_KINDS]).order('id').limit(100)
    if (res.error || !res.data?.length) return [...FALLBACK_FACTS]
    return res.data as Fact[]
  },
}

// ── Replies page ───────────────────────────────────────────────────────────


/**
 * LinkedIn replies still waiting on Frank: each deal's newest actionable
 * inbound (interested / question / not_now, last 30 days) with no draft from
 * that thread marked Sent, Booked or Not interested since it arrived.
 */
export async function loadLinkedinWaiting(now: Date = new Date()): Promise<LinkedinWaiting[]> {
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString()
  const inbound = (check(
    'waiting.inbound',
    await sb().from('reply_desk_inbound').select('id, deal_id, person_name, company, linkedin_url, label, message, received_at').in('label', ['interested', 'question', 'not_now']).not('deal_id', 'is', null).gte('received_at', since).order('received_at', { ascending: false }).limit(300)
  ) ?? []) as { id: number; deal_id: string; person_name: string | null; company: string | null; linkedin_url: string | null; label: string; message: string | null; received_at: string }[]
  const newest = new Map<string, (typeof inbound)[number]>()
  for (const r of inbound) if (!newest.has(r.deal_id)) newest.set(r.deal_id, r)
  if (!newest.size) return []
  const drafts = (check('waiting.drafts', await sb().from('reply_desk_drafts').select('inbound_id, status').in('inbound_id', [...newest.values()].map((r) => r.id))) ?? []) as { inbound_id: number; status: string }[]
  const done = new Set(drafts.filter((d) => ['sent', 'booked', 'not_interested'].includes(d.status)).map((d) => d.inbound_id))
  const drafted = new Set(drafts.filter((d) => d.status === 'posted').map((d) => d.inbound_id))
  return [...newest.values()]
    .filter((r) => !done.has(r.id))
    .map((r) => ({
      inbound_id: r.id,
      deal_id: r.deal_id,
      name: r.person_name,
      company: r.company,
      linkedin_url: r.linkedin_url,
      label: r.label,
      untrusted_excerpt: r.message ? r.message.replace(/\s+/g, ' ').trim().slice(0, 300) : null,
      received_at: r.received_at,
      drafted: drafted.has(r.id),
    }))
}
