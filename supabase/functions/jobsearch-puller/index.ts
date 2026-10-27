// Supabase Edge Function: jobsearch-puller
// Phase worker for the job search pipeline. Each invocation loads the batch,
// runs ONE phase under a 110 s budget, PATCHes job_batches as it goes (that
// updated_at is the watchdog's heartbeat) and self-invokes with the next phase.
//
//   gate      approved     -> resolving  first fill round: read Jobs Final, build the
//                                        eligible pool (strict GTM titles, then adjacent,
//                                        then everything), take enough companies for a
//                                        500-contact order, insert them as pending
//   fill_more resolving                  another fill round after Apollo misses
//   refill    waiting_fill -> resolving  the hourly cron / a new scrape tops up a parked batch
//   resolve   resolving                  Apollo: domain -> organization_id, <=20/invocation;
//                                        then order, fill more, or park as waiting_fill
//   order     resolving    -> ordered    Leadsfriday: place the export order (>= 500 contacts)
//   poll     ordered   -> delivered   Leadsfriday: wait, then store the CSV in Storage
//   rank     delivered -> ranked      parse, join, role + rank, Gate 2 prompt
//
// POST {batch_id, phase?}. Without a phase the worker derives it from status,
// which is what jobs_resume and the dashboard's Resume rely on.
//
// supabaseRequest / tg copied from telegram-inbox; self-invoke pattern from
// hnwi-pipeline-orchestrator.

import {
  APOLLO_MAX_ORGS,
  assignRole,
  buildApolloUrl,
  type ContactFields,
  mapLeadsfridayRow,
  normalizeCompanyName,
  normalizeDomain,
  optionalHeaderIndex,
  parseCsv,
  rankContacts,
  type Role,
  rowToRecord,
} from '../_shared/jobsearch/pure.ts'
import {
  classifyPool,
  companiesNeeded,
  companiesToTake,
  contactCountFor,
  LEADSFRIDAY_MIN_CONTACTS,
  type Pool,
} from '../_shared/jobsearch/pool.ts'
import { getAccessToken, readRange } from '../_shared/jobsearch/sheets.ts'
import { alert, type AlertInput, lumeLink, titleFrom } from '../_shared/alert.ts'

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? ''
const GOOGLE_SERVICE_ACCOUNT_JSON = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON') ?? ''
const JOBSEARCH_SHEET_ID = Deno.env.get('JOBSEARCH_SHEET_ID') ?? '1wjvpjyX2g7UUkjgeOXRtPEb7-s4MQfmPOgikalpthcs'
const APOLLO_API_KEY = Deno.env.get('APOLLO_API_KEY') ?? ''
const LEADSFRIDAY_API_TOKEN = Deno.env.get('LEADSFRIDAY_API_TOKEN') ?? ''
const LEADSFRIDAY_BASE = Deno.env.get('LEADSFRIDAY_BASE_URL') ?? 'https://api.leadsfriday.com'

const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`
const STORAGE_BUCKET = 'leadsfriday-results'

const CHUNK_LIMIT_MS = 110_000          // stay under the 150 s wall clock
const RESOLVE_BATCH = 20                // Apollo calls per invocation
const POLL_SLEEP_MS = 60_000
const POLL_GIVE_UP_MS = 6 * 3600_000
const KEEP_TOP = 5
const MAX_FILL_ROUNDS = 8               // gate + fill_more passes before we park
// Statuses whose companies are spoken for: another batch must not take them.
const LIVE_STATUSES = 'approved,resolving,waiting_fill,ordered,delivered,ranked,written'

const REST_HEADERS: Record<string, string> = {
  'apikey': SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=minimal',
}

async function supabaseRequest(
  method: string,
  path: string,
  body?: unknown,
  opts?: { returning?: boolean; prefer?: string },
): Promise<unknown> {
  const headers = { ...REST_HEADERS }
  if (opts?.returning) headers['Prefer'] = 'return=representation'
  if (opts?.prefer) headers['Prefer'] = opts.prefer
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Supabase ${method} ${path} failed (${res.status}): ${text}`)
  }
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) return res.json()
  return null
}

