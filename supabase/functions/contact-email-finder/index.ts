// Supabase Edge Function: contact-email-finder
// Receives { job_id }, resolves an address for every row that arrived without
// one via connector-os, then hands the whole list to email-validator so found
// and pre-existing addresses are validated together in a single pass.
//
// Runs BEFORE email-validator, not after: MailTester costs ~1.1s per row, so
// there's no sense paying that for blank rows, and a found address deserves
// the same validation as one that came in the file.
//
// Rows that can't be resolved end as 'no_email' rather than 'invalid' — never
// having an address is a different outcome from having a dead one, and mixing
// them made invalid_count useless on partly-blank lists.

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CONNECTOR_OS_API_KEY = Deno.env.get('CONNECTOR_OS_API_KEY') ?? ''
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? ''

const FINDER_URL = 'https://api.connector-os.com/api/email/v2/find'

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
  return ct.includes('application/json') ? res.json() : null
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

// ---- Column detection (mirrors the other edge functions; they don't share
// code with the Next.js app — see design doc) ----

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

const FIRST_EXACT = new Set(['first_name', 'firstname', 'given_name'])
const LAST_EXACT = new Set(['last_name', 'lastname', 'surname', 'family_name'])
const FULL_EXACT = new Set(['name', 'full_name', 'person_name', 'contact_name'])
// Company Domain before Website: a bare domain needs no URL parsing.
const DOMAIN_EXACT = new Set(['company_domain', 'domain', 'website', 'company_website', 'url'])

interface Columns {
  first: string | null
  last: string | null
  full: string | null
  domain: string | null
}

function detectColumns(headers: string[]): Columns {
  return {
    first: pickColumn(headers, FIRST_EXACT, ['first_name', 'first']),
    last: pickColumn(headers, LAST_EXACT, ['last_name', 'last']),
    full: pickColumn(headers, FULL_EXACT, ['full_name', 'person_name', 'contact_name']),
    domain: pickColumn(headers, DOMAIN_EXACT, ['domain', 'website']),
  }
}

function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean)
  return { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') }
}

// Accepts a bare domain, a full URL, or an email-ish string and returns the
// hostname the finder expects.
function toDomain(raw: string): string {
  let value = (raw ?? '').trim()
  if (!value) return ''
  if (value.includes('@')) value = value.split('@').pop() ?? ''
  if (/^https?:\/\//i.test(value)) {
    try { value = new URL(value).hostname } catch { /* fall through to cleanup */ }
  }
  value = value.replace(/^www\./i, '').replace(/\/.*$/, '').trim()
  return value.includes('.') ? value.toLowerCase() : ''
}

interface FinderOutcome {
  email: string | null
  detail: Record<string, unknown>
  authFailed?: boolean
}

// A wrong or expired key returns 401/403 on every call. Without this, the run
// would quietly mark every row 'no_email' and look like a list where nothing
// could be found — the most expensive kind of silent failure.
class FinderAuthError extends Error {}

async function findEmail(firstName: string, lastName: string, domain: string): Promise<FinderOutcome> {
  try {
    const res = await fetch(FINDER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CONNECTOR_OS_API_KEY}`,
      },
      body: JSON.stringify({ firstName, lastName, domain }),
    })
    if (res.status === 200) {
      const data = await res.json() as { email?: string; status?: string; found_via?: string }
      return {
        email: data.email ?? null,
        detail: { found_via: data.found_via ?? null, finder_status: data.status ?? null },
      }
    }
    if (res.status === 401 || res.status === 403) {
      return { email: null, detail: { http_status: res.status }, authFailed: true }
    }
    // 404 = no match, 503 = busy. Neither is fatal for the run.
    return { email: null, detail: { http_status: res.status } }
  } catch (err: unknown) {
    return { email: null, detail: { error: err instanceof Error ? err.message : String(err) } }
  }
}

interface ValidationRow {
  id: string
  row_index: number
  row_data: Record<string, unknown> | null
}

interface ValidationJob {
  id: string
  filename: string
  column_order: string[] | null
  emails_found: number
  emails_not_found: number
}

async function invokeValidator(jobId: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/functions/v1/email-validator`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ job_id: jobId }),
  }).catch(err => console.error('[contact-email-finder] email-validator invoke error:', err))
}

