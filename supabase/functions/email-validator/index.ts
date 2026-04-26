// Supabase Edge Function: email-validator
// Receives { job_id }, validates all pending validation_rows via MailTester Ninja,
// updates validation_jobs progress after each row, sends Telegram milestones,
// uploads valid-only CSV to Storage, sets job status to completed or failed.

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const MAILTESTER_API_KEY = Deno.env.get('MAILTESTER_API_KEY') ?? ''
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? ''

const REST_HEADERS = {
  'apikey': SUPABASE_SERVICE_ROLE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=minimal',
}

async function supabaseRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
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
  // For GET/SELECT requests return JSON; mutations return empty body
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) {
    return res.json()
  }
  return null
}

interface ValidationRow {
  id: string
  job_id: string
  email: string
  row_index: number
  status: string
  validation_result: unknown
  row_data: Record<string, unknown> | null
}

interface ValidationJob {
  id: string
  filename: string
  total_rows: number
  processed_rows: number
  valid_count: number
  invalid_count: number
  status: string
  error_message: string | null
  storage_path: string | null
  source: string
}

async function validateEmail(
  email: string,
): Promise<{ valid: boolean; result: Record<string, unknown> }> {
  try {
    const url =
      `https://happy.mailtester.ninja/ninja?email=${encodeURIComponent(email)}&key=${MAILTESTER_API_KEY}`
    const res = await fetch(url)
    if (!res.ok) {
      return { valid: false, result: { error: `HTTP ${res.status}` } }
    }
    const data = await res.json() as Record<string, unknown>
    // MailTester returns { valid: boolean, ... }
    const valid = Boolean(data.valid ?? data.deliverable ?? false)
    return { valid, result: data }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return { valid: false, result: { error: message } }
  }
}

async function sendTelegram(message: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return
  try {
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
      },
    )
  } catch {
    // Non-critical — ignore Telegram errors
  }
}

