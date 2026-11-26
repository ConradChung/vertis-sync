import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { DbError } from '@/lib/db/service'
import { HIRING_CONFIG_KEY, monthToDate, parseHiringConfig, type HiringConfig, type Lane } from '@/lib/hiring/config'
import type { HiringCheck } from '@/lib/hiring/checkPrompt'
import type { CachedCheck, HiringStore, PendingRow, RowPatch, RunRow } from '@/lib/hiring/engine'
import type { Candidate } from '@/lib/hiring/lanes'
import { normCompany } from '@/lib/hiring/normalize'
import type { HiringRow, HiringListQuery } from '@/lib/hiring/view'

/**
 * GTM-19 tables (migration lume_hiring_signal), service role only: called
 * after `requireSecret` (cron) or `requireOwner` (the sheet). Every state
 * change is conditional on the state it expects, so a retried tick or a
 * double click finds nothing to do.
 */

const sb = () => createServiceClient()
const nowIso = () => new Date().toISOString()
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v))

const ROW_COLS =
  'id, dedupe_key, signal, role_tier, role_title, headline, source_url, posted_at, location, country, company_name, company_domain, company_website, company_phone, company_linkedin, person_name, person_title, person_linkedin, contact_source, attempts'

export const VIEW_COLS =
  'id, signal, role_tier, role_title, headline, source_url, posted_at, location, country, company_name, company_domain, company_website, company_phone, company_linkedin, person_name, person_title, person_linkedin, contact_name, contact_title, contact_linkedin, contact_email, pm_fit, pm_evidence, skip_reason, draft_subject, draft_body, draft_status, draft_violations, status, decided_by, decided_at, created_at'

export async function getHiringConfig(): Promise<HiringConfig> {
  const res = await sb().from('lume_settings').select('value').eq('key', HIRING_CONFIG_KEY).maybeSingle()
  if (res.error) throw new DbError('getHiringConfig', res.error)
  return parseHiringConfig(res.data?.value)
}

