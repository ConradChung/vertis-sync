import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { buildActionRequest } from '@/lib/actions/build'
import { createAction, DuplicateActionError } from '@/lib/actions/create'
import { PRICES, reactionsMaxChargeUsd } from '@/lib/influencers/model'
import { DuplicateInfluencerError, insertInfluencer, updateInfluencer } from '@/lib/influencers/store'
import { getApifyCapUsd } from '@/lib/settings/store'
import { ownerDate, ownerDayStart, ownerTimeOfDay } from '@/lib/time/owner'
import type { InfluencerRow } from '@/lib/influencers/model'
import type { Json } from '@/lib/db/types'

/**
 * GTM-14 reactions lane: the Monday one-tap card (owner rule "every stage
 * waits on a tap" applies here; the comments-lane exception does not).
 *
 * Once a week (America/Los_Angeles Monday, hour >= 8; or `force` for a manual
 * first run) Frank's posts still `pending` / `held` are filed as ONE
 * `influencer_run` pending action in URL mode, through the same builder and
 * createAction path as the MCP tool `lume_run_influencer_scrape` with
 * post_urls (one card: approving it starts the reactions scrape at the
 * per-post cap). Nothing is spent until the owner taps.
 *
 *  - scheduled: posts from the previous Mon 00:00 – Sun 23:59 PT week;
 *    forced: the last 7 days. Held posts are retried on any later due call
 *    (they fit again once the Apify cycle has reset).
 *  - estimate: Σ min(likes, caps.reactions_per_post) × the shared reactions
 *    price (PRICES.reactions_per_1k, mirrored from _shared/influencer/cost.ts).
 *  - fit: lane (signal_spend reactions_apify this Apify cycle + estimate ≤
 *    caps.reactions_apify_usd) and account (Apify usage this cycle + estimate
 *    ≤ lume_settings.apify_monthly_cap_usd). The cycle comes from Apify's
 *    usageCycle, never a calendar month.
 *  - dry_run: files nothing; notes the posts and returns the card preview.
 *
 * `reactions_status` only moves forward: pending/held → filed (here) →
 * running/done/skipped (the signal-comments ingest).
 */

export const FRANK_PROFILE_URL = 'https://www.linkedin.com/in/frank22/'
export const LANE = 'reactions_apify'
/** The URL-mode card takes at most 10 posts (lib/influencers/postUrls.ts MAX_POST_URLS). */
const MAX_POSTS_PER_CARD = 10
const DAY_MS = 24 * 60 * 60_000

// ---------------------------------------------------------------------------
// Pure

export interface SignalReactionsConfig {
  dry_run: boolean
  profile_url: string
  reactions_apify_usd: number
  reactions_per_post: number
}

/** lume_settings.signal_config → the fields this lane reads (dry_run defaults to true). */
export function parseSignalConfig(v: unknown): SignalReactionsConfig {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  const caps = o.caps && typeof o.caps === 'object' ? (o.caps as Record<string, unknown>) : {}
  const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : d)
  return {
    dry_run: o.dry_run !== false,
    profile_url: typeof o.profile_url === 'string' && o.profile_url ? o.profile_url : FRANK_PROFILE_URL,
    reactions_apify_usd: num(caps.reactions_apify_usd, 8),
    reactions_per_post: Math.min(1000, Math.floor(num(caps.reactions_per_post, 200))),
  }
}

export type DueWindow = { due: false } | { due: true; from: Date; to: Date; mode: 'scheduled' | 'forced' }

/** Monday ≥ 08:00 PT → the previous Mon–Sun PT week; forced → the last 7 days. */
export function dueWindow(now: Date, force: boolean): DueWindow {
  if (force) return { due: true, from: new Date(now.getTime() - 7 * DAY_MS), to: now, mode: 'forced' }
  const today = ownerDate(now)
  const [y, m, d] = today.split('-').map(Number)
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  if (weekday !== 1 || ownerTimeOfDay(now).hour < 8) return { due: false }
  const prevMonday = new Date(Date.UTC(y, m - 1, d - 7)).toISOString().slice(0, 10)
  return { due: true, from: ownerDayStart(prevMonday), to: ownerDayStart(today), mode: 'scheduled' }
}

const cents = (n: number) => Math.round(n * 100) / 100
const fmt = (n: number) => `$${n.toFixed(2)}`

/** One post's reactions at the per-post cap (likes unknown → the cap). */
export function postReactions(likes: number | null | undefined, cap: number): number {
  const l = typeof likes === 'number' && Number.isFinite(likes) ? Math.max(0, Math.floor(likes)) : cap
  return Math.min(l, cap)
}

