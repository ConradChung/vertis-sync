import { vi } from 'vitest'
import { monthToDate, parseHiringConfig, type HiringConfig } from '@/lib/hiring/config'
import type { AiPort, ApifyPort, CachedCheck, Deps, HiringStore, PendingRow, RowPatch, RunRow } from '@/lib/hiring/engine'
import type { Candidate } from '@/lib/hiring/lanes'
import { normCompany } from '@/lib/hiring/normalize'
import { GOOD_DRAFT } from './fixtures'

/** An in-memory HiringStore with the same conditional semantics as lib/hiring/store.ts. */
export function memoryStore(cfgValue: unknown = { dry_run: true, lanes: { hiring: true } }) {
  let cfg: HiringConfig = parseHiringConfig(cfgValue)
  const runs: (RunRow & { manual: boolean; cost_usd: number | null; items: number | null; inserted: number | null; error: string | null })[] = []
  const rows: (PendingRow & Record<string, unknown>)[] = []
  const spend: { lane: string; kind: string; usd: number; status: string; run_id?: number; row_id?: number; created_at: string }[] = []
  const checks = new Map<string, CachedCheck>()
  const notices = new Map<string, { text: string; status: string }>()
  let lead: { domains: Map<string, 'in_lead_bank' | 'in_campaign'>; names: Map<string, 'in_lead_bank' | 'in_campaign'> } = { domains: new Map(), names: new Map() }
  let id = 0
  let now = '2026-11-23T20:00:00.000Z'

  const store: HiringStore = {
    getConfig: async () => cfg,
    monthSpend: async (from) => monthToDate(spend.filter((s) => s.created_at >= from)),
    addSpend: async (e) => void spend.push({ ...e, created_at: now }),
    settleRunSpend: async (runId, usd) => {
      for (const s of spend) if (s.run_id === runId && s.kind === 'apify' && s.status === 'reserved') Object.assign(s, { usd, status: 'settled' })
    },
    releaseRunSpend: async (runId) => {
      for (const s of spend) if (s.run_id === runId && s.kind === 'apify' && s.status === 'reserved') s.status = 'released'
    },
    lastRunStart: async (lane) => runs.filter((r) => r.lane === lane && !r.manual).map((r) => r.started_at).sort().pop() ?? null,
    claimRun: async (r) => {
      if (runs.some((x) => x.lane === r.lane && x.variant === r.variant && (x.status === 'starting' || x.status === 'started'))) return null
      const run = { ...r, id: ++id, apify_run_id: null, dataset_id: null, status: 'starting' as const, started_at: now, cost_usd: null, items: null, inserted: null, error: null }
      runs.push(run)
      return run.id
    },
    markRunStarted: async (rid, a, d) => {
      const r = runs.find((x) => x.id === rid && x.status === 'starting')
      if (r) Object.assign(r, { status: 'started', apify_run_id: a, dataset_id: d })
    },
    markRunFailed: async (rid, error, cost) => {
      const r = runs.find((x) => x.id === rid && (x.status === 'starting' || x.status === 'started'))
      if (r) Object.assign(r, { status: 'failed', error, cost_usd: cost ?? null })
    },
    markRunRead: async (rid, x) => {
      const r = runs.find((y) => y.id === rid && y.status === 'started')
      if (r) Object.assign(r, { status: 'read', ...x })
    },
    listStartedRuns: async () => runs.filter((r) => r.status === 'started'),
    sweepStaleStarting: async () => [],
    insertCandidates: async (cs: Candidate[], runId) => {
      let n = 0
      for (const c of cs) {
        if (rows.some((r) => r.dedupe_key === c.dedupe_key)) continue
        rows.push({ ...c, id: ++id, attempts: 0, run_id: runId, stage: 'pending', status: 'new', skip_reason: null, locked_until: null, created_at: now } as PendingRow & Record<string, unknown>)
        n++
      }
      return n
    },
    claimPending: async (limit, lease) => {
      const got = rows.filter((r) => r.stage === 'pending' && (!r.locked_until || (r.locked_until as string) < now)).slice(0, limit)
      for (const r of got) r.locked_until = lease
      return got.map((r) => ({ ...r }))
    },
    updateRow: async (rid, patch: RowPatch) => {
      const r = rows.find((x) => x.id === rid && x.stage === 'pending')
      if (r) Object.assign(r, patch)
    },
    exclusions: async (domains, names) => {
      const m = new Map<string, 'in_lead_bank' | 'in_campaign'>()
      for (const d of domains) if (lead.domains.has(d)) m.set(`domain:${d}`, lead.domains.get(d)!)
      for (const n of names) if (lead.names.has(n)) m.set(`name:${n}`, lead.names.get(n)!)
      return m
    },
    companySeen: async (key, excludeId) =>
      rows.some((r) => r.id !== excludeId && r.stage === 'done' && r.skip_reason === null && ((key.domain && r.company_domain === key.domain) || (!key.domain && key.name && normCompany(r.company_name) === key.name))),
    getCheck: async (k) => checks.get(k) ?? null,
    saveCheck: async (k, _n, c) => void (checks.has(k) || checks.set(k, { icp_fit: c.icp_fit, property_type: c.property_type, evidence: c.evidence, phone: c.phone, website: c.website })),
    saveNotice: async (k, text, dry) => void (notices.has(k) || notices.set(k, { text, status: dry ? 'dry_run' : 'pending' })),
  }

  return {
    store,
    runs,
    rows,
    spend,
    checks,
    notices,
    setConfig: (v: unknown) => (cfg = parseHiringConfig(v)),
    setLead: (l: typeof lead) => (lead = l),
    setNow: (iso: string) => (now = iso),
  }
}

export function fakeApify(datasets: Record<string, Record<string, unknown>[]> = {}) {
  const status: Record<string, { status: string; usageTotalUsd: number | null }> = {}
  let n = 0
  const apify: ApifyPort & { status: typeof status } = {
    status,
    startRun: vi.fn(async () => {
      const id = `apr${++n}`
      status[id] = { status: 'RUNNING', usageTotalUsd: null }
      return { id, datasetId: `ds_${id}` }
    }),
    getRun: vi.fn(async (id: string) => ({ status: status[id]?.status ?? 'RUNNING', datasetId: `ds_${id}`, usageTotalUsd: status[id]?.usageTotalUsd ?? null })),
    datasetItems: vi.fn(async (ds: string) => datasets[ds] ?? []),
  }
  return apify
}

export function fakeAi(over: Partial<AiPort> = {}): AiPort & { [K in keyof AiPort]: ReturnType<typeof vi.fn> } {
  return {
    checkCompany: vi.fn(async () => ({ check: { icp_fit: 'fit' as const, property_type: 'residential', evidence: 'Manages rentals for owners', phone: '(512) 555-0142', website: 'https://sunbeltpm.com' }, usd: 0.007 })),
    draft: vi.fn(async () => ({ draft: GOOD_DRAFT, usd: 0.001 })),
    extract: vi.fn(async () => ({ extraction: { relevant: true, company_name: 'Evernest', domain: 'evernest.co', event_type: 'acquisition' as const, summary: 'Evernest bought a firm.' }, usd: 0.0005 })),
    ...over,
  } as AiPort & { [K in keyof AiPort]: ReturnType<typeof vi.fn> }
}

export const deps = (m: ReturnType<typeof memoryStore>, apify: ApifyPort, ai: AiPort): Deps => ({ store: m.store, apify, ai, clock: () => 0 })
