// Supabase Edge Function: instantly-push
// Receives { job_id }, pushes a finished job's valid rows into the Instantly
// campaign chosen over Telegram, then reports counts back to Telegram.
//
// Two barriers gate what actually goes out (see the migration for defaults):
//   location_barrier  OFF (default) — keep every valid row; if the operating
//                     city is UNKNOWN/ERROR/missing, send a BLANK location
//                     rather than the literal word "UNKNOWN". Lax, but never
//                     lets a placeholder render inside a live email.
//                     ON — only rows with a real city AND high city_confidence.
//   company_barrier   ON (default) — the owner reviews the first 10 normalized
//                     company names before anything is written, and obvious
//                     junk names (scraped placeholders) are dropped.
//                     OFF — no review, no junk filtering.
//
// Company names follow the owner's cold-email SOP (_shared/company_name.ts),
// both barriers aside: Haiku first, deterministic rules as the fallback.
//
// mode:'preview' answers synchronously with the first 10 normalized names and
// the eligibility counts — telegram-inbox renders that for the review screen.
// Keeping preview here (rather than reimplementing normalization in
// telegram-inbox) is deliberate: the names you approve are produced by the
// exact code that later pushes them.

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }
import { alert, type AlertInput, gateKey, lumeLink, titleFrom } from '../_shared/alert.ts'
import {
  complianceLaw,
  FALLBACK_COMPLIANCE_LAW,
  type JurisdictionRow,
  normalizeCountry,
  normalizeRegion,
  resolveJurisdiction,
} from '../_shared/research/jurisdiction.ts'
import {
  applyStrict,
  cacheKey,
  cleanCompanyNameRules,
  cleanCompanyNames,
  emailDomain,
  restCache,
} from '../_shared/company_name.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const INSTANTLY_API_KEY = Deno.env.get('INSTANTLY_API_KEY') ?? ''
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? ''
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''

const INSTANTLY_BASE_URL = 'https://api.instantly.ai/api/v2'
const SAMPLE_SIZE = 10

const REST_HEADERS: Record<string, string> = {
  'apikey': SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=minimal',
}

async function supabaseRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: REST_HEADERS,
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

// Every notice lands in lume_alerts; Telegram sends exactly as before while
// ALERT_CHANNELS includes telegram (the default).
type NotifyMeta = Pick<AlertInput<void>, 'severity' | 'link' | 'campaign_id' | 'scope' | 'dedupe_key'>
function notify(message: string, meta: NotifyMeta, replyMarkup?: unknown): Promise<void | undefined> {
  return alert({
    source: 'instantly-push', title: titleFrom(message), body: message, ...meta,
    telegram: () => sendTelegram(message, replyMarkup),
  })
}

async function sendTelegram(message: string, replyMarkup?: unknown): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    })
  } catch {
    // Non-critical — ignore Telegram errors
  }
}

// ---- Column detection (mirrors operating-city-enricher; edge functions
// don't share code with the Next.js app — see design doc) ----

function normalizeHeader(h: string): string {
  return h.toLowerCase().trim().replace(/\s+/g, '_')
}

function pickColumn(headers: string[], exact: Set<string>, contains: string[]): string | null {
  const normalized = headers.map(normalizeHeader)
  for (let i = 0; i < headers.length; i++) if (exact.has(normalized[i])) return headers[i]
  for (let i = 0; i < headers.length; i++) {
    if (contains.some(c => normalized[i].includes(c))) return headers[i]
  }
  return null
}

const COMPANY_EXACT = new Set(['company_name', 'company', 'business_name', 'organization'])
const WEBSITE_EXACT = new Set(['website', 'domain', 'url', 'web'])
const FIRST_EXACT = new Set(['first_name', 'firstname', 'given_name'])
const LAST_EXACT = new Set(['last_name', 'lastname', 'surname', 'family_name'])

interface Columns {
  company: string | null
  website: string | null
  first: string | null
  last: string | null
}

function detectColumns(headers: string[]): Columns {
  return {
    company: pickColumn(headers, COMPANY_EXACT, ['company', 'business_name']),
    website: pickColumn(headers, WEBSITE_EXACT, ['website', 'domain']),
    first: pickColumn(headers, FIRST_EXACT, ['first_name', 'first']),
    last: pickColumn(headers, LAST_EXACT, ['last_name', 'last']),
  }
}

// ---- Company name normalization ----
//
// The owner's SOP (_shared/company_name.ts): Haiku cleans each chunk's names
// before decideRow runs, and the deterministic rules stand in for any name it
// did not answer (no key, an error, a rejected answer). company_strict then
// peels descriptive suffixes on top, as before.

function normalizeCompany(raw: string, strict: boolean, cleaned?: string): string {
  const base = cleaned ?? cleanCompanyNameRules(raw)
  return strict && base ? applyStrict(base) : base
}