export function reactionsUsd(reactions: number): number {
  return cents((reactions * PRICES.reactions_per_1k) / 1000)
}

/** Σ min(likes, cap) × the shared reactions price. */
export function estimateReactionsUsd(posts: { likes: number | null }[], cap: number): number {
  return reactionsUsd(posts.reduce((s, p) => s + postReactions(p.likes, cap), 0))
}

export interface ApifyUsage {
  usedUsd: number
  cycleStart: string
  cycleEnd: string
}

/** GET /v2/users/me/usage/monthly → usage this cycle and the cycle bounds; null when unreadable. */
export function parseApifyUsage(body: unknown): ApifyUsage | null {
  const data = body && typeof body === 'object' ? (body as { data?: unknown }).data : null
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const cycle = d.usageCycle && typeof d.usageCycle === 'object' ? (d.usageCycle as Record<string, unknown>) : null
  const start = typeof cycle?.startAt === 'string' && !Number.isNaN(Date.parse(cycle.startAt)) ? cycle.startAt : null
  const end = typeof cycle?.endAt === 'string' && !Number.isNaN(Date.parse(cycle.endAt)) ? cycle.endAt : null
  let used: number | null = null
  for (const k of ['totalUsageCreditsUsdAfterVolumeDiscount', 'totalUsageCreditsUsdBeforeVolumeDiscount']) {
    const v = d[k]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      used = v
      break
    }
  }
  if (used === null || !start || !end) return null
  return { usedUsd: used, cycleStart: start, cycleEnd: end }
}

export interface Fit {
  ok: boolean
  needUsd: number
  leftUsd: number
}

/** Both caps must hold; `left` is the tighter of the two. */
export function fitCheck(a: { needUsd: number; laneSpentUsd: number; laneCapUsd: number; accountUsedUsd: number; accountCapUsd: number }): Fit {
  const laneLeft = a.laneCapUsd - a.laneSpentUsd
  const accountLeft = a.accountCapUsd - a.accountUsedUsd
  const left = Math.max(0, cents(Math.min(laneLeft, accountLeft)))
  return { ok: a.needUsd <= laneLeft + 1e-9 && a.needUsd <= accountLeft + 1e-9, needUsd: a.needUsd, leftUsd: left }
}

export function holdNote(fit: Fit, cycleEnd: string): string {
  return `held: needs ${fmt(fit.needUsd)}, ${fmt(fit.leftUsd)} left; Apify cycle resets ${ownerDate(cycleEnd)}`
}

/** The URL the influencer pipeline turns back into this post id (postIdFromUrl → the activity digits). */
export function postUrlFor(postId: string): string {
  return `https://www.linkedin.com/feed/update/urn:li:activity:${postId}`
}

// ---------------------------------------------------------------------------
// Runner

export interface SignalPost {
  post_id: string
  post_url: string
  posted_at: string
  likes: number | null
  reactions_status: 'pending' | 'held'
}

export interface CardPreview {
  title: string
  posts: { post_id: string; post_url: string; posted_at: string; likes: number | null; reactions_max: number; est_usd: number }[]
  bill: { estimate_usd: number; reactions_max: number; card_usd: number; apify_hard_cap_usd: number; per_post_cap: number }
}

export type FileResult = { ok: true; actionId: string } | { ok: false; error: string }

export interface ReactionsDeps {
  loadConfig(): Promise<SignalReactionsConfig>
  /** pending posts with posted_at in [from, to), plus held posts (any date). */
  candidatePosts(from: Date, to: Date): Promise<SignalPost[]>
  apifyUsage(): Promise<ApifyUsage | null>
  laneSpend(since: string): Promise<number>
  accountCapUsd(): Promise<number>
  /** Conditional: only rows still pending/held change (status only moves forward). */
  patchPosts(ids: string[], patch: Record<string, Json>): Promise<void>
  addNotice(key: string, text: string, status: 'pending' | 'dry_run'): Promise<void>
  /** The MCP tool's path: Frank as influencer + buildActionRequest + createAction. */
  fileCard(profileUrl: string, perPostCap: number, postUrls: string[]): Promise<FileResult>
  reserve(rows: { post_id: string; usd: number }[]): Promise<void>
}

export type ReactionsOutcome =
  | { ok: true; outcome: 'not_due' | 'nothing_to_file' }
  | { ok: true; outcome: 'held'; posts: string[]; note: string }
  | { ok: true; outcome: 'dry_run'; posts: string[]; note: string; preview: CardPreview }
  | { ok: true; outcome: 'filed'; posts: string[]; action_id: string; estimate_usd: number; preview: CardPreview }
  | { ok: false; error: string }

