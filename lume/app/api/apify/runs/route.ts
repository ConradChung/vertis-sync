import { NextResponse } from 'next/server'
import { requireOwner } from '@/lib/auth/guards'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * `GET /api/apify/runs` — the most recent actor runs the owner approved
 * (executed `run_actor` actions), newest first, with the run id the agent
 * needs for get_actor_run / import_actor_run. Read-only.
 */
export async function GET(req: Request) {
  const auth = await requireOwner(req)
  if (!auth.ok) return auth.response
  const limit = Math.min(20, Math.max(1, Number(new URL(req.url).searchParams.get('limit')) || 5))
  const res = await createServiceClient()
    .from('pending_actions')
    .select('id,status,created_at,decided_at,result,error')
    .eq('kind', 'run_actor')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (res.error) return NextResponse.json({ error: 'db_error' }, { status: 500 })
  const runs = (res.data ?? []).map((a) => {
    const r = (a.result ?? {}) as Record<string, unknown>
    return {
      action_id: a.id,
      action_status: a.status,
      approved_at: a.decided_at ?? null,
      created_at: a.created_at,
      actor_id: r.actor_id ?? null,
      run_id: r.run_id ?? null,
      dataset_id: r.dataset_id ?? null,
      console_url: r.console_url ?? null,
      error: a.error ?? null,
    }
  })
  return NextResponse.json({ runs })
}
