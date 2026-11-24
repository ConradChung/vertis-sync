import { CHECK_USD, DRAFT_USD, EXTRACT_USD, fitsCap, isDue, LANES, MAX_RUN_CAP_USD, type HiringConfig, type Lane } from '@/lib/hiring/config'
import { finishDraft, type Draft, type DraftViolation } from '@/lib/hiring/draft'
import type { HiringCheck } from '@/lib/hiring/checkPrompt'
import {
  ACTORS,
  articleCandidate,
  buildExpansionInputs,
  buildHiringInput,
  buildNewManagerInput,
  normalizeArticle,
  normalizeJob,
  normalizePerson,
  RUN_TIMEOUT_S,
  uniqueByKey,
  type Article,
  type Candidate,
  type Extraction,
  type LaneInput,
} from '@/lib/hiring/lanes'
import { companyDomain, normCompany } from '@/lib/hiring/normalize'

/**
 * GTM-19 Hiring Ops Signal, one tick (called by /api/cron/hiring-signal):
 *
 *  a. start: each enabled lane that is due (hiring + expansion daily,
 *     new_manager weekly) with no run in flight starts its Apify run(s) with
 *     the lane's run cap as maxTotalChargeUsd, only when month-to-date spend
 *     + that cap stays within the monthly cap ($40). The run is claimed in
 *     signal_hiring_runs (one in flight per lane + variant) BEFORE startRun,
 *     and the cap is reserved in the ledger until the run is read.
 *  b. read: started runs → getRun; SUCCEEDED → dataset → normalise →
 *     insert rows (on conflict do nothing on dedupe_key), settle the
 *     reservation to usageTotalUsd; FAILED / ABORTED / TIMED-OUT → failed.
 *  c. process pending rows (bounded per tick): exclusions (lead bank /
 *     Instantly) → duplicate company → per-domain PM check (cached, counted
 *     toward the cap) → draft as Frank, SOP-linted → done. Skipped rows keep
 *     their skip_reason for audit.
 *
 * A manual override `{ lane, run_cap_usd?, max_items?, force: true }` starts
 * one run of that lane now (any lane that exists, on or off; still within the
 * monthly cap). Dry run changes only the notices (stored, never sent to
 * Slack); rows are always written. Nothing is ever sent to a lead.
 */

export interface RunRow {
  id: number
  lane: Lane
  variant: string
  actor_id: string
  apify_run_id: string | null
  dataset_id: string | null
  status: 'starting' | 'started' | 'read' | 'failed'
  cap_usd: number
  started_at: string
}

export interface PendingRow extends Candidate {
  id: number
  attempts: number
}

export interface RowPatch {
  stage?: 'pending' | 'done'
  attempts?: number
  locked_until?: null
  last_error?: string | null
  skip_reason?: string | null
  pm_fit?: 'fit' | 'not_fit' | 'unclear' | null
  pm_evidence?: string | null
  company_domain?: string | null
  company_website?: string | null
  company_phone?: string | null
  draft_subject?: string | null
  draft_body?: string | null
  draft_status?: 'ready' | 'needs_edit' | 'failed' | null
  draft_violations?: DraftViolation[] | null
}

export interface CachedCheck {
  icp_fit: 'fit' | 'not_fit' | 'unclear'
  property_type: string | null
  evidence: string | null
  phone: string | null
  website: string | null
}

export interface HiringStore {
  getConfig(): Promise<HiringConfig>
  monthSpend(fromIso: string): Promise<number>
  addSpend(e: { lane: Lane; kind: 'apify' | 'check' | 'draft' | 'extract'; usd: number; status: 'reserved' | 'settled'; run_id?: number; row_id?: number }): Promise<void>
  settleRunSpend(runId: number, usd: number): Promise<void>
  releaseRunSpend(runId: number): Promise<void>
  lastRunStart(lane: Lane): Promise<string | null>
  claimRun(r: { lane: Lane; variant: string; actor_id: string; cap_usd: number; manual: boolean }): Promise<number | null>
  markRunStarted(id: number, apifyRunId: string, datasetId: string | null): Promise<void>
  markRunFailed(id: number, error: string, costUsd?: number | null): Promise<void>
  markRunRead(id: number, r: { cost_usd: number | null; items: number; inserted: number }): Promise<void>
  listStartedRuns(): Promise<RunRow[]>
  /** 'starting' rows older than the cutoff (a crash between claim and startRun) → failed; returns their ids. */
  sweepStaleStarting(beforeIso: string): Promise<number[]>
  insertCandidates(cs: Candidate[], runId: number): Promise<number>
  claimPending(limit: number, leaseUntilIso: string): Promise<PendingRow[]>
  updateRow(id: number, patch: RowPatch): Promise<void>
  exclusions(domains: string[], names: string[]): Promise<Map<string, 'in_lead_bank' | 'in_campaign'>>
  /** Another processed, shown row for this company (domain or normalised name) since `sinceIso`. */
  companySeen(key: { domain: string | null; name: string | null }, excludeId: number, sinceIso: string): Promise<boolean>
  getCheck(key: string): Promise<CachedCheck | null>
  saveCheck(key: string, companyName: string | null, c: HiringCheck, usd: number): Promise<void>
  saveNotice(key: string, text: string, dryRun: boolean): Promise<void>
}