export const liveStore: HiringStore = {
  getConfig: getHiringConfig,

  async monthSpend(fromIso) {
    const res = await sb().from('signal_hiring_spend').select('usd, status').gte('created_at', fromIso).limit(10_000)
    if (res.error) throw new DbError('hiring monthSpend', res.error)
    return monthToDate((res.data ?? []) as { usd: number; status: string }[])
  },

  async addSpend(e) {
    const res = await sb().from('signal_hiring_spend').insert({ lane: e.lane, kind: e.kind, usd: e.usd, status: e.status, run_id: e.run_id ?? null, row_id: e.row_id ?? null })
    if (res.error) throw new DbError('hiring addSpend', res.error)
  },

  async settleRunSpend(runId, usd) {
    const res = await sb().from('signal_hiring_spend').update({ usd: Math.max(0, usd), status: 'settled', settled_at: nowIso() }).eq('run_id', runId).eq('kind', 'apify').eq('status', 'reserved')
    if (res.error) throw new DbError('hiring settleRunSpend', res.error)
  },

  async releaseRunSpend(runId) {
    const res = await sb().from('signal_hiring_spend').update({ status: 'released', settled_at: nowIso() }).eq('run_id', runId).eq('kind', 'apify').eq('status', 'reserved')
    if (res.error) throw new DbError('hiring releaseRunSpend', res.error)
  },

  async lastRunStart(lane) {
    const res = await sb().from('signal_hiring_runs').select('started_at').eq('lane', lane).eq('manual', false).order('started_at', { ascending: false }).limit(1)
    if (res.error) throw new DbError('hiring lastRunStart', res.error)
    return (res.data?.[0]?.started_at as string | undefined) ?? null
  },

  async claimRun(r) {
    const res = await sb().from('signal_hiring_runs').insert({ ...r, status: 'starting' }).select('id')
    if (res.error) {
      if (res.error.code === '23505') return null // a run of this lane + variant is in flight
      throw new DbError('hiring claimRun', res.error)
    }
    return (res.data?.[0]?.id as number | undefined) ?? null
  },

  async markRunStarted(id, apifyRunId, datasetId) {
    const res = await sb().from('signal_hiring_runs').update({ status: 'started', apify_run_id: apifyRunId, dataset_id: datasetId }).eq('id', id).eq('status', 'starting')
    if (res.error) throw new DbError('hiring markRunStarted', res.error)
  },

  async markRunFailed(id, error, costUsd) {
    const res = await sb().from('signal_hiring_runs').update({ status: 'failed', error: error.slice(0, 500), cost_usd: costUsd ?? null, read_at: nowIso() }).eq('id', id).in('status', ['starting', 'started'])
    if (res.error) throw new DbError('hiring markRunFailed', res.error)
  },

  async markRunRead(id, r) {
    const res = await sb().from('signal_hiring_runs').update({ status: 'read', cost_usd: r.cost_usd, items: r.items, inserted: r.inserted, read_at: nowIso() }).eq('id', id).eq('status', 'started')
    if (res.error) throw new DbError('hiring markRunRead', res.error)
  },

  async listStartedRuns() {
    const res = await sb().from('signal_hiring_runs').select('id, lane, variant, actor_id, apify_run_id, dataset_id, status, cap_usd, started_at').eq('status', 'started').order('id', { ascending: true }).limit(20)
    if (res.error) throw new DbError('hiring listStartedRuns', res.error)
    return ((res.data ?? []) as RunRow[]).map((r) => ({ ...r, cap_usd: num(r.cap_usd) }))
  },

  async sweepStaleStarting(beforeIso) {
    const res = await sb().from('signal_hiring_runs').update({ status: 'failed', error: 'never started (claim swept)', read_at: nowIso() }).eq('status', 'starting').lt('started_at', beforeIso).select('id')
    if (res.error) throw new DbError('hiring sweepStaleStarting', res.error)
    return (res.data ?? []).map((r) => r.id as number)
  },

  async insertCandidates(cs, runId) {
    const rows = cs.map((c: Candidate) => ({ ...c, run_id: runId }))
    const res = await sb().from('signal_hiring').upsert(rows, { onConflict: 'dedupe_key', ignoreDuplicates: true }).select('id')
    if (res.error) throw new DbError('hiring insertCandidates', res.error)
    return (res.data ?? []).length
  },

  async claimPending(limit, leaseUntilIso) {
    const now = nowIso()
    const pick = await sb().from('signal_hiring').select('id').eq('stage', 'pending').or(`locked_until.is.null,locked_until.lt.${now}`).order('id', { ascending: true }).limit(limit)
    if (pick.error) throw new DbError('hiring claimPending', pick.error)
    const ids = (pick.data ?? []).map((r) => r.id as number)
    if (!ids.length) return []
    const res = await sb()
      .from('signal_hiring')
      .update({ locked_until: leaseUntilIso, updated_at: now })
      .in('id', ids)
      .eq('stage', 'pending')
      .or(`locked_until.is.null,locked_until.lt.${now}`)
      .select(ROW_COLS)
    if (res.error) throw new DbError('hiring claimPending', res.error)
    return ((res.data ?? []) as unknown as PendingRow[]).map((r) => ({ ...r, raw: {} })).sort((a, b) => a.id - b.id)
  },

  async updateRow(id, patch: RowPatch) {
    const res = await sb().from('signal_hiring').update({ ...patch, updated_at: nowIso() }).eq('id', id).eq('stage', 'pending')
    if (res.error) throw new DbError('hiring updateRow', res.error)
  },

  async exclusions(domains, names) {
    const out = new Map<string, 'in_lead_bank' | 'in_campaign'>()
    if (!domains.length && !names.length) return out
    const res = await sb().rpc('signal_hiring_exclusions', { p_domains: domains, p_names: names })
    if (res.error) throw new DbError('hiring exclusions', res.error)
    for (const r of (res.data ?? []) as { match_key: string; reason: 'in_lead_bank' | 'in_campaign' }[]) {
      // in_campaign wins over in_lead_bank for the same key
      if (out.get(r.match_key) !== 'in_campaign') out.set(r.match_key, r.reason)
    }
    return out
  },

  async companySeen(key, excludeId, sinceIso) {
    if (!key.domain && !key.name) return false
    let q = sb().from('signal_hiring').select('id, company_name').eq('stage', 'done').is('skip_reason', null).neq('id', excludeId).gte('created_at', sinceIso).limit(50)
    if (key.domain) q = q.eq('company_domain', key.domain)
    else q = q.ilike('company_name', `%${(key.name ?? '').split(' ')[0].replace(/[%_]/g, '')}%`)
    const res = await q
    if (res.error) throw new DbError('hiring companySeen', res.error)
    if (key.domain) return (res.data ?? []).length > 0
    return (res.data ?? []).some((r) => normCompany(r.company_name as string | null) === key.name)
  },

  async getCheck(key) {
    const res = await sb().from('signal_company_checks').select('icp_fit, property_type, evidence, phone, website').eq('domain', key).maybeSingle()
    if (res.error) throw new DbError('hiring getCheck', res.error)
    return (res.data as CachedCheck | null) ?? null
  },

  async saveCheck(key, companyName, c: HiringCheck, usd) {
    const res = await sb()
      .from('signal_company_checks')
      .upsert(
        { domain: key, company_name: companyName, icp_fit: c.icp_fit, property_type: c.property_type, evidence: c.evidence, phone: c.phone, website: c.website, cost_usd: usd, checked_at: nowIso() },
        { onConflict: 'domain', ignoreDuplicates: true }
      )
    if (res.error) throw new DbError('hiring saveCheck', res.error)
  },

  async saveNotice(key, text, dryRun) {
    // signal_notices is the GTM-14 notice queue: 'pending' rows are posted to #sales by
    // /api/cron/signal-alerts (its own dry-run rule applies); a dry run stores it as 'dry_run'.
    const res = await sb().from('signal_notices').upsert({ key, text, status: dryRun ? 'dry_run' : 'pending' }, { onConflict: 'key', ignoreDuplicates: true })
    if (res.error) throw new DbError('hiring saveNotice', res.error)
  },
}

