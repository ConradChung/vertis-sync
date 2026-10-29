import { htmlToText } from '@/lib/adapters/instantly.map'

/**
 * Inbox manager (Phase 3a–3c, docs/lume/2026-10-28-inbox-manager-design.md):
 * the pure, client-safe part. Instantly `/emails` items → messages and
 * threads (quotes trimmed), the live-thread safety check, which webhook
 * events count as a positive reply, and what a reply label does.
 */

// ---------------------------------------------------------------------------
// Instantly interest status (`lt_interest_status`, OpenAPI Lead schema)

export const INTEREST = {
  ooo: 0,
  interested: 1,
  meeting_booked: 2,
  meeting_completed: 3,
  won: 4,
  not_interested: -1,
  wrong_person: -2,
  lost: -3,
  no_show: -4,
} as const

const INTEREST_NAMES: Record<number, string> = {
  0: 'out of office',
  1: 'interested',
  2: 'meeting booked',
  3: 'meeting completed',
  4: 'won',
  [-1]: 'not interested',
  [-2]: 'wrong person',
  [-3]: 'lost',
  [-4]: 'no show',
}

export function interestLabel(v: number | null | undefined): string | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null
  return INTEREST_NAMES[v] ?? `custom (${v})`
}

// ---------------------------------------------------------------------------
// Messages

export interface InboxEmail {
  id: string
  thread_id: string
  direction: 'in' | 'out'
  /** Our sending account (the inbox a reply must come from). */
  eaccount: string | null
  from: string | null
  to: string[]
  cc: string[]
  /** The lead's address. */
  lead: string | null
  subject: string | null
  /** Full text (HTML converted), capped; quotes NOT yet trimmed. */
  text: string
  at: string | null
  campaign_id: string | null
  /** Instantly `i_status` (interest), when set. */
  interest: number | null
  unread: boolean
  auto_reply: boolean
}

type Raw = Record<string, unknown>
const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v)
const s = (o: Raw, k: string): string | null => {
  const v = o[k]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}
const n = (o: Raw, k: string): number | null => {
  const v = o[k]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return null
}
const list = (v: unknown): string[] =>
  (typeof v === 'string' ? v.split(',') : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)

export const MAX_EMAIL_TEXT = 20_000

function bodyText(o: Raw): string {
  const body = isObj(o.body) ? o.body : {}
  const html = s(body, 'html')
  const text = s(body, 'text') ?? (html ? htmlToText(html) : null) ?? s(o, 'content_preview') ?? ''
  return text.length > MAX_EMAIL_TEXT ? `${text.slice(0, MAX_EMAIL_TEXT)}…` : text
}

/** One `/emails` item → an InboxEmail; unknown shapes → null. `ue_type` 2 = received. */
export function mapInboxEmail(it: unknown): InboxEmail | null {
  if (!isObj(it)) return null
  const id = s(it, 'id')
  if (!id) return null
  const from = s(it, 'from_address_email')?.toLowerCase() ?? null
  const eaccount = s(it, 'eaccount')?.toLowerCase() ?? null
  const ue = n(it, 'ue_type')
  const direction: 'in' | 'out' = ue === 2 || (ue === null && !!from && !!eaccount && from !== eaccount) ? 'in' : 'out'
  const to = list(it.to_address_email_list)
  const lead = s(it, 'lead')?.toLowerCase() ?? (direction === 'in' ? from : (to[0] ?? null))
  return {
    id,
    thread_id: s(it, 'thread_id') ?? id,
    direction,
    eaccount,
    from,
    to,
    cc: list(it.cc_address_email_list),
    lead,
    subject: s(it, 'subject'),
    text: bodyText(it),
    at: s(it, 'timestamp_email') ?? s(it, 'timestamp_created'),
    campaign_id: s(it, 'campaign_id'),
    interest: n(it, 'i_status'),
    unread: n(it, 'is_unread') === 1 || it.is_unread === true,
    auto_reply: n(it, 'is_auto_reply') === 1 || it.is_auto_reply === true,
  }
}

// ---------------------------------------------------------------------------
// Quote trimming

const QUOTE_HEADER = [
  /^\s*-{2,}\s*original message\s*-{2,}/i,
  /^\s*_{10,}\s*$/,
  /^\s*begin forwarded message/i,
]
/** "On <date> <name> wrote:" — may wrap onto the next line. */
const ON_WROTE = /^\s*on\b.*\bwrote:\s*$/i
const ON_START = /^\s*on\s.+/i

