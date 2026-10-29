import 'server-only'
import { getAnalyticsOverview, isInstantlyConfigured, listCampaigns, mapLimit } from '@/lib/adapters/instantly'
import { listDecidedSince } from '@/lib/actions/store'
import { listAlerts, ALERTS_MAX_LIMIT, type AlertRow } from '@/lib/alertsStore'
import { getCampaigns, getGates, listEventsSince } from '@/lib/db/service'
import { listOpenReplies, type ReplyRow } from '@/lib/inbox/store'
import type { EventRow } from '@/lib/db/types'
import {
  alertsForScope,
  checkinSummary,
  decisionEventsForScope,
  DECISION_EVENT_TYPES,
  instantlyCampaignIds,
  needsConfirmation,
  newRepliesForScope,
  outcomesForScope,
  statsRanges,
  type CheckinItem,
  type CheckinScope,
  type CheckinSummary,
  type DecisionEventItem,
  type NewReplyItem,
  type OutcomeItem,
} from '@/lib/operators/checkin'
import { resolveCampaignQuery, type CampaignLite } from '@/lib/validate/campaignQuery'
import { hasLiveMaster, routeItemForAction, verticalFor } from '@/lib/operators/route'
import { listOperators, listVerticals, touchOperator } from '@/lib/operators/store'
import type { Operator, Vertical } from '@/lib/operators/types'

/**
 * Everything the `/operator` page shows, in one load (server only, after the
 * middleware's owner check). Who is looking decides the scope:
 *  - a vertical Grok Bot: its vertical;
 *  - the master bot: every vertical;
 *  - the owner: `?vertical=<id>`, else every vertical.
 * A bot's visit records its check-in (`touchOperator`); the summary's
 * `last_checked_at` is the check-in before this one.
 */

export interface CampaignStat {
  id: string
  name: string
  today: { sent: number; replies: number; bounced: number } | null
  week: { sent: number; replies: number; bounced: number } | null
  note: string | null
}

export interface CheckinData {
  scope: CheckinScope
  verticals: Vertical[]
  operator: Operator | null
  summary: CheckinSummary
  items: CheckinItem[]
  alerts: AlertRow[]
  /** Unhandled positive replies, newest first (inbox manager). */
  newReplies: NewReplyItem[]
  outcomes: OutcomeItem[]
  /** Gate decisions and campaign picks in the last 24 h (events). */
  decisionEvents: DecisionEventItem[]
  /** Alert id → the vertical name it routes to (null: owner / master). */
  alertVerticals: Record<string, string | null>
  operatorLabels: Record<string, string>
  campaigns: CampaignStat[]
  campaignsNote: string | null
  /** Matches for a several-match campaign-name search (`?cq=`), under the same Instantly budget. */
  campaignMatches: CampaignLite[] | 'unavailable' | null
  /** Parts that failed to load, as fixed text (LOAD_ERRORS); the page still renders the rest. */
  errors: string[]
}

/** All Instantly reads for one page load (stats + a campaign-name search) share this budget. */
export const STATS_BUDGET_MS = 6_000

/**
 * Load problems shown on the page as fixed text (details go to the log): the
 * page is read by a bot, so it never shows a raw error message.
 */
