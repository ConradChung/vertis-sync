// Supabase Edge Function: jobsearch-puller
// Phase worker for the job search pipeline. Each invocation loads the batch,
// runs ONE phase under a 110 s budget, PATCHes job_batches as it goes (that
// updated_at is the watchdog's heartbeat) and self-invokes with the next phase.
//
//   gate     approved  -> resolving   read Jobs Final, select the batch's rows,
//                                     exclude what gtm already has, insert companies
//   resolve  resolving                Apollo: domain -> organization_id, <=20/invocation,
//                                     then build the people-search URL
//   order    resolving -> ordered     Leadsfriday: place the export order
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
  headerIndex,
  isGtmTitle,
  mapLeadsfridayRow,
  normalizeCompanyName,
  normalizeDomain,
  optionalHeaderIndex,
  parseCsv,
  rankContacts,
  type Role,
  rowToRecord,
  sameSheetDate,
} from '../_shared/jobsearch/pure.ts'
import { getAccessToken, readRange } from '../_shared/jobsearch/sheets.ts'

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
const CONTACTS_PER_COMPANY = 15         // ~13 observed; Leadsfriday contact_count
const MIN_CONTACT_COUNT = 50

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

// ---- Types ----------------------------------------------------------------

type Phase = 'gate' | 'resolve' | 'order' | 'poll' | 'rank'

interface Payload {
  batch_id: string
  phase?: Phase
  ordered_at?: string   // ISO; carried through poll self-invokes so the 6 h clock survives heartbeats
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
  resolving: 'resolve',
  ordered: 'poll',
  delivered: 'rank',
}

