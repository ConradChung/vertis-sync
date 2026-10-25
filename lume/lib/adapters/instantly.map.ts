/**
 * Pure mappers over Instantly API v2 responses. The API's field names drift
 * between endpoints and versions, so every reader is defensive: unknown shapes
 * become zeros / nulls, and nothing raw is passed through to the browser.
 */

type Raw = Record<string, unknown>

const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)

/** First finite number among the given keys (numeric strings accepted). */
function num(o: Raw, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  }
  return null
}

function str(o: Raw, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return null
}

/** `{items: [...]}` or a bare array → the array. */
export function itemsOf(body: unknown): unknown[] {
  if (Array.isArray(body)) return body
  if (isObj(body) && Array.isArray(body.items)) return body.items
  if (isObj(body) && Array.isArray(body.data)) return body.data
  return []
}

// ---------------------------------------------------------------------------
// Campaigns

export interface InstantlyCampaign {
  id: string
  name: string
  status: number
  statusLabel: string
}

export function campaignStatusLabel(status: number): string {
  if (status === 0) return 'draft'
  if (status === 1) return 'active'
  if (status === 2) return 'paused'
  if (status === 3) return 'completed'
  if (status === 4) return 'running_subsequences'
  return String(status)
}

/** Drops deleted campaigns (status < 0) and rows without an id; sorted by name. */
export function mapCampaigns(items: unknown[]): InstantlyCampaign[] {
  const out: InstantlyCampaign[] = []
  for (const it of items) {
    if (!isObj(it)) continue
    const id = str(it, 'id')
    const status = num(it, 'status')
    if (!id || status === null || status < 0) continue
    out.push({ id, name: str(it, 'name') ?? id, status, statusLabel: campaignStatusLabel(status) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------------------
// Analytics

export interface AnalyticsOverview {
  sent: number
  replies: number
  bounced: number
  opportunities: number
  opportunity_value: number | null
  /** Percent (0–100); `null` when nothing has been sent. */
  reply_rate: number | null
}

/** `/campaigns/analytics/overview` (one campaign or the whole workspace). */
export function mapAnalyticsOverview(body: unknown): AnalyticsOverview {
  const o = isObj(body) ? body : Array.isArray(body) && isObj(body[0]) ? body[0] : {}
  const sent = num(o, 'emails_sent_count', 'contacted_count', 'sent') ?? 0
  const replies = num(o, 'reply_count', 'replies', 'reply_count_unique') ?? 0
  return {
    sent,
    replies,
    bounced: num(o, 'bounced_count', 'bounces') ?? 0,
    opportunities: num(o, 'total_opportunities', 'opportunities') ?? 0,
    opportunity_value: num(o, 'total_opportunity_value'),
    reply_rate: sent > 0 ? (replies / sent) * 100 : null,
  }
}

export interface DailyPoint {
  date: string // YYYY-MM-DD
  sent: number
  replies: number
  opportunities: number
}

/** `/campaigns/analytics/daily` → one point per date, ascending. */
export function mapDaily(body: unknown): DailyPoint[] {
  const out: DailyPoint[] = []
  for (const it of itemsOf(body)) {
    if (!isObj(it)) continue
    const date = str(it, 'date')
    if (!date) continue
    out.push({
      date: date.slice(0, 10),
      sent: num(it, 'sent', 'emails_sent', 'contacted') ?? 0,
      replies: num(it, 'replies', 'unique_replies') ?? 0,
      opportunities: num(it, 'opportunities', 'unique_opportunities') ?? 0,
    })
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

/** The last `n` UTC calendar dates ending at `now`, ascending. */
export function lastNDates(now: Date, n: number): string[] {
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    out.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10))
  }
  return out
}

/** Values of `key` aligned to `dates` (missing days are 0); several series are summed. */
export function seriesOn(dates: string[], key: 'sent' | 'replies' | 'opportunities', ...series: DailyPoint[][]): number[] {
  const by = new Map<string, number>()
  for (const s of series) for (const p of s) by.set(p.date, (by.get(p.date) ?? 0) + p[key])
  return dates.map((d) => by.get(d) ?? 0)
}

// ---------------------------------------------------------------------------
// Accounts

export interface InstantlyAccount {
  email: string
  status: string
  warmup_status: string
  /** 0–100, or null when Instantly did not report one. */
  warmup_score: number | null
  daily_limit: number | null
}

const ACCOUNT_STATUS: Record<number, string> = {
  1: 'active',
  2: 'paused',
  [-1]: 'connection_error',
  [-2]: 'soft_bounce_error',
  [-3]: 'sending_error',
}

const WARMUP_STATUS: Record<number, string> = {
  0: 'paused',
  1: 'active',
  [-1]: 'banned',
  [-2]: 'spam_folder_unknown',
  [-3]: 'permanent_suspension',
}

function label(o: Raw, key: string, table: Record<number, string>): string {
  const n = num(o, key)
  if (n !== null) return table[n] ?? String(n)
  return str(o, key)?.toLowerCase() ?? 'unknown'
}

export function mapAccount(it: unknown): InstantlyAccount | null {
  if (!isObj(it)) return null
  const email = str(it, 'email', 'email_address')
  if (!email) return null
  const warmup = isObj(it.warmup) ? it.warmup : {}
  return {
    email,
    status: label(it, 'status', ACCOUNT_STATUS),
    warmup_status: label(it, 'warmup_status', WARMUP_STATUS),
    warmup_score: num(it, 'stat_warmup_score', 'warmup_score') ?? num(warmup, 'score'),
    daily_limit: num(it, 'daily_limit', 'sending_limit') ?? null,
  }
}

export function mapAccounts(items: unknown[]): InstantlyAccount[] {
  return items
    .map(mapAccount)
    .filter((a): a is InstantlyAccount => a !== null)
    .sort((a, b) => a.email.localeCompare(b.email))
}

// ---------------------------------------------------------------------------
// Campaign sync (Rotate) and sequence preview

export interface InstantlyCampaignDetail extends InstantlyCampaign {
  /** Campaign `daily_limit` (sends per day), when set. */
  dailyLimit: number | null
  /** Number of sending accounts on the campaign (`email_list`). */
  accounts: number
}

/** Like `mapCampaigns`, plus the fields `lume_campaigns` keeps from a sync. */
export function mapCampaignDetails(items: unknown[]): InstantlyCampaignDetail[] {
  const byId = new Map<string, Raw>()
  for (const it of items) if (isObj(it) && typeof it.id === 'string') byId.set(it.id, it)
  return mapCampaigns(items).map((c) => {
    const raw = byId.get(c.id) ?? {}
    const list = raw.email_list
    return { ...c, dailyLimit: num(raw, 'daily_limit'), accounts: Array.isArray(list) ? list.length : 0 }
  })
}

/** Instantly's numeric status → the `lume_campaigns.status` vocabulary. */
export function lumeCampaignStatus(status: number): string {
  if (status === 4) return 'active' // running subsequences
  const label = campaignStatusLabel(status)
  return ['draft', 'active', 'paused', 'completed'].includes(label) ? label : 'unknown'
}

export interface SequenceStep {
  step: number
  /** Days to wait before this step (Instantly `delay`, relative to the previous one). */
  delayDays: number
  subject: string
  /** Plain text: HTML tags stripped, whitespace collapsed, capped at 600 chars. */
  body: string
  variants: number
}

const stripHtml = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/** `GET /campaigns/{id}` → the first `limit` steps of the first sequence (variant A). */
export function mapCampaignSequence(body: unknown, limit = 3): SequenceStep[] {
  if (!isObj(body) || !Array.isArray(body.sequences)) return []
  const first = body.sequences[0]
  if (!isObj(first) || !Array.isArray(first.steps)) return []
  const out: SequenceStep[] = []
  for (const s of first.steps) {
    if (out.length >= limit) break
    if (!isObj(s)) continue
    const variants = Array.isArray(s.variants) ? s.variants.filter(isObj) : []
    const a = variants[0] ?? {}
    const text = stripHtml(str(a, 'body') ?? '')
    out.push({
      step: out.length + 1,
      delayDays: num(s, 'delay') ?? 0,
      subject: str(a, 'subject') ?? '',
      body: text.length > 600 ? `${text.slice(0, 600)}…` : text,
      variants: variants.length,
    })
  }
  return out
}