export const LOAD_ERRORS = {
  unknown_vertical: 'That vertical does not exist; showing all verticals.',
  gates: 'Could not load Needs confirmation; reload before deciding anything.',
  alerts: 'Could not load alerts.',
  outcomes: 'Could not load recent actions.',
  operators: 'Could not load the bot list.',
  events: 'Could not load recent gate decisions.',
  checkin: 'Your check-in was not recorded.',
  stats: 'Campaign stats failed this time.',
  replies: 'Could not load new replies.',
} as const
export type LoadError = keyof typeof LOAD_ERRORS

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export async function loadCheckin(opts: {
  operator: Operator | null
  verticalParam: string | null
  /** A several-match campaign-name search to list again (`?cq=` after several_matches). */
  campaignQuery?: string | null
  now?: Date
}): Promise<CheckinData> {
  const now = opts.now ?? new Date()
  const errors: string[] = []
  const fail = (code: LoadError, e?: unknown) => {
    if (e !== undefined) console.error(`[operator] ${code}:`, errText(e))
    errors.push(LOAD_ERRORS[code])
  }
  const op = opts.operator

  const verticals = await listVerticals()
  let scope: CheckinScope = { all: true }
  if (op && !op.is_master) {
    const v = verticals.find((x) => x.id === op.vertical_id)
    // A bot whose vertical was archived still gets a page, scoped to nothing but itself.
    scope = v
      ? { all: false, vertical: v }
      : { all: false, vertical: { id: op.vertical_id ?? '', name: '(archived vertical)', campaign_ids: [], scopes: [], is_default: false, created_at: '', archived_at: now.toISOString() } }
  } else if (!op && opts.verticalParam) {
    const v = verticals.find((x) => x.id === opts.verticalParam)
    if (v) scope = { all: false, vertical: v }
    else fail('unknown_vertical')
  }

  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const [gates, alerts, decided, operators, events, openReplies] = await Promise.all([
    getGates().catch((e) => (fail('gates', e), [])),
    listAlerts({ unackedOnly: true, limit: ALERTS_MAX_LIMIT }).catch((e) => (fail('alerts', e), [] as AlertRow[])),
    listDecidedSince(since).catch((e) => (fail('outcomes', e), [])),
    listOperators({ includeRevoked: true }).catch((e) => (fail('operators', e), [] as Operator[])),
    listEventsSince(DECISION_EVENT_TYPES, since).catch((e) => (fail('events', e), [] as EventRow[])),
    listOpenReplies().catch((e) => (fail('replies', e), [] as ReplyRow[])),
  ])

  // The check-in before this one: the bot's own, or (owner) the latest of the scope's bots.
  const seen = (o: Operator) => o.last_seen_at
  const lastCheckedAt = op
    ? op.last_seen_at
    : operators
        .filter((o) => !o.revoked_at && (scope.all || o.vertical_id === scope.vertical.id))
        .map(seen)
        .filter((s): s is string => !!s)
        .sort()
        .at(-1) ?? null
  if (op) {
    try {
      await touchOperator(op.id)
    } catch (e) {
      fail('checkin', e)
    }
  }

  // A live master bot takes unrouted items instead of the default vertical.
  const routeOpts = { masterLive: hasLiveMaster(operators) }
  const items = needsConfirmation(gates, verticals, scope, routeOpts)
  const scopedAlerts = alertsForScope(alerts, verticals, scope, routeOpts)
  const outcomes = outcomesForScope(decided, verticals, scope, routeItemForAction, routeOpts)
  const decisionEvents = decisionEventsForScope(events, verticals, scope, routeOpts)
  // An awaiting send_reply for a reply (its lume_action gate) is linked from the New replies row.
  const drafts: Record<string, string> = {}
  for (const g of gates) {
    const r = g.kind === 'lume_action' && g.title === 'send_reply' ? g.counts?.reply_to_uuid : null
    if (typeof r === 'string' && r) drafts[r] = g.target_id
  }
  const newReplies = newRepliesForScope(openReplies, verticals, scope, drafts, routeOpts)
  const alertVerticals = Object.fromEntries(scopedAlerts.map((a) => [a.id, verticalFor(a, verticals, routeOpts)?.name ?? null]))
  const operatorLabels = Object.fromEntries(operators.map((o) => [o.id, o.label]))

  // One budget and one AbortSignal for every Instantly read on this page.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), STATS_BUDGET_MS)
  const campaignIds = [...new Set((scope.all ? verticals : [scope.vertical]).flatMap((v) => v.campaign_ids))]
  let stats: { campaigns: CampaignStat[]; note: string | null }
  let campaignMatches: CampaignLite[] | 'unavailable' | null = null
  try {
    const [st, matches] = await Promise.all([
      campaignStats(campaignIds, now, controller.signal).catch((e) => {
        fail('stats', e)
        return { campaigns: [] as CampaignStat[], note: null }
      }),
      opts.campaignQuery ? campaignMatchesFor(opts.campaignQuery, controller.signal) : Promise.resolve(null),
    ])
    stats = st
    campaignMatches = matches
  } finally {
    clearTimeout(timer)
  }

  return {
    scope,
    verticals,
    operator: op,
    summary: checkinSummary({ scope, items, alerts: scopedAlerts, newReplies: newReplies.length, lastCheckedAt, now }),
    items,
    alerts: scopedAlerts,
    newReplies,
    outcomes,
    decisionEvents,
    alertVerticals,
    operatorLabels,
    campaigns: stats.campaigns,
    campaignsNote: stats.note,
    campaignMatches,
    errors,
  }
}

