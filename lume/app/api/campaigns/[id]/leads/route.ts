import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { isInstantlyConfigured } from '@/lib/adapters/instantly'
import { listCampaignLeads, MAX_LIST } from '@/lib/adapters/instantlyLeads'
import { LEAD_STATES, parseLeadQuery } from '@/lib/adapters/instantlyLeads.map'
import { campaignIdParam } from '@/lib/campaigns/params'
import { instantlyErrorResponse, notConfigured } from '@/lib/http/instantly'
import { archivedLeadHistory } from '@/lib/leads/cycledStore'
import { historyNote } from '@/lib/leads/history'

/**
 * One Instantly campaign's leads in a state (read-only, uncached):
 * `?state=finished_no_reply|replied|bounced|contacted|interested|no_reply_after_days:N`
 * and `?limit=` (default 100, max 1000). Scans at most 2,000 leads (removals scan 5,000);
 * `truncated` says when there may be more. The agent's `list_campaign_leads`.
 *
 * Instantly only lists leads still uploaded (`scope: in_instantly_now`). The
 * rotator and remove_leads delete finished, bounced and replied leads, so
 * `history` adds the campaign's lead_bank rows that already left Instantly
 * (replied / bounced / finished_no_reply), with a `note` when they exist.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const id = campaignIdParam((await ctx.params).id)
  if (!id) return NextResponse.json({ error: 'bad_campaign_id' }, { status: 400 })
  const sp = new URL(req.url).searchParams
  const query = parseLeadQuery(sp.get('state') ?? '')
  if (!query) {
    return NextResponse.json({ error: 'bad_state', allowed: [...LEAD_STATES.filter((s) => s !== 'no_reply_after_days'), 'no_reply_after_days:N'] }, { status: 400 })
  }
  const limitRaw = Number(sp.get('limit') ?? 100)
  const limit = Number.isInteger(limitRaw) && limitRaw >= 1 ? Math.min(limitRaw, MAX_LIST) : 100
  if (!isInstantlyConfigured()) return notConfigured()
  try {
    const [r, hist] = await Promise.all([
      listCampaignLeads(id, query, { limit }),
      archivedLeadHistory(id).then(
        (h) => ({ ok: true as const, h }),
        (err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) })
      ),
    ])
    const extra: Record<string, unknown> = {}
    if (hist.ok) {
      const { removed_by_lume, ...gone } = hist.h
      extra.history = { source: 'lead_bank', no_longer_in_instantly: gone, removed_by_lume }
      const note = historyNote(gone)
      if (note) extra.note = note
    } else {
      console.error('[api/campaigns/[id]/leads] history failed:', hist.error)
      extra.history_error = 'lead history unavailable'
    }
    return NextResponse.json({ configured: true, campaign_id: id, state: sp.get('state'), scope: 'in_instantly_now', ...r, returned: r.leads.length, ...extra })
  } catch (err) {
    return instantlyErrorResponse(err, 'api/campaigns/[id]/leads')
  }
}
