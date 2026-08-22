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
  opts?: { returning?: boolean },
): Promise<unknown> {
  const url = `${SUPABASE_URL}/rest/v1/${path}`
  // returning=true is what makes a conditional PATCH usable as a claim: the
  // response carries the rows that actually matched, so "zero rows back" means
  // someone else won the race.
  const headers = opts?.returning
    ? { ...REST_HEADERS, 'Prefer': 'return=representation' }
    : REST_HEADERS
  const res = await fetch(url, {
    method,
    headers,
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
  column_order: string[] | null
  icp_filter: boolean
  enrich: boolean
  enrich_started: boolean
  instantly_status: string
}

// PostgREST silently truncates an unbounded GET at its max-rows ceiling (1000
// here) and returns 200, so a large export looks complete while missing most
// of its rows. Every multi-row read must page explicitly.
// The caller's query must carry a stable `order=` or offset paging can repeat
// or skip rows between pages.
async function fetchAllPages(baseQuery: string, pageSize = 1000): Promise<ValidationRow[]> {
  const all: ValidationRow[] = []
  for (let offset = 0; ; offset += pageSize) {
    const page = (await supabaseRequest(
      'GET',
      `${baseQuery}&limit=${pageSize}&offset=${offset}`,
    )) as ValidationRow[]
    if (!page || page.length === 0) break
    all.push(...page)
    if (page.length < pageSize) break
  }
  return all
}

// The 110s hand-off is the one point where the whole chain can die: this
// invocation is about to exit, so if the POST is rejected nothing resumes and
// the job stalls silently. On 2026-08-22 a platform 502 (8ms, no deployment_id)
// did exactly that at 3,328/5,385 — the old code fired the request without
// awaiting it and swallowed the failure into console.error. Await it, retry,
// and if it still fails, say so rather than dying quietly.
async function handOff(fnName: string, jobId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/${fnName}`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ job_id: jobId }),
      })
      if (res.ok) return true
      console.error(`[${fnName}] hand-off attempt ${attempt + 1}: HTTP ${res.status}`)
    } catch (err) {
      console.error(`[${fnName}] hand-off attempt ${attempt + 1} threw:`, err)
    }
    await new Promise(r => setTimeout(r, 1_500 * (attempt + 1)))
  }
  return false
}

// True when the owner (or a failure) has taken the job out of the runnable
// set. Callers must exit WITHOUT self-reinvoking and without writing status.
async function isHalted(jobId: string): Promise<boolean> {
  try {
    const rows = (await supabaseRequest(
      'GET',
      `validation_jobs?id=eq.${jobId}&select=status`,
    )) as { status: string }[]
    const status = rows?.[0]?.status
    return status === 'cancelled' || status === 'failed'
  } catch (err) {
    // A transient read failure must not look like a cancellation, or one blip
    // silently stops a healthy run.
    console.error('[email-validator] halt check failed, continuing:', err)
    return false
  }
}

function jobTitle(filename: string): string {
  if (filename.startsWith('hnwi-signals'))     return '🎯 HNWI Demand — Direct Emails'
  if (filename.startsWith('hnwi-email-found')) return '🔍 HNWI Demand — Email Finder'
  if (filename.startsWith('ria-signals'))      return '🏢 RIA Supply — Direct Emails'
  if (filename.startsWith('ria-email-found'))  return '🔍 RIA Supply — Email Finder'
  return `📊 ${filename}`
}

function isEmailFinderJob(filename: string): boolean {
  return filename.startsWith('hnwi-email-found') || filename.startsWith('ria-email-found')
}

// MailTester answers HTTP 200 even when the key is dead or out of quota. The
// body is a shell: code '--', message 'Invalid Key', limit 0. `res.ok` is true
// for it, so a plain "message !== Accepted" test would silently mark every
// remaining row invalid. That has to abort the job instead.
class MailTesterKeyError extends Error {}

// The server declined to give a verdict — the mailbox was never actually
// tested. These get retried; they are never written off as invalid.
// Message values per https://mailtester.ninja/api/
// Compared lowercased: the docs spell these "Mx Error"/"No Mx" but the live
// API returns "MX Error"/"No MX", and an exact-case match silently files a
// retryable row as invalid.
const INCONCLUSIVE_MESSAGES = new Set([
  'limited',
  'timeout',
  'spam block',
  'mx error',
])

type Verdict = 'valid' | 'invalid' | 'inconclusive'

async function validateEmail(
  email: string,
): Promise<{ verdict: Verdict; result: Record<string, unknown> }> {
  try {
    const url =
      `https://happy.mailtester.ninja/ninja?email=${encodeURIComponent(email)}&key=${MAILTESTER_API_KEY}`

    // A 429 says "slow down", not "bad address". Back off and re-ask for the
    // SAME row rather than spending one of its attempts — otherwise a burst of
    // rate limiting quietly evicts good addresses from the list.
    let res = await fetch(url)
    for (let backoff = 0; res.status === 429 && backoff < 4; backoff++) {
      await new Promise((r) => setTimeout(r, 2_000 * (backoff + 1)))
      res = await fetch(url)
    }

    if (!res.ok) {
      return { verdict: 'inconclusive', result: { error: `HTTP ${res.status}` } }
    }
    const data = await res.json() as Record<string, unknown>
    const message = String(data.message ?? '')

    if (data.code === '--' || message === 'Invalid Key' || Number(data.limit) === 0) {
      throw new MailTesterKeyError(
        `MailTester rejected the key (code=${data.code}, message=${message}). ` +
        `Job aborted before any row could be mis-marked invalid.`,
      )
    }

    if (message === 'Accepted') return { verdict: 'valid', result: data }
    if (INCONCLUSIVE_MESSAGES.has(message.toLowerCase())) {
      return { verdict: 'inconclusive', result: data }
    }
    return { verdict: 'invalid', result: data }
  } catch (err: unknown) {
    if (err instanceof MailTesterKeyError) throw err
    // A network failure is not evidence the mailbox is bad either.
    const message = err instanceof Error ? err.message : String(err)
    return { verdict: 'inconclusive', result: { error: message } }
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

  // 1. Claim the job as processing — CONDITIONALLY. An unconditional PATCH
  //    here is what made cancellation impossible: the owner sets 'cancelled',
  //    the next self-reinvocation stamps 'processing' straight back over it,
  //    and the run continues forever. Matching only pending/processing means a
  //    cancelled or failed job can never be resurrected by its own chain.
  const claimedJob = (await supabaseRequest(
    'PATCH',
    `validation_jobs?id=eq.${jobId}&status=in.(pending,processing)`,
    { status: 'processing' },
    { returning: true },
  )) as ValidationJob[]
  if (!claimedJob || claimedJob.length === 0) {
    console.log(`[email-validator] Job ${jobId} is not runnable (cancelled, failed or already finished) — exiting.`)
    return
  }

  // 2. Fetch job metadata
  const jobs = (await supabaseRequest(
    'GET',
    `validation_jobs?id=eq.${jobId}&select=id,filename,total_rows,processed_rows,valid_count,invalid_count,source,column_order,icp_filter,enrich,enrich_started,instantly_status`,
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

  // Pro plan allows 11 emails / 10s (~1 per 909ms) — https://mailtester.ninja/api/
  // Pace on CYCLE time rather than sleeping a flat interval on top of request
  // latency: a ~1.5s request already satisfies the ceiling by itself, so the
  // old unconditional 1100ms sleep was discarding roughly half the throughput.
  // 1000ms = 10 requests per 10s, one under the plan's 11 — the margin matters
  // because the ceiling is a sliding window, not an average.
  const MIN_INTERVAL_MS = 1_000
  const MAX_ATTEMPTS = 3

  // 3. Main processing loop — 50 rows at a time. Once nothing is pending,
  //    inconclusive rows get another attempt before they are given up on.
  while (true) {
    // Cancellation is only observable here. There is no signal into a running
    // worker, so the owner's 'cancelled' is picked up at the top of each batch
    // — worst case one batch (~50 rows) after the flip.
    if (await isHalted(jobId)) {
      console.log(`[email-validator] Job ${jobId} halted mid-run — exiting without re-invoking.`)
      return
    }

    let rows = (await supabaseRequest(
      'GET',
      `validation_rows?job_id=eq.${jobId}&status=eq.pending&order=row_index.asc&limit=50`,
    )) as ValidationRow[]
    let isRetry = false

    if (!rows || rows.length === 0) {
      // Retry pass. `attempts` is matched against a literal set because
      // PostgREST compares a jsonb ->> extraction as text, so lt.3 would be a
      // string comparison. Rows parked by an operator halt carry no
      // `inconclusive` key, so they are never picked up here.
      const retryable = Array.from({ length: MAX_ATTEMPTS - 1 }, (_, i) => i + 1).join(',')
      rows = (await supabaseRequest(
        'GET',
        `validation_rows?job_id=eq.${jobId}&status=eq.error` +
        `&validation_result->>inconclusive=eq.true` +
        `&validation_result->>attempts=in.(${retryable})` +
        `&order=row_index.asc&limit=50`,
      )) as ValidationRow[]
      isRetry = true
    }

    if (!rows || rows.length === 0) break

    for (const row of rows) {
      const cycleStart = Date.now()
      const { verdict, result } = await validateEmail(row.email)

      if (verdict === 'inconclusive') {
        // Not a verdict. The mailbox was never tested, so it must not land in
        // the invalid bucket and get dropped from the export.
        const priorAttempts = isRetry
          ? Number((row.validation_result as { attempts?: unknown } | null)?.attempts ?? 1)
          : 0
        await supabaseRequest(
          'PATCH',
          `validation_rows?id=eq.${row.id}`,
          {
            status: 'error',
            validation_result: { ...result, inconclusive: true, attempts: priorAttempts + 1 },
            processed_at: new Date().toISOString(),
          },
        )
      } else {
        await supabaseRequest(
          'PATCH',
          `validation_rows?id=eq.${row.id}`,
          {
            status: verdict,
            validation_result: result,
            processed_at: new Date().toISOString(),
          },
        )
        if (verdict === 'valid') validCount++
        else invalidCount++
      }

      // A row counts as processed once, on its first attempt — a later retry
      // resolves it but does not make it a new row.
      if (!isRetry) processed++

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

      // Top up to the documented interval only if the request itself was
      // faster than it. Usually it wasn't, so this sleeps 0ms.
      const cycleElapsed = Date.now() - cycleStart
      if (cycleElapsed < MIN_INTERVAL_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_INTERVAL_MS - cycleElapsed))
      }

      // Approaching wall clock limit — hand off to a fresh invocation and exit.
      // The next invocation resumes from remaining pending rows automatically.
      if (Date.now() - startTime > CHUNK_LIMIT_MS) {
        const handedOff = await handOff('email-validator', jobId)
        if (!handedOff) {
          await sendTelegram(
            `⚠️ ${job.filename}: could not start the next validation chunk after 4 attempts.\n` +
            `${processed}/${totalRows} done. The stall watchdog will offer a Resume in ~10 min.`,
          )
        }
        return
      }
    }
  }

  // 3b. Enrichment is chained directly, not put behind a button. The decision
  // was already made once at intake (Approve vs Approve + Enrich); re-asking
  // here created a second, replayable decision point whose button could be
  // tapped at any time — including while validation was still running, which
  // is how one job ended up with 179 enriched rows and 4,164 still unvalidated.
  //
  // Reaching this line means the loop drained, so validation IS complete for
  // this job. `enrich_started` is a one-way latch claimed atomically: the
  // enricher chains back into this function when it finishes, and without the
  // latch that second pass would re-arm enrichment and loop forever.
  if (job.enrich && !job.enrich_started) {
    const pendingEnrichment = (await supabaseRequest(
      'GET',
      `validation_rows?job_id=eq.${jobId}&status=eq.valid&enrichment_status=eq.skipped&select=id&limit=1`,
    )) as { id: string }[]

    if (pendingEnrichment.length > 0) {
      const validShare = totalRows > 0 ? validCount / totalRows : 0

      if (validShare < 0.10) {
        // A mostly-dead list isn't worth Perplexity/Haiku credits. Say so and
        // fall through to the export rather than silently spending.
        await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, { enrich_started: true })
        await sendTelegram(
          `⏭ Skipped enrichment — ${job.filename}\n` +
          `Only ${validCount} of ${totalRows} rows validated (${(validShare * 100).toFixed(1)}%), ` +
          `below the 10% floor. Building the CSV from what's there.`,
        )
      } else {
        const latched = (await supabaseRequest(
          'PATCH',
          `validation_jobs?id=eq.${jobId}&enrich_started=is.false`,
          { enrich_started: true },
          { returning: true },
        )) as ValidationJob[]

        if (latched && latched.length > 0) {
          await supabaseRequest(
            'PATCH',
            `validation_rows?job_id=eq.${jobId}&status=eq.valid&enrichment_status=eq.skipped`,
            { enrichment_status: 'pending' },
          )
          await sendTelegram(
            `✅ Validation complete — ${job.filename}\n` +
            `${validCount} valid / ${invalidCount} invalid\n\n` +
            `🔎 Enriching ${validCount} rows with operating-city research…`,
          )
          fetch(`${SUPABASE_URL}/functions/v1/operating-city-enricher`, {
            method: 'POST',
            headers: {
              'apikey': SUPABASE_SERVICE_ROLE_KEY,
              'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ job_id: jobId }),
          }).catch(err => console.error('[email-validator] enricher invoke error:', err))
          await new Promise(r => setTimeout(r, 3000))
          return
        }
      }
    }
  }

  // 4. Build CSV and upload to Storage
  // ICP filter applies only here, at the export exit — it never re-triggers
  // enrichment. row_data.icp_status is merged in by operating-city-enricher.
  const validRowsFilterQuery = job.icp_filter
    ? `validation_rows?job_id=eq.${jobId}&status=eq.valid&row_data->>icp_status=eq.confirmed&order=row_index.asc&select=email,row_data`
    : `validation_rows?job_id=eq.${jobId}&status=eq.valid&order=row_index.asc&select=email,row_data`
  const validRows = await fetchAllPages(validRowsFilterQuery)

  let csvContent: string

  if (validRows.length > 0 && validRows[0].row_data) {
    // Full-column CSV: all row_data fields, nested objects JSON-stringified.
    // column_order is a jsonb array (order-preserving); row_data is a jsonb
    // object (key order not guaranteed), so prefer column_order when present.
    const allKeys = job.column_order && job.column_order.length > 0
      ? job.column_order
      : Object.keys(validRows[0].row_data)
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

  const pct = totalRows > 0 ? ((validCount / totalRows) * 100).toFixed(1) : '0.0'
  const isFinderJob = isEmailFinderJob(job.filename)
  const lines = [
    `✅ ${jobTitle(job.filename)}`,
    ``,
    `1. Valid emails: ${validCount}`,
    `2. Valid %: ${pct}%`,
    isFinderJob
      ? `3. Emails found: ${totalRows}`
      : `3. Emails found: N/A (direct)`,
    isFinderJob
      ? `4. Valid % of found: ${pct}%`
      : `4. Valid % of found: N/A`,
  ]
  await sendTelegram(lines.join('\n'))

  // 6. This is the true end of the job — the same point whether or not
  // enrichment ran. Ask which Instantly campaign the valid leads should go
  // into, by NAME. The force_reply is what makes the answer findable later:
  // telegram-inbox matches the reply's reply_to_message.message_id back to
  // this job, so no separate state machine is needed.
  // Guarded on 'idle' because operating-city-enricher chains back into this
  // function, and a re-invocation must not re-prompt.
  if (validCount > 0 && job.instantly_status === 'idle' && TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    await promptForCampaign(jobId, job.filename, validCount)
  }
}

async function promptForCampaign(jobId: string, filename: string, validCount: number): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text:
          `📤 Push ${validCount} valid leads to Instantly?\n${filename}\n\n` +
          `Reply to this message with the campaign NAME (partial is fine — I'll match it against your campaign list).`,
        reply_markup: { force_reply: true },
      }),
    })
    const sent = await res.json() as { result?: { message_id?: number } }
    const messageId = sent.result?.message_id
    if (!messageId) return
    await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobId}`, {
      instantly_prompt_message_id: messageId,
      instantly_status: 'awaiting_campaign',
    })
  } catch (err) {
    console.error('[email-validator] Instantly campaign prompt failed:', err)
  }
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
    // A key failure is silent by nature — MailTester returns 200 for it — so
    // it gets an explicit alert rather than just a row in the jobs table.
    if (err instanceof MailTesterKeyError) {
      await sendTelegram(`🔑 Validation halted — MailTester key problem.\n\n${message}`)
    }
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