/** Cleaned company names for these rows, keyed by cacheKey(raw, email domain). Never throws. */
export async function cleanNamesFor(rows: ValidationRow[], cols: Columns, deadline?: number, llmKeys?: Set<string>): Promise<Map<string, string>> {
  if (!cols.company) return new Map()
  const inputs = rows.map(r => ({ raw: String(r.row_data?.[cols.company!] ?? ''), email: r.email ?? '' }))
  return await cleanCompanyNames(inputs, {
    anthropicKey: ANTHROPIC_API_KEY,
    ...(ANTHROPIC_API_KEY ? restCache(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : {}),
    deadline,
    llmKeys,
  })
}

// Scraped placeholders that would render as a broken first line if they
// reached a live email — "🚧 Old Site-Under Construction" was a real one.
const JUNK_PATTERNS = [
  /under construction/i,
  /old site/i,
  /coming soon/i,
  /^(n\/?a|none|null|unknown|test|untitled|no name)$/i,
  /^https?:\/\//i,
  /^www\./i,
  /^[\d\s\-_.]+$/,
]

function looksLikeJunkCompany(raw: string): boolean {
  const s = raw.trim()
  if (s.length < 2) return true
  if (JUNK_PATTERNS.some(p => p.test(s))) return true
  // Emoji / pictographs never belong in a company name.
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(s)) return true
  return false
}

// ---- Row evaluation ----

const NON_CITY_VALUES = new Set(['', 'unknown', 'error', 'parse_error', 'n/a', 'none', 'null'])

function isRealCity(value: string): boolean {
  return !NON_CITY_VALUES.has(value.trim().toLowerCase())
}

interface ValidationRow {
  id: string
  row_index: number
  email: string
  row_data: Record<string, unknown> | null
}

interface ValidationJob {
  id: string
  filename: string
  icp_filter: boolean
  column_order: string[] | null
  instantly_campaign_id: string | null
  instantly_campaign_name: string | null
  instantly_campaign_id_nolocation: string | null
  instantly_campaign_name_nolocation: string | null
  instantly_pushed_nolocation: number
  instantly_pushed: number
  instantly_filtered: number
  instantly_errors: number
  location_barrier: boolean
  company_barrier: boolean
  company_strict: boolean
  // Lead bank routing (20261109100136_instantly_lead_bank_routing.sql). Optional so
  // rows/fixtures from before the columns existed read as "not decided yet".
  instantly_banked?: number | null
  instantly_route?: 'direct' | 'bank' | null
}

interface Lead {
  email: string
  first_name: string
  last_name: string
  company_name: string
  website: string
  location: string
  operatingCities: string
  // Apollo's Country / Company Country as ISO2 and State / Company State as
  // the canonical name, set only when the country is certain; '' otherwise.
  country: string
  region: string
  // {{compliance_law}}: the short_name ("RTA") or compliance_name ("Residential
  // Tenancies Act, 2006") of the matching active jurisdiction, else the generic
  // fallback "local landlord-tenant law". Never blank (Instantly can't fall back).
  complianceLaw: string
}

// Active, named jurisdictions rows, loaded once per push (_shared/research/jurisdiction.ts).
export interface JurisdictionContext {
  rows: JurisdictionRow[]
}

/** Country from Country, else Company Country; region from State, else Company State, within that country. */
function leadGeo(data: Record<string, unknown>): { country: string; region: string } {
  const str = (k: string) => String(data[k] ?? '').trim()
  const country = normalizeCountry(str('Country')) ?? normalizeCountry(str('Company Country'))
  if (!country) return { country: '', region: '' }
  const region = normalizeRegion(country, str('State')) ?? normalizeRegion(country, str('Company State'))
  return { country, region: region ?? '' }
}

type Decision =
  | { keep: true; lead: Lead; originalCompany: string }
  | { keep: false; reason: string }

export function decideRow(
  row: ValidationRow,
  cols: Columns,
  job: ValidationJob,
  ctx: JurisdictionContext = { rows: [] },
  names?: Map<string, string>,
): Decision {
  const data = row.row_data ?? {}
  const get = (col: string | null): string => (col ? String(data[col] ?? '').trim() : '')

  const email = (row.email ?? '').trim()
  if (!email) return { keep: false, reason: 'no email' }

  // The ICP membrane applies at every export exit, same as the CSV build.
  if (job.icp_filter && String(data.icp_status ?? '') !== 'confirmed') {
    return { keep: false, reason: 'not confirmed ICP' }
  }

  const rawCity = String(data.operating_city ?? '').trim()
  const confidence = String(data.city_confidence ?? '').trim().toLowerCase()
  const cityIsReal = isRealCity(rawCity)

  if (job.location_barrier) {
    // Strict: a real city AND high confidence. This is the corrected filter
    // from the manual run — confidence alone let UNKNOWN cities through.
    if (!cityIsReal) return { keep: false, reason: 'no resolved city' }
    if (confidence !== 'high') return { keep: false, reason: `city confidence ${confidence || 'missing'}` }
  }

  // Lax mode still refuses to send the literal placeholder into a live email.
  const location = cityIsReal ? rawCity : ''
  const secondary = String(data.secondary_cities ?? '').trim()
  const operatingCities = cityIsReal
    ? [rawCity, secondary].filter(Boolean).join('; ')
    : ''

  const rawCompany = get(cols.company)
  if (job.company_barrier && rawCompany && looksLikeJunkCompany(rawCompany)) {
    return { keep: false, reason: 'junk company name' }
  }

  const geo = leadGeo(data)
  const law = complianceLaw(resolveJurisdiction(geo.country, geo.region, ctx.rows))

  return {
    keep: true,
    originalCompany: rawCompany,
    lead: {
      email,
      first_name: get(cols.first),
      last_name: get(cols.last),
      company_name: normalizeCompany(rawCompany, job.company_strict, names?.get(cacheKey(rawCompany, emailDomain(email)))),
      website: get(cols.website),
      location,
      operatingCities,
      country: geo.country,
      region: geo.region,
      complianceLaw: law,
    },
  }
}

