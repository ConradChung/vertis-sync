// Supabase Edge Function: operating-city-enricher
// Receives { job_id }, enriches all pending validation_rows with an
// operating_city (Perplexity research -> Haiku extraction), merges the
// result into row_data + column_order, then chains into email-validator.
// Prompts ported from enrich_operating_city.py — Perplexity prompt and
// HAIKU_SYSTEM parameterized on job.icp_description, otherwise verbatim.

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const PERPLEXITY_API_KEY = Deno.env.get('PERPLEXITY_API_KEY') ?? ''
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? ''

const PPLX_URL = 'https://api.perplexity.ai/chat/completions'
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const PPLX_MODEL = 'sonar'
const HAIKU_MODEL = 'claude-haiku-4-5'
const DEFAULT_ICP_DESCRIPTION = 'a property management company that actively manages properties'
const ENRICHMENT_COLUMNS = ['operating_city', 'secondary_cities', 'city_confidence', 'city_research', 'icp_status']

const REST_HEADERS: Record<string, string> = {
  'apikey': SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=minimal',
}

async function supabaseRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = `${SUPABASE_URL}/rest/v1/${path}`
  const res = await fetch(url, {
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

async function sendTelegram(message: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    })
  } catch {
    // Non-critical — ignore Telegram errors
  }
}

function normalizeHeader(h: string): string {
  return h.toLowerCase().trim().replace(/\s+/g, '_')
}

const COMPANY_TIER1 = new Set(['company_name', 'company', 'business_name', 'organization'])
function detectCompanyColumn(headers: string[]): string | null {
  const normalized = headers.map(normalizeHeader)
  for (let i = 0; i < headers.length; i++) if (COMPANY_TIER1.has(normalized[i])) return headers[i]
  for (let i = 0; i < headers.length; i++) if (normalized[i].includes('company') || normalized[i].includes('business_name')) return headers[i]
  const nameIdx = normalized.indexOf('name')
  return nameIdx >= 0 ? headers[nameIdx] : null
}

const WEBSITE_TIER1 = new Set(['website', 'domain', 'url', 'web'])
function detectWebsiteColumn(headers: string[]): string | null {
  const normalized = headers.map(normalizeHeader)
  for (let i = 0; i < headers.length; i++) if (WEBSITE_TIER1.has(normalized[i])) return headers[i]
  for (let i = 0; i < headers.length; i++) if (normalized[i].includes('website') || normalized[i].includes('domain')) return headers[i]
  return null
}

interface ValidationRow {
  id: string
  row_index: number
  row_data: Record<string, unknown> | null
}

interface ValidationJob {
  id: string
  filename: string
  total_rows: number
  enriched_rows: number
  column_order: string[] | null
  icp_description: string | null
  icp_filter: boolean
}