async function tg(method: string, body: unknown): Promise<Record<string, unknown>> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { ok: false }
  try {
    const res = await fetch(`${TG_API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return await res.json()
  } catch {
    return { ok: false }
  }
}

function sendTelegram(text: string, reply_markup?: unknown): Promise<unknown> {
  return tg('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text, reply_markup, disable_web_page_preview: true })
}

// Every notice lands in lume_alerts; Telegram sends exactly as before while
// ALERT_CHANNELS includes telegram (the default).
type NotifyMeta = Pick<AlertInput<unknown>, 'severity' | 'link' | 'campaign_id' | 'scope' | 'dedupe_key'>
function notify(text: string, meta: NotifyMeta, reply_markup?: unknown): Promise<unknown> {
  return alert({
    source: 'jobsearch-puller', title: titleFrom(text), body: text, scope: 'orders', ...meta,
    telegram: () => sendTelegram(text, reply_markup),
  })
}

// ---- Types ----------------------------------------------------------------

type Phase = 'gate' | 'fill_more' | 'refill' | 'resolve' | 'order' | 'poll' | 'rank'

interface Payload {
  batch_id: string
  phase?: Phase
  ordered_at?: string   // ISO; carried through poll self-invokes so the 6 h clock survives heartbeats
  rate_limited?: boolean // set when the previous resolve invocation hit Apollo 429; a second one fails loudly
  pool_left?: number     // eligible companies the last fill round did NOT take (0 = pool exhausted)
}

interface JobBatch {
  id: string
  batch_date: string
  status: string
  companies_added: number
  companies_pulled: number
  companies_unresolved: number
  apollo_url: string | null
  leadsfriday_order_id: number | null
  leadsfriday_status: string | null
  result_storage_path: string | null
  lookback_days: number
  fill_rounds: number
  force_order: boolean
  updated_at: string
}

interface Company {
  id: string
  company_name: string
  website: string | null
  domain: string | null
  job_poster_name: string | null
  apollo_org_id: string | null
  resolve_status: string
}

const PHASE_FOR_STATUS: Record<string, Phase> = {
  approved: 'gate',
  waiting_fill: 'refill',
  resolving: 'resolve',
  ordered: 'poll',
  delivered: 'rank',
}

const STATUS_FOR_PHASE: Record<Phase, string> = {
  gate: 'approved',
  refill: 'waiting_fill',
  fill_more: 'resolving',
  resolve: 'resolving',
  order: 'resolving',
  poll: 'ordered',
  rank: 'delivered',
}

// ---- Small helpers --------------------------------------------------------

function selfInvoke(payload: Payload): void {
  fetch(`${SUPABASE_URL}/functions/v1/jobsearch-puller`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  }).catch(err => console.error('[jobsearch-puller] self-invoke error:', err))
}

async function loadBatch(batchId: string): Promise<JobBatch> {
  const rows = (await supabaseRequest(
    'GET',
    `job_batches?id=eq.${batchId}&select=id,batch_date,status,companies_added,companies_pulled,companies_unresolved,apollo_url,leadsfriday_order_id,leadsfriday_status,result_storage_path,lookback_days,fill_rounds,force_order,updated_at&limit=1`,
  )) as JobBatch[]
  if (!rows?.[0]) throw new Error(`job batch ${batchId} not found`)
  return rows[0]
}

function heartbeat(batchId: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  return supabaseRequest('PATCH', `job_batches?id=eq.${batchId}`, { updated_at: new Date().toISOString(), ...extra })
}

// Conditional transition. Returns false when another invocation already won.
async function claimStatus(batchId: string, from: string, patch: Record<string, unknown>, extraFilter = ''): Promise<boolean> {
  const rows = (await supabaseRequest(
    'PATCH',
    `job_batches?id=eq.${batchId}&status=eq.${from}${extraFilter}`,
    patch,
    { returning: true },
  )) as unknown[]
  return Array.isArray(rows) && rows.length > 0
}

function formatBatchDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

// The owner can abort from Telegram or the dashboard at any time. Long loops
// re-check the row so an abort takes effect within one step, not one phase.
async function stillInStatus(batchId: string, status: string): Promise<boolean> {
  const rows = (await supabaseRequest('GET', `job_batches?id=eq.${batchId}&select=status&limit=1`)) as { status: string }[]
  return rows?.[0]?.status === status
}

async function sheetsToken(): Promise<string> {
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON secret is not set')
  return getAccessToken(GOOGLE_SERVICE_ACCOUNT_JSON)
}

function storageHeaders(contentType?: string): Record<string, string> {
  const h: Record<string, string> = {
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  }
  if (contentType) h['Content-Type'] = contentType
  return h
}

async function storageUpload(path: string, body: string | Uint8Array, contentType: string): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`, {
    method: 'POST',
    headers: { ...storageHeaders(contentType), 'x-upsert': 'true' },
    body: body as BodyInit,
  })
  if (!res.ok) throw new Error(`Storage upload ${path} failed (${res.status}): ${await res.text()}`)
}

