import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { createServiceClient } from '@/lib/supabase/service'
import { dbErrorResponse } from '@/lib/http/errors'
import { uuidParam } from '@/lib/http/json'
import { nextRotation } from '@/lib/progress/bank'

/**
 * Where a banked push stands (owner, 2026-11-09: "it keeps saying 0 pushed"):
 * how many of this job's leads are still queued vs already rotated into
 * Instantly, how full Instantly is (the last rotation run), how many other
 * campaigns' leads are queued ahead of it (rotation is oldest-first), and the
 * next rotation time (pg_cron 13:00 and 01:00 UTC).
 *   GET → { queued, in_instantly, done, in_instantly_total, cap, last_run_at, ahead, next_run_at }
 */
type Ctx = { params: Promise<{ id: string }> }

const CAP = 25000 // Instantly plan contact limit (upgraded 2026-11-12)

export async function GET(req: Request, ctx: Ctx) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const jobId = uuidParam((await ctx.params).id)
  if (!jobId) return NextResponse.json({ error: 'bad_job_id' }, { status: 400 })
  const sb = createServiceClient()
  try {
    const count = async (state: string[]) => {
      const r = await sb.from('lead_bank').select('id', { count: 'exact', head: true }).eq('source_job_id', jobId).in('state', state)
      if (r.error) throw r.error
      return r.count ?? 0
    }
    const [queued, inInstantly, done, oldest, run] = await Promise.all([
      count(['queued']),
      count(['active']),
      count(['completed', 'bounced', 'skipped', 'orphaned']),
      sb.from('lead_bank').select('created_at,campaign_id').eq('source_job_id', jobId).eq('state', 'queued').order('created_at').limit(1).maybeSingle(),
      sb.from('rotation_runs').select('ran_at,in_instantly_after').order('ran_at', { ascending: false }).limit(1).maybeSingle(),
    ])
    let ahead = 0
    if (oldest.data) {
      const a = await sb
        .from('lead_bank')
        .select('id', { count: 'exact', head: true })
        .eq('state', 'queued')
        .lt('created_at', oldest.data.created_at)
        .or(`source_job_id.is.null,source_job_id.neq.${jobId}`)
      if (a.error) throw a.error
      ahead = a.count ?? 0
    }
    return NextResponse.json({
      queued,
      in_instantly: inInstantly,
      done,
      in_instantly_total: run.data?.in_instantly_after ?? null,
      cap: CAP,
      last_run_at: run.data?.ran_at ?? null,
      ahead,
      next_run_at: nextRotation(new Date()),
    })
  } catch (err) {
    return dbErrorResponse(err, 'api/jobs/bank')
  }
}