// ── the sheet ────────────────────────────────────────────────────────────

export async function listHiringRows(q: HiringListQuery): Promise<{ rows: HiringRow[]; total: number }> {
  let query = sb().from('signal_hiring').select(VIEW_COLS, { count: 'exact' }).eq('stage', 'done')
  if (q.status !== 'all') query = query.eq('status', q.status)
  if (q.signal !== 'all') query = query.eq('signal', q.signal)
  if (q.tier !== 'all') query = query.eq('role_tier', q.tier)
  query = q.skipped ? query.not('skip_reason', 'is', null) : query.is('skip_reason', null)
  const res = await query.order('created_at', { ascending: false }).order('id', { ascending: false }).range(q.offset, q.offset + q.limit - 1)
  if (res.error) throw new DbError('listHiringRows', res.error)
  return { rows: (res.data ?? []) as unknown as HiringRow[], total: res.count ?? 0 }
}

/** new → sent | skipped, once. Null when the row was not 'new' any more (a double click). */
export async function decideHiringRow(id: number, to: 'sent' | 'skipped', by: string): Promise<HiringRow | null> {
  const res = await sb()
    .from('signal_hiring')
    .update({ status: to, decided_by: by, decided_at: nowIso(), updated_at: nowIso() })
    .eq('id', id)
    .eq('status', 'new')
    .eq('stage', 'done')
    .select(VIEW_COLS)
  if (res.error) throw new DbError('decideHiringRow', res.error)
  return ((res.data ?? []) as unknown as HiringRow[])[0] ?? null
}

/** Spend this month, the last run per lane: the sheet's header. */
export async function hiringStatus(fromIso: string): Promise<{ month_to_date_usd: number; last_runs: Partial<Record<Lane, { started_at: string; status: string; inserted: number | null }>> }> {
  const [spend, runs] = await Promise.all([
    sb().from('signal_hiring_spend').select('usd, status').gte('created_at', fromIso).limit(10_000),
    sb().from('signal_hiring_runs').select('lane, started_at, status, inserted').order('started_at', { ascending: false }).limit(30),
  ])
  if (spend.error) throw new DbError('hiringStatus spend', spend.error)
  if (runs.error) throw new DbError('hiringStatus runs', runs.error)
  const last: Partial<Record<Lane, { started_at: string; status: string; inserted: number | null }>> = {}
  for (const r of (runs.data ?? []) as { lane: Lane; started_at: string; status: string; inserted: number | null }[]) last[r.lane] ??= { started_at: r.started_at, status: r.status, inserted: r.inserted }
  return { month_to_date_usd: monthToDate((spend.data ?? []) as { usd: number; status: string }[]), last_runs: last }
}