async function storageDownload(path: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`, { headers: storageHeaders() })
  if (!res.ok) throw new Error(`Storage download ${path} failed (${res.status}): ${await res.text()}`)
  return res.text()
}

function toInt(v: string | undefined): number | null {
  if (!v) return null
  const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10)
  return Number.isFinite(n) ? n : null
}

// ---- Fill rounds: gate / fill_more / refill ------------------------------

interface TakenRow { domain: string | null; company_name: string }

// Companies spoken for by any live batch (including this one).
async function loadTaken(batchId: string): Promise<{ domains: Set<string>; names: Set<string> }> {
  const others = (await supabaseRequest(
    'GET',
    `job_batch_companies?select=domain,company_name,job_batches!inner(status)` +
    `&job_batches.status=in.(${LIVE_STATUSES})&resolve_status=in.(pending,resolved)&limit=5000`,
  )) as TakenRow[]
  const mine = (await supabaseRequest(
    'GET', `job_batch_companies?batch_id=eq.${batchId}&select=domain,company_name&limit=1000`,
  )) as TakenRow[]
  const domains = new Set<string>()
  const names = new Set<string>()
  for (const r of [...(others ?? []), ...(mine ?? [])]) {
    if (r.domain) domains.add(r.domain)
    const n = normalizeCompanyName(r.company_name)
    if (n) names.add(n)
  }
  return { domains, names }
}

async function companyCounts(batchId: string): Promise<{ resolved: number; pending: number; unresolved: number }> {
  const rows = (await supabaseRequest(
    'GET', `job_batch_companies?batch_id=eq.${batchId}&select=resolve_status&limit=1000`,
  )) as { resolve_status: string }[]
  const c = { resolved: 0, pending: 0, unresolved: 0 }
  for (const r of rows ?? []) {
    if (r.resolve_status === 'resolved') c.resolved++
    else if (r.resolve_status === 'pending') c.pending++
    else if (r.resolve_status === 'unresolved') c.unresolved++
  }
  return c
}

async function buildPool(batch: JobBatch): Promise<Pool> {
  const token = await sheetsToken()
  const grid = await readRange(token, JOBSEARCH_SHEET_ID, "'Jobs Final'!A1:ZZ")
  if (grid.length < 2) throw new Error('Jobs Final has no data rows')

  const gtm = await readRange(token, JOBSEARCH_SHEET_ID, 'gtm!A1:ZZ')
  const gtmNames = new Set<string>()
  const gtmDomains = new Set<string>()
  if (gtm.length > 1) {
    const gCompany = optionalHeaderIndex(gtm[0], 'company')
    const gDomain = optionalHeaderIndex(gtm[0], 'domain')
    for (const r of gtm.slice(1)) {
      if (gCompany >= 0 && r[gCompany]) gtmNames.add(normalizeCompanyName(r[gCompany]))
      if (gDomain >= 0 && r[gDomain]) {
        const d = normalizeDomain(r[gDomain])
        if (d) gtmDomains.add(d)
      }
    }
  }
  const taken = await loadTaken(batch.id)
  return classifyPool(grid[0], grid.slice(1), {
    batchDate: batch.batch_date,
    lookbackDays: batch.lookback_days ?? 365,
    gtmNames,
    gtmDomains,
    takenDomains: taken.domains,
    takenNames: taken.names,
  })
}

function poolLine(pool: Pool): string {
  return `tier 1 strict GTM ${pool.byTier[1]} · tier 2 adjacent ${pool.byTier[2]} · tier 3 other ${pool.byTier[3]}`
}

// One fill round. `mode` decides the claim; the work is the same.
async function fillRound(batch: JobBatch, mode: 'gate' | 'fill_more' | 'refill'): Promise<void> {
  if (mode === 'gate' && !(await claimStatus(batch.id, 'approved', { status: 'resolving' }))) {
    console.log('[jobsearch-puller] gate: batch no longer approved, skipping'); return
  }
  if (mode === 'refill' && !(await claimStatus(batch.id, 'waiting_fill', { status: 'resolving' }))) {
    console.log('[jobsearch-puller] refill: batch no longer waiting_fill, skipping'); return
  }
  if (mode === 'fill_more' && !(await stillInStatus(batch.id, 'resolving'))) return

  const pool = await buildPool(batch)
  const counts = await companyCounts(batch.id)
  const take = companiesToTake(counts.resolved, counts.pending)
  const chosen = pool.eligible.slice(0, take)
  const poolLeft = Math.max(0, pool.eligible.length - chosen.length)

  const cell = (rec: Record<string, string>, name: string): string | null => {
    const v = rec[name]
    return v !== undefined && v !== '' ? String(v) : null
  }
  const inserts = chosen.map(r => ({
    batch_id: batch.id,
    company_name: r.company_name,
    website: r.website,
    domain: r.domain,
    job_title: r.title || null,
    job_link: cell(r.record, 'link'),
    job_poster_name: cell(r.record, 'jobPosterName'),
    job_poster_title: cell(r.record, 'jobPosterTitle'),
    job_poster_url: cell(r.record, 'jobPosterProfileUrl'),
    salary_text: cell(r.record, 'salaryText'),
    posted_at: r.posted_at ?? cell(r.record, 'postedAt'),
    employees: toInt(cell(r.record, 'companyEmployeesCount') ?? undefined),
    industries: cell(r.record, 'industries'),
    location: cell(r.record, 'location'),
    other_titles: cell(r.record, 'other_titles'),
    n_postings: cell(r.record, 'n_postings'),
    funding_stage: cell(r.record, 'fundingStage'),
    yc_batch: cell(r.record, 'ycBatch'),
    fit_tier: r.tier,
    resolve_status: 'pending',
  }))
  if (inserts.length > 0) {
    await supabaseRequest('POST', 'job_batch_companies', inserts, { prefer: 'return=minimal,resolution=ignore-duplicates' })
  }

  const after = await companyCounts(batch.id)
  await heartbeat(batch.id, {
    companies_pulled: after.resolved + after.pending + after.unresolved,
    companies_added: Math.max(batch.companies_added, pool.newRows),
    fill_rounds: (batch.fill_rounds ?? 0) + 1,
  })

  const tiers = { 1: 0, 2: 0, 3: 0 } as Record<1 | 2 | 3, number>
  for (const r of chosen) tiers[r.tier]++
  console.log(`[jobsearch-puller] ${mode}: pool ${poolLine(pool)}; took ${chosen.length} (t1 ${tiers[1]}, t2 ${tiers[2]}, t3 ${tiers[3]}); ${poolLeft} left`)

  if (mode === 'gate') {
    await notify(
      `🔎 Filling batch ${formatBatchDate(batch.batch_date)}\n` +
      `Eligible pool (not in gtm, last ${batch.lookback_days ?? 365} days): ${poolLine(pool)}.\n` +
      `Taking ${chosen.length} companies this round (strict ${tiers[1]}, adjacent ${tiers[2]}, other ${tiers[3]}); ` +
      `target ${companiesNeeded()} resolved for a ${LEADSFRIDAY_MIN_CONTACTS}-contact order.`,
      { severity: 'info', link: lumeLink('/validate') },
      { inline_keyboard: [[{ text: '⛔ Abort batch', callback_data: `jobs_abort:${batch.id}` }]] },
    )
  }

  if (after.pending === 0 && after.resolved === 0) {
    // Nothing to resolve and nothing taken: pool is empty right now.
    await parkWaitingFill(batch, after.resolved, poolLeft)
    return
  }
  selfInvoke({ batch_id: batch.id, phase: 'resolve', pool_left: poolLeft })
}

async function parkWaitingFill(batch: JobBatch, resolved: number, poolLeft: number): Promise<void> {
  if (!(await claimStatus(batch.id, 'resolving', { status: 'waiting_fill' }))) return
  const need = companiesNeeded()
  await notify(
    `⏳ Batch ${formatBatchDate(batch.batch_date)} is waiting to fill\n` +
    `${resolved} ${resolved === 1 ? 'company' : 'companies'} resolved (~${resolved * 15} contacts); ` +
    `Leadsfriday needs ${LEADSFRIDAY_MIN_CONTACTS} (${need} companies).\n` +
    `Eligible pool left: ${poolLeft}. New scrapes top this batch up automatically (checked hourly).\n\n` +
    `Order anyway places a ${LEADSFRIDAY_MIN_CONTACTS}-contact order for the ${resolved} resolved now.`,
    // Money decision. Keyed on the resolved count so a retry adds nothing but
    // a later re-park (after a refill) gets its own row.
    { severity: 'urgent', link: lumeLink(`/validate?gate=jobs_fill:${batch.id}`), dedupe_key: `${batch.id}:jobs_fill:${resolved}` },
    {
      inline_keyboard: [[
        { text: `💳 Order anyway (${LEADSFRIDAY_MIN_CONTACTS} min)`, callback_data: `jobs_order_now:${batch.id}` },
        { text: '⛔ Abort', callback_data: `jobs_abort:${batch.id}` },
      ]],
    },
  )
}

// ---- Phase: resolve -------------------------------------------------------

interface ApolloAccountResponse {
  account?: { id?: string; organization_id?: string | null; organization?: { id?: string } }
}

// Returns the org id, null when Apollo has no match, 'rate_limited' on 429.
// Anything that means "your account cannot do this" (bad key, no credits, plan
// limit) throws, which fails the whole batch and tells the owner in Telegram —
// the alternative is silently marking every company unresolved.
const APOLLO_CREDIT_RE = /credit|insufficient|plan limit|upgrade your plan|quota|not allowed on your plan/i

async function apolloOrgId(name: string, domain: string): Promise<string | null | 'rate_limited'> {
  const res = await fetch('https://api.apollo.io/api/v1/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': APOLLO_API_KEY },
    body: JSON.stringify({ name, domain }),
  })
  if (res.status === 401) {
    throw new Error('Apollo rejected the request (401) — check the APOLLO_API_KEY secret')
  }
  if (res.status === 402 || res.status === 403) {
    const body = (await res.text()).slice(0, 300)
    throw new Error(`Apollo refused (${res.status}) — out of credits or plan limit reached. ${body}`)
  }
  if (res.status === 429) return 'rate_limited'
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300)
    if (APOLLO_CREDIT_RE.test(body)) {
      throw new Error(`Apollo refused (${res.status}) — out of credits or plan limit reached. ${body}`)
    }
    console.warn(`[jobsearch-puller] Apollo ${res.status} for ${domain}: ${body}`)
    return null
  }
  const data = await res.json() as ApolloAccountResponse
  return data.account?.organization_id ?? data.account?.organization?.id ?? null
}

async function phaseResolve(batch: JobBatch, payload: Payload, startedAt: number): Promise<void> {
  if (!APOLLO_API_KEY) throw new Error('APOLLO_API_KEY secret is not set')
  const rateLimitedBefore = payload.rate_limited === true

  const pending = (await supabaseRequest(
    'GET',
    `job_batch_companies?batch_id=eq.${batch.id}&resolve_status=eq.pending&select=id,company_name,website,domain&order=fit_tier,created_at&limit=${RESOLVE_BATCH}`,
  )) as Company[]

  let rateLimited = false
  for (const c of pending) {
    if (Date.now() - startedAt > CHUNK_LIMIT_MS - 10_000) break
    if (!(await stillInStatus(batch.id, 'resolving'))) { console.log('[jobsearch-puller] resolve: batch left resolving (aborted?), stopping'); return }
    if (!c.domain) {
      await supabaseRequest('PATCH', `job_batch_companies?id=eq.${c.id}&resolve_status=eq.pending`,
        { resolve_status: 'unresolved', exclude_reason: 'no_domain' })
      continue
    }
    let orgId = await apolloOrgId(c.company_name, c.domain)
    if (orgId === 'rate_limited') {
      await new Promise(r => setTimeout(r, 20_000))
      orgId = await apolloOrgId(c.company_name, c.domain)
      if (orgId === 'rate_limited') {
        if (rateLimitedBefore) {
          throw new Error('Apollo keeps returning 429 (rate or plan limit). Resume the batch later from Telegram or the dashboard.')
        }
        rateLimited = true
        break
      }
    }
    await supabaseRequest('PATCH', `job_batch_companies?id=eq.${c.id}&resolve_status=eq.pending`,
      orgId
        ? { resolve_status: 'resolved', apollo_org_id: orgId }
        : { resolve_status: 'unresolved', exclude_reason: 'apollo_no_match' })
  }
  if (!(await stillInStatus(batch.id, 'resolving'))) return
  await heartbeat(batch.id)

  const counts = await companyCounts(batch.id)
  if (counts.pending > 0) {
    if (rateLimited) await new Promise(r => setTimeout(r, 30_000))
    selfInvoke({ batch_id: batch.id, phase: 'resolve', rate_limited: rateLimited || undefined, pool_left: payload.pool_left })
    return
  }

  // Everything taken so far is decided. Enough for an order?
  const need = companiesNeeded()
  const fresh = await loadBatch(batch.id)
  if (counts.resolved < need && !fresh.force_order) {
    const poolLeft = payload.pool_left ?? 1 // unknown -> assume there may be more
    if (poolLeft > 0 && (fresh.fill_rounds ?? 0) < MAX_FILL_ROUNDS) {
      console.log(`[jobsearch-puller] resolve: ${counts.resolved}/${need} resolved, filling more (${poolLeft} left in pool)`)
      selfInvoke({ batch_id: batch.id, phase: 'fill_more' })
      return
    }
    if (counts.resolved === 0) {
      await failBatch(batch.id, 'resolving', 'resolve', 'no companies to order: nothing eligible resolved in Apollo')
      return
    }
    await parkWaitingFill(fresh, counts.resolved, poolLeft)
    return
  }

  const resolved = (await supabaseRequest(
    'GET',
    `job_batch_companies?batch_id=eq.${batch.id}&resolve_status=eq.resolved&select=id,apollo_org_id&order=fit_tier,created_at&limit=500`,
  )) as Company[]
  const overflow = resolved.slice(APOLLO_MAX_ORGS)
  for (const c of overflow) {
    await supabaseRequest('PATCH', `job_batch_companies?id=eq.${c.id}`, { resolve_status: 'unresolved', exclude_reason: 'batch_cap' })
  }
  const kept = resolved.slice(0, APOLLO_MAX_ORGS)
  const url = buildApolloUrl(kept.map(c => c.apollo_org_id!))

  await heartbeat(batch.id, { apollo_url: url, companies_unresolved: counts.unresolved + overflow.length })
  console.log(`[jobsearch-puller] resolve: ${kept.length} resolved, ${counts.unresolved} unresolved${fresh.force_order ? ' (forced order)' : ''}`)
  selfInvoke({ batch_id: batch.id, phase: 'order' })
}

// ---- Phase: order ---------------------------------------------------------

interface LeadsfridayOrder {
  order_id: number
  status: string
  status_url?: string
  download_url?: string | null
  credits_deducted?: number
  new_balance?: number
}

async function phaseOrder(batch: JobBatch): Promise<void> {
  if (!LEADSFRIDAY_API_TOKEN) throw new Error('LEADSFRIDAY_API_TOKEN secret is not set')
  if (!batch.apollo_url) throw new Error('order: apollo_url is empty')

  const resolvedCount = ((await supabaseRequest(
    'GET', `job_batch_companies?batch_id=eq.${batch.id}&resolve_status=eq.resolved&select=id&limit=500`,
  )) as { id: string }[]).length
  const contactCount = contactCountFor(resolvedCount)

  // Claim BEFORE paying. A replayed invocation finds zero rows and places no
  // second order. If the call below fails the batch goes to failed with the
  // reason, which is the visible, recoverable outcome.
  if (!(await claimStatus(batch.id, 'resolving', { status: 'ordered' }, '&leadsfriday_order_id=is.null'))) {
    console.log('[jobsearch-puller] order: already ordered, skipping')
    return
  }

  const form = new FormData()
  form.set('search_url', batch.apollo_url)
  form.set('results_file_name', `jobsearch-${batch.batch_date}.csv`)
  form.set('contact_count', String(contactCount))
  form.set('verify_emails', 'yes')
  form.set('note', `job search batch ${batch.batch_date}`)

  const res = await fetch(`${LEADSFRIDAY_BASE}/api/export-apollo/`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${LEADSFRIDAY_API_TOKEN}` },
    body: form,
  })
  if (res.status === 403) {
    await failBatch(batch.id, 'ordered', 'order', `Leadsfriday: insufficient credits for ${contactCount} contacts — top up, then Resume the batch`)
    return
  }
  if (res.status === 401) { await failBatch(batch.id, 'ordered', 'order', 'Leadsfriday rejected the token (401) — check the LEADSFRIDAY_API_TOKEN secret'); return }
  if (!res.ok) {
    await failBatch(batch.id, 'ordered', 'order', `Leadsfriday ${res.status}: ${(await res.text()).slice(0, 300)}`)
    return
  }
  const order = await res.json() as LeadsfridayOrder
  if (!order.order_id) { await failBatch(batch.id, 'ordered', 'order', `Leadsfriday returned no order_id: ${JSON.stringify(order).slice(0, 300)}`); return }

  const orderedAt = new Date().toISOString()
  await heartbeat(batch.id, { leadsfriday_order_id: order.order_id, leadsfriday_status: order.status ?? 'pending' })
  console.log(`[jobsearch-puller] order: #${order.order_id} for ${contactCount} contacts (${order.credits_deducted ?? '?'} credits)`)

  // Cost report the moment money moves. Apollo's account lookups are free.
  const deducted = order.credits_deducted !== undefined ? `${order.credits_deducted} credits deducted` : 'credits deducted: not reported'
  const balance = order.new_balance !== undefined ? ` · balance ${order.new_balance}` : ''
  await notify(
    `💳 Leadsfriday order #${order.order_id} — batch ${formatBatchDate(batch.batch_date)}\n` +
    `${contactCount} contacts requested across ${resolvedCount} ${resolvedCount === 1 ? 'company' : 'companies'} (verified emails)\n` +
    `${deducted}${balance}\n` +
    `Apollo: ${resolvedCount} org lookups, free.\n\n` +
    `Abort stops the pipeline here; Leadsfriday credits already spent are not refunded.`,
    { severity: 'urgent', link: lumeLink('/validate') },
    { inline_keyboard: [[{ text: '⛔ Abort batch', callback_data: `jobs_abort:${batch.id}` }]] },
  )
  selfInvoke({ batch_id: batch.id, phase: 'poll', ordered_at: orderedAt })
}