export async function runSignalReactions(now: Date, opts: { force?: boolean }, deps: ReactionsDeps): Promise<ReactionsOutcome> {
  const win = dueWindow(now, opts.force === true)
  if (!win.due) return { ok: true, outcome: 'not_due' }
  const cfg = await deps.loadConfig()
  const all = await deps.candidatePosts(win.from, win.to)
  const posts = [...all].sort((a, b) => Date.parse(a.posted_at) - Date.parse(b.posted_at)).slice(0, MAX_POSTS_PER_CARD)
  if (!posts.length) return { ok: true, outcome: 'nothing_to_file' }
  const ids = posts.map((p) => p.post_id)

  const cap = cfg.reactions_per_post
  const estimate = estimateReactionsUsd(posts, cap)
  const cardReactions = posts.length * cap
  const cardUsd = reactionsUsd(cardReactions)
  const preview: CardPreview = {
    title: `Frank's posts · ${posts.length} post${posts.length === 1 ? '' : 's'} · reactions scrape (≤${cap}/post)`,
    posts: posts.map((p) => ({
      post_id: p.post_id, post_url: postUrlFor(p.post_id), posted_at: p.posted_at, likes: p.likes,
      reactions_max: postReactions(p.likes, cap), est_usd: reactionsUsd(postReactions(p.likes, cap)),
    })),
    bill: { estimate_usd: estimate, reactions_max: cardReactions, card_usd: cardUsd, apify_hard_cap_usd: reactionsMaxChargeUsd(cardUsd), per_post_cap: cap },
  }

  const usage = await deps.apifyUsage()
  if (!usage) return { ok: false, error: 'Apify usage unreadable (needs APIFY_API_TOKEN and usageCycle); nothing filed' }
  const [laneSpent, accountCap] = await Promise.all([deps.laneSpend(usage.cycleStart), deps.accountCapUsd()])
  const fit = fitCheck({ needUsd: estimate, laneSpentUsd: laneSpent, laneCapUsd: cfg.reactions_apify_usd, accountUsedUsd: usage.usedUsd, accountCapUsd: accountCap })
  if (!fit.ok) {
    const note = holdNote(fit, usage.cycleEnd)
    await deps.patchPosts(ids, { reactions_status: 'held', reactions_note: note })
    await deps.addNotice(`hold:reactions:${usage.cycleStart}`, `Frank reactions lane ${note}`, cfg.dry_run ? 'dry_run' : 'pending')
    return { ok: true, outcome: 'held', posts: ids, note }
  }

  if (cfg.dry_run) {
    const note = `dry_run: would file ${posts.length} posts, est ${fmt(estimate)}, per-post cap ${cap}`
    await deps.patchPosts(ids, { reactions_note: note })
    return { ok: true, outcome: 'dry_run', posts: ids, note, preview }
  }

  const filed = await deps.fileCard(cfg.profile_url, cap, posts.map((p) => postUrlFor(p.post_id)))
  if (!filed.ok) return { ok: false, error: filed.error }
  await deps.patchPosts(ids, {
    reactions_status: 'filed', reactions_action_id: filed.actionId,
    reactions_note: `filed: one-tap card ${filed.actionId}, est ${fmt(estimate)}, per-post cap ${cap}`,
  })
  await deps.reserve(posts.map((p) => ({ post_id: p.post_id, usd: reactionsUsd(postReactions(p.likes, cap)) })))
  return { ok: true, outcome: 'filed', posts: ids, action_id: filed.actionId, estimate_usd: estimate, preview }
}

// ---------------------------------------------------------------------------
// Live deps (service role; the route runs after requireSecret)

