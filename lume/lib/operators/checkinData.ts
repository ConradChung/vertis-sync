import 'server-only'
import { getAnalyticsOverview, isInstantlyConfigured, listCampaigns, mapLimit } from '@/lib/adapters/instantly'
import { listDecidedSince } from '@/lib/actions/store'
import { listAlerts, ALERTS_MAX_LIMIT, type AlertRow } from '@/lib/alertsStore'
import { getCampaigns, getGates } from '@/lib/db/service'
import {
  alertsForScope,
  checkinSummary,
  instantlyCampaignIds,
  needsConfirmation,
  outcomesForScope,
  statsRanges,
  type CheckinItem,
  type CheckinScope,
  type CheckinSummary,
  type OutcomeItem,
} from '@/lib/operators/checkin'
import { routeItemForAction } from '@/lib/operators/route'
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
  outcomes: OutcomeItem[]
  operatorLabels: Record<string, string>
  campaigns: CampaignStat[]
  campaignsNote: string | null
  /** Parts that failed to load (the page still renders the rest). */
  errors: string[]
}

/** Instantly stats get this long in total; slower → the page says so and shows what it has. */
export const STATS_BUDGET_MS = 6_000

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export async function loadCheckin(opts: { operator: Operator | null; verticalParam: string | null; now?: Date }): Promise<CheckinData> {
  const now = opts.now ?? new Date()
  const errors: string[] = []
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
    else errors.push(`Unknown vertical ${opts.verticalParam}; showing all verticals`)
  }

  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const [gates, alerts, decided, operators] = await Promise.all([
    getGates().catch((e) => (errors.push(`gates: ${errText(e)}`), [])),
    listAlerts({ unackedOnly: true, limit: ALERTS_MAX_LIMIT }).catch((e) => (errors.push(`alerts: ${errText(e)}`), [] as AlertRow[])),
    listDecidedSince(since).catch((e) => (errors.push(`outcomes: ${errText(e)}`), [])),
    listOperators({ includeRevoked: true }).catch((e) => (errors.push(`operators: ${errText(e)}`), [] as Operator[])),
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
      errors.push(`check-in not recorded: ${errText(e)}`)
    }
  }

  const items = needsConfirmation(gates, verticals, scope)
  const scopedAlerts = alertsForScope(alerts, verticals, scope)
  const outcomes = outcomesForScope(decided, verticals, scope, routeItemForAction)
  const operatorLabels = Object.fromEntries(operators.map((o) => [o.id, o.label]))

  const campaignIds = [...new Set((scope.all ? verticals : [scope.vertical]).flatMap((v) => v.campaign_ids))]
  const { campaigns, note } = await campaignStats(campaignIds, now).catch((e) => ({
    campaigns: [] as CampaignStat[],
    note: `Campaign stats failed: ${errText(e)}`,
  }))

  return {
    scope,
    verticals,
    operator: op,
    summary: checkinSummary({ scope, items, alerts: scopedAlerts, lastCheckedAt, now }),
    items,
    alerts: scopedAlerts,
    outcomes,
    operatorLabels,
    campaigns,
    campaignsNote: note,
    errors,
  }
}

/**
 * Sent / replies / bounces for today and the last 7 days, per Instantly
 * campaign, from Instantly's analytics overview (the Campaigns screen's
 * source; the adapter caches each call 60 s). Non-Instantly ids (Gmail,
 * Muse) are listed without stats. Capped at STATS_BUDGET_MS overall.
 */
async function campaignStats(ids: string[], now: Date): Promise<{ campaigns: CampaignStat[]; note: string | null }> {
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
  const work = (async () => {
    const list = await listCampaigns().catch(() => [])
    for (const c of list) if (instantlyIds.has(c.id)) nameOf.set(c.id, c.name)
    const stats = await mapLimit([...instantlyIds], 4, async (id) => {
      try {
        const [t, w] = await Promise.all([getAnalyticsOverview(id, ranges.today), getAnalyticsOverview(id, ranges.week)])
        return [id, { t, w }] as const
      } catch {
        return [id, null] as const
      }
    })
    return { stats: new Map(stats), names: nameOf }
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((r) => {
    timer = setTimeout(() => r('timeout'), STATS_BUDGET_MS)
  })
  const got = await Promise.race([work, timeout])
  if (timer) clearTimeout(timer)
  if (got === 'timeout') {
    return { campaigns: base, note: `Instantly took longer than ${STATS_BUDGET_MS / 1000} s; stats skipped this time (reload to retry).` }
  }
  const pick = (o: { sent: number; replies: number; bounced: number }) => ({ sent: o.sent, replies: o.replies, bounced: o.bounced })
  return {
    campaigns: base.map((c) => {
      const s = got.stats.get(c.id)
      const name = got.names.get(c.id) ?? c.name
      if (!instantlyIds.has(c.id)) return c
      if (!s) return { ...c, name, note: 'Instantly stats unavailable' }
      return { ...c, name, today: pick(s.t), week: pick(s.w) }
    }),
    note: null,
  }
}