// ---- Phase: poll ----------------------------------------------------------

interface LeadsfridayStatus {
  status: string
  delivered_count?: number
  download_url?: string | null
  expires_at?: string
  delivery_expired?: boolean
}

async function phasePoll(batch: JobBatch, payload: Payload, startedAt: number): Promise<void> {
  if (!batch.leadsfriday_order_id) throw new Error('poll: no leadsfriday_order_id on the batch')
  // Without a carried clock (watchdog resume) the 6 h window restarts here.
  const orderedAt = payload.ordered_at ?? new Date().toISOString()

  while (true) {
    const res = await fetch(`${LEADSFRIDAY_BASE}/api/export-apollo/${batch.leadsfriday_order_id}/`, {
      headers: { 'Authorization': `Bearer ${LEADSFRIDAY_API_TOKEN}` },
    })
    if (res.status === 401) throw new Error('Leadsfriday rejected the token (401) — check the LEADSFRIDAY_API_TOKEN secret')
    if (!res.ok) throw new Error(`Leadsfriday status ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const st = await res.json() as LeadsfridayStatus

    if (st.status === 'delivered') {
      if (!st.download_url) throw new Error('Leadsfriday says delivered but gave no download_url')
      // The URL expires — fetch it now, in this invocation.
      const dl = await fetch(st.download_url, { redirect: 'follow' })
      if (!dl.ok) throw new Error(`Leadsfriday download failed (${dl.status})`)
      const csv = await dl.text()
      const path = `${batch.id}.csv`
      await storageUpload(path, csv, 'text/csv')
      const ok = await claimStatus(batch.id, 'ordered', {
        status: 'delivered',
        leadsfriday_status: 'delivered',
        leadsfriday_download_url: st.download_url,
        result_storage_path: `${STORAGE_BUCKET}/${path}`,
      })
      if (!ok) { console.log('[jobsearch-puller] poll: another invocation already stored the delivery'); return }
      console.log(`[jobsearch-puller] poll: delivered ${st.delivered_count ?? '?'} rows, stored ${path}`)
      selfInvoke({ batch_id: batch.id, phase: 'rank' })
      return
    }
    if (st.status === 'cancelled') {
      await failBatch(batch.id, 'ordered', 'poll', 'Leadsfriday cancelled the order')
      return
    }

    if (!(await stillInStatus(batch.id, 'ordered'))) { console.log('[jobsearch-puller] poll: batch left ordered (aborted?), stopping'); return }
    await heartbeat(batch.id, { leadsfriday_status: st.status })

    if (Date.now() - new Date(orderedAt).getTime() > POLL_GIVE_UP_MS) {
      await failBatch(batch.id, 'ordered', 'poll', 'Leadsfriday did not deliver within 6 hours')
      return
    }
    const elapsed = Date.now() - startedAt
    const budgetLeft = CHUNK_LIMIT_MS - elapsed
    if (budgetLeft < POLL_SLEEP_MS + 15_000) {
      selfInvoke({ batch_id: batch.id, phase: 'poll', ordered_at: orderedAt })
      return
    }
    await new Promise(r => setTimeout(r, POLL_SLEEP_MS))
  }
}

// ---- Phase: rank ----------------------------------------------------------

type ContactRow = ContactFields & {
  role: Role
  company_id: string | null
  matched_company_name: string
  matched_domain: string | null
  raw: Record<string, string>
}

async function phaseRank(batch: JobBatch): Promise<void> {
  if (!batch.result_storage_path) throw new Error('rank: no result_storage_path on the batch')
  const path = batch.result_storage_path.replace(new RegExp(`^${STORAGE_BUCKET}/`), '')
  const csvText = await storageDownload(path)
  const { headers, rows } = parseCsv(csvText)
  if (headers.length === 0) throw new Error('rank: the Leadsfriday CSV is empty')
  console.log(`[jobsearch-puller] rank: CSV header = ${headers.join(' | ')}`)

  const companies = (await supabaseRequest(
    'GET',
    `job_batch_companies?batch_id=eq.${batch.id}&select=id,company_name,website,domain,job_poster_name,apollo_org_id,resolve_status&limit=500`,
  )) as Company[]
  const byDomain = new Map<string, Company>()
  const byName = new Map<string, Company>()
  for (const c of companies) {
    if (c.domain) byDomain.set(c.domain, c)
    const n = normalizeCompanyName(c.company_name)
    if (n) byName.set(n, c)
  }

  const contacts: ContactRow[] = []
  for (const r of rows) {
    const raw = rowToRecord(headers, r)
    const f = mapLeadsfridayRow(raw)
    const domain = f.website ? normalizeDomain(f.website) || null : null
    const company = (domain && byDomain.get(domain)) || byName.get(normalizeCompanyName(f.company_name)) || null
    contacts.push({
      ...f,
      role: assignRole(f.title, f.first_name, f.last_name, company?.job_poster_name),
      company_id: company?.id ?? null,
      matched_company_name: company?.company_name ?? (f.company_name || 'Unknown'),
      matched_domain: company?.domain ?? domain,
      raw,
    })
  }

  // Rank within each company (by id when matched, else by normalized name).
  const groups = new Map<string, ContactRow[]>()
  for (const c of contacts) {
    const key = c.company_id ?? `name:${normalizeCompanyName(c.matched_company_name)}`
    const g = groups.get(key) ?? []
    g.push(c)
    groups.set(key, g)
  }

  const inserts: Record<string, unknown>[] = []
  let withEmail = 0
  let keptCount = 0
  for (const group of groups.values()) {
    for (const c of rankContacts(group, KEEP_TOP)) {
      if (c.email) withEmail++
      if (c.kept) keptCount++
      inserts.push({
        batch_id: batch.id,
        company_id: c.company_id,
        company_name: c.matched_company_name,
        domain: c.matched_domain,
        first_name: c.first_name,
        last_name: c.last_name,
        title: c.title,
        email: c.email,
        linkedin_url: c.linkedin_url,
        seniority: c.seniority,
        department: c.department,
        location: c.location,
        corporate_phone: c.corporate_phone,
        role: c.role,
        rank: c.rank,
        kept: c.kept,
        raw: c.raw,
      })
    }
  }

  // ignore-duplicates: re-running rank after a partial insert is safe
  // (unique on batch_id + email).
  for (let i = 0; i < inserts.length; i += 200) {
    await supabaseRequest('POST', 'job_contacts', inserts.slice(i, i + 200), { prefer: 'return=minimal,resolution=ignore-duplicates' })
  }

  const ok = await claimStatus(batch.id, 'delivered', {
    status: 'ranked',
    write_status: 'awaiting',
    contacts_total: contacts.length,
    contacts_kept: keptCount,
  })
  if (!ok) { console.log('[jobsearch-puller] rank: another invocation already ranked this batch'); return }

  const unresolved = companies.filter(c => c.resolve_status === 'unresolved').map(c => c.company_name)
  const unresolvedLine = unresolved.length
    ? `\n${unresolved.length} ${unresolved.length === 1 ? 'company' : 'companies'} unresolved in Apollo: ${unresolved.slice(0, 10).join(', ')}${unresolved.length > 10 ? '…' : ''}`
    : ''
  const text =
    `📇 Contacts ready — batch ${formatBatchDate(batch.batch_date)}\n` +
    `${contacts.length} people across ${groups.size} ${groups.size === 1 ? 'company' : 'companies'} · ${withEmail} with email\n` +
    `kept top ${KEEP_TOP} per company → ${keptCount} rows` +
    unresolvedLine
  await notify(text, { severity: 'urgent', link: lumeLink(`/validate?gate=jobs_write:${batch.id}`), dedupe_key: `${batch.id}:jobs_write` }, {
    inline_keyboard: [[
      { text: '✍️ Write to gtm tab', callback_data: `jobs_write:${batch.id}` },
      { text: '🗑 Discard', callback_data: `jobs_discard:${batch.id}` },
    ]],
  })
  console.log(`[jobsearch-puller] rank: ${contacts.length} contacts, ${keptCount} kept`)
}

// ---- Failure --------------------------------------------------------------

async function failBatch(batchId: string, fromStatus: string, phase: string, message: string): Promise<void> {
  const rows = (await supabaseRequest(
    'PATCH',
    `job_batches?id=eq.${batchId}&status=eq.${fromStatus}`,
    { status: 'failed', error: message },
    { returning: true },
  )) as JobBatch[]
  if (rows?.length) {
    await notify(`❌ Job batch ${formatBatchDate(rows[0].batch_date)} failed at ${phase}\n${message}`, { severity: 'warn', link: lumeLink('/validate') })
  }
}

// ---- Dispatch -------------------------------------------------------------

async function run(payload: Payload): Promise<void> {
  const startedAt = Date.now()
  const batch = await loadBatch(payload.batch_id)
  const phase = payload.phase ?? PHASE_FOR_STATUS[batch.status]
  if (!phase) {
    console.log(`[jobsearch-puller] nothing to do for status ${batch.status}`)
    return
  }
  // An explicit phase must agree with the row. A stale self-invoke that lands
  // after a watchdog Resume must not run a second copy of a finished phase.
  if (STATUS_FOR_PHASE[phase] !== batch.status) {
    console.log(`[jobsearch-puller] phase ${phase} does not match status ${batch.status}, skipping`)
    return
  }

  try {
    switch (phase) {
      case 'gate': await fillRound(batch, 'gate'); break
      case 'fill_more': await fillRound(batch, 'fill_more'); break
      case 'refill': await fillRound(batch, 'refill'); break
      case 'resolve': await phaseResolve(batch, payload, startedAt); break
      case 'order': await phaseOrder(batch); break
      case 'poll': await phasePoll(batch, payload, startedAt); break
      case 'rank': await phaseRank(batch); break
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[jobsearch-puller] ${phase} failed:`, message)
    const current = await loadBatch(batch.id).catch(() => null)
    if (current && !['failed', 'written', 'discarded', 'skipped', 'merged'].includes(current.status)) {
      await failBatch(batch.id, current.status, phase, message)
    }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  let payload: Payload
  try {
    payload = await req.json() as Payload
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }
  if (!payload.batch_id) {
    return new Response(JSON.stringify({ error: 'batch_id is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }
  if (payload.phase && !(payload.phase in STATUS_FOR_PHASE)) {
    return new Response(JSON.stringify({ error: `unknown phase ${payload.phase}` }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  EdgeRuntime.waitUntil(run(payload).catch(err => console.error('[jobsearch-puller] unhandled:', err)))

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
})