export interface ApifyPort {
  startRun(actorId: string, input: Record<string, unknown>, o: { timeout: number; maxItems?: number; maxTotalChargeUsd: number }): Promise<{ id: string; datasetId: string | null }>
  getRun(runId: string): Promise<{ status: string; datasetId: string | null; usageTotalUsd: number | null }>
  datasetItems(datasetId: string): Promise<Record<string, unknown>[]>
}

export interface AiPort {
  checkCompany(c: { company_name: string | null; website: string | null; company_key: string }): Promise<{ check: HiringCheck; usd: number }>
  draft(c: Candidate): Promise<{ draft: Draft; usd: number }>
  extract(a: Article): Promise<{ extraction: Extraction; usd: number }>
}

export interface Deps {
  store: HiringStore
  apify: ApifyPort
  ai: AiPort
  /** ms since epoch; tests pass a fake clock. */
  clock?: () => number
}

export interface ManualRun {
  lane: Lane
  run_cap_usd?: number
  max_items?: number
}

export interface TickResult {
  ok: boolean
  dry_run: boolean
  month_to_date_usd: number
  started: { lane: Lane; variant: string; run_id: number; apify_run_id: string; cap_usd: number }[]
  not_started: { lane: Lane; reason: string }[]
  read: { run_id: number; status: string; items: number; inserted: number }[]
  processed: { shown: number; skipped: number; needs_edit: number; deferred: number; errors: number }
  notices: string[]
  errors: string[]
}

export const PROCESS_LIMIT = 12
export const PROCESS_CONCURRENCY = 2
export const PROCESS_BUDGET_MS = 75_000
export const EXTRACT_LIMIT = 60
export const MAX_ATTEMPTS = 3
export const LEASE_MS = 5 * 60_000
export const STALE_STARTING_MS = 15 * 60_000
export const DUPLICATE_WINDOW_DAYS = 30
const TERMINAL_FAIL = new Set(['FAILED', 'ABORTED', 'TIMED-OUT', 'TIMED_OUT'])

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300)
const round4 = (n: number) => Math.round(n * 10_000) / 10_000

/** First instant of the owner's (America/Los_Angeles) calendar month containing `now`. */
export function monthStartIso(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit' }).formatToParts(now)
  const y = Number(parts.find((p) => p.type === 'year')?.value)
  const m = Number(parts.find((p) => p.type === 'month')?.value)
  // Midnight PT is 07:00 or 08:00 UTC; take the earlier (07:00) so nothing in the month is missed.
  return new Date(Date.UTC(y, m - 1, 1, 7)).toISOString()
}

export const monthKey = (now: Date) => monthStartIso(now).slice(0, 7)

export function laneInputs(lane: Lane, regions: readonly string[], maxItems?: number): LaneInput[] {
  if (lane === 'hiring') return [buildHiringInput(regions, maxItems)]
  if (lane === 'new_manager') return [buildNewManagerInput(regions, maxItems)]
  return buildExpansionInputs(regions, maxItems)
}

