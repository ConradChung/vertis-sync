import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { getAnalyticsOverview, isInstantlyConfigured, listCampaigns, mapLimit } from '@/lib/adapters/instantly'
import type { AnalyticsOverview, InstantlyCampaign } from '@/lib/adapters/instantly.map'
import { getLastActivity } from '@/lib/campaigns/service'
import type { CampaignTableResponse, CampaignTableRow, InstantlyState } from '@/lib/campaigns/types'
import { getCampaigns, getQueuedCounts } from '@/lib/db/service'
import type { LumeCampaignRow } from '@/lib/db/types'
import { dbErrorResponse } from '@/lib/http/errors'
import { rotatorCampaignId } from '@/lib/rules/rotator'

/**
 * `lume_campaigns` rows (default — the registry shape other screens use),
 * each with `queued` (lead_bank rows waiting for that campaign) and `rotator`
 * (true for the one campaign the existing `instantly-rotate` cron drains;
 * every other campaign's queue just waits).
 *
 * `?with=analytics` (Campaigns screen): one row per campaign across all
 * families — `lume_campaigns` merged with Instantly's own list (Instantly
 * campaigns not registered yet appear as family `other`), each Instantly row
 * with its `analytics/overview` totals, plus last activity from `events`.
 * Instantly down or unconfigured degrades to the registry rows with nulls.
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  try {
    const campaigns = await getCampaigns()
    if (new URL(req.url).searchParams.get('with') === 'analytics') return NextResponse.json(await buildTable(campaigns))
    const queued = await getQueuedCounts(campaigns.map((c) => c.external_id ?? ''))
    const rotator = rotatorCampaignId()
    return NextResponse.json(
      campaigns.map((c) => ({
        ...c,
        queued: c.external_id ? (queued[c.external_id] ?? 0) : 0,
        rotator: c.external_id === rotator,
      }))
    )
  } catch (err) {
    return dbErrorResponse(err, 'api/campaigns')
  }
}

function guessFamily(name: string): LumeCampaignRow['family'] {
  if (/kaspen|zenport|property|\bpm\b/i.test(name)) return 'kaspen'
  if (/recruit|gtm|job/i.test(name)) return 'recruiter'
  if (/muse/i.test(name)) return 'muse'
  return 'other'
}

async function buildTable(registry: LumeCampaignRow[]): Promise<CampaignTableResponse> {
  let instantly: InstantlyState = isInstantlyConfigured() ? 'ok' : 'not_configured'
  let list: InstantlyCampaign[] = []
  const stats = new Map<string, AnalyticsOverview>()
  if (instantly === 'ok') {
    try {
      list = await listCampaigns()
      const results = await mapLimit(list, 4, async (c) => {
        try {
          return [c.id, await getAnalyticsOverview(c.id)] as const
        } catch {
          return null
        }
      })
      for (const r of results) if (r) stats.set(r[0], r[1])
    } catch (err) {
      console.error('[api/campaigns] instantly:', err instanceof Error ? err.message : err)
      instantly = 'error'
    }
  }

  const byInstantly = new Map(list.map((c) => [c.id, c]))
  const rows: CampaignTableRow[] = []
  const seen = new Set<string>()
  const withStats = (id: string | null) => {
    const s = id ? stats.get(id) : undefined
    return {
      sent: s?.sent ?? null,
      replies: s?.replies ?? null,
      reply_rate: s?.reply_rate ?? null,
      opportunities: s?.opportunities ?? null,
      bounced: s?.bounced ?? null,
    }
  }

  for (const r of registry) {
    const instantlyId = r.sender_type === 'instantly' && r.external_id ? r.external_id : null
    const live = instantlyId ? byInstantly.get(instantlyId) : undefined
    if (instantlyId) seen.add(instantlyId)
    rows.push({
      key: instantlyId ?? `lume:${r.id}`,
      instantly_id: instantlyId,
      lume_id: r.id,
      name: live?.name ?? r.name,
      family: r.family,
      sender_type: r.sender_type,
      status: live?.statusLabel ?? r.status,
      ...withStats(instantlyId),
      last_activity: null,
    })
  }
  for (const c of list) {
    if (seen.has(c.id)) continue
    rows.push({
      key: c.id,
      instantly_id: c.id,
      lume_id: null,
      name: c.name,
      family: guessFamily(c.name),
      sender_type: 'instantly',
      status: c.statusLabel,
      ...withStats(c.id),
      last_activity: null,
    })
  }

  const activityIds = rows.map((r) => r.instantly_id ?? registry.find((x) => x.id === r.lume_id)?.external_id ?? '')
  const last = await getLastActivity(activityIds).catch(() => ({}) as Record<string, string>)
  rows.forEach((r, i) => (r.last_activity = last[activityIds[i]] ?? null))

  return { campaigns: rows, instantly }
}