async function perplexityResearch(company: string, website: string | null, icpDescription: string): Promise<string> {
  const ctxBits = [`Company name: ${company}`]
  if (website) ctxBits.push(`Website: ${website}`)
  const context = ctxBits.join('\n')

  const prompt =
    `${context}\n\n` +
    `This is meant to be ${icpDescription}. In which specific city is its PRIMARY ` +
    `operating market — i.e. where does it actually operate, not just where ` +
    `it is incorporated? Name the actual city it operates in, not a larger metro area or ` +
    `county it happens to sit near — do not generalize a suburb or smaller city up to a ` +
    `bigger nearby city. If it operates in multiple distinct cities, name the largest of ` +
    `those actual operating cities first, then list the others. If you cannot confirm this company ` +
    `matches that description (${icpDescription}), say so explicitly. ` +
    `Be concise (2-4 sentences). If you cannot find reliable information, say so explicitly.`

  const res = await fetch(PPLX_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: PPLX_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
      temperature: 0.1,
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Perplexity request failed (${res.status}): ${text}`)
  }
  const data = await res.json() as { choices: { message: { content: string } }[] }
  return data.choices[0].message.content
}

function haikuSystemPrompt(icpDescription: string): string {
  return (
    `You extract a single operating city from research text about a company. The company is expected to be: ${icpDescription}. ` +
    'Respond ONLY with a JSON object, no markdown fences, no preamble, exactly this shape:\n' +
    '{"operating_city": "<City>" or "UNKNOWN", "secondary_cities": ["..."], "confidence": "high"|"medium"|"low", "icp_status": "confirmed"|"unconfirmed"|"not_icp"}\n' +
    'Rules: operating_city is where the company actually operates (primary market), ' +
    'not merely a registered-agent address. Output ONLY the city name, no state/country/abbreviation. ' +
    'Use the specific, actual city the company operates in — never generalize a suburb or smaller ' +
    'city up to a larger nearby metro area or county name. If the research names multiple distinct ' +
    'operating cities, pick the largest of those actual cities as operating_city and list the rest ' +
    'in secondary_cities. ' +
    'Extract operating_city whenever the research supports a city, regardless of icp_status — do not ' +
    'force operating_city to UNKNOWN just because the ICP match is unconfirmed. ' +
    `icp_status rules: "confirmed" if the research clearly shows the company matches the expected ` +
    `description (${icpDescription}). "not_icp" if the research clearly shows it does NOT match ` +
    '(e.g. a pure sales/brokerage business when an operator was expected, or an unrelated business). ' +
    '"unconfirmed" if the research is ambiguous or doesn\'t clearly establish either way. ' +
    'If the research is inconclusive or says it could not find information, use UNKNOWN operating_city ' +
    'with low confidence and icp_status "unconfirmed". ' +
    'Never invent a city that is not supported by the research text.'
  )
}

interface HaikuExtraction {
  operating_city: string
  secondary_cities: string[]
  confidence: string
  icp_status: string
}

async function haikuExtract(company: string, research: string, icpDescription: string): Promise<HaikuExtraction> {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 300,
      system: haikuSystemPrompt(icpDescription),
      messages: [{ role: 'user', content: `Company: ${company}\n\nResearch:\n${research}` }],
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Anthropic request failed (${res.status}): ${text}`)
  }
  const data = await res.json() as { content: { text: string }[] }
  const raw = data.content[0].text
  const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim()
  let parsed: Partial<HaikuExtraction>
  try {
    parsed = JSON.parse(clean)
  } catch {
    parsed = { operating_city: 'PARSE_ERROR', secondary_cities: [], confidence: 'low', icp_status: 'unconfirmed' }
  }
  return {
    operating_city: parsed.operating_city ?? 'UNKNOWN',
    secondary_cities: parsed.secondary_cities ?? [],
    confidence: parsed.confidence ?? 'low',
    icp_status: parsed.icp_status ?? 'unconfirmed',
  }
}