export async function runHiringTick(now: Date, manual: ManualRun | null, deps: Deps): Promise<TickResult> {
  const { store } = deps
  const clock = deps.clock ?? (() => Date.now())
  const t0 = clock()
  const cfg = await store.getConfig()
  const from = monthStartIso(now)
  let mtd = await store.monthSpend(from)
  const out: TickResult = {
    ok: true,
    dry_run: cfg.dry_run,
    month_to_date_usd: mtd,
    started: [],
    not_started: [],
    read: [],
    processed: { shown: 0, skipped: 0, needs_edit: 0, deferred: 0, errors: 0 },
    notices: [],
    errors: [],
  }
  let capNoticed = false
  const capNotice = async (what: string) => {
    if (capNoticed) return
    capNoticed = true
    const key = `hiring:cap:${monthKey(now)}`
    const text = `Hiring Ops Signal: the $${cfg.monthly_cap_usd} monthly cap is reached ($${mtd.toFixed(2)} this month), so ${what} waits until next month or a higher cap.`
    try {
      await store.saveNotice(key, text, cfg.dry_run)
      out.notices.push(key)
    } catch (e) {
      out.errors.push(`notice: ${msg(e)}`)
    }
  }

  // ── a0. sweep claims that never started ──
  try {
    for (const id of await store.sweepStaleStarting(new Date(now.getTime() - STALE_STARTING_MS).toISOString())) await store.releaseRunSpend(id)
  } catch (e) {
    out.errors.push(`sweep: ${msg(e)}`)
  }

  // ── b. read finished runs (first, so this tick can process what they found) ──
  let runs: RunRow[] = []
  try {
    runs = await store.listStartedRuns()
  } catch (e) {
    out.errors.push(`list runs: ${msg(e)}`)
  }
  for (const run of runs) {
    if (!run.apify_run_id) continue
    try {
      const info = await deps.apify.getRun(run.apify_run_id)
      if (info.status === 'SUCCEEDED') {
        const ds = info.datasetId ?? run.dataset_id
        const items = ds ? await deps.apify.datasetItems(ds) : []
        const cs = await normalizeRun(run, items, now, cfg, deps, () => mtd, (usd) => (mtd = round4(mtd + usd)), capNotice)
        const inserted = cs.length ? await store.insertCandidates(cs, run.id) : 0
        const cost = info.usageTotalUsd
        await store.settleRunSpend(run.id, cost ?? run.cap_usd)
        mtd = round4(mtd - run.cap_usd + (cost ?? run.cap_usd))
        await store.markRunRead(run.id, { cost_usd: cost, items: items.length, inserted })
        out.read.push({ run_id: run.id, status: 'read', items: items.length, inserted })
      } else if (TERMINAL_FAIL.has(info.status)) {
        const cost = info.usageTotalUsd
        await store.settleRunSpend(run.id, cost ?? run.cap_usd)
        mtd = round4(mtd - run.cap_usd + (cost ?? run.cap_usd))
        await store.markRunFailed(run.id, `apify ${info.status}`, cost)
        out.read.push({ run_id: run.id, status: 'failed', items: 0, inserted: 0 })
      }
    } catch (e) {
      out.errors.push(`read run ${run.id}: ${msg(e)}`)
    }
  }

  // ── a. start due lanes (or the manual run) ──
  const plan: { lane: Lane; capUsd: number; maxItems?: number; manual: boolean }[] = []
  if (manual) {
    const cap = Math.min(MAX_RUN_CAP_USD, manual.run_cap_usd && manual.run_cap_usd > 0 ? manual.run_cap_usd : cfg.run_cap_usd[manual.lane])
    plan.push({ lane: manual.lane, capUsd: cap, maxItems: manual.max_items, manual: true })
  } else {
    for (const lane of LANES) {
      if (!cfg.lanes[lane]) continue
      try {
        if (!isDue(lane, await store.lastRunStart(lane), now)) continue
      } catch (e) {
        out.errors.push(`due ${lane}: ${msg(e)}`)
        continue
      }
      plan.push({ lane, capUsd: cfg.run_cap_usd[lane], manual: false })
    }
  }
  for (const p of plan) {
    const inputs = laneInputs(p.lane, cfg.regions, p.maxItems)
    if (!inputs.length) {
      out.not_started.push({ lane: p.lane, reason: 'no_regions' })
      continue
    }
    const each = round4(p.capUsd / inputs.length)
    for (const li of inputs) {
      if (!(each > 0)) {
        out.not_started.push({ lane: p.lane, reason: 'zero_cap' })
        continue
      }
      if (!fitsCap(mtd, each, cfg.monthly_cap_usd)) {
        out.not_started.push({ lane: p.lane, reason: 'monthly_cap' })
        await capNotice(`the ${p.lane} lane`)
        continue
      }
      let runId: number | null = null
      try {
        runId = await store.claimRun({ lane: p.lane, variant: li.variant, actor_id: ACTORS[p.lane], cap_usd: each, manual: p.manual })
        if (runId === null) {
          out.not_started.push({ lane: p.lane, reason: 'in_flight' })
          continue
        }
        await store.addSpend({ lane: p.lane, kind: 'apify', usd: each, status: 'reserved', run_id: runId })
        mtd = round4(mtd + each)
        const started = await deps.apify.startRun(ACTORS[p.lane], li.input, { timeout: RUN_TIMEOUT_S[p.lane], maxItems: li.maxItems, maxTotalChargeUsd: each })
        await store.markRunStarted(runId, started.id, started.datasetId)
        out.started.push({ lane: p.lane, variant: li.variant, run_id: runId, apify_run_id: started.id, cap_usd: each })
      } catch (e) {
        out.errors.push(`start ${p.lane}/${li.variant}: ${msg(e)}`)
        if (runId !== null) {
          await store.markRunFailed(runId, `start: ${msg(e)}`, 0).catch(() => {})
          await store.releaseRunSpend(runId).catch(() => {})
          mtd = round4(mtd - each)
        }
      }
    }
  }

  // ── c. process pending rows ──
  let rows: PendingRow[] = []
  try {
    rows = await store.claimPending(PROCESS_LIMIT, new Date(now.getTime() + LEASE_MS).toISOString())
  } catch (e) {
    out.errors.push(`claim rows: ${msg(e)}`)
  }
  if (rows.length) {
    let excl = new Map<string, 'in_lead_bank' | 'in_campaign'>()
    try {
      excl = await store.exclusions(
        [...new Set(rows.map((r) => r.company_domain).filter((d): d is string => !!d))],
        [...new Set(rows.map((r) => normCompany(r.company_name)).filter((n): n is string => !!n))]
      )
    } catch (e) {
      out.errors.push(`exclusions: ${msg(e)}`)
      // Without the exclusion list nothing is processed this tick (never show a company we may already be emailing).
      for (const r of rows) await store.updateRow(r.id, { locked_until: null }).catch(() => {})
      out.processed.deferred += rows.length
      rows = []
    }
    const ctx: ProcessCtx = { cfg, now, deps, excl, mtd: () => mtd, spend: (u) => (mtd = round4(mtd + u)), capNotice, out, stop: false, taken: new Set<string>() }
    const queue = [...rows]
    const worker = async () => {
      for (;;) {
        const r = queue.shift()
        if (!r) return
        if (ctx.stop || clock() - t0 > PROCESS_BUDGET_MS) {
          await store.updateRow(r.id, { locked_until: null }).catch(() => {})
          out.processed.deferred++
          continue
        }
        await processRow(r, ctx)
      }
    }
    await Promise.all(Array.from({ length: PROCESS_CONCURRENCY }, worker))
  }

  out.month_to_date_usd = round4(mtd)
  if (out.errors.length) out.ok = false
  return out
}

