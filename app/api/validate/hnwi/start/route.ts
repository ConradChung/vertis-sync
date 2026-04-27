// app/api/validate/hnwi/start/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'

export const maxDuration = 300

const HNWI_ACTOR_ID = 'belcaidsaad~scrape-hnwi-for-wealth-management-market-saad-belcaid'
const WEALTH_ACTOR_ID = 'belcaidsaad~wealth-management-scraper-saad-belcaid-market-saad-belcaid'

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

function hasEmail(r: ARecord): boolean {
  const e = String(r.email ?? '')
  return e.includes('@') && e.includes('.')
}

// ── Apify helpers ──────────────────────────────────────────────────────────────

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

async function waitForRun(runId: string, token: string): Promise<string> {
  const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED_OUT'])
  for (let attempt = 0; attempt < 60; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 5_000))
    const res = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${token}`,
    )
    if (!res.ok) throw new Error(`Actor run poll failed: ${res.status}`)
    const data = await res.json() as { data: { status: string; defaultDatasetId: string } }
    const { status, defaultDatasetId } = data.data
    if (status === 'SUCCEEDED') return defaultDatasetId
    if (TERMINAL.has(status)) throw new Error(`Actor run ${runId} ended with status: ${status}`)
  }
  throw new Error(`Actor run ${runId} timed out after 5 minutes`)
}

async function fetchDataset(datasetId: string, token: string): Promise<ARecord[]> {
  const res = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&limit=99999`,
  )
  if (!res.ok) throw new Error(`Dataset fetch failed: ${res.status}`)
  return res.json() as Promise<ARecord[]>
}

// ── Stats & chart helpers ───────────────────────────────────────────────────────

interface PipelineStats {
  hnwi_count: number
  wealth_count: number
  total: number
  stream_a: number
  stream_b: number
  urgency: Record<string, number>
  aum_tiers: Record<string, number>
  top_states: Array<{ state: string; count: number }>
  start_date: string
  end_date: string
}

function buildStats(
  hnwiRecords: ARecord[],
  wealthRecords: ARecord[],
  streamA: ARecord[],
  streamB: ARecord[],
  startDate: string,
  endDate: string,
): PipelineStats {
  const urgency: Record<string, number> = {}
  for (const r of hnwiRecords) {
    const u = String(r.signal_urgency ?? r.urgency ?? 'unknown')
    urgency[u] = (urgency[u] ?? 0) + 1
  }

  const aum_tiers: Record<string, number> = { boutique: 0, mid_market: 0, institution: 0 }
  for (const r of wealthRecords) {
    const cat = String(r.firm_category ?? '')
    if (cat === 'boutique') aum_tiers.boutique++
    else if (cat === 'mid_market') aum_tiers.mid_market++
    else if (cat === 'institutional' || cat === 'mega') aum_tiers.institution++
  }

  const stateCounts: Record<string, number> = {}
  for (const r of wealthRecords) {
    const s = String(r.state ?? '')
    if (s) stateCounts[s] = (stateCounts[s] ?? 0) + 1
  }
  const top_states = Object.entries(stateCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([state, count]) => ({ state, count }))

  return {
    hnwi_count: hnwiRecords.length,
    wealth_count: wealthRecords.length,
    total: hnwiRecords.length + wealthRecords.length,
    stream_a: streamA.length,
    stream_b: streamB.length,
    urgency,
    aum_tiers,
    top_states,
    start_date: startDate,
    end_date: endDate,
  }
}

function buildDailySignalCounts(
  hnwiRecords: ARecord[],
  startDate: string,
  endDate: string,
): Array<{ label: string; count: number }> {
  const counts: Record<string, number> = {}
  const start = new Date(startDate + 'T00:00:00')
  const end = new Date(endDate + 'T00:00:00')

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    counts[d.toISOString().slice(0, 10)] = 0
  }

  for (const r of hnwiRecords) {
    const date = String(r.signal_date ?? '').slice(0, 10)
    if (date in counts) counts[date]++
  }

  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => {
      const d = new Date(date + 'T00:00:00')
      const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      return { label, count }
    })
}

function renderLineChart(points: Array<{ label: string; count: number }>): string[] {
  if (points.length === 0) return []
  const max = Math.max(...points.map(p => p.count), 1)
  const H = 4
  const rowOf = (n: number) => Math.round((n / max) * H)
  const rows = points.map(p => rowOf(p.count))
  const lines: string[] = []

  for (let h = H; h >= 0; h--) {
    const yVal = Math.round((h / H) * max)
    let row = `  │ ${String(yVal).padStart(2)} ┤`

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      const prev = i > 0 ? rows[i - 1] : r
      const next = i < rows.length - 1 ? rows[i + 1] : r

      if (r === h) {
        const left = i === 0 ? '─' : prev > h ? '╰' : prev < h ? '╭' : '─'
        const right = i === rows.length - 1 ? '' : next > h ? '╮' : next < h ? '─' : '─'
        row += left + '─' + right + (right === '' ? ' ' : '')
      } else if (r > h) {
        const prevAtOrBelow = i === 0 || rows[i - 1] <= h
        const nextAtOrBelow = i === rows.length - 1 || rows[i + 1] <= h
        if (prevAtOrBelow && !nextAtOrBelow) row += '╭──'
        else if (!prevAtOrBelow && nextAtOrBelow) row += '──╮'
        else if (prevAtOrBelow && nextAtOrBelow) row += ' · '
        else row += '───'
      } else {
        row += '   '
      }
    }

    lines.push(row)
  }

  lines.push('  │     └' + '───'.repeat(points.length))
  lines.push(
    '  │      ' +
      points.map(p => p.label.padEnd(3)).join('  '),
  )

  return lines
}

