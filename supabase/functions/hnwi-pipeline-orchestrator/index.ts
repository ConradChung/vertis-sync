// supabase/functions/hnwi-pipeline-orchestrator/index.ts
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const APIFY_TOKEN = Deno.env.get('APIFY_API_TOKEN')!
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? ''

const WEALTH_ACTOR_ID = 'belcaidsaad~wealth-management-scraper-saad-belcaid-market-saad-belcaid'

const REST_HEADERS = {
  'apikey': SERVICE_KEY,
  'Authorization': `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=minimal',
}

const EDGE_HEADERS = {
  'apikey': SERVICE_KEY,
  'Authorization': `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
}

// Self-invoke before hitting Supabase wall-clock limit
const CHUNK_LIMIT_MS = 110_000

type ARecord = Record<string, unknown>

interface RiaInput {
  minAUM: number
  maxAUM: number
  minEmployees: number
  maxEmployees: number
  stateFilter: string
  firmCategory: string
  maxResults: number
}

interface Payload {
  hnwi_job_a: string   // HNWI direct emails
  hnwi_job_b: string   // HNWI email finder
  ria_job_a: string    // RIA direct emails
  ria_job_b: string    // RIA email finder
  hnwi_run_id: string
  ria_input: RiaInput
  phase?: 'hnwi' | 'ria'
  ria_run_id?: string  // set after RIA actor is started
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
    // Non-critical
  }
}

function hasEmail(r: ARecord): boolean {
  const e = String(r.email ?? '')
  return e.includes('@') && e.includes('.')
}

async function startActorRun(actorId: string, input: unknown): Promise<string> {
  const res = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to start actor ${actorId}: ${res.status} ${text}`)
  }
  const data = await res.json() as { data: { id: string } }
  return data.data.id
}

// Returns datasetId on success, or timedOut when approaching wall-clock limit.
// Caller should self-invoke with same payload — Apify run state persists across invocations.
async function pollApify(
  runId: string,
  startTime: number,
): Promise<{ datasetId?: string; timedOut: boolean }> {
  const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED_OUT'])
  for (let attempt = 0; attempt < 60; attempt++) {
    if (Date.now() - startTime > CHUNK_LIMIT_MS) return { timedOut: true }
    if (attempt > 0) await new Promise(r => setTimeout(r, 5_000))
    const res = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`)
    if (!res.ok) throw new Error(`Apify poll failed: ${res.status}`)
    const data = await res.json() as { data: { status: string; defaultDatasetId: string } }
    const { status, defaultDatasetId } = data.data
    if (status === 'SUCCEEDED') return { datasetId: defaultDatasetId, timedOut: false }
    if (TERMINAL.has(status)) throw new Error(`Apify run ${runId} ended: ${status}`)
  }
  throw new Error(`Apify run ${runId} polling exhausted`)
}