const STATUS_FOR_PHASE: Record<Phase, string> = {
  gate: 'approved',
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
    `job_batches?id=eq.${batchId}&select=id,batch_date,status,companies_added,companies_pulled,companies_unresolved,apollo_url,leadsfriday_order_id,leadsfriday_status,result_storage_path,updated_at&limit=1`,
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

// ---- Phase: gate ----------------------------------------------------------

async function phaseGate(batch: JobBatch): Promise<void> {
  if (!(await claimStatus(batch.id, 'approved', { status: 'resolving' }))) {
    console.log('[jobsearch-puller] gate: batch no longer approved, skipping')
    return
  }

  const token = await sheetsToken()
  const grid = await readRange(token, JOBSEARCH_SHEET_ID, "'Jobs Final'!A1:ZZ")
  if (grid.length < 2) throw new Error('Jobs Final has no data rows')
  const headers = grid[0]

  // Column lookups by name, read at run time. Required columns throw with the name.
  const col = {
    company: headerIndex(headers, 'companyName'),
    title: headerIndex(headers, 'title'),
    link: headerIndex(headers, 'link'),
    status: headerIndex(headers, 'status'),
    website: headerIndex(headers, 'companyWebsite'),
    addedOn: headerIndex(headers, 'added_on'),
  }
  const opt = (name: string) => optionalHeaderIndex(headers, name)
  const o = {
    posterName: opt('jobPosterName'), posterTitle: opt('jobPosterTitle'), posterUrl: opt('jobPosterProfileUrl'),
    salary: opt('salaryText'), postedAt: opt('postedAt'), employees: opt('companyEmployeesCount'),
    industries: opt('industries'), location: opt('location'), otherTitles: opt('other_titles'),
    nPostings: opt('n_postings'), funding: opt('fundingStage'), yc: opt('ycBatch'),
  }
  const cell = (row: string[], i: number): string | null => (i >= 0 && row[i] !== undefined && row[i] !== '' ? String(row[i]) : null)

  // What gtm already has, by normalized name and by domain.
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

  type NewCompany = Record<string, unknown> & { resolve_status: string; _key: string }
  const byKey = new Map<string, NewCompany>()

  for (const row of grid.slice(1)) {
    if (!sameSheetDate(row[col.addedOn], batch.batch_date)) continue
    const name = (row[col.company] ?? '').trim()
    if (!name) continue
    const title = row[col.title] ?? ''
    const status = (row[col.status] ?? '').trim().toLowerCase()
    const website = cell(row, col.website)
    const domain = website ? normalizeDomain(website) || null : null
    const normName = normalizeCompanyName(name)

    let exclude: string | null = null
    if (status === 'not a right fit') exclude = 'not_a_right_fit'
    else if (!isGtmTitle(title)) exclude = 'title_mismatch'
    else if ((domain && gtmDomains.has(domain)) || (normName && gtmNames.has(normName))) exclude = 'already_in_gtm'

    const key = domain ?? `name:${normName}`
    const record: NewCompany = {
      _key: key,
      batch_id: batch.id,
      company_name: name,
      website,
      domain,
      job_title: title || null,
      job_link: cell(row, col.link),
      job_poster_name: cell(row, o.posterName),
      job_poster_title: cell(row, o.posterTitle),
      job_poster_url: cell(row, o.posterUrl),
      salary_text: cell(row, o.salary),
      posted_at: cell(row, o.postedAt),
      employees: toInt(cell(row, o.employees) ?? undefined),
      industries: cell(row, o.industries),
      location: cell(row, o.location),
      other_titles: cell(row, o.otherTitles),
      n_postings: cell(row, o.nPostings),
      funding_stage: cell(row, o.funding),
      yc_batch: cell(row, o.yc),
      resolve_status: exclude ? 'excluded' : 'pending',
      exclude_reason: exclude,
    }

    // Same company twice in one batch: keep the first, unless the later one
    // is included and the earlier was excluded.
    const prev = byKey.get(key)
    if (!prev || (prev.resolve_status === 'excluded' && !exclude)) byKey.set(key, record)
  }

  const companies = Array.from(byKey.values()).map(({ _key, ...rest }) => rest)
  if (companies.length > 0) {
    await supabaseRequest('POST', 'job_batch_companies', companies, { prefer: 'return=minimal,resolution=ignore-duplicates' })
  }
  const pulled = companies.filter(c => c.resolve_status === 'pending').length
  await heartbeat(batch.id, { companies_pulled: pulled })

  console.log(`[jobsearch-puller] gate: ${companies.length} rows for ${batch.batch_date}, ${pulled} to resolve`)
  if (pulled === 0) {
    await failBatch(batch.id, 'resolving', 'gate', 'no companies to order: every row for this batch was excluded or missing')
    return
  }
  selfInvoke({ batch_id: batch.id, phase: 'resolve' })
}

// ---- Phase: resolve -------------------------------------------------------

interface ApolloAccountResponse {
  account?: { id?: string; organization_id?: string | null; organization?: { id?: string } }
}

// Returns the org id, null when Apollo has no match, 'rate_limited' on 429.
async function apolloOrgId(name: string, domain: string): Promise<string | null | 'rate_limited'> {
  const res = await fetch('https://api.apollo.io/api/v1/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'x-api-key': APOLLO_API_KEY },
    body: JSON.stringify({ name, domain }),
  })
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Apollo rejected the request (${res.status}) — check the APOLLO_API_KEY secret`)
  }
  if (res.status === 429) return 'rate_limited'
  if (!res.ok) {
    console.warn(`[jobsearch-puller] Apollo ${res.status} for ${domain}: ${(await res.text()).slice(0, 200)}`)
    return null
  }
  const data = await res.json() as ApolloAccountResponse
  return data.account?.organization_id ?? data.account?.organization?.id ?? null
}

async function phaseResolve(batch: JobBatch, startedAt: number): Promise<void> {
  if (!APOLLO_API_KEY) throw new Error('APOLLO_API_KEY secret is not set')

  const pending = (await supabaseRequest(
    'GET',
    `job_batch_companies?batch_id=eq.${batch.id}&resolve_status=eq.pending&select=id,company_name,website,domain&order=created_at&limit=${RESOLVE_BATCH}`,
  )) as Company[]

  let rateLimited = false
  for (const c of pending) {
    if (Date.now() - startedAt > CHUNK_LIMIT_MS - 10_000) break
    if (!c.domain) {
      await supabaseRequest('PATCH', `job_batch_companies?id=eq.${c.id}&resolve_status=eq.pending`,
        { resolve_status: 'unresolved', exclude_reason: 'no_domain' })
      continue
    }
    const orgId = await apolloOrgId(c.company_name, c.domain)
    if (orgId === 'rate_limited') { rateLimited = true; break }
    await supabaseRequest('PATCH', `job_batch_companies?id=eq.${c.id}&resolve_status=eq.pending`,
      orgId
        ? { resolve_status: 'resolved', apollo_org_id: orgId }
        : { resolve_status: 'unresolved', exclude_reason: 'apollo_no_match' })
  }
  await heartbeat(batch.id)

  const remaining = (await supabaseRequest(
    'GET', `job_batch_companies?batch_id=eq.${batch.id}&resolve_status=eq.pending&select=id&limit=1`,
  )) as { id: string }[]
  if (remaining.length > 0) {
    if (rateLimited) await new Promise(r => setTimeout(r, 10_000))
    selfInvoke({ batch_id: batch.id, phase: 'resolve' })
    return
  }

  // Everything is decided. Build the search URL from the resolved org ids.
  const resolved = (await supabaseRequest(
    'GET',
    `job_batch_companies?batch_id=eq.${batch.id}&resolve_status=eq.resolved&select=id,apollo_org_id&order=created_at&limit=500`,
  )) as Company[]
  if (resolved.length === 0) {
    await failBatch(batch.id, 'resolving', 'resolve', 'no companies to order: Apollo resolved none of the websites')
    return
  }
  const overflow = resolved.slice(APOLLO_MAX_ORGS)
  for (const c of overflow) {
    await supabaseRequest('PATCH', `job_batch_companies?id=eq.${c.id}`, { resolve_status: 'unresolved', exclude_reason: 'batch_cap' })
  }
  const kept = resolved.slice(0, APOLLO_MAX_ORGS)
  const url = buildApolloUrl(kept.map(c => c.apollo_org_id!))

  const unresolvedCount = ((await supabaseRequest(
    'GET', `job_batch_companies?batch_id=eq.${batch.id}&resolve_status=eq.unresolved&select=id&limit=500`,
  )) as { id: string }[]).length

  await heartbeat(batch.id, { apollo_url: url, companies_unresolved: unresolvedCount })
  console.log(`[jobsearch-puller] resolve: ${kept.length} resolved, ${unresolvedCount} unresolved`)
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
  const contactCount = Math.max(MIN_CONTACT_COUNT, Math.ceil(resolvedCount * CONTACTS_PER_COMPANY))

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
  if (res.status === 403) { await failBatch(batch.id, 'ordered', 'order', 'insufficient credits'); return }
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
  await sendTelegram(text, {
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
    await sendTelegram(`❌ Job batch ${formatBatchDate(rows[0].batch_date)} failed at ${phase}\n${message}`)
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
      case 'gate': await phaseGate(batch); break
      case 'resolve': await phaseResolve(batch, startedAt); break
      case 'order': await phaseOrder(batch); break
      case 'poll': await phasePoll(batch, payload, startedAt); break
      case 'rank': await phaseRank(batch); break
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[jobsearch-puller] ${phase} failed:`, message)
    const current = await loadBatch(batch.id).catch(() => null)
    if (current && !['failed', 'written', 'discarded', 'skipped'].includes(current.status)) {
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