// ── normalising one finished run ─────────────────────────────────────────

async function normalizeRun(
  run: RunRow,
  items: Record<string, unknown>[],
  now: Date,
  cfg: HiringConfig,
  deps: Deps,
  mtd: () => number,
  spend: (usd: number) => void,
  capNotice: (what: string) => Promise<void>
): Promise<Candidate[]> {
  if (run.lane === 'hiring') return uniqueByKey(items.map(normalizeJob).filter((c): c is Candidate => !!c))
  if (run.lane === 'new_manager') return uniqueByKey(items.map((i) => normalizePerson(i, now)).filter((c): c is Candidate => !!c))
  const arts = items.map((i) => normalizeArticle(i, run.variant)).filter((a): a is Article => !!a)
  const seen = new Set<string>()
  const out: Candidate[] = []
  for (const a of arts.slice(0, EXTRACT_LIMIT)) {
    if (seen.has(a.url)) continue
    seen.add(a.url)
    if (!fitsCap(mtd(), EXTRACT_USD, cfg.monthly_cap_usd)) {
      await capNotice('news extraction')
      break
    }
    try {
      const { extraction, usd } = await deps.ai.extract(a)
      spend(usd)
      await deps.store.addSpend({ lane: 'expansion', kind: 'extract', usd, status: 'settled', run_id: run.id })
      const c = articleCandidate(a, extraction)
      if (c) out.push(c)
    } catch {
      // one unreadable headline never fails the run
    }
  }
  return uniqueByKey(out)
}

// ── processing one row ───────────────────────────────────────────────────

interface ProcessCtx {
  cfg: HiringConfig
  now: Date
  deps: Deps
  excl: Map<string, 'in_lead_bank' | 'in_campaign'>
  mtd: () => number
  spend: (usd: number) => void
  capNotice: (what: string) => Promise<void>
  out: TickResult
  stop: boolean
  /** Company keys already handled this tick (two rows of one company never both show). */
  taken: Set<string>
}

export const checkKey = (domain: string | null, name: string | null): string | null => domain ?? (name ? `name:${name}` : null)