/** The campaigns a several-match name search lists again on /operator; 'unavailable' when Instantly is off or slow. */
async function campaignMatchesFor(query: string, signal: AbortSignal): Promise<CampaignLite[] | 'unavailable'> {
  if (!isInstantlyConfigured()) return 'unavailable'
  try {
    const r = resolveCampaignQuery(query, await listCampaigns({ signal }))
    if (r.kind === 'several') return r.matches
    if (r.kind === 'resolved') return [r.campaign]
    return []
  } catch {
    return 'unavailable'
  }
}

const isAbort = (e: unknown) => e instanceof Error && e.name === 'AbortError'

/**
 * Sent / replies / bounces for today and the last 7 days, per Instantly
 * campaign, from Instantly's analytics overview (the Campaigns screen's
 * source; the adapter caches each call 60 s). Non-Instantly ids (Gmail,
 * Muse) are listed without stats. When the page's budget runs out (`signal`)
 * the campaigns that already answered keep their stats and the rest say so.
 */
async function campaignStats(ids: string[], now: Date, signal: AbortSignal): Promise<{ campaigns: CampaignStat[]; note: string | null }> {
  if (!ids.length) return { campaigns: [], note: 'This vertical has no campaigns mapped yet (Settings → Verticals).' }
  const registry = await getCampaigns().catch(() => [])
  const nameOf = new Map<string, string>()
  for (const c of registry) {
    if (c.external_id) nameOf.set(c.external_id, c.name)
  }
  const instantlyIds = new Set(instantlyCampaignIds(ids))
  const base: CampaignStat[] = ids.map((id) => ({
    id,
    name: nameOf.get(id) ?? id,
    today: null,
    week: null,
    note: instantlyIds.has(id) ? null : 'Not an Instantly campaign: no send stats here',
  }))
  if (!instantlyIds.size) return { campaigns: base, note: null }
  if (!isInstantlyConfigured()) return { campaigns: base, note: 'Instantly is not configured: no send stats.' }

  const ranges = statsRanges(now)
  const pick = (o: { sent: number; replies: number; bounced: number }) => ({ sent: o.sent, replies: o.replies, bounced: o.bounced })
  const got = new Map<string, { today: CampaignStat['today']; week: CampaignStat['week'] } | 'error' | 'timeout'>()
  try {
    for (const c of await listCampaigns({ signal })) if (instantlyIds.has(c.id)) nameOf.set(c.id, c.name)
  } catch {
    // names fall back to the ids
  }
  await mapLimit([...instantlyIds], 4, async (id) => {
    try {
      const [t, w] = await Promise.all([getAnalyticsOverview(id, ranges.today, signal), getAnalyticsOverview(id, ranges.week, signal)])
      got.set(id, { today: pick(t), week: pick(w) })
    } catch (e) {
      got.set(id, isAbort(e) || signal.aborted ? 'timeout' : 'error')
    }
  })
  const slow = [...got.values()].some((v) => v === 'timeout')
  return {
    campaigns: base.map((c) => {
      if (!instantlyIds.has(c.id)) return c
      const name = nameOf.get(c.id) ?? c.name
      const s = got.get(c.id)
      if (!s || s === 'timeout') return { ...c, name, note: 'Instantly was too slow this time (reload to retry)' }
      if (s === 'error') return { ...c, name, note: 'Instantly stats unavailable' }
      return { ...c, name, today: s.today, week: s.week }
    }),
    note: slow ? `Instantly took longer than ${STATS_BUDGET_MS / 1000} s; the campaigns it answered for are shown.` : null,
  }
}