async function fetchDataset(datasetId: string): Promise<ARecord[]> {
  const res = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&limit=99999`,
  )
  if (!res.ok) throw new Error(`Dataset fetch failed: ${res.status}`)
  return res.json() as Promise<ARecord[]>
}

async function insertInBatches(rows: unknown[], batchSize = 100): Promise<void> {
  for (let i = 0; i < rows.length; i += batchSize) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/validation_rows`, {
      method: 'POST',
      headers: REST_HEADERS,
      body: JSON.stringify(rows.slice(i, i + batchSize)),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Batch insert failed (${res.status}): ${text}`)
    }
  }
}

function selfInvoke(payload: Payload): void {
  fetch(`${SUPABASE_URL}/functions/v1/hnwi-pipeline-orchestrator`, {
    method: 'POST',
    headers: EDGE_HEADERS,
    body: JSON.stringify(payload),
  }).catch(err => console.error('[hnwi-pipeline-orchestrator] Self-invoke error:', err))
}

async function processRecords(
  records: ARecord[],
  jobIdA: string,
  jobIdB: string,
): Promise<{ streamALen: number; streamBLen: number }> {
  const streamA = records.filter(r => hasEmail(r))
  const streamB = records.filter(r => !hasEmail(r))

  await Promise.all([
    supabaseRequest('PATCH', `validation_jobs?id=eq.${jobIdA}`, { total_rows: streamA.length }),
    supabaseRequest('PATCH', `validation_jobs?id=eq.${jobIdB}`, { total_rows: streamB.length }),
  ])

  if (streamA.length > 0) {
    await insertInBatches(
      streamA.map((r, i) => ({
        job_id: jobIdA,
        email: String(r.email ?? ''),
        row_index: i,
        status: 'pending',
        row_data: r,
      })),
    )
    fetch(`${SUPABASE_URL}/functions/v1/email-validator`, {
      method: 'POST',
      headers: EDGE_HEADERS,
      body: JSON.stringify({ job_id: jobIdA }),
    }).catch(err => console.error('[orchestrator] email-validator invoke error:', err))
  } else {
    await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobIdA}`, { status: 'completed' })
  }

  if (streamB.length > 0) {
    await insertInBatches(
      streamB.map((r, i) => ({
        job_id: jobIdB,
        email: '',
        row_index: i,
        status: 'pending',
        row_data: r,
      })),
    )
    fetch(`${SUPABASE_URL}/functions/v1/hnwi-email-finder`, {
      method: 'POST',
      headers: EDGE_HEADERS,
      body: JSON.stringify({ job_id: jobIdB }),
    }).catch(err => console.error('[orchestrator] hnwi-email-finder invoke error:', err))
  } else {
    await supabaseRequest('PATCH', `validation_jobs?id=eq.${jobIdB}`, { status: 'completed' })
  }

  return { streamALen: streamA.length, streamBLen: streamB.length }
}

async function run(payload: Payload): Promise<void> {
  const phase = payload.phase ?? 'hnwi'
  const startTime = Date.now()

  if (phase === 'hnwi') {
    // ── Phase 1: HNWI Demand Scraper ───────────────────────────────────────────
    const hnwiResult = await pollApify(payload.hnwi_run_id, startTime)

    if (hnwiResult.timedOut) {
      selfInvoke({ ...payload, phase: 'hnwi' })
      return
    }

    const hnwiRecords = await fetchDataset(hnwiResult.datasetId!)
    const { streamALen, streamBLen } = await processRecords(
      hnwiRecords,
      payload.hnwi_job_a,
      payload.hnwi_job_b,
    )

    // Telegram: HNWI done, switching to RIA
    await sendTelegram(
      `🎯 HNWI Demand Scraper — complete\n\n` +
      `${hnwiRecords.length} signals scraped\n` +
      `├ ${streamALen} with emails → direct validation\n` +
      `└ ${streamBLen} without emails → email finder\n\n` +
      `🔄 Starting RIA Supply Scraper...`,
    )

    // Start RIA actor now that HNWI is done
    const riaRunId = await startActorRun(WEALTH_ACTOR_ID, payload.ria_input)

    // Hand off to RIA phase in a fresh invocation
    selfInvoke({ ...payload, phase: 'ria', ria_run_id: riaRunId })
    return
  }

  if (phase === 'ria') {
    // ── Phase 2: RIA Supply Scraper ────────────────────────────────────────────
    if (!payload.ria_run_id) throw new Error('ria_run_id missing in ria phase')

    const riaResult = await pollApify(payload.ria_run_id, startTime)

    if (riaResult.timedOut) {
      selfInvoke({ ...payload, phase: 'ria' })
      return
    }

    const riaRecords = await fetchDataset(riaResult.datasetId!)
    await processRecords(riaRecords, payload.ria_job_a, payload.ria_job_b)
    // Completion Telegrams are sent by email-validator when each job finishes
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  let payload: Payload
  try {
    payload = await req.json() as Payload
    if (
      !payload.hnwi_job_a || !payload.hnwi_job_b ||
      !payload.ria_job_a || !payload.ria_job_b ||
      !payload.hnwi_run_id || !payload.ria_input
    ) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const asyncWork = run(payload).catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[hnwi-pipeline-orchestrator] Failed:', message)
    const jobIds = [payload.hnwi_job_a, payload.hnwi_job_b, payload.ria_job_a, payload.ria_job_b]
    await Promise.all(
      jobIds.map(id =>
        supabaseRequest('PATCH', `validation_jobs?id=eq.${id}`, {
          status: 'failed',
          error_message: message,
        }).catch(() => {}),
      ),
    )
  })

  EdgeRuntime.waitUntil(asyncWork)

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
