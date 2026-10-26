'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRealtimeInvalidate } from '@/hooks/useRealtimeInvalidate'
import { STALE_RUN_MS, withStaleRun, type OrbRun } from '@/lib/agent/orbState'

/**
 * The latest `agent_runs` row (RLS: owner only) plus whether its approval
 * action has been decided, kept fresh by Realtime on `agent_runs` and
 * `pending_actions`. Drives the orb on every screen.
 */
export function useLatestAgentRun(): { run: OrbRun | null; approvalSettled: boolean } {
  const [run, setRun] = useState<OrbRun | null>(null)
  const [approvalSettled, setApprovalSettled] = useState(false)

  const load = useCallback(async () => {
    const sb = createClient()
    const { data, error } = await sb
      .from('agent_runs')
      .select('id,status,tool_calls,approval_action_id,created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) return
    // A `running` row older than 6 min is a killed run: show it as failed.
    const latest = withStaleRun((data as OrbRun | null) ?? null)
    setRun(latest)
    if (latest?.status === 'needs_approval' && latest.approval_action_id) {
      const { data: action } = await sb
        .from('pending_actions')
        .select('status')
        .eq('id', latest.approval_action_id)
        .maybeSingle()
      setApprovalSettled(!!action && (action as { status: string }).status !== 'awaiting')
    } else {
      setApprovalSettled(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Re-read when a running run crosses the stale line (no Realtime event marks it).
  useEffect(() => {
    if (run?.status !== 'running' || !run.created_at) return
    const due = Date.parse(run.created_at) + STALE_RUN_MS - Date.now()
    if (!Number.isFinite(due)) return
    const t = setTimeout(() => void load(), Math.max(0, due) + 1000)
    return () => clearTimeout(t)
  }, [run, load])

  useRealtimeInvalidate(() => void load(), { tables: ['agent_runs', 'pending_actions'], debounceMs: 150 })

  return { run, approvalSettled }
}