/**
 * The active jurisdictions that have a compliance_name (activation = active +
 * a name; copy_hook is no longer read), one REST select per push. A failed
 * read is logged and treated as no rows: every lead then gets the fallback
 * law, which is what an unreviewed table means anyway.
 */
export async function loadActiveJurisdictions(): Promise<JurisdictionRow[]> {
  try {
    const rows = (await supabaseRequest(
      'GET',
      'jurisdictions?active=eq.true&compliance_name=not.is.null&select=country,region,city_match,jurisdiction,compliance_name,short_name,active',
    )) as JurisdictionRow[] | null
    return Array.isArray(rows) ? rows : []
  } catch (err) {
    console.error('[instantly-push] jurisdictions read failed, using the fallback compliance_law:', err instanceof Error ? err.message : err)
    return []
  }
}

async function loadJob(jobId: string): Promise<ValidationJob> {
  const jobs = (await supabaseRequest(
    'GET',
    `validation_jobs?id=eq.${jobId}&select=id,filename,icp_filter,column_order,instantly_campaign_id,instantly_campaign_name,instantly_campaign_id_nolocation,instantly_campaign_name_nolocation,instantly_pushed_nolocation,instantly_pushed,instantly_filtered,instantly_errors,location_barrier,company_barrier,company_strict,instantly_banked,instantly_route`,
  )) as ValidationJob[]
  if (!jobs || jobs.length === 0) throw new Error(`Job ${jobId} not found`)
  return jobs[0]
}

async function resolveColumns(job: ValidationJob): Promise<Columns> {
  let headers = job.column_order && job.column_order.length > 0 ? job.column_order : null
  if (!headers) {
    const sample = (await supabaseRequest(
      'GET',
      `validation_rows?job_id=eq.${job.id}&limit=1&select=row_data`,
    )) as ValidationRow[]
    headers = sample?.[0]?.row_data ? Object.keys(sample[0].row_data) : []
  }
  return detectColumns(headers)
}

// ---- Preview (drives the company-name review screen) ----

interface PreviewResult {
  eligible: number
  filtered: number
  junk: number
  missingFirstName: number
  blankLocation: number
  samples: { original: string; normalized: string }[]
  strict: boolean
  // How many would route to the separate no-location campaign, if one is set.
  noLocationRouted: number
  hasNoLocationCampaign: boolean
  // Edge functions have their own secret store, separate from the Next.js
  // app's Vercel env. Surfacing this in the preview means a missing key shows
  // up on the review screen instead of failing mid-push.
  instantlyKeyPresent: boolean
  // Lead bank routing: more than bank_threshold eligible leads go to lead_bank
  // (queued) and instantly-rotate drips them in as slots free; otherwise direct.
  route: PushRoute
  banked_estimate: number
  bank_threshold: number
}

// ---- Lead bank routing ----

export type PushRoute = 'direct' | 'bank'

const BANK_THRESHOLD_DEFAULT = 1000

/** More than `threshold` eligible leads go to the lead bank; at or below, straight into Instantly. */
export function pushRoute(eligible: number, threshold: number): PushRoute {
  return eligible > threshold ? 'bank' : 'direct'
}

/**
 * lume_settings.bank_threshold (Lume Settings → Budget), else the
 * BANK_THRESHOLD env, else 1000. A failed read falls back, never blocks.
 */
export async function loadBankThreshold(): Promise<number> {
  try {
    const rows = (await supabaseRequest('GET', 'lume_settings?key=eq.bank_threshold&select=value')) as { value: unknown }[] | null
    const n = Number(Array.isArray(rows) ? rows[0]?.value : undefined)
    if (Number.isInteger(n) && n >= 1) return n
  } catch (err) {
    console.error('[instantly-push] bank_threshold read failed, using the fallback:', err instanceof Error ? err.message : err)
  }
  const env = Number(Deno.env.get('BANK_THRESHOLD') ?? '')
  return Number.isInteger(env) && env >= 1 ? env : BANK_THRESHOLD_DEFAULT
}

// PostgREST caps an unbounded GET at 1000 rows, which would silently
// undercount the preview on any list bigger than that ("1000 ready to push"
// when 1939 are). Page explicitly so the counts shown for approval are the
// real ones.
const PREVIEW_PAGE_SIZE = 1000

async function fetchAllPushableRows(jobId: string): Promise<ValidationRow[]> {
  const all: ValidationRow[] = []
  for (let offset = 0; ; offset += PREVIEW_PAGE_SIZE) {
    const page = (await supabaseRequest(
      'GET',
      `validation_rows?job_id=eq.${jobId}&status=eq.valid&instantly_status=eq.skipped` +
      `&order=row_index.asc&select=id,row_index,email,row_data` +
      `&limit=${PREVIEW_PAGE_SIZE}&offset=${offset}`,
    )) as ValidationRow[]
    if (!page || page.length === 0) break
    all.push(...page)
    if (page.length < PREVIEW_PAGE_SIZE) break
  }
  return all
}