async function processJob(jobId: string): Promise<void> {
  const startTime = Date.now()
  // Re-invoke self after 110s to stay within the edge function wall clock limit.
  const CHUNK_LIMIT_MS = 110_000

  await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, { status: 'processing' })

  const jobs = (await supabaseRequest(
    'GET',
    `validation_jobs?id=eq.${jobId}&select=id,filename,total_rows,enriched_rows,column_order,icp_description,icp_filter`,
  )) as ValidationJob[]
  if (!jobs || jobs.length === 0) throw new Error(`Job ${jobId} not found`)
  const job = jobs[0]
  const icpDescription = job.icp_description || DEFAULT_ICP_DESCRIPTION

  // Determine company/website columns from the job's known headers.
  let workingHeaders = job.column_order && job.column_order.length > 0 ? job.column_order : null
  if (!workingHeaders) {
    const sample = (await supabaseRequest(
      'GET',
      `validation_rows?job_id=eq.${jobId}&limit=1&select=row_data`,
    )) as ValidationRow[]
    workingHeaders = sample?.[0]?.row_data ? Object.keys(sample[0].row_data) : []
  }
  const companyCol = detectCompanyColumn(workingHeaders)
  const websiteCol = detectWebsiteColumn(workingHeaders)
  if (!companyCol) {
    throw new Error('Could not detect a company name column for enrichment')
  }

  // Extend column_order with enrichment columns (idempotent — only if missing).
  const newColumnOrder = workingHeaders.some(h => ENRICHMENT_COLUMNS.includes(h))
    ? workingHeaders
    : [...workingHeaders, ...ENRICHMENT_COLUMNS]
  await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, { column_order: newColumnOrder })

  // Only rows with a valid email are ever eligible for enrichment (email-validator
  // flips them from 'skipped' to 'pending' before invoking this function) — use
  // that eligible count as the percentage denominator, not the raw CSV row count.
  const eligibleRows = (await supabaseRequest(
    'GET',
    `validation_rows?job_id=eq.${jobId}&status=eq.valid&select=id`,
  )) as { id: string }[]
  const enrichableCount = eligibleRows.length

  let enriched = job.enriched_rows
  let lastMilestonePct = enrichableCount > 0 ? Math.floor((enriched / enrichableCount) * 10) * 10 : 0

  while (true) {
    const rows = (await supabaseRequest(
      'GET',
      `validation_rows?job_id=eq.${jobId}&enrichment_status=eq.pending&order=row_index.asc&limit=50&select=id,row_index,row_data`,
    )) as ValidationRow[]
    if (!rows || rows.length === 0) break

    for (const row of rows) {
      const rowData = row.row_data ?? {}
      const company = String(rowData[companyCol] ?? '').trim()
      const website = websiteCol ? (String(rowData[websiteCol] ?? '').trim() || null) : null

      let enrichment: HaikuExtraction & { research?: string }
      let newStatus: string

      if (!company) {
        enrichment = { operating_city: 'UNKNOWN', secondary_cities: [], confidence: 'low', icp_status: 'unconfirmed', research: '' }
        newStatus = 'unknown'
      } else {
        try {
          const research = await perplexityResearch(company, website, icpDescription)
          const extracted = await haikuExtract(company, research, icpDescription)
          enrichment = { ...extracted, research }
          newStatus = extracted.operating_city === 'PARSE_ERROR'
            ? 'error'
            : extracted.operating_city === 'UNKNOWN'
              ? 'unknown'
              : 'done'
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          enrichment = { operating_city: 'ERROR', secondary_cities: [], confidence: 'low', icp_status: 'unconfirmed', research: message }
          newStatus = 'error'
        }
      }

      const mergedRowData = {
        ...rowData,
        operating_city: enrichment.operating_city,
        secondary_cities: (enrichment.secondary_cities ?? []).join('; '),
        city_confidence: enrichment.confidence,
        city_research: enrichment.research ?? '',
        icp_status: enrichment.icp_status,
      }

      await supabaseRequest('PATCH', `validation_rows?id=eq.${row.id}`, {
        enrichment_status: newStatus,
        enrichment,
        row_data: mergedRowData,
      })

      enriched++
      await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, { enriched_rows: enriched })

      if (enrichableCount > 0) {
        const currentPct = Math.floor((enriched / enrichableCount) * 100)
        const milestonePct = Math.floor(currentPct / 10) * 10
        if (milestonePct > lastMilestonePct && milestonePct <= 100) {
          lastMilestonePct = milestonePct
          await sendTelegram(`City enrichment ${milestonePct}% complete (${enriched}/${enrichableCount}).`)
        }
      }

      // Rate-limit cushion between rows (matches the Python script's --sleep default).
      await new Promise((resolve) => setTimeout(resolve, 1000))

      if (Date.now() - startTime > CHUNK_LIMIT_MS) {
        fetch(`${SUPABASE_URL}/functions/v1/operating-city-enricher`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ job_id: jobId }),
        }).catch(err => console.error('[operating-city-enricher] Self re-invoke error:', err))
        await new Promise(r => setTimeout(r, 3000))
        return
      }
    }
  }

  // Enrichment complete for this job — summarize, then hand back to
  // email-validator to finish (it will find nothing left to validate and
  // proceed straight to building the CSV with enrichment merged in).
  const statusCounts = (await supabaseRequest(
    'GET',
    `validation_rows?job_id=eq.${jobId}&select=enrichment_status`,
  )) as { enrichment_status: string }[]
  const doneCount = statusCounts.filter(r => r.enrichment_status === 'done').length

  const confirmedIcp = (await supabaseRequest(
    'GET',
    `validation_rows?job_id=eq.${jobId}&select=id&enrichment->>icp_status=eq.confirmed`,
  )) as { id: string }[]
  const confirmedCount = confirmedIcp.length
  const excludedByMembrane = job.icp_filter ? enrichableCount - confirmedCount : 0
  const resolvedPct = enrichableCount > 0 ? ((doneCount / enrichableCount) * 100).toFixed(1) : '0.0'

  await sendTelegram(
    [
      `🏙️ City enrichment complete — ${job.filename}`,
      `Resolved: ${doneCount}/${enrichableCount} valid-email rows (${resolvedPct}%)`,
      `Confirmed ICP: ${confirmedCount}/${enrichableCount}`,
      job.icp_filter
        ? `Excluded by ICP filter: ${excludedByMembrane}`
        : 'ICP filter: off (all valid-email rows will export)',
    ].join('\n'),
  )

  fetch(`${SUPABASE_URL}/functions/v1/email-validator`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ job_id: jobId }),
  }).catch(err => console.error('[operating-city-enricher] email-validator invoke error:', err))
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  let jobId: string
  try {
    const body = await req.json() as { job_id?: string }
    if (!body.job_id) {
      return new Response(JSON.stringify({ error: 'job_id is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    jobId = body.job_id
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const asyncWork = processJob(jobId).catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[operating-city-enricher] Job ${jobId} failed:`, message)
    try {
      await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, { status: 'failed', error_message: message })
    } catch (patchErr) {
      console.error('[operating-city-enricher] Failed to patch job status to failed:', patchErr)
    }
    await sendTelegram(`⚠️ operating-city-enricher failed for job ${jobId}: ${message}`).catch(() => {})
  })

  EdgeRuntime.waitUntil(asyncWork)

  return new Response(JSON.stringify({ ok: true, job_id: jobId }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