async function processRow(r: PendingRow, ctx: ProcessCtx): Promise<void> {
  const { store } = ctx.deps
  const skip = async (reason: string, extra: RowPatch = {}) => {
    await store.updateRow(r.id, { ...extra, stage: 'done', skip_reason: reason, locked_until: null, last_error: null })
    ctx.out.processed.skipped++
  }
  try {
    let domain = r.company_domain
    const name = normCompany(r.company_name)
    if (!domain && !name) return await skip('no_domain')

    const excluded = (domain && ctx.excl.get(`domain:${domain}`)) || (name && ctx.excl.get(`name:${name}`))
    if (excluded) return await skip(excluded)

    const keys = [domain && `domain:${domain}`, name && `name:${name}`].filter((k): k is string => !!k)
    if (keys.some((k) => ctx.taken.has(k))) return await skip('duplicate_company')
    keys.forEach((k) => ctx.taken.add(k))
    const since = new Date(ctx.now.getTime() - DUPLICATE_WINDOW_DAYS * 86_400_000).toISOString()
    if (await store.companySeen({ domain, name }, r.id, since)) return await skip('duplicate_company')

    // Per-company PM check, cached by domain (else by normalised name).
    const key = checkKey(domain, name)!
    let check = await store.getCheck(key)
    if (!check) {
      if (!fitsCap(ctx.mtd(), CHECK_USD, ctx.cfg.monthly_cap_usd)) {
        ctx.stop = true
        await store.updateRow(r.id, { locked_until: null })
        ctx.out.processed.deferred++
        await ctx.capNotice('the company checks')
        return
      }
      try {
        const res = await ctx.deps.ai.checkCompany({ company_name: r.company_name, website: r.company_website ?? domain, company_key: key })
        ctx.spend(res.usd)
        await store.addSpend({ lane: r.signal, kind: 'check', usd: res.usd, status: 'settled', row_id: r.id })
        await store.saveCheck(key, r.company_name, res.check, res.usd)
        check = { icp_fit: res.check.icp_fit, property_type: res.check.property_type, evidence: res.check.evidence, phone: res.check.phone, website: res.check.website }
      } catch (e) {
        const attempts = r.attempts + 1
        if (attempts >= MAX_ATTEMPTS) return await skip('check_failed', { attempts, last_error: msg(e) })
        await store.updateRow(r.id, { attempts, last_error: msg(e), locked_until: null })
        ctx.out.processed.errors++
        return
      }
    }

    const patch: RowPatch = { pm_fit: check.icp_fit, pm_evidence: check.evidence }
    if (!r.company_phone && check.phone) patch.company_phone = check.phone
    if (!r.company_website && check.website) patch.company_website = /^https?:\/\//i.test(check.website) ? check.website : `https://${check.website}`
    if (!domain && check.website) {
      const d = companyDomain(check.website)
      if (d) {
        domain = d
        patch.company_domain = d
        // The check found the domain: re-run the exclusion on it.
        const again = await store.exclusions([d], [])
        const ex = again.get(`domain:${d}`)
        if (ex) return await skip(ex, patch)
      }
    }
    if (check.icp_fit === 'not_fit') return await skip('not_pm', patch)
    if (check.icp_fit === 'unclear') return await skip('pm_unclear', patch)

    // Draft as Frank, SOP-linted.
    const row: Candidate = { ...r, company_domain: domain, company_phone: patch.company_phone ?? r.company_phone, company_website: patch.company_website ?? r.company_website }
    if (!fitsCap(ctx.mtd(), DRAFT_USD, ctx.cfg.monthly_cap_usd)) {
      ctx.stop = true
      await store.updateRow(r.id, { ...patch, locked_until: null })
      ctx.out.processed.deferred++
      await ctx.capNotice('drafting')
      return
    }
    try {
      const { draft, usd } = await ctx.deps.ai.draft(row)
      ctx.spend(usd)
      await store.addSpend({ lane: r.signal, kind: 'draft', usd, status: 'settled', row_id: r.id })
      const d = finishDraft(draft, row)
      await store.updateRow(r.id, {
        ...patch,
        stage: 'done',
        skip_reason: null,
        locked_until: null,
        last_error: null,
        draft_subject: d.subject,
        draft_body: d.body,
        draft_status: d.status,
        draft_violations: d.violations.length ? d.violations : null,
      })
      if (d.status === 'needs_edit') ctx.out.processed.needs_edit++
      ctx.out.processed.shown++
    } catch (e) {
      await store.updateRow(r.id, { ...patch, stage: 'done', skip_reason: null, locked_until: null, draft_status: 'failed', last_error: msg(e) })
      ctx.out.processed.shown++
    }
  } catch (e) {
    ctx.out.processed.errors++
    ctx.out.errors.push(`row ${r.id}: ${msg(e)}`)
    await store.updateRow(r.id, { locked_until: null, last_error: msg(e) }).catch(() => {})
  }
}