/**
 * The new text of an email, without the quoted history under it: cut at the
 * first "On … wrote:", "-----Original Message-----", an Outlook
 * "From: … / Sent: …" header block, a long underscore rule, or a run of `>`
 * lines. A message that is nothing but quotes is returned as it was.
 */
export function trimQuotes(text: string): string {
  const lines = (text ?? '').replace(/\r\n?/g, '\n').split('\n')
  let cut = lines.length
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (QUOTE_HEADER.some((re) => re.test(l))) {
      cut = i
      break
    }
    if (ON_WROTE.test(l) || (ON_START.test(l) && i + 1 < lines.length && /wrote:\s*$/i.test(lines[i + 1]))) {
      cut = i
      break
    }
    if (/^\s*from:\s.+/i.test(l) && lines.slice(i + 1, i + 4).some((x) => /^\s*(sent|date):\s/i.test(x))) {
      cut = i
      break
    }
    if (/^\s*>/.test(l) && lines.slice(i).every((x) => /^\s*>/.test(x) || !x.trim())) {
      cut = i
      break
    }
  }
  const kept = lines.slice(0, cut).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (kept) return kept
  return (text ?? '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** A one-paragraph excerpt for cards and lists: quotes trimmed, whitespace collapsed, capped. */
export function excerptOf(text: string, max = 300): string {
  const t = trimQuotes(text).replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) : t
}

// ---------------------------------------------------------------------------
// Threads

export interface ThreadMessage {
  id: string
  direction: 'in' | 'out'
  from: string | null
  to: string[]
  cc: string[]
  subject: string | null
  /** Quotes trimmed. */
  text: string
  at: string | null
  auto_reply: boolean
}

export interface ThreadView {
  thread_id: string
  campaign_id: string | null
  lead_email: string | null
  subject: string | null
  messages: ThreadMessage[]
  /** The newest message from the lead: what a reply answers. Null when the lead never wrote. */
  latest_inbound: { reply_to_uuid: string; eaccount: string | null; subject: string | null; at: string | null } | null
}

const byTime = (a: InboxEmail, b: InboxEmail) => (a.at ?? '').localeCompare(b.at ?? '') || a.id.localeCompare(b.id)

/** A thread's emails, oldest → newest, quotes trimmed. */
export function threadView(emails: readonly InboxEmail[]): ThreadView {
  const sorted = [...emails].sort(byTime)
  const lastIn = [...sorted].reverse().find((m) => m.direction === 'in') ?? null
  return {
    thread_id: sorted[0]?.thread_id ?? '',
    campaign_id: sorted.find((m) => m.campaign_id)?.campaign_id ?? null,
    lead_email: sorted.find((m) => m.lead)?.lead ?? null,
    subject: sorted[0]?.subject ?? null,
    messages: sorted.map((m) => ({
      id: m.id,
      direction: m.direction,
      from: m.from,
      to: m.to,
      cc: m.cc,
      subject: m.subject,
      text: trimQuotes(m.text),
      at: m.at,
      auto_reply: m.auto_reply,
    })),
    latest_inbound: lastIn ? { reply_to_uuid: lastIn.id, eaccount: lastIn.eaccount, subject: lastIn.subject, at: lastIn.at } : null,
  }
}

/**
 * The send safety check: an inbound message in the live thread that is newer
 * than the one being answered (`replyToId`), or null when it is safe to send.
 * If the answered message is not in the thread at all, any inbound counts as
 * newer (fail closed: we cannot prove nothing came after it).
 */
export function newerInbound(emails: readonly InboxEmail[], replyToId: string): InboxEmail | null {
  const sorted = [...emails].sort(byTime)
  const idx = sorted.findIndex((m) => m.id === replyToId)
  const after = idx === -1 ? sorted : sorted.slice(idx + 1)
  return after.find((m) => m.direction === 'in' && m.id !== replyToId) ?? null
}

// ---------------------------------------------------------------------------
// Positive replies from the webhook

const POSITIVE_KEYS = ['lt_interest_status', 'interest_status', 'i_status', 'interest_value'] as const

/**
 * Does a mapped Instantly webhook event count as a positive reply? A
 * `lead_interested` event (`interested`) always does. A `reply_received`
 * (`reply`) only when the payload itself carries an interested status (1);
 * Instantly's reply webhook normally does not classify, so unclassified
 * replies are left to the list_replies poll (`i_status=1`) as the backstop.
 */
