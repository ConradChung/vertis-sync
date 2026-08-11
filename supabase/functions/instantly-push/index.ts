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
// Company names are ALWAYS returned in Capitalized Case, both barriers aside.
//
// mode:'preview' answers synchronously with the first 10 normalized names and
// the eligibility counts — telegram-inbox renders that for the review screen.
// Keeping preview here (rather than reimplementing normalization in
// telegram-inbox) is deliberate: the names you approve are produced by the
// exact code that later pushes them.

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const INSTANTLY_API_KEY = Deno.env.get('INSTANTLY_API_KEY') ?? ''
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? ''

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

// Stripped in every mode. Order matters only in that longer variants must be
// tried before their prefixes ('l.l.c.' before 'lc' style collisions).
const LEGAL_SUFFIXES = [
  'incorporated', 'corporation', 'limited', 'company',
  'l.l.c.', 'l.l.c', 'llc', 'l.p.', 'llp', 'lp', 'p.l.l.c.', 'pllc', 'p.c.', 'plc', 'pc',
  'inc.', 'inc', 'corp.', 'corp', 'ltd.', 'ltd', 'co.', 'co',
  'gmbh', 'ag', 'n.v.', 'nv', 'b.v.', 'bv', 's.a.', 'sa', 'pty', 'pte',
]

// Stripped only when the owner asks for stricter personalization from the
// review screen. This is what turns "Wildwood Management Group" into
// "Wildwood" so a first line reads like a person wrote it.
const DESCRIPTIVE_SUFFIXES = [
  'property management group', 'property management', 'properties management',
  'management group', 'management company', 'management', 'property', 'properties',
  'real estate group', 'real estate', 'realty group', 'realty',
  'holdings', 'holding', 'group', 'partners', 'partner', 'associates', 'associate',
  'enterprises', 'enterprise', 'services', 'service', 'solutions', 'solution',
  'ventures', 'venture', 'capital', 'advisors', 'advisory', 'consulting',
  'agency', 'team', 'rentals', 'rental', 'homes', 'residential', 'commercial',
  'investments', 'investment', 'development', 'developers', 'builders',
]

// A trailing conjunction or stray punctuation left behind by suffix stripping
// is exactly the "Hylton & Company" -> "Hylton &" bug from the manual run.
function trimEdges(s: string): string {
  return s
    .replace(/[\s,;:.\-_/\\|]+$/g, '')
    .replace(/\s+(?:&|and|\+|of|the|for)$/i, '')
    .replace(/[\s,;:.\-_/\\|]+$/g, '')
    .replace(/^[\s,;:.\-_/\\|]+/g, '')
    .trim()
}

function stripSuffixes(name: string, suffixes: string[]): string {
  let current = trimEdges(name)
  // Peel repeatedly: "Acme Properties LLC, Inc." needs more than one pass.
  for (let pass = 0; pass < 4; pass++) {
    const lower = current.toLowerCase()
    let matched = false
    for (const suffix of suffixes) {
      // Suffix must sit at the end on a word boundary, not mid-word
      // ("Incorporated" must not be shaved off "Incorporations").
      const idx = lower.lastIndexOf(suffix)
      if (idx <= 0 || idx + suffix.length !== lower.length) continue
      const preceding = current[idx - 1]
      if (!/[\s,\-&.]/.test(preceding)) continue
      const candidate = trimEdges(current.slice(0, idx))
      // Never strip a name down to nothing — "Management Group" as a whole
      // company name has to survive as itself.
      if (candidate.length < 2) continue
      current = candidate
      matched = true
      break
    }
    if (!matched) break
  }
  return current
}

