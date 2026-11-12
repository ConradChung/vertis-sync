import 'server-only'
import { z } from 'zod'
import type { Json, PendingActionKind } from '@/lib/db/types'
import { callInfluencerFn } from '@/lib/adapters/influencerFn'
import {
  CHECK_APPROVAL_LIMIT_USD,
  CHECK_USD_PER_COMPANY,
  DEFAULT_ICP,
  estimateCheck,
  PRICING_SOURCES,
  type CheckEstimate,
  type CheckPlan,
} from '@/lib/companyCheck/model'
import { checkPlan, checkSummary, getCheckJob, getCheckRun, listCheckResults, type CheckJob, type CheckResultRow, type CheckRun, type CheckSummary } from '@/lib/companyCheck/store'

/**
 * `company_check`: the paid per-company check of a validation job's valid
 * leads (check_companies). Always asks: it spends Perplexity + Haiku money.
 *
 *  overview  the job, the ICP used (the owner's, else the job's, else the
 *            enricher's default), the plan (valid leads, distinct companies,
 *            those already cached for this ICP), the estimate for the rest
 *            and where each price comes from, the run's progress and results.
 *  build     { job_id, icp?, max_usd? } → the companies still unchecked x
 *            $0.00695 and a hard cap (default +10 %, at most $50 per approval)
 *            the edge function stops at (status 'capped').
 *  execute   re-checks the job and the plan (still something to check, no run
 *            in progress), then starts company-check with the approved cap
 *            and this action's id (a retried start for the same id is a no-op).
 */

const fmt = (n: number) => `$${n.toFixed(2)}`
const usdNum = (v: number | string | null | undefined) => (v === null || v === undefined || v === '' ? null : Number(v))

export interface CheckOverview {
  job: { id: string; name: string; status: string | null }
  icp: string
  icp_source: 'owner' | 'job' | 'default'
  plan: CheckPlan
  unchecked: number
  estimate: CheckEstimate
  pricing: typeof PRICING_SOURCES
  run: (Omit<CheckRun, 'estimate_usd' | 'max_usd' | 'spent_usd'> & { estimate_usd: number | null; max_usd: number | null; spent_usd: number }) | null
  summary: CheckSummary | null
  results: CheckResultRow[]
  notes: string[]
}

export function pickIcp(owner: string | undefined, job: Pick<CheckJob, 'icp_description'>): { icp: string; source: CheckOverview['icp_source'] } {
  if (owner?.trim()) return { icp: owner.trim(), source: 'owner' }
  if (job.icp_description?.trim()) return { icp: job.icp_description.trim(), source: 'job' }
  return { icp: DEFAULT_ICP, source: 'default' }
}

export function overviewNotes(plan: CheckPlan, est: CheckEstimate): string[] {
  const notes: string[] = []
  const e = plan.enrichment_icp_status ?? {}
  const enriched = Object.entries(e).filter(([k]) => k !== 'none').reduce((n, [, v]) => n + v, 0)
  if (enriched > 0) {
    notes.push(
      `This job already has a per-lead icp_status from operating-city enrichment (free to read): ${Object.entries(e).map(([k, v]) => `${k} ${v}`).join(', ')}. ` +
        'The company check is a separate, deeper per-company verdict.'
    )
  }
  if (plan.leads_without_company > 0) notes.push(`${plan.leads_without_company} valid leads have no website, company email domain or company name and are not checked.`)
  if (plan.companies_by_name_only > 0) notes.push(`${plan.companies_by_name_only} companies have no domain and are checked by name only (lower confidence).`)
  if (est.over_one_approval) {
    const per = Math.floor(CHECK_APPROVAL_LIMIT_USD / CHECK_USD_PER_COMPANY)
    notes.push(`The full check is over one approval's $${CHECK_APPROVAL_LIMIT_USD} cap: one approval covers about ${per} companies (most leads first); approve again to continue.`)
  }
  return notes
}

export async function companyCheckOverview(jobId: string, opts: { icp?: string; fit?: 'fit' | 'not_fit' | 'unclear'; limit?: number; offset?: number } = {}): Promise<CheckOverview | null> {
  const job = await getCheckJob(jobId)
  if (!job) return null
  const { icp, source } = pickIcp(opts.icp, job)
  const plan = await checkPlan(job.id, icp)
  const unchecked = Math.max(0, plan.companies - plan.cached)
  const estimate = estimateCheck(unchecked, plan.valid_leads)
  const run = await getCheckRun(job.id, plan.icp_key)
  const [summary, results] = run ? await Promise.all([checkSummary(run.id), listCheckResults(run.id, opts)]) : [null, []]
  return {
    job: { id: job.id, name: job.display_name ?? job.filename ?? job.id, status: job.status },
    icp,
    icp_source: source,
    plan,
    unchecked,
    estimate,
    pricing: PRICING_SOURCES,
    run: run ? { ...run, estimate_usd: usdNum(run.estimate_usd), max_usd: usdNum(run.max_usd), spent_usd: usdNum(run.spent_usd) ?? 0 } : null,
    summary,
    results,
    notes: overviewNotes(plan, estimate),
  }
}

