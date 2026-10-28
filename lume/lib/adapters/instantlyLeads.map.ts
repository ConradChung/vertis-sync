/**
 * Instantly v2 leads + plan details → Lume shapes. Pure (no fetch), so the
 * state filters and the "never remove a replied / interested lead" rule are
 * unit-tested on their own.
 *
 * Lead `status`: 1 active, 2 paused, 3 completed, -1 bounced, -2 unsubscribed,
 * -3 skipped. `lt_interest_status`: 1 interested, 2 meeting booked, 3 meeting
 * completed, 4 won (all "interested" here), 0 out of office, -1 not
 * interested, -2 wrong person, -3 lost, -4 no show.
 */

export const LEAD_STATES = ['finished_no_reply', 'replied', 'bounced', 'contacted', 'interested', 'no_reply_after_days'] as const
export type LeadState = (typeof LEAD_STATES)[number]

/** A state plus an optional "last contacted at least `days` ago" bound (required for no_reply_after_days). */
export interface LeadQuery {
  state: LeadState
  days?: number
}

export const MAX_DAYS = 365

const UPSTREAM: Record<LeadState, string> = {
  finished_no_reply: 'FILTER_VAL_COMPLETED_NO_REPLY',
  replied: 'FILTER_VAL_REPLIED',
  bounced: 'FILTER_VAL_BOUNCED',
  contacted: 'FILTER_VAL_CONTACTED',
  interested: 'FILTER_LEAD_INTERESTED',
  no_reply_after_days: 'FILTER_VAL_CONTACTED',
}

/** `"replied"`, `"no_reply_after_days:14"` → a query; anything else → null. */
export function parseLeadQuery(raw: string): LeadQuery | null {
  const s = raw.trim()
  const m = /^no_reply_after_days:(\d{1,3})$/.exec(s)
  if (m) {
    const days = Number(m[1])
    return days >= 1 && days <= MAX_DAYS ? { state: 'no_reply_after_days', days } : null
  }
  if (s === 'no_reply_after_days') return null
  return (LEAD_STATES as readonly string[]).includes(s) ? { state: s as LeadState } : null
}

export function upstreamFilter(q: LeadQuery): string {
  return UPSTREAM[q.state]
}

const STATUS_LABEL: Record<number, string> = {
  1: 'active',
  2: 'paused',
  3: 'completed',
  [-1]: 'bounced',
  [-2]: 'unsubscribed',
  [-3]: 'skipped',
}

const INTEREST_LABEL: Record<number, string> = {
  1: 'interested',
  2: 'meeting_booked',
  3: 'meeting_completed',
  4: 'won',
  0: 'out_of_office',
  [-1]: 'not_interested',
  [-2]: 'wrong_person',
  [-3]: 'lost',
  [-4]: 'no_show',
}

export interface CampaignLead {
  id: string
  email: string | null
  name: string | null
  company: string | null
  status: number | null
  status_label: string | null
  last_contact_at: string | null
  last_reply_at: string | null
  reply_count: number
  interest: number | null
  interest_label: string | null
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function mapLead(raw: unknown): CampaignLead | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = text(r.id)
  if (!id) return null
  const name = [text(r.first_name), text(r.last_name)].filter(Boolean).join(' ') || null
  const status = num(r.status)
  const interest = num(r.lt_interest_status)
  return {
    id,
    email: text(r.email)?.toLowerCase() ?? null,
    name,
    company: text(r.company_name),
    status,
    status_label: status === null ? null : (STATUS_LABEL[status] ?? String(status)),
    last_contact_at: text(r.timestamp_last_contact),
    last_reply_at: text(r.timestamp_last_reply),
    reply_count: num(r.email_reply_count) ?? 0,
    interest,
    interest_label: interest === null ? null : (INTEREST_LABEL[interest] ?? 'custom'),
  }
}

/**
 * Why a lead must never be removed, or null. Replied (any reply count or a
 * reply timestamp) and interested (interest status above 0: interested,
 * meeting booked / completed, won, or a positive custom label).
 */
export function protectedReason(l: Pick<CampaignLead, 'reply_count' | 'last_reply_at' | 'interest'>): 'replied' | 'interested' | null {
  if (l.interest !== null && l.interest > 0) return 'interested'
  if (l.reply_count > 0 || l.last_reply_at) return 'replied'
  return null
}

const DAY_MS = 86_400_000

function contactedBefore(l: CampaignLead, days: number, now: Date): boolean {
  if (!l.last_contact_at) return false
  const t = Date.parse(l.last_contact_at)
  return Number.isFinite(t) && t <= now.getTime() - days * DAY_MS
}

/**
 * Client-side checks on top of Instantly's filter: finished_no_reply also
 * needs status completed (never a bounced lead); no_reply_after_days needs no
 * reply and not bounced; `days` bounds the last contact.
 */
export function leadMatches(l: CampaignLead, q: LeadQuery, now: Date): boolean {
  const replied = l.reply_count > 0 || !!l.last_reply_at
  if (q.state === 'finished_no_reply' && (l.status !== 3 || protectedReason(l) !== null)) return false
  if (q.state === 'no_reply_after_days' && (l.status === -1 || replied)) return false
  return q.days === undefined || contactedBefore(l, q.days, now)
}

export interface LeadSummary {
  total: number
  by_status: Record<string, number>
  replied: number
  interested: number
}

export function summarizeLeads(leads: CampaignLead[]): LeadSummary {
  const by: Record<string, number> = {}
  let replied = 0
  let interested = 0
  for (const l of leads) {
    const k = l.status_label ?? 'unknown'
    by[k] = (by[k] ?? 0) + 1
    if (l.reply_count > 0 || l.last_reply_at) replied++
    if (l.interest !== null && l.interest > 0) interested++
  }
  return { total: leads.length, by_status: by, replied, interested }
}

export interface ContactUsage {
  plan_name: string | null
  current: number
  limit: number
  base_limit: number | null
  addons: number | null
  headroom: number
  used_pct: number
}

/** `GET /workspace-billing/plan-details` → uploaded contacts vs the outreach plan limit. */
export function mapUsage(raw: unknown): ContactUsage | null {
  const o = (raw as { subscriptions?: { outreach?: Record<string, unknown> } } | null)?.subscriptions?.outreach
  if (!o || typeof o !== 'object') return null
  const current = num(o.current_lead_count)
  const limit = num(o.total_lead_limit)
  if (current === null || limit === null) return null
  return {
    plan_name: text(o.plan_name),
    current,
    limit,
    base_limit: num(o.base_lead_limit),
    addons: num(o.addons_qty),
    headroom: Math.max(0, limit - current),
    used_pct: limit > 0 ? Math.round((current / limit) * 1000) / 10 : 0,
  }
}