async function processJob(jobId: string): Promise<void> {
  const startTime = Date.now()
  const CHUNK_LIMIT_MS = 110_000

  if (!CONNECTOR_OS_API_KEY) {
    // Don't strand the job: validate what already has addresses and say why.
    await sendTelegram(
      '⚠️ CONNECTOR_OS_API_KEY is not set on this Supabase project — skipping the ' +
      'email finder and validating only the rows that already have an address.',
    )
    await invokeValidator(jobId)
    return
  }

  await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, { status: 'processing' })

  const jobs = (await supabaseRequest(
    'GET',
    `validation_jobs?id=eq.${jobId}&select=id,filename,column_order,emails_found,emails_not_found`,
  )) as ValidationJob[]
  if (!jobs || jobs.length === 0) throw new Error(`Job ${jobId} not found`)
  const job = jobs[0]

  let headers = job.column_order && job.column_order.length > 0 ? job.column_order : null
  if (!headers) {
    const sample = (await supabaseRequest(
      'GET',
      `validation_rows?job_id=eq.${jobId}&limit=1&select=row_data`,
    )) as ValidationRow[]
    headers = sample?.[0]?.row_data ? Object.keys(sample[0].row_data) : []
  }
  const cols = detectColumns(headers)

  let found = job.emails_found
  let notFound = job.emails_not_found
  let lastMilestone = 0

  const missingRows = (await supabaseRequest(
    'GET',
    `validation_rows?job_id=eq.${jobId}&status=eq.pending&email=eq.&select=id`,
  )) as { id: string }[]
  const totalMissing = missingRows.length + found + notFound

  while (true) {
    const rows = (await supabaseRequest(
      'GET',
      `validation_rows?job_id=eq.${jobId}&status=eq.pending&email=eq.&order=row_index.asc&limit=50&select=id,row_index,row_data`,
    )) as ValidationRow[]
    if (!rows || rows.length === 0) break

    for (const row of rows) {
      const data = row.row_data ?? {}
      const get = (col: string | null): string => (col ? String(data[col] ?? '').trim() : '')

      let firstName = get(cols.first)
      let lastName = get(cols.last)
      if (!firstName && cols.full) {
        const split = splitFullName(get(cols.full))
        firstName = split.firstName
        lastName = lastName || split.lastName
      }
      const domain = toDomain(get(cols.domain))

      if (!firstName || !domain) {
        // Nothing to search on — don't spend a lookup.
        await supabaseRequest('PATCH', `validation_rows?id=eq.${row.id}`, {
          status: 'no_email',
          validation_result: { skipped: 'no name or domain to search on' },
        })
        notFound++
      } else {
        const outcome = await findEmail(firstName, lastName, domain)
        if (outcome.authFailed) {
          throw new FinderAuthError(
            `connector-os rejected the API key (HTTP ${outcome.detail.http_status}). ` +
            `Stopped after ${found + notFound} rows — no rows were wrongly marked as not-found.`,
          )
        }
        if (outcome.email) {
          // status stays 'pending' so email-validator picks it up alongside
          // the addresses that came in the file.
          await supabaseRequest('PATCH', `validation_rows?id=eq.${row.id}`, {
            email: outcome.email,
            validation_result: { found_by: 'connector-os', ...outcome.detail },
          })
          found++
        } else {
          await supabaseRequest('PATCH', `validation_rows?id=eq.${row.id}`, {
            status: 'no_email',
            validation_result: { not_found: true, ...outcome.detail },
          })
          notFound++
        }
      }

      await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, {
        emails_found: found,
        emails_not_found: notFound,
      })

      const done = found + notFound
      if (totalMissing > 0) {
        const milestone = Math.floor((done / totalMissing) * 100 / 25) * 25
        if (milestone > lastMilestone && milestone <= 100) {
          lastMilestone = milestone
          await sendTelegram(`🔍 Email finder ${milestone}% (${done}/${totalMissing}) — ${found} found so far.`)
        }
      }

      if (Date.now() - startTime > CHUNK_LIMIT_MS) {
        fetch(`${SUPABASE_URL}/functions/v1/contact-email-finder`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ job_id: jobId }),
        }).catch(err => console.error('[contact-email-finder] Self re-invoke error:', err))
        await new Promise(r => setTimeout(r, 3000))
        return
      }
    }
  }

  // total_rows should reflect what MailTester will actually see: the rows that
  // came with an address plus the ones just resolved.
  const toValidate = (await supabaseRequest(
    'GET',
    `validation_rows?job_id=eq.${jobId}&status=eq.pending&select=id`,
  )) as { id: string }[]

  await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, {
    total_rows: toValidate.length,
    emails_found: found,
    emails_not_found: notFound,
  })

  await sendTelegram(
    [
      `🔍 Email finder complete — ${job.filename}`,
      `Found: ${found}`,
      `Not found: ${notFound}`,
      ``,
      `Validating ${toValidate.length} addresses now.`,
    ].join('\n'),
  )

  if (toValidate.length === 0) {
    await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, { status: 'completed' })
    return
  }

  await invokeValidator(jobId)
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  let jobId: string
  try {
    const body = await req.json() as { job_id?: string; mode?: string }
    // Edge functions have their own secret store, separate from the Next.js
    // app's Vercel env — worth being able to check without starting a run.
    if (body.mode === 'check') {
      return new Response(
        JSON.stringify({ ok: true, connectorOsKeyPresent: CONNECTOR_OS_API_KEY.length > 0 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
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
    console.error(`[contact-email-finder] Job ${jobId} failed:`, message)
    try {
      await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, { status: 'failed', error_message: message })
    } catch (patchErr) {
      console.error('[contact-email-finder] Failed to patch job to failed:', patchErr)
    }
    await sendTelegram(`⚠️ Email finder failed for job ${jobId}: ${message}`).catch(() => {})
  })

  EdgeRuntime.waitUntil(asyncWork)

  return new Response(JSON.stringify({ ok: true, job_id: jobId }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
