import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import type { CheckPlan, CheckScope, Fit, PropertyType } from '@/lib/companyCheck/model'

/**
 * Company check reads (service role, behind the owner guard). Lume only reads
 * here: runs, items and the cache are written by the company-check edge
 * function after the owner approves a `company_check` pending action.
 */

export interface CheckJob {
  id: string
  filename: string | null
  display_name: string | null
  status: string | null
  icp_description: string | null
  instantly_campaign_name: string | null
  /** The job's tag (lume_verticals.name), when tagged. */
  vertical_name: string | null
}

export interface CheckRun {
  id: string
  job_id: string
  icp_description: string
  icp_key: string
  scope: CheckScope
  status: 'staged' | 'running' | 'done' | 'capped' | 'cancelled' | 'failed'
  companies_total: number
  estimate_usd: number | string | null
  max_usd: number | string | null
  spent_usd: number | string
  error: string | null
  created_at: string
  updated_at: string
  finished_at: string | null
}

export interface CheckSummary {
  items: Record<string, number>
  companies_by_fit: Record<string, number>
  leads_by_fit: Record<string, number>
  companies_by_type: Record<string, number>
  leads_by_type: Record<string, number>
}

export interface CheckResultRow {
  company_key: string
  company_name: string | null
  website: string | null
  leads: number
  status: 'pending' | 'cached' | 'done' | 'error'
  error: string | null
  what_it_does: string | null
  icp_fit: 'fit' | 'not_fit' | 'unclear' | null
  confidence: 'high' | 'medium' | 'low' | null
  evidence: string | null
  evidence_url: string | null
  property_type: PropertyType | null
  doors: number | null
  doors_evidence: string | null
}

const RUN_COLS = 'id,job_id,icp_description,icp_key,scope,status,companies_total,estimate_usd,max_usd,spent_usd,error,created_at,updated_at,finished_at'
const RESULT_COLS = 'company_key,company_name,website,leads,status,error,what_it_does,icp_fit,confidence,evidence,evidence_url,property_type,doors,doors_evidence'
const db = () => createServiceClient()

export async function getCheckJob(id: string): Promise<CheckJob | null> {
  const sb = db()
  const res = await sb.from('validation_jobs').select('id,filename,display_name,status,icp_description,instantly_campaign_name,vertical_id').eq('id', id).maybeSingle()
  if (res.error) throw new DbError('getCheckJob', res.error)
  const row = res.data as (Omit<CheckJob, 'vertical_name'> & { vertical_id: string | null }) | null
  if (!row) return null
  const { vertical_id, ...job } = row
  let vertical_name: string | null = null
  if (vertical_id) {
    const v = await sb.from('lume_verticals').select('name').eq('id', vertical_id).maybeSingle()
    if (v.error) throw new DbError('getCheckJob.vertical', v.error)
    vertical_name = (v.data as { name: string } | null)?.name ?? null
  }
  return { ...job, vertical_name }
}

export async function checkPlan(jobId: string, icp: string, scope: CheckScope = 'all'): Promise<CheckPlan> {
  const res = await db().rpc('company_check_plan', { p_job_id: jobId, p_icp: icp, p_scope: scope })
  if (res.error) throw new DbError('checkPlan', res.error)
  return res.data as CheckPlan
}

export async function getCheckRun(jobId: string, icpKey: string, scope: CheckScope = 'all'): Promise<CheckRun | null> {
  const res = await db().from('company_check_runs').select(RUN_COLS).eq('job_id', jobId).eq('icp_key', icpKey).eq('scope', scope).maybeSingle()
  if (res.error) throw new DbError('getCheckRun', res.error)
  return (res.data as CheckRun | null) ?? null
}

export async function checkSummary(runId: string): Promise<CheckSummary> {
  const res = await db().rpc('company_check_summary', { p_run_id: runId })
  if (res.error) throw new DbError('checkSummary', res.error)
  return res.data as CheckSummary
}

/** A page of a run's companies with their verdicts, most leads first; optionally one verdict and / or one property type. */
export async function listCheckResults(runId: string, opts: { fit?: Fit; type?: PropertyType; limit?: number; offset?: number } = {}): Promise<CheckResultRow[]> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50))
  const offset = Math.max(0, opts.offset ?? 0)
  let q = db().from('company_check_results').select(RESULT_COLS).eq('run_id', runId)
  if (opts.fit) q = q.eq('icp_fit', opts.fit)
  if (opts.type === 'unknown') q = q.not('icp_fit', 'is', null).or('property_type.is.null,property_type.eq.unknown')
  else if (opts.type) q = q.eq('property_type', opts.type)
  const res = await q.order('leads', { ascending: false }).order('company_key').range(offset, offset + limit - 1)
  if (res.error) throw new DbError('listCheckResults', res.error)
  return (res.data ?? []) as CheckResultRow[]
}

/** Running runs and those finished in the last day (the Progress page). */
export async function recentCheckRuns(sinceIso: string): Promise<(CheckRun & { job_name: string | null })[]> {
  const sb = db()
  const res = await sb
    .from('company_check_runs')
    .select(RUN_COLS)
    .or(`status.eq.running,and(status.in.(done,capped,failed,cancelled),updated_at.gte.${sinceIso})`)
    .order('created_at', { ascending: false })
    .limit(20)
  if (res.error) throw new DbError('recentCheckRuns', res.error)
  const runs = (res.data ?? []) as CheckRun[]
  if (!runs.length) return []
  const jobs = await sb.from('validation_jobs').select('id,filename,display_name').in('id', [...new Set(runs.map((r) => r.job_id))])
  if (jobs.error) throw new DbError('recentCheckRuns.jobs', jobs.error)
  const names = new Map((jobs.data ?? []).map((j: { id: string; filename: string | null; display_name: string | null }) => [j.id, j.display_name ?? j.filename]))
  return runs.map((r) => ({ ...r, job_name: names.get(r.job_id) ?? null }))
}
