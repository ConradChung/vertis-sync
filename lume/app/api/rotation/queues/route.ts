import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { isInstantlyConfigured, listCampaigns } from '@/lib/adapters/instantly'
import { createServiceClient } from '@/lib/supabase/service'
import { dbErrorResponse } from '@/lib/http/errors'
import { nextRotation } from '@/lib/progress/bank'
import { bankBlockers, groupQueues, type QueueRow } from '@/lib/rotation/queues'

/**
 * GET → { tags: TagQueues[], in_instantly, cap, last_run_at, next_run_at, blockers }:
 * the lead bank by tag → campaign, how full Instantly is (the last rotation
 * run) and when the next one runs. Campaign names / statuses come from
 * Instantly (best effort: ids when it can't be read).
 */
const CAP = 1000

export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const sb = createServiceClient()
  try {
    const [q, v, run] = await Promise.all([
      sb.rpc('lume_lead_bank_queues'),
      sb.from('lume_verticals').select('id,name,campaign_ids').is('archived_at', null),
      sb.from('rotation_runs').select('ran_at,in_instantly_after').order('ran_at', { ascending: false }).limit(1).maybeSingle(),
    ])
    if (q.error) throw q.error
    if (v.error) throw v.error
    const names = new Map<string, { name: string; status: string | null }>()
    if (isInstantlyConfigured()) {
      try {
        for (const c of await listCampaigns()) names.set(c.id, { name: c.name, status: c.statusLabel ?? null })
      } catch (err) {
        console.error('[api/rotation/queues] campaign names failed:', err instanceof Error ? err.message : err)
      }
    }
    const tags = groupQueues((q.data ?? []) as QueueRow[], names, (v.data ?? []) as { id: string; name: string; campaign_ids: string[] | null }[])
    const inInstantly = run.data?.in_instantly_after ?? null
    return NextResponse.json({
      tags,
      in_instantly: inInstantly,
      cap: CAP,
      last_run_at: run.data?.ran_at ?? null,
      next_run_at: nextRotation(new Date()),
      blockers: bankBlockers(tags, inInstantly, CAP),
    })
  } catch (err) {
    return dbErrorResponse(err, 'api/rotation/queues')
  }
}