async function processJob(jobId: string): Promise<void> {
  const startTime = Date.now()
  // Re-invoke self after 110s to stay within the edge function wall clock limit.
  // Each re-invocation picks up remaining pending rows automatically.
  const CHUNK_LIMIT_MS = 110_000

  // 1. Mark job as processing
  await supabaseRequest(
    'PATCH',
    `validation_jobs?id=eq.${jobId}`,
    { status: 'processing' },
  )

  // 2. Fetch job metadata for total_rows
  const jobs = (await supabaseRequest(
    'GET',
    `validation_jobs?id=eq.${jobId}&select=id,total_rows,processed_rows,valid_count,invalid_count,source`,
  )) as ValidationJob[]

  if (!jobs || jobs.length === 0) {
    throw new Error(`Job ${jobId} not found`)
  }

  const job = jobs[0]
  let processed = job.processed_rows
  let validCount = job.valid_count
  let invalidCount = job.invalid_count
  const totalRows = job.total_rows
  let lastMilestonePct = totalRows > 0
    ? Math.floor((processed / totalRows) * 10) * 10
    : 0

  // 3. Main processing loop — fetch 50 pending rows at a time
  while (true) {
    const rows = (await supabaseRequest(
      'GET',
      `validation_rows?job_id=eq.${jobId}&status=eq.pending&order=row_index.asc&limit=50`,
    )) as ValidationRow[]

    if (!rows || rows.length === 0) break

    for (const row of rows) {
      const { valid, result } = await validateEmail(row.email)

      // Update the individual row
      await supabaseRequest(
        'PATCH',
        `validation_rows?id=eq.${row.id}`,
        {
          status: valid ? 'valid' : 'invalid',
          validation_result: result,
          processed_at: new Date().toISOString(),
        },
      )

      // Update job counters
      processed++
      if (valid) validCount++
      else invalidCount++

      await supabaseRequest(
        'PATCH',
        `validation_jobs?id=eq.${jobId}`,
        {
          processed_rows: processed,
          valid_count: validCount,
          invalid_count: invalidCount,
        },
      )

      // Check milestones (10%, 20%, ..., 100%)
      if (totalRows > 0) {
        const currentPct = Math.floor((processed / totalRows) * 100)
        const milestonePct = Math.floor(currentPct / 10) * 10
        if (milestonePct > lastMilestonePct && milestonePct <= 100) {
          lastMilestonePct = milestonePct
          await sendTelegram(
            `Email validation ${milestonePct}% complete (${processed}/${totalRows}) — ${validCount} valid so far.`,
          )
        }
      }

      // Brief pause to avoid rate-limit hammering
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Approaching wall clock limit — hand off to a fresh invocation and exit.
      // The next invocation resumes from remaining pending rows automatically.
      if (Date.now() - startTime > CHUNK_LIMIT_MS) {
        fetch(
          `${SUPABASE_URL}/functions/v1/email-validator`,
          {
            method: 'POST',
            headers: {
              'apikey': SUPABASE_SERVICE_ROLE_KEY,
              'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ job_id: jobId }),
          },
        ).catch(err => console.error('[email-validator] Self re-invoke error:', err))
        return
      }
    }
  }

  // 4. Build CSV and upload to Storage
  const validRows = (await supabaseRequest(
    'GET',
    `validation_rows?job_id=eq.${jobId}&status=eq.valid&order=row_index.asc&select=email,row_data`,
  )) as ValidationRow[]

  let csvContent: string

  if (job.source === 'apify' && validRows.length > 0 && validRows[0].row_data) {
    // Full-column CSV: all row_data fields, nested objects JSON-stringified
    const allKeys = Object.keys(validRows[0].row_data)
    const headers = allKeys.join(',')
    const dataLines = validRows.map(row => {
      return allKeys.map(key => {
        const val = row.row_data![key]
        if (val === null || val === undefined) return ''
        if (typeof val === 'object') return `"${JSON.stringify(val).replace(/"/g, '""')}"`
        const str = String(val)
        return str.includes(',') || str.includes('"') || str.includes('\n')
          ? `"${str.replace(/"/g, '""')}"`
          : str
      }).join(',')
    })
    csvContent = [headers, ...dataLines].join('\n')
  } else {
    // Email-only CSV for regular jobs
    const csvLines: string[] = ['email']
    for (const row of validRows) csvLines.push(row.email)
    csvContent = csvLines.join('\n')
  }
  const csvBytes = new TextEncoder().encode(csvContent)
  const storagePath = `jobs/${jobId}/valid.csv`

  // Upload to Supabase Storage
  const uploadUrl =
    `${SUPABASE_URL}/storage/v1/object/validation-results/${storagePath}`
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'text/csv',
      'x-upsert': 'true',
    },
    body: csvBytes,
  })

  if (!uploadRes.ok) {
    const text = await uploadRes.text()
    throw new Error(`Storage upload failed (${uploadRes.status}): ${text}`)
  }

  // 5. Mark job completed
  await supabaseRequest(
    'PATCH',
    `validation_jobs?id=eq.${jobId}`,
    {
      status: 'completed',
      storage_path: storagePath,
      processed_rows: processed,
      valid_count: validCount,
      invalid_count: invalidCount,
    },
  )

  await sendTelegram(
    `Email validation complete! ${validCount}/${totalRows} valid emails saved to Storage.`,
  )
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

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

  // Fire-and-forget: respond immediately, process in background
  const asyncWork = processJob(jobId).catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[email-validator] Job ${jobId} failed:`, message)
    try {
      await supabaseRequest(
        'PATCH',
        `validation_jobs?id=eq.${jobId}`,
        { status: 'failed', error_message: message },
      )
    } catch (patchErr) {
      console.error('[email-validator] Failed to patch job status to failed:', patchErr)
    }
  })

  EdgeRuntime.waitUntil(asyncWork)

  return new Response(JSON.stringify({ ok: true, job_id: jobId }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
