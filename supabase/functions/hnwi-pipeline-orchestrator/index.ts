// supabase/functions/hnwi-pipeline-orchestrator/index.ts
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const APIFY_TOKEN = Deno.env.get('APIFY_API_TOKEN')!

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

// Self-invoke before hitting Supabase's wall-clock limit
const CHUNK_LIMIT_MS = 110_000

type ARecord = Record<string, unknown>

interface Payload {
  job_id_a: string
  job_id_b: string
  hnwi_run_id: string
  wealth_run_id: string
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

function hasEmail(r: ARecord): boolean {
  const e = String(r.email ?? '')
  return e.includes('@') && e.includes('.')
}

// Returns datasetId on success, or { timedOut: true } when approaching the wall-clock limit.
// On timedOut, caller should self-invoke with the same payload — Apify run state persists,
// so the next invocation's first poll will return SUCCEEDED immediately if already done.
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
    if (TERMINAL.has(status)) throw new Error(`Apify run ${runId} ended with status: ${status}`)
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

async function run(payload: Payload): Promise<void> {
  const { job_id_a, job_id_b, hnwi_run_id, wealth_run_id } = payload
  const startTime = Date.now()

  // Poll both actors concurrently — if either times out, self-invoke with same payload.
  // Apify run state persists so the re-invocation's first check returns SUCCEEDED immediately.
  const [hnwiResult, wealthResult] = await Promise.all([
    pollApify(hnwi_run_id, startTime),
    pollApify(wealth_run_id, startTime),
  ])

  if (hnwiResult.timedOut || wealthResult.timedOut) {
    fetch(`${SUPABASE_URL}/functions/v1/hnwi-pipeline-orchestrator`, {
      method: 'POST',
      headers: EDGE_HEADERS,
      body: JSON.stringify(payload),
    }).catch(err => console.error('[hnwi-pipeline-orchestrator] Self-invoke error:', err))
    return
  }

  // Fetch both datasets
  const [hnwiRecords, wealthRecords] = await Promise.all([
    fetchDataset(hnwiResult.datasetId!),
    fetchDataset(wealthResult.datasetId!),
  ])

  // Merge and split by email presence
  const all = [...hnwiRecords, ...wealthRecords]
  const streamA = all.filter(r => hasEmail(r))
  const streamB = all.filter(r => !hasEmail(r))

  // Update total_rows now that we have real counts
  await Promise.all([
    supabaseRequest('PATCH', `validation_jobs?id=eq.${job_id_a}`, { total_rows: streamA.length }),
    supabaseRequest('PATCH', `validation_jobs?id=eq.${job_id_b}`, { total_rows: streamB.length }),
  ])

  // Insert rows for Stream A
  if (streamA.length > 0) {
    await insertInBatches(
      streamA.map((r, i) => ({
        job_id: job_id_a,
        email: String(r.email ?? ''),
        row_index: i,
        status: 'pending',
        row_data: r,
      })),
    )
  } else {
    await supabaseRequest('PATCH', `validation_jobs?id=eq.${job_id_a}`, { status: 'completed' })
  }

  // Insert rows for Stream B
  if (streamB.length > 0) {
    await insertInBatches(
      streamB.map((r, i) => ({
        job_id: job_id_b,
        email: '',
        row_index: i,
        status: 'pending',
        row_data: r,
      })),
    )
  } else {
    await supabaseRequest('PATCH', `validation_jobs?id=eq.${job_id_b}`, { status: 'completed' })
  }

  // Fire email-validator for Stream A (fire-and-forget)
  if (streamA.length > 0) {
    fetch(`${SUPABASE_URL}/functions/v1/email-validator`, {
      method: 'POST',
      headers: EDGE_HEADERS,
      body: JSON.stringify({ job_id: job_id_a }),
    }).catch(err => console.error('[hnwi-pipeline-orchestrator] email-validator invoke error:', err))
  }

  // Fire hnwi-email-finder for Stream B (fire-and-forget)
  if (streamB.length > 0) {
    fetch(`${SUPABASE_URL}/functions/v1/hnwi-email-finder`, {
      method: 'POST',
      headers: EDGE_HEADERS,
      body: JSON.stringify({ job_id: job_id_b }),
    }).catch(err => console.error('[hnwi-pipeline-orchestrator] hnwi-email-finder invoke error:', err))
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  let payload: Payload
  try {
    payload = await req.json() as Payload
    if (!payload.job_id_a || !payload.job_id_b || !payload.hnwi_run_id || !payload.wealth_run_id) {
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
    try {
      // PATCH doesn't support in() via REST without PostgREST filter — patch each job
      await Promise.all([
        supabaseRequest('PATCH', `validation_jobs?id=eq.${payload.job_id_a}`, { status: 'failed', error_message: message }),
        supabaseRequest('PATCH', `validation_jobs?id=eq.${payload.job_id_b}`, { status: 'failed', error_message: message }),
      ])
    } catch (patchErr) {
      console.error('[hnwi-pipeline-orchestrator] Failed to mark jobs failed:', patchErr)
    }
  })

  EdgeRuntime.waitUntil(asyncWork)

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