async function buildPreview(jobId: string): Promise<PreviewResult> {
  const job = await loadJob(jobId)
  const cols = await resolveColumns(job)

  const [rows, threshold] = await Promise.all([fetchAllPushableRows(jobId), loadBankThreshold()])

  const result: PreviewResult = {
    eligible: 0, filtered: 0, junk: 0, missingFirstName: 0, blankLocation: 0,
    samples: [], strict: job.company_strict,
    noLocationRouted: 0,
    hasNoLocationCampaign: Boolean(job.instantly_campaign_id_nolocation),
    instantlyKeyPresent: INSTANTLY_API_KEY.length > 0,
    route: 'direct', banked_estimate: 0, bank_threshold: threshold,
  }

  const sampleRows: ValidationRow[] = []
  for (const row of rows ?? []) {
    const decision = decideRow(row, cols, job)
    if (!decision.keep) {
      result.filtered++
      if (decision.reason === 'junk company name') result.junk++
      continue
    }
    result.eligible++
    if (!decision.lead.first_name) result.missingFirstName++
    if (!decision.lead.location) {
      result.blankLocation++
      if (job.instantly_campaign_id_nolocation) result.noLocationRouted++
    }
    if (sampleRows.length < SAMPLE_SIZE) sampleRows.push(row)
  }
  // Only the shown names go through Haiku here; the push cleans every chunk
  // the same way (same cache), so what is approved is what is sent.
  const names = await cleanNamesFor(sampleRows, cols, Date.now() + 25_000)
  for (const row of sampleRows) {
    const decision = decideRow(row, cols, job, undefined, names)
    if (!decision.keep) continue
    result.samples.push({
      original: decision.originalCompany || '(blank)',
      normalized: decision.lead.company_name || '(blank)',
    })
  }
  // A push already under way keeps the route it started with.
  result.route = job.instantly_route ?? pushRoute(result.eligible, threshold)
  // An estimate: leads already in the bank for that campaign, or already
  // pushed to Instantly, are skipped at push time.
  result.banked_estimate = result.route === 'bank' ? result.eligible : 0
  return result
}

// ---- Instantly ----

