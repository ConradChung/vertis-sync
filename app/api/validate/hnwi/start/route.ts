// app/api/validate/hnwi/start/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'

export const maxDuration = 60

const HNWI_ACTOR_ID = 'belcaidsaad~scrape-hnwi-for-wealth-management-market-saad-belcaid'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ARecord = Record<string, any>

function createServiceClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll: () => [], setAll: () => {} } },
  )
}

function dateString(daysAgo = 0): string {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  return d.toISOString().slice(0, 10)
}

async function startActorRun(actorId: string, input: unknown, token: string): Promise<string> {
  const res = await fetch(
    `https://api.apify.com/v2/acts/${actorId}/runs?token=${token}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    },
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to start actor ${actorId}: ${res.status} ${text}`)
  }
  const data = await res.json() as { data: { id: string } }
  return data.data.id
}

export async function POST(request: NextRequest) {
  const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN
  if (!APIFY_API_TOKEN) {
    return NextResponse.json({ error: 'Missing APIFY_API_TOKEN' }, { status: 500 })
  }

  let body: ARecord = {}
  try {
    body = await request.json() as ARecord
  } catch {
    // no body is fine — all fields have defaults
  }

  const startDate = String(body.startDate ?? dateString(7))
  const endDate = String(body.endDate ?? dateString(0))

  const hnwiInput = {
    scrapeForm4: true,
    scrapeForm144: true,
    scrape8K: true,
    startDate,
    endDate,
    minTransactionValue: Number(body.minTransactionValue ?? 1_000_000),
    minSellRatio: 0.20,
    minUrgency: String(body.minUrgency ?? 'high'),
    officersOnly: true,
    excludeMegaCap: true,
    maxResults: Number(body.maxResultsHnwi ?? 200),
  }

  // RIA input is passed to the orchestrator — it starts the RIA actor only after HNWI completes
  const riaInput = {
    minAUM: Number(body.minAUM ?? 100_000_000),
    maxAUM: 0,
    minEmployees: 0,
    maxEmployees: Number(body.maxEmployees ?? 50),
    stateFilter: String(body.stateFilter ?? ''),
    firmCategory: 'all',
    maxResults: Number(body.maxResultsWealth ?? 500),
  }

  try {
    // 1. Start only the HNWI actor — RIA starts sequentially after HNWI completes
    const hnwiRunId = await startActorRun(HNWI_ACTOR_ID, hnwiInput, APIFY_API_TOKEN)

    // 2. Create 4 validation jobs (2 per scraper: direct emails + email finder)
    const today = dateString(0)
    const hnwiJobA = crypto.randomUUID()  // HNWI direct emails
    const hnwiJobB = crypto.randomUUID()  // HNWI email finder
    const riaJobA  = crypto.randomUUID()  // RIA direct emails
    const riaJobB  = crypto.randomUUID()  // RIA email finder
    const supabase = createServiceClient()

    const { error: jobsError } = await supabase.from('validation_jobs').insert([
      { id: hnwiJobA, filename: `hnwi-signals-${today}`,     total_rows: 0, processed_rows: 0, valid_count: 0, invalid_count: 0, status: 'pending', source: 'hnwi' },
      { id: hnwiJobB, filename: `hnwi-email-found-${today}`, total_rows: 0, processed_rows: 0, valid_count: 0, invalid_count: 0, status: 'pending', source: 'hnwi' },
      { id: riaJobA,  filename: `ria-signals-${today}`,      total_rows: 0, processed_rows: 0, valid_count: 0, invalid_count: 0, status: 'pending', source: 'hnwi' },
      { id: riaJobB,  filename: `ria-email-found-${today}`,  total_rows: 0, processed_rows: 0, valid_count: 0, invalid_count: 0, status: 'pending', source: 'hnwi' },
    ])
    if (jobsError) {
      return NextResponse.json({ error: `Failed to create jobs: ${jobsError.message}` }, { status: 500 })
    }

    // 3. Fire orchestrator (fire-and-forget) — handles sequential scraping + all validation
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
    fetch(`${supabaseUrl}/functions/v1/hnwi-pipeline-orchestrator`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`,
        'apikey': serviceKey,
      },
      body: JSON.stringify({
        hnwi_job_a: hnwiJobA,
        hnwi_job_b: hnwiJobB,
        ria_job_a:  riaJobA,
        ria_job_b:  riaJobB,
        hnwi_run_id: hnwiRunId,
        ria_input: riaInput,
      }),
    }).catch(err => console.error('[hnwi/start] orchestrator invoke error:', err))

    return NextResponse.json({
      hnwi_job_a: hnwiJobA,
      hnwi_job_b: hnwiJobB,
      ria_job_a:  riaJobA,
      ria_job_b:  riaJobB,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