async function insertInBatches(
  supabase: ReturnType<typeof createServiceClient>,
  rows: unknown[],
  batchSize = 100,
): Promise<{ error: { message: string } | null }> {
  for (let i = 0; i < rows.length; i += batchSize) {
    const { error } = await supabase.from('validation_rows').insert(rows.slice(i, i + batchSize))
    if (error) return { error }
  }
  return { error: null }
}

// ── Main handler ───────────────────────────────────────────────────────────────

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
    maxResults: 200,
  }

  const wealthInput = {
    minAUM: Number(body.minAUM ?? 100_000_000),
    maxAUM: 0,
    minEmployees: 0,
    maxEmployees: Number(body.maxEmployees ?? 50),
    stateFilter: String(body.stateFilter ?? ''),
    firmCategory: 'all',
    maxResults: 500,
  }

  try {
    // 1. Trigger both actors in parallel
    const [hnwiRunId, wealthRunId] = await Promise.all([
      startActorRun(HNWI_ACTOR_ID, hnwiInput, APIFY_API_TOKEN),
      startActorRun(WEALTH_ACTOR_ID, wealthInput, APIFY_API_TOKEN),
    ])

    // 2. Wait for both to complete, get dataset IDs
    const [hnwiDatasetId, wealthDatasetId] = await Promise.all([
      waitForRun(hnwiRunId, APIFY_API_TOKEN),
      waitForRun(wealthRunId, APIFY_API_TOKEN),
    ])

    // 3. Fetch both datasets
    const [hnwiRecords, wealthRecords] = await Promise.all([
      fetchDataset(hnwiDatasetId, APIFY_API_TOKEN),
      fetchDataset(wealthDatasetId, APIFY_API_TOKEN),
    ])

    // 4. Merge and split
    const all = [...hnwiRecords, ...wealthRecords]
    const streamA = all.filter(r => hasEmail(r))
    const streamB = all.filter(r => !hasEmail(r))

    // 5. Build stats and chart
    const stats = buildStats(hnwiRecords, wealthRecords, streamA, streamB, startDate, endDate)
    const dailyPoints = buildDailySignalCounts(hnwiRecords, startDate, endDate)
    const chartLines = renderLineChart(dailyPoints)

    // 6. Create two jobs
    const today = dateString(0)
    const jobIdA = crypto.randomUUID()
    const jobIdB = crypto.randomUUID()
    const supabase = createServiceClient()

    const { error: jobsError } = await supabase.from('validation_jobs').insert([
      {
        id: jobIdA,
        filename: `hnwi-signals-${today}`,
        total_rows: streamA.length,
        processed_rows: 0,
        valid_count: 0,
        invalid_count: 0,
        status: 'pending',
        source: 'hnwi',
      },
      {
        id: jobIdB,
        filename: `hnwi-email-found-${today}`,
        total_rows: streamB.length,
        processed_rows: 0,
        valid_count: 0,
        invalid_count: 0,
        status: 'pending',
        source: 'hnwi',
      },
    ])
    if (jobsError) {
      return NextResponse.json({ error: `Failed to create jobs: ${jobsError.message}` }, { status: 500 })
    }

    // 7. Insert validation rows for Stream A (have email)
    if (streamA.length > 0) {
      const { error: rowsAError } = await insertInBatches(
        supabase,
        streamA.map((r, i) => ({
          job_id: jobIdA,
          email: String(r.email ?? ''),
          row_index: i,
          status: 'pending',
          row_data: r,
        })),
      )
      if (rowsAError) {
        await supabase.from('validation_jobs').delete().in('id', [jobIdA, jobIdB])
        return NextResponse.json({ error: `Failed to insert Stream A rows: ${rowsAError.message}` }, { status: 500 })
      }
    }

    // 8. Insert validation rows for Stream B (no email yet — blank email, status pending)
    if (streamB.length > 0) {
      const { error: rowsBError } = await insertInBatches(
        supabase,
        streamB.map((r, i) => ({
          job_id: jobIdB,
          email: '',
          row_index: i,
          status: 'pending',
          row_data: r,
        })),
      )
      if (rowsBError) {
        await supabase.from('validation_jobs').delete().in('id', [jobIdA, jobIdB])
        return NextResponse.json({ error: `Failed to insert Stream B rows: ${rowsBError.message}` }, { status: 500 })
      }
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
    const edgeHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${serviceKey}`,
      'apikey': serviceKey,
    }

    // 9. Fire email-validator for Stream A
    if (streamA.length > 0) {
      try {
        await fetch(`${supabaseUrl}/functions/v1/email-validator`, {
          method: 'POST',
          headers: edgeHeaders,
          body: JSON.stringify({ job_id: jobIdA }),
        })
      } catch (err) {
        console.error('[hnwi/start] email-validator invoke error:', err)
      }
    } else {
      await supabase.from('validation_jobs').update({ status: 'completed' }).eq('id', jobIdA)
    }

    // 10. Fire hnwi-email-finder for Stream B
    if (streamB.length > 0) {
      try {
        await fetch(`${supabaseUrl}/functions/v1/hnwi-email-finder`, {
          method: 'POST',
          headers: edgeHeaders,
          body: JSON.stringify({ job_id: jobIdB }),
        })
      } catch (err) {
        console.error('[hnwi/start] hnwi-email-finder invoke error:', err)
      }
    } else {
      await supabase.from('validation_jobs').update({ status: 'completed' }).eq('id', jobIdB)
    }

    return NextResponse.json({
      job_id_a: jobIdA,
      job_id_b: jobIdB,
      stats,
      chart_lines: chartLines,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