export function isPositiveWebhook(type: string, payload: Record<string, unknown>): boolean {
  if (type === 'interested') return true
  if (type !== 'reply') return false
  return POSITIVE_KEYS.some((k) => {
    const v = payload[k]
    const num = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
    return num === INTEREST.interested
  })
}

// ---------------------------------------------------------------------------
// Labels

export const REPLY_CATEGORIES = ['interested', 'not_now', 'wrong_person', 'not_interested', 'ooo', 'unsubscribe', 'hostile', 'booked'] as const
export type ReplyCategory = (typeof REPLY_CATEGORIES)[number]
export const VERDICTS = ['GOOD', 'UNSURE', 'BAD'] as const
export type Verdict = (typeof VERDICTS)[number]

export interface LabelPlan {
  /** Instantly interest value to set; undefined = leave Instantly as it is. */
  interest: number | undefined
  /** CRM stage to move to directly (never Won/Lost). */
  stage: string | null
  /** A closing stage that needs the owner's approval (a crm_close_deal action). */
  close: 'Lost' | null
  /** Add the lead's address to the Instantly blocklist. */
  block: boolean
  /** Log a meeting activity. */
  meeting: boolean
  /** No reply is owed any more: the reply leaves "New replies". */
  handled: boolean
}

const PLANS: Record<ReplyCategory, LabelPlan> = {
  interested: { interest: INTEREST.interested, stage: 'Interested', close: null, block: false, meeting: false, handled: false },
  // Instantly has no "not now" status: leave its label, park the deal.
  not_now: { interest: undefined, stage: 'Not now', close: null, block: false, meeting: false, handled: false },
  wrong_person: { interest: INTEREST.wrong_person, stage: null, close: null, block: false, meeting: false, handled: false },
  ooo: { interest: INTEREST.ooo, stage: null, close: null, block: false, meeting: false, handled: true },
  not_interested: { interest: INTEREST.not_interested, stage: null, close: 'Lost', block: false, meeting: false, handled: true },
  unsubscribe: { interest: INTEREST.not_interested, stage: null, close: 'Lost', block: true, meeting: false, handled: true },
  hostile: { interest: INTEREST.not_interested, stage: null, close: 'Lost', block: true, meeting: false, handled: true },
  booked: { interest: INTEREST.meeting_booked, stage: 'Meeting booked', close: null, block: false, meeting: true, handled: true },
}

const BAD_PLAN: LabelPlan = { interest: INTEREST.lost, stage: null, close: 'Lost', block: false, meeting: false, handled: true }

/**
 * What a label does. A category decides it; a BAD verdict without one is a
 * bad fit (Instantly "lost", CRM Lost through approval, no reply), blocked
 * only with `block: true`. `block` is honoured for BAD only: unsubscribe and
 * hostile always block, nothing else ever does.
 */
export function labelPlan(input: { category?: ReplyCategory; verdict?: Verdict; block?: boolean }): LabelPlan {
  if (input.category) {
    const p = { ...PLANS[input.category] }
    if (input.verdict === 'BAD' && input.block) p.block = true
    return p
  }
  if (input.verdict === 'BAD') return { ...BAD_PLAN, block: input.block === true }
  throw new Error('a category is required unless the verdict is BAD')
}

// ---------------------------------------------------------------------------
// The reply approval card

/** What a send_reply card shows (ApprovalCard, /operator). */
export interface ReplyCard {
  lead_email: string | null
  lead_name: string | null
  company: string | null
  verdict: string | null
  their_message: string | null
  draft: string
  proposed_times: string[]
  research_note: string | null
  eaccount: string | null
  edited_by: string | null
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

export function replyCardOf(p: Record<string, unknown> | null | undefined): ReplyCard {
  const o = p ?? {}
  return {
    lead_email: str(o.lead_email),
    lead_name: str(o.lead_name),
    company: str(o.company),
    verdict: str(o.verdict),
    their_message: str(o.their_message),
    draft: typeof o.body === 'string' ? o.body : '',
    proposed_times: Array.isArray(o.proposed_times) ? o.proposed_times.filter((t): t is string => typeof t === 'string' && !!t.trim()) : [],
    research_note: str(o.research_note),
    eaccount: str(o.eaccount),
    edited_by: str(o.edited_by),
  }
}