export async function createLead(campaignId: string, lead: Lead): Promise<Record<string, unknown>> {
  const custom: Record<string, string> = {}
  // Only set variables we actually resolved — an empty custom variable is
  // better left absent than written as an empty string.
  if (lead.location) custom['location'] = lead.location
  if (lead.operatingCities) custom['Operating Cities Copied'] = lead.operatingCities
  // Always set: the compliance law's name or the generic fallback, so a
  // {{compliance_law}} in the sequence never renders blank.
  custom['compliance_law'] = lead.complianceLaw.trim() || FALLBACK_COMPLIANCE_LAW

  const body: Record<string, unknown> = {
    campaign: campaignId,
    email: lead.email,
    // Instantly mirrors these into the lead payload as {{firstName}},
    // {{lastName}}, {{companyName}}, {{website}}.
    first_name: lead.first_name,
    last_name: lead.last_name,
    company_name: lead.company_name,
    // Never skip_if_in_campaign: leads already in the workspace get silently
    // dropped and never attach to the campaign (see playbooks/instantly-mcp.md).
    skip_if_in_campaign: false,
  }
  if (lead.website) body.website = lead.website
  if (Object.keys(custom).length > 0) body.custom_variables = custom

  const res = await fetch(`${INSTANTLY_BASE_URL}/leads`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${INSTANTLY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Instantly POST /leads failed (${res.status}): ${text.slice(0, 300)}`)
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return {}
  }
}

// The smoke test from the manual run, automated: after the first lead lands,
// read it back and confirm the custom variables actually rendered into the
// payload before committing the other few hundred.
//
// problem: location / Operating Cities Copied missing -> the push halts (as
// before). warning: compliance_law missing -> logged and recorded, never a
// halt. An unreadable echo is unverifiable, not proven broken: neither.
export interface FirstLeadCheck {
  problem: string | null
  warning: string | null
}

const JURISDICTION_ECHO_WARNING = 'compliance_law missing on the first lead (Instantly did not echo it); push continued'

export async function verifyFirstLead(campaignId: string, lead: Lead): Promise<FirstLeadCheck> {
  const ok: FirstLeadCheck = { problem: null, warning: null }
  const expected = [
    lead.location ? 'location' : null,
    lead.operatingCities ? 'Operating Cities Copied' : null,
  ].filter(Boolean) as string[]

  try {
    const res = await fetch(`${INSTANTLY_BASE_URL}/leads/list`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${INSTANTLY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ limit: 2, campaign: campaignId, search: lead.email }),
    })
    if (!res.ok) return ok // Unverifiable, not proven broken — don't block.
    const data = await res.json() as { items?: { email?: string; payload?: Record<string, unknown> }[] }
    const match = (data.items ?? []).find(i => (i.email ?? '').toLowerCase() === lead.email.toLowerCase())
    if (!match || !match.payload) return ok
    const missing = expected.filter(k => !(k in match.payload!))
    if (missing.length > 0) return { problem: `custom variables missing on the first lead: ${missing.join(', ')}`, warning: null }
    if (!('compliance_law' in match.payload)) return { problem: null, warning: JURISDICTION_ECHO_WARNING }
    return ok
  } catch {
    return ok
  }
}

// ---- Push ----

export async function processJob(jobId: string): Promise<void> {
  const startTime = Date.now()
  const CHUNK_LIMIT_MS = 110_000

  const job = await loadJob(jobId)
  const campaignId = job.instantly_campaign_id
  if (!campaignId) throw new Error('No Instantly campaign selected for this job')
  if (!INSTANTLY_API_KEY) throw new Error('INSTANTLY_API_KEY is not set')

  await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, { instantly_status: 'pushing' })

  const cols = await resolveColumns(job)

  // Route, decided once on the first invocation and kept across self
  // re-invokes (the remaining count shrinks as rows are written). A push that
  // was already under way before routing existed stays direct.
  let route = job.instantly_route ?? null
  if (!route) {
    const started = job.instantly_pushed > 0 || job.instantly_pushed_nolocation > 0 || job.instantly_errors > 0
    const threshold = await loadBankThreshold()
    let eligible = 0
    if (!started) for (const row of await fetchAllPushableRows(jobId)) if (decideRow(row, cols, job).keep) eligible++
    route = started ? 'direct' : pushRoute(eligible, threshold)
    await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, { instantly_route: route, instantly_bank_threshold: threshold })
  }
  if (route === 'bank') return processBankJob(job, cols, startTime)

  const jurisdictionCtx: JurisdictionContext = { rows: await loadActiveJurisdictions() }
  // A lead with no resolved city must never land in a campaign whose subject
  // line interpolates {{location}}. Instantly rotates A/B variants by its own
  // algorithm, so there is no per-lead variant targeting — a separate campaign
  // is the only guarantee. Without one configured, everything goes to the main
  // campaign exactly as before.
  const noLocationCampaignId = job.instantly_campaign_id_nolocation
  let pushedNoLocation = job.instantly_pushed_nolocation
  let pushed = job.instantly_pushed
  let filtered = job.instantly_filtered
  let errors = job.instantly_errors
  let verified = pushed > 0 // A resumed run already cleared the smoke test.
  // A non-fatal first-lead note: on that row's instantly_result and in the
  // completion report (validation_jobs has no notes column).
  let firstLeadWarning: string | null = null

  while (true) {
    const rows = (await supabaseRequest(
      'GET',
      `validation_rows?job_id=eq.${jobId}&status=eq.valid&instantly_status=eq.skipped&order=row_index.asc&limit=100&select=id,row_index,email,row_data`,
    )) as ValidationRow[]
    if (!rows || rows.length === 0) break
    const names = await cleanNamesFor(rows, cols, startTime + CHUNK_LIMIT_MS)

    for (const row of rows) {
      const decision = decideRow(row, cols, job, jurisdictionCtx, names)

      if (!decision.keep) {
        await supabaseRequest('PATCH', `validation_rows?id=eq.${row.id}`, {
          instantly_status: 'filtered',
          instantly_result: { reason: decision.reason },
        })
        filtered++
        continue
      }

      const targetCampaign = (!decision.lead.location && noLocationCampaignId)
        ? noLocationCampaignId
        : campaignId
      // compliance_law does not depend on the campaign (one generic fallback).
      const lead: Lead = decision.lead
      let rowWarning: string | null = null

      try {
        const created = await createLead(targetCampaign, lead)

        if (!verified) {
          const check = await verifyFirstLead(targetCampaign, lead)
          const problem = check.problem
          if (check.warning) {
            console.warn(`[instantly-push] job ${jobId}: ${check.warning}`)
            rowWarning = firstLeadWarning = check.warning
          }
          if (problem) {
            await supabaseRequest('PATCH', `validation_rows?id=eq.${row.id}`, {
              instantly_status: 'pushed',
              instantly_result: created,
            })
            await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, {
              instantly_status: 'error',
              instantly_pushed: pushed + 1,
              instantly_filtered: filtered,
              instantly_errors: errors,
            })
            await notify(
              `⚠️ Stopped the Instantly push after 1 lead — ${problem}.\n` +
              `Campaign: ${job.instantly_campaign_name}\nNothing else was sent.`,
              { severity: 'warn', link: lumeLink('/campaigns'), scope: 'campaign', campaign_id: targetCampaign },
            )
            return
          }
          verified = true
        }

        await supabaseRequest('PATCH', `validation_rows?id=eq.${row.id}`, {
          instantly_status: 'pushed',
          instantly_result: { ...created, routed_to: targetCampaign, ...(rowWarning ? { warning: rowWarning } : {}) },
        })
        if (targetCampaign === noLocationCampaignId) pushedNoLocation++
        else pushed++
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        await supabaseRequest('PATCH', `validation_rows?id=eq.${row.id}`, {
          instantly_status: 'error',
          instantly_result: { error: message },
        })
        errors++
      }

      await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, {
        instantly_pushed: pushed,
        instantly_pushed_nolocation: pushedNoLocation,
        instantly_filtered: filtered,
        instantly_errors: errors,
      })

      // Gentle pacing so a few hundred creates don't trip Instantly's limits.
      await new Promise(resolve => setTimeout(resolve, 250))

      if (Date.now() - startTime > CHUNK_LIMIT_MS) {
        await fetch(`${SUPABASE_URL}/functions/v1/instantly-push`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ job_id: jobId }),
        }).catch(err => console.error('[instantly-push] Self re-invoke error:', err))
        await new Promise(r => setTimeout(r, 3000))
        return
      }
    }
  }

  await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, { instantly_status: 'done' })

  await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, {
    eta_seconds: 0,
    eta_updated_at: new Date().toISOString(),
  })

  // The launch button is the end of the road: everything is in the campaign,
  // so the only thing left is to start sending. telegram-inbox handles the tap
  // and refuses to activate a campaign with no sequence written.
  await notify(
    [
      `📤 Instantly push complete — ${job.filename}`,
      `Campaign: ${job.instantly_campaign_name}`,
      ``,
      `Pushed: ${pushed}`,
      ...(noLocationCampaignId
        ? [`Pushed (no location): ${pushedNoLocation} \u2192 ${job.instantly_campaign_name_nolocation}`]
        : []),
      `Filtered out: ${filtered}`,
      `Errors: ${errors}`,
      ``,
      `Barriers — location: ${job.location_barrier ? 'ON' : 'OFF'}, company: ${job.company_barrier ? 'ON' : 'OFF'}${job.company_strict ? ' (strict names)' : ''}`,
      ...(firstLeadWarning ? [`Note: ${firstLeadWarning}`] : []),
      ``,
      `Ready to launch when your sequence is written.`,
    ].join('\n'),
    pushed > 0
      // The Launch button asks a decision; without it this is a report.
      ? { severity: 'urgent', link: lumeLink('/campaigns'), scope: 'campaign', campaign_id: campaignId, dedupe_key: gateKey(jobId, 'camp_launch') }
      : { severity: 'info', link: lumeLink('/campaigns'), scope: 'campaign', campaign_id: campaignId },
    pushed > 0
      ? { inline_keyboard: [[{ text: '🚀 Launch campaign', callback_data: `camp_launch:${jobId}` }]] }
      : undefined,
  )
}

// ---- Bank route ----
//
// Above bank_threshold eligible leads, nothing is created in Instantly here:
// every eligible lead is queued in lead_bank for its target campaign (main, or
// the no-location sibling for city-less leads when one is set) and
// instantly-rotate pushes them twice a day as the shared 1,000-contact
// workspace cap frees slots, oldest queued first. The owner's push tap is the
// authorisation for both the banking and that rotation. Same decideRow, same
// barriers; compliance_law is left null so the rotation resolves it at push
// time (rotateLeadBody), exactly like Lume's own lead-bank assigns.

const BANK_CHUNK = 500
const ID_CHUNK = 150

export interface BankRow {
  campaign_id: string
  email: string
  first_name: string | null
  last_name: string | null
  company_name: string | null
  website: string | null
  location: string | null
  operating_cities: string | null
  country: string | null
  region: string | null
  state: 'queued'
  source_job_id: string
}

/** The lead_bank row instantly-rotate later turns into a POST /leads body (lead.ts rotateLeadBody). */
export function bankRow(lead: Lead, campaignId: string, jobId: string): BankRow {
  const v = (s: string) => (s.trim() ? s.trim() : null)
  return {
    campaign_id: campaignId,
    // instantly-rotate matches bank rows by lowercased email.
    email: lead.email.trim().toLowerCase(),
    first_name: v(lead.first_name),
    last_name: v(lead.last_name),
    company_name: v(lead.company_name),
    website: v(lead.website),
    location: v(lead.location),
    operating_cities: v(lead.operatingCities),
    country: v(lead.country),
    region: v(lead.region),
    state: 'queued',
    source_job_id: jobId,
  }
}

const chunks = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}
const inList = (xs: string[]) => `(${xs.map(x => `"${encodeURIComponent(x.replace(/"/g, ''))}"`).join(',')})`

/** Emails (lowercased) a previous push already created in Instantly. A failed read means none: the rotation's skip_if_in_workspace still guards. */
async function alreadyPushed(emails: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (const part of chunks(emails, 500)) {
    try {
      const rows = (await supabaseRequest('POST', 'rpc/instantly_pushed_emails', { p_emails: part })) as unknown[] | null
      for (const r of rows ?? []) {
        const e = typeof r === 'string' ? r : Object.values((r ?? {}) as Record<string, unknown>)[0]
        if (typeof e === 'string') out.add(e.toLowerCase())
      }
    } catch (err) {
      console.error('[instantly-push] pushed-email lookup failed:', err instanceof Error ? err.message : err)
    }
  }
  return out
}

/** Insert queued rows, `on conflict (campaign_id, email) do nothing`; returns the `campaign|email` keys inserted. */
async function insertBankRows(rows: BankRow[]): Promise<Set<string>> {
  const inserted = new Set<string>()
  for (const part of chunks(rows, BANK_CHUNK)) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/lead_bank?on_conflict=campaign_id,email&select=campaign_id,email`, {
      method: 'POST',
      headers: { ...REST_HEADERS, 'Prefer': 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify(part),
    })
    if (!res.ok) throw new Error(`Supabase POST lead_bank failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
    for (const r of (await res.json()) as { campaign_id: string; email: string }[]) inserted.add(`${r.campaign_id}|${r.email}`)
  }
  return inserted
}

/** Of `keys` (campaign|email) that conflicted, the ones this job banked on an earlier, interrupted invocation. */
async function bankedByJob(jobId: string, keys: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  const emails = [...new Set(keys.map(k => k.slice(k.indexOf('|') + 1)))]
  for (const part of chunks(emails, ID_CHUNK)) {
    const rows = (await supabaseRequest('GET', `lead_bank?source_job_id=eq.${jobId}&email=in.${inList(part)}&select=campaign_id,email`)) as { campaign_id: string; email: string }[] | null
    for (const r of rows ?? []) out.add(`${r.campaign_id}|${r.email}`)
  }
  return out
}

async function patchRows(ids: string[], patch: Record<string, unknown>): Promise<void> {
  for (const part of chunks(ids, ID_CHUNK)) {
    await supabaseRequest('PATCH', `validation_rows?id=in.(${part.join(',')})`, patch)
  }
}

function reinvoke(jobId: string): Promise<void> {
  return fetch(`${SUPABASE_URL}/functions/v1/instantly-push`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ job_id: jobId }),
  }).then(() => undefined).catch(err => console.error('[instantly-push] Self re-invoke error:', err))
}

export async function processBankJob(job: ValidationJob, cols: Columns, startTime: number): Promise<void> {
  const CHUNK_LIMIT_MS = 110_000
  const jobId = job.id
  const campaignId = job.instantly_campaign_id!
  const noLocationCampaignId = job.instantly_campaign_id_nolocation
  let banked = job.instantly_banked ?? 0
  let filtered = job.instantly_filtered

  while (true) {
    const rows = (await supabaseRequest(
      'GET',
      `validation_rows?job_id=eq.${jobId}&status=eq.valid&instantly_status=eq.skipped&order=row_index.asc&limit=${BANK_CHUNK}&select=id,row_index,email,row_data`,
    )) as ValidationRow[]
    if (!rows || rows.length === 0) break

    const drops = new Map<string, string[]>() // reason -> row ids
    const drop = (reason: string, id: string) => drops.set(reason, [...(drops.get(reason) ?? []), id])
    const kept: { id: string; key: string; row: BankRow }[] = []
    const seen = new Set<string>()
    const names = await cleanNamesFor(rows, cols, startTime + CHUNK_LIMIT_MS)
    for (const row of rows) {
      const decision = decideRow(row, cols, job, undefined, names)
      if (!decision.keep) { drop(decision.reason, row.id); continue }
      const target = (!decision.lead.location && noLocationCampaignId) ? noLocationCampaignId : campaignId
      const b = bankRow(decision.lead, target, jobId)
      const key = `${b.campaign_id}|${b.email}`
      if (seen.has(key)) { drop('duplicate email in this push', row.id); continue }
      seen.add(key)
      kept.push({ id: row.id, key, row: b })
    }

    const pushedBefore = await alreadyPushed(kept.map(k => k.row.email))
    const toBank = kept.filter(k => {
      if (!pushedBefore.has(k.row.email)) return true
      drop('already pushed to Instantly', k.id)
      return false
    })
    const inserted = await insertBankRows(toBank.map(k => k.row))
    const conflicts = toBank.filter(k => !inserted.has(k.key)).map(k => k.key)
    const mine = conflicts.length ? await bankedByJob(jobId, conflicts) : new Set<string>()

    const bankedIds = new Map<string, string[]>() // campaign -> row ids
    for (const k of toBank) {
      if (inserted.has(k.key) || mine.has(k.key)) {
        bankedIds.set(k.row.campaign_id, [...(bankedIds.get(k.row.campaign_id) ?? []), k.id])
      } else drop('already in lead bank', k.id)
    }

    for (const [campaign, ids] of bankedIds) {
      await patchRows(ids, { instantly_status: 'banked', instantly_result: { banked_to: campaign, routed_to: campaign, route: 'bank' } })
      banked += ids.length
    }
    for (const [reason, ids] of drops) {
      await patchRows(ids, { instantly_status: 'filtered', instantly_result: { reason } })
      filtered += ids.length
    }
    await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, { instantly_banked: banked, instantly_filtered: filtered })

    if (Date.now() - startTime > CHUNK_LIMIT_MS) {
      await reinvoke(jobId)
      await new Promise(r => setTimeout(r, 3000))
      return
    }
  }

  await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, { instantly_status: 'done' })
  await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, { eta_seconds: 0, eta_updated_at: new Date().toISOString() })

  await notify(
    [
      `📥 Sent to the lead bank — ${job.filename}`,
      `Campaign: ${job.instantly_campaign_name}`,
      ``,
      `Banked: ${banked} leads → lead bank (over the lead bank threshold, so nothing was created in Instantly yet)`,
      ...(noLocationCampaignId ? [`City-less leads are queued for ${job.instantly_campaign_name_nolocation}`] : []),
      `Filtered out: ${filtered}`,
      ``,
      `The twice-daily rotation pushes them into the campaign as slots free under the workspace contact cap, oldest first.`,
      `Barriers — location: ${job.location_barrier ? 'ON' : 'OFF'}, company: ${job.company_barrier ? 'ON' : 'OFF'}${job.company_strict ? ' (strict names)' : ''}`,
      ``,
      `Ready to launch when your sequence is written.`,
    ].join('\n'),
    banked > 0
      ? { severity: 'urgent', link: lumeLink('/campaigns'), scope: 'campaign', campaign_id: campaignId, dedupe_key: gateKey(jobId, 'camp_launch') }
      : { severity: 'info', link: lumeLink('/campaigns'), scope: 'campaign', campaign_id: campaignId },
    banked > 0
      ? { inline_keyboard: [[{ text: '🚀 Launch campaign', callback_data: `camp_launch:${jobId}` }]] }
      : undefined,
  )
}

// ---- Re-clean a banked job's company names ----
//
// mode:'reclean_bank' re-runs the company-name SOP over a job's valid rows and
// rewrites company_name on that job's lead_bank rows that are still queued
// (never on a lead already created in Instantly). Haiku answers are cached,
// so a run cut short by the chunk limit re-invokes itself and picks up where
// it stopped; after RECLEAN_MAX_PASSES the rules stand in for the rest.
// dry_run fills the cache and logs the count without renaming anything.

const RECLEAN_MAX_PASSES = 6

async function fetchAllValidRows(jobId: string): Promise<ValidationRow[]> {
  const all: ValidationRow[] = []
  for (let offset = 0; ; offset += PREVIEW_PAGE_SIZE) {
    const page = (await supabaseRequest(
      'GET',
      `validation_rows?job_id=eq.${jobId}&status=eq.valid&order=row_index.asc&select=id,row_index,email,row_data` +
      `&limit=${PREVIEW_PAGE_SIZE}&offset=${offset}`,
    )) as ValidationRow[]
    if (!page || page.length === 0) break
    all.push(...page)
    if (page.length < PREVIEW_PAGE_SIZE) break
  }
  return all
}

export async function recleanBank(jobId: string, pass: number, dryRun = false): Promise<void> {
  const startTime = Date.now()
  const job = await loadJob(jobId)
  const cols = await resolveColumns(job)
  const rows = await fetchAllValidRows(jobId)

  const llmKeys = new Set<string>()
  const names = await cleanNamesFor(rows, cols, startTime + 110_000, llmKeys)
  const wanted = new Set(rows.map(r => cacheKey(String(r.row_data?.[cols.company ?? ''] ?? ''), emailDomain(r.email ?? ''))).filter(k => !k.startsWith('\u0000')))
  const missing = [...wanted].filter(k => !llmKeys.has(k)).length
  if (missing > 0 && pass < RECLEAN_MAX_PASSES && ANTHROPIC_API_KEY) {
    console.log(`[instantly-push] reclean ${jobId}: pass ${pass}, ${missing} names still to clean, re-invoking`)
    await fetch(`${SUPABASE_URL}/functions/v1/instantly-push`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, mode: 'reclean_bank', pass: pass + 1, dry_run: dryRun }),
    }).catch(err => console.error('[instantly-push] reclean re-invoke error:', err))
    await new Promise(r => setTimeout(r, 3000))
    return
  }

  const byEmail = new Map<string, string>()
  for (const row of rows) {
    const d = decideRow(row, cols, job, undefined, names)
    if (d.keep) byEmail.set(d.lead.email.trim().toLowerCase(), d.lead.company_name)
  }
  const bank: { id: number; email: string; company_name: string | null }[] = []
  for (let offset = 0; ; offset += PREVIEW_PAGE_SIZE) {
    const page = (await supabaseRequest(
      'GET',
      `lead_bank?source_job_id=eq.${jobId}&state=eq.queued&pushed_at=is.null&order=id.asc&select=id,email,company_name&limit=${PREVIEW_PAGE_SIZE}&offset=${offset}`,
    )) as typeof bank
    if (!page || page.length === 0) break
    bank.push(...page)
    if (page.length < PREVIEW_PAGE_SIZE) break
  }
  const updates = bank
    .filter(b => byEmail.has(b.email) && (byEmail.get(b.email) || null) !== b.company_name)
    .map(b => ({ id: b.id, company_name: byEmail.get(b.email) ?? '' }))
  if (dryRun) {
    console.log(`[instantly-push] reclean ${jobId} (dry run): ${bank.length} queued, ${updates.length} would be renamed, ${missing} by rules only`)
    return
  }
  let changed = 0
  for (const part of chunks(updates, 1000)) {
    changed += Number(await supabaseRequest('POST', 'rpc/lead_bank_set_company_names', { p_rows: part }) ?? 0)
  }
  console.log(`[instantly-push] reclean ${jobId}: ${bank.length} queued, ${changed} renamed, ${missing} by rules only`)
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  let jobId: string
  let mode: string | undefined
  let pass = 1
  let dryRun = false
  try {
    const body = await req.json() as { job_id?: string; mode?: string; pass?: number; dry_run?: boolean }
    if (!body.job_id) {
      return new Response(JSON.stringify({ error: 'job_id is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    jobId = body.job_id
    mode = body.mode
    pass = Number.isInteger(body.pass) ? body.pass! : 1
    dryRun = body.dry_run === true
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Preview is synchronous — telegram-inbox needs the names to render a message.
  if (mode === 'preview') {
    try {
      const preview = await buildPreview(jobId)
      return new Response(JSON.stringify({ ok: true, ...preview }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return new Response(JSON.stringify({ ok: false, error: message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }

  if (mode === 'reclean_bank') {
    EdgeRuntime.waitUntil(recleanBank(jobId, pass, dryRun).catch(err =>
      console.error(`[instantly-push] reclean ${jobId} failed:`, err instanceof Error ? err.message : err)))
    return new Response(JSON.stringify({ ok: true, job_id: jobId, mode, pass, dry_run: dryRun }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const asyncWork = processJob(jobId).catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[instantly-push] Job ${jobId} failed:`, message)
    try {
      await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, { instantly_status: 'error' })
    } catch (patchErr) {
      console.error('[instantly-push] Failed to patch instantly_status:', patchErr)
    }
    await notify(`⚠️ Instantly push failed for job ${jobId}: ${message}`,
      { severity: 'warn', link: lumeLink('/campaigns'), scope: 'campaign' }).catch(() => {})
  })

  EdgeRuntime.waitUntil(asyncWork)

  return new Response(JSON.stringify({ ok: true, job_id: jobId }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