export type CompanyCheckBuild =
  | { ok: true; kind: PendingActionKind; payload: Record<string, Json> & { summary: string } }
  | { ok: false; status: number; error: string }

const fail = (status: number, error: string): CompanyCheckBuild => ({ ok: false, status, error })

const Body = z.object({
  job_id: z.string().uuid(),
  icp: z.string().trim().min(3).max(1000).optional(),
  max_usd: z.number().positive().max(CHECK_APPROVAL_LIMIT_USD).optional(),
})

export async function buildCompanyCheck(raw: Record<string, unknown>): Promise<CompanyCheckBuild> {
  const body = Body.safeParse(raw)
  if (!body.success) return fail(400, 'invalid_payload')
  const o = await companyCheckOverview(body.data.job_id.toLowerCase(), { icp: body.data.icp, limit: 1 })
  if (!o) return fail(404, 'job_not_found')
  if (o.job.status !== 'completed') return fail(409, `job_${o.job.status ?? 'unknown'}: validation must be completed first`)
  if (o.run?.status === 'running') return fail(409, 'check_running')
  if (!o.unchecked) return fail(409, 'nothing_to_check')
  const est = o.estimate
  const cap = body.data.max_usd ?? est.default_cap_usd
  if (cap < CHECK_USD_PER_COMPANY) return fail(400, `max_usd below one company ($${CHECK_USD_PER_COMPANY})`)
  const covers = Math.min(o.unchecked, Math.floor(cap / CHECK_USD_PER_COMPANY + 1e-9))
  const perLead = est.per_lead_usd === null ? '' : `, about $${est.per_lead_usd.toFixed(4)} per lead over ${o.plan.valid_leads} valid leads`
  return {
    ok: true,
    kind: 'company_check',
    payload: {
      job_id: o.job.id,
      job_name: o.job.name,
      icp: o.icp,
      icp_source: o.icp_source,
      companies: o.unchecked,
      cached: o.plan.cached,
      valid_leads: o.plan.valid_leads,
      unit_usd: CHECK_USD_PER_COMPANY,
      estimate_usd: est.usd,
      per_lead_usd: est.per_lead_usd,
      max_usd: cap,
      summary:
        `Check what ${o.unchecked} companies in "${o.job.name}" really do and whether each is ${o.icp} (Perplexity Sonar + a Haiku parse per company domain): ` +
        `~${fmt(est.usd)} (${o.unchecked} × $${CHECK_USD_PER_COMPANY}${perLead}), hard cap ${fmt(cap)}` +
        (covers < o.unchecked ? ` (covers about ${covers} companies, most leads first; approve again for the rest)` : '') +
        `.${o.plan.cached ? ` ${o.plan.cached} companies already checked for this ICP are free.` : ''} Nothing changes in the job or its leads.`,
    },
  }
}

export type ExecOutcome = { ok: true; result: Record<string, Json> } | { ok: false; error: string; result: Record<string, Json> }
const uncertainCall = (error: string) => error === 'timeout' || error === 'unreachable'

export async function executeCompanyCheck(p: Record<string, Json>, actionId: string): Promise<ExecOutcome> {
  const jobId = typeof p.job_id === 'string' ? p.job_id : ''
  const icp = typeof p.icp === 'string' ? p.icp : ''
  const maxUsd = typeof p.max_usd === 'number' ? p.max_usd : NaN
  if (!jobId || !icp || !Number.isFinite(maxUsd)) return { ok: false, error: 'payload.job_id / icp / max_usd missing', result: {} }
  const o = await companyCheckOverview(jobId, { icp, limit: 1 })
  if (!o) return { ok: false, error: 're-check failed: the job is gone', result: { job_id: jobId } }
  if (o.run?.status === 'running') return { ok: false, error: 're-check failed: a check of this job is already running', result: { job_id: jobId, run_id: o.run.id } }
  if (!o.unchecked) return { ok: false, error: 're-check failed: every company is already checked', result: { job_id: jobId } }
  const r = await callInfluencerFn({ action: 'start', job_id: jobId, max_usd: maxUsd, action_id: actionId }, 'company-check')
  if (!r.ok) {
    return {
      ok: false,
      error: `company-check start: ${r.error}`,
      result: uncertainCall(r.error)
        ? { http_status: r.status, uncertain: true, note: 'The check may have started: call get_company_check before retrying.' }
        : { http_status: r.status },
    }
  }
  return {
    ok: true,
    result: {
      job_id: jobId,
      run_id: typeof r.body.run_id === 'string' ? r.body.run_id : null,
      status: 'running',
      max_usd: typeof r.body.max_usd === 'number' ? r.body.max_usd : maxUsd,
      companies: o.unchecked,
    },
  }
}