// "Capitalized Case" for every name, in every mode — the owner's rule.
// Acronym-only names ("JLL") come back as "Jll"; the review screen is where
// that gets caught, since the rule is deliberately literal and predictable.
function capitalizedCase(name: string): string {
  return name
    .split(/(\s+|[-/])/)
    .map(part => {
      if (part.length === 0 || /^\s+$/.test(part) || part === '-' || part === '/') return part
      const cased = part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
      // O'Brien / D'Angelo — capitalize after an apostrophe only when the
      // fragment before it is a 1-2 letter prefix, so "Sam's" stays "Sam's".
      return cased.replace(/^([A-Za-z]{1,2})'([a-z])/, (_m, p1, p2) => `${p1}'${p2.toUpperCase()}`)
    })
    .join('')
}

function normalizeCompany(raw: string, strict: boolean): string {
  const base = raw.replace(/\s+/g, ' ').trim()
  if (!base) return ''
  let out = stripSuffixes(base, LEGAL_SUFFIXES)
  if (strict) {
    const stricter = stripSuffixes(out, DESCRIPTIVE_SUFFIXES)
    if (stricter.length >= 2) out = stricter
  }
  out = trimEdges(out)
  if (out.length < 2) out = trimEdges(base)
  return capitalizedCase(out)
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
}

interface Lead {
  email: string
  first_name: string
  last_name: string
  company_name: string
  website: string
  location: string
  operatingCities: string
}

type Decision =
  | { keep: true; lead: Lead; originalCompany: string }
  | { keep: false; reason: string }

function decideRow(row: ValidationRow, cols: Columns, job: ValidationJob): Decision {
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

  return {
    keep: true,
    originalCompany: rawCompany,
    lead: {
      email,
      first_name: get(cols.first),
      last_name: get(cols.last),
      company_name: normalizeCompany(rawCompany, job.company_strict),
      website: get(cols.website),
      location,
      operatingCities,
    },
  }
}

async function loadJob(jobId: string): Promise<ValidationJob> {
  const jobs = (await supabaseRequest(
    'GET',
    `validation_jobs?id=eq.${jobId}&select=id,filename,icp_filter,column_order,instantly_campaign_id,instantly_campaign_name,instantly_campaign_id_nolocation,instantly_campaign_name_nolocation,instantly_pushed_nolocation,instantly_pushed,instantly_filtered,instantly_errors,location_barrier,company_barrier,company_strict`,
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

  const rows = await fetchAllPushableRows(jobId)

  const result: PreviewResult = {
    eligible: 0, filtered: 0, junk: 0, missingFirstName: 0, blankLocation: 0,
    samples: [], strict: job.company_strict,
    noLocationRouted: 0,
    hasNoLocationCampaign: Boolean(job.instantly_campaign_id_nolocation),
    instantlyKeyPresent: INSTANTLY_API_KEY.length > 0,
  }

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
    if (result.samples.length < SAMPLE_SIZE) {
      result.samples.push({
        original: decision.originalCompany || '(blank)',
        normalized: decision.lead.company_name || '(blank)',
      })
    }
  }
  return result
}

// ---- Instantly ----

async function createLead(campaignId: string, lead: Lead): Promise<Record<string, unknown>> {
  const custom: Record<string, string> = {}
  // Only set variables we actually resolved — an empty custom variable is
  // better left absent than written as an empty string.
  if (lead.location) custom['location'] = lead.location
  if (lead.operatingCities) custom['Operating Cities Copied'] = lead.operatingCities

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
async function verifyFirstLead(campaignId: string, lead: Lead): Promise<string | null> {
  const expected = [
    lead.location ? 'location' : null,
    lead.operatingCities ? 'Operating Cities Copied' : null,
  ].filter(Boolean) as string[]
  if (expected.length === 0) return null

  try {
    const res = await fetch(`${INSTANTLY_BASE_URL}/leads/list`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${INSTANTLY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ limit: 2, campaign: campaignId, search: lead.email }),
    })
    if (!res.ok) return null // Unverifiable, not proven broken — don't block.
    const data = await res.json() as { items?: { email?: string; payload?: Record<string, unknown> }[] }
    const match = (data.items ?? []).find(i => (i.email ?? '').toLowerCase() === lead.email.toLowerCase())
    if (!match || !match.payload) return null
    const missing = expected.filter(k => !(k in match.payload!))
    if (missing.length > 0) return `custom variables missing on the first lead: ${missing.join(', ')}`
    return null
  } catch {
    return null
  }
}

// ---- Push ----

async function processJob(jobId: string): Promise<void> {
  const startTime = Date.now()
  const CHUNK_LIMIT_MS = 110_000

  const job = await loadJob(jobId)
  const campaignId = job.instantly_campaign_id
  if (!campaignId) throw new Error('No Instantly campaign selected for this job')
  if (!INSTANTLY_API_KEY) throw new Error('INSTANTLY_API_KEY is not set')

  await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, { instantly_status: 'pushing' })

  const cols = await resolveColumns(job)
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

  while (true) {
    const rows = (await supabaseRequest(
      'GET',
      `validation_rows?job_id=eq.${jobId}&status=eq.valid&instantly_status=eq.skipped&order=row_index.asc&limit=100&select=id,row_index,email,row_data`,
    )) as ValidationRow[]
    if (!rows || rows.length === 0) break

    for (const row of rows) {
      const decision = decideRow(row, cols, job)

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

      try {
        const created = await createLead(targetCampaign, decision.lead)

        if (!verified) {
          const problem = await verifyFirstLead(targetCampaign, decision.lead)
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
            await sendTelegram(
              `⚠️ Stopped the Instantly push after 1 lead — ${problem}.\n` +
              `Campaign: ${job.instantly_campaign_name}\nNothing else was sent.`,
            )
            return
          }
          verified = true
        }

        await supabaseRequest('PATCH', `validation_rows?id=eq.${row.id}`, {
          instantly_status: 'pushed',
          instantly_result: { ...created, routed_to: targetCampaign },
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
        fetch(`${SUPABASE_URL}/functions/v1/instantly-push`, {
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
  await sendTelegram(
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
      ``,
      `Ready to launch when your sequence is written.`,
    ].join('\n'),
    pushed > 0
      ? { inline_keyboard: [[{ text: '🚀 Launch campaign', callback_data: `camp_launch:${jobId}` }]] }
      : undefined,
  )
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  let jobId: string
  let mode: string | undefined
  try {
    const body = await req.json() as { job_id?: string; mode?: string }
    if (!body.job_id) {
      return new Response(JSON.stringify({ error: 'job_id is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    jobId = body.job_id
    mode = body.mode
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

  const asyncWork = processJob(jobId).catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[instantly-push] Job ${jobId} failed:`, message)
    try {
      await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, { instantly_status: 'error' })
    } catch (patchErr) {
      console.error('[instantly-push] Failed to patch instantly_status:', patchErr)
    }
    await sendTelegram(`⚠️ Instantly push failed for job ${jobId}: ${message}`).catch(() => {})
  })

  EdgeRuntime.waitUntil(asyncWork)

  return new Response(JSON.stringify({ ok: true, job_id: jobId }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