/** https://(www.)linkedin.com/in/<handle>(/) → the spellings the influencers table may hold. */
export function profileUrlVariants(url: string): string[] {
  const m = url.trim().match(/^https:\/\/(?:www\.)?linkedin\.com\/in\/([^/?#\s]+)\/?$/)
  if (!m) return [url]
  const h = m[1]
  return [`https://www.linkedin.com/in/${h}`, `https://www.linkedin.com/in/${h}/`, `https://linkedin.com/in/${h}`, `https://linkedin.com/in/${h}/`]
}

const INFLUENCER_COLS = 'id, name, slug, linkedin_url, max_reactions_per_post, active'

/**
 * Frank as an influencer, by profile URL. Missing → created through Lume's own
 * add-influencer insert (insertInfluencer, as POST /api/influencers) with the
 * lane's per-post cap; a different per-post cap → set through updateInfluencer,
 * since the URL-mode card bills max_reactions_per_post per post.
 */
async function ensureFrank(profileUrl: string, cap: number): Promise<{ ok: true; slug: string } | { ok: false; error: string }> {
  const sb = createServiceClient()
  const res = await sb.from('influencers').select(INFLUENCER_COLS).in('linkedin_url', profileUrlVariants(profileUrl)).limit(1)
  if (res.error) return { ok: false, error: `influencers lookup: ${res.error.message}` }
  let row = ((res.data ?? [])[0] as Pick<InfluencerRow, 'slug' | 'active' | 'max_reactions_per_post'> | undefined) ?? null
  if (!row) {
    const handle = profileUrl.match(/\/in\/([^/?#\s]+)/)?.[1]?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') ?? ''
    if (!handle) return { ok: false, error: 'add Frank as an influencer in Lume' }
    try {
      row = await insertInfluencer({
        name: 'Frank', slug: handle, linkedin_url: profileUrlVariants(profileUrl)[0], max_reactions_per_post: cap,
        notes: 'GTM-14 reactions lane (added by /api/cron/signal-reactions)',
      })
    } catch (err) {
      if (err instanceof DuplicateInfluencerError) return { ok: false, error: 'add Frank as an influencer in Lume (slug taken by another influencer)' }
      throw err
    }
  }
  if (!row.active) return { ok: false, error: 'Frank is an inactive influencer in Lume; reactivate him' }
  if (row.max_reactions_per_post !== cap) {
    const up = await updateInfluencer(row.slug, { max_reactions_per_post: cap })
    if (!up) return { ok: false, error: 'could not set Frank\'s per-post reactions cap' }
  }
  return { ok: true, slug: row.slug }
}

export const liveDeps: ReactionsDeps = {
  async loadConfig() {
    const res = await createServiceClient().from('lume_settings').select('value').eq('key', 'signal_config').maybeSingle()
    if (res.error) throw new Error(`signal_config: ${res.error.message}`)
    return parseSignalConfig(res.data?.value)
  },
  async candidatePosts(from, to) {
    const sb = createServiceClient()
    const cols = 'post_id, post_url, posted_at, likes, reactions_status'
    const [pending, held] = await Promise.all([
      sb.from('signal_posts').select(cols).eq('reactions_status', 'pending').gte('posted_at', from.toISOString()).lt('posted_at', to.toISOString()),
      sb.from('signal_posts').select(cols).eq('reactions_status', 'held'),
    ])
    if (pending.error || held.error) throw new Error(`signal_posts: ${(pending.error ?? held.error)!.message}`)
    return [...(pending.data ?? []), ...(held.data ?? [])] as SignalPost[]
  },
  async apifyUsage() {
    const token = process.env.APIFY_API_TOKEN?.trim()
    if (!token) return null
    try {
      const res = await fetch('https://api.apify.com/v2/users/me/usage/monthly', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) return null
      return parseApifyUsage(await res.json())
    } catch {
      return null
    }
  },
  async laneSpend(since) {
    const res = await createServiceClient().rpc('signal_lane_spend', { p_lanes: [LANE], p_since: since })
    if (res.error) throw new Error(`signal_lane_spend: ${res.error.message}`)
    return Number(res.data) || 0
  },
  accountCapUsd: getApifyCapUsd,
  async patchPosts(ids, patch) {
    const res = await createServiceClient()
      .from('signal_posts')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .in('post_id', ids)
      .in('reactions_status', ['pending', 'held'])
    if (res.error) throw new Error(`signal_posts update: ${res.error.message}`)
  },
  async addNotice(key, text, status) {
    const res = await createServiceClient().from('signal_notices').upsert({ key, text, status }, { onConflict: 'key', ignoreDuplicates: true })
    if (res.error) throw new Error(`signal_notices: ${res.error.message}`)
  },
  async fileCard(profileUrl, cap, postUrls) {
    const frank = await ensureFrank(profileUrl, cap)
    if (!frank.ok) return frank
    const built = await buildActionRequest({ kind: 'influencer_run', payload: { slugs: [frank.slug], post_urls: postUrls } })
    if (!built.ok) return { ok: false, error: `influencer_run refused (${built.error}); nothing filed` }
    try {
      const row = await createAction(built.kind, built.payload, 'rule', { ruleId: built.ruleId ?? null })
      return { ok: true, actionId: row.id }
    } catch (err) {
      if (err instanceof DuplicateActionError) return { ok: false, error: `an influencer_run already awaits approval (${err.existingId}); retry after it is decided` }
      throw err
    }
  },
  async reserve(rows) {
    if (!rows.length) return
    const res = await createServiceClient()
      .from('signal_spend')
      .insert(rows.map((r) => ({ lane: LANE, kind: 'reactions', status: 'reserved', usd: r.usd, post_id: r.post_id })))
    if (res.error) throw new Error(`signal_spend reserve: ${res.error.message}`)
  },
}
